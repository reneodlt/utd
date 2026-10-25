"""Uploaded photos, files and media: stored under MEDIA_ROOT on an
Attachment of kind "file". Images get a small JPEG thumbnail (EXIF-rotated,
so iPhone photos stand the right way up). Audio and video are recognised by
their bytes, never by the client's content type or the file extension, and
get a duration (ffprobe) and, for video, a poster frame (ffmpeg) when those
tools are installed. Both are optional: without them the attachment simply
has no duration or poster, and the browser fills the duration in once the
clip loads."""

import io
import json
import mimetypes
import os
import shutil
import subprocess
import tempfile

from django.conf import settings
from django.core.files.base import ContentFile

THUMB_PX = 640
PROBE_TIMEOUT = 20  # seconds, for ffprobe and for ffmpeg


class UploadError(ValueError):
    """Too big, empty, or unreadable; the message is safe to show."""


# --- recognising media from its bytes -------------------------------------

def _sniff(head: bytes) -> tuple[str, str] | None:
    """(content type, media class) from the first bytes, or None. Containers
    that can hold audio or video (mp4/mov, webm/matroska) come back as the
    video type and are refined by _refine()."""
    if head[:4] == b"OggS":
        return ("audio/opus" if b"OpusHead" in head[:128] else "audio/ogg"), "audio"
    if head[:3] == b"ID3":
        return "audio/mpeg", "audio"
    if head[:4] == b"fLaC":
        return "audio/flac", "audio"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return "audio/wav", "audio"
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:
        # MPEG audio frame sync. Layer bits 00 is ADTS (AAC); anything else is mp3.
        if (head[1] & 0x06) == 0:
            return "audio/aac", "audio"
        return "audio/mpeg", "audio"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"M4A ", b"M4B ", b"M4P "):
            return "audio/mp4", "audio"
        if brand == b"qt  ":
            return "video/quicktime", "video"
        return "video/mp4", "video"
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "video/webm", "video"
    return None


def _tool(name: str) -> str | None:
    return shutil.which(name)


def probe(path: str) -> dict | None:
    """ffprobe facts about a file: {"duration": float|None, "video": bool,
    "width": int, "height": int}. None when ffprobe is missing or fails.
    The path goes in as one argument (no shell), with a timeout."""
    ffprobe = _tool("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-print_format", "json",
             "-show_entries", "format=duration:stream=codec_type,width,height:stream_disposition=attached_pic",
             "-i", path],
            capture_output=True, timeout=PROBE_TIMEOUT, check=True, text=True,
        ).stdout
        info = json.loads(out)
    except (subprocess.SubprocessError, OSError, ValueError):
        return None
    streams = info.get("streams") or []
    # Cover art in an m4a or mp3 shows up as a video stream; it isn't one.
    video = next((s for s in streams if s.get("codec_type") == "video"
                  and not (s.get("disposition") or {}).get("attached_pic")), None)
    try:
        duration = float(info.get("format", {}).get("duration"))
    except (TypeError, ValueError):
        duration = None
    return {"duration": duration, "video": video is not None,
            "width": (video or {}).get("width"), "height": (video or {}).get("height")}


def _refine(content_type: str, media: str, name: str, declared: str, facts: dict | None):
    """Audio or video? mp4/mov and webm/matroska can be either. ffprobe
    settles it from the streams; without it, the extension (or, for webm,
    the declared audio/ type) breaks the tie."""
    if content_type not in ("video/mp4", "video/webm"):
        return content_type, media
    family = content_type.split("/")[1]
    if facts is not None:
        is_video = facts["video"]
    else:
        ext = os.path.splitext(name)[1].lower()
        is_video = not (ext in (".m4a", ".m4b", ".aac", ".weba", ".mka")
                        or (family == "webm" and declared.startswith("audio/")))
    return (f"video/{family}", "video") if is_video else (f"audio/{'mp4' if family == 'mp4' else 'webm'}", "audio")


# --- images ----------------------------------------------------------------

def _thumbnail(raw: bytes):
    """(thumbnail JPEG bytes, width, height) for an image, else None."""
    from PIL import Image, ImageOps, UnidentifiedImageError
    try:
        with Image.open(io.BytesIO(raw)) as img:
            img = ImageOps.exif_transpose(img)
            width, height = img.size
            img.thumbnail((THUMB_PX, THUMB_PX))
            if img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            out = io.BytesIO()
            img.save(out, "JPEG", quality=80, optimize=True)
            return out.getvalue(), width, height
    except (UnidentifiedImageError, OSError, ValueError):
        return None


def _poster(path: str) -> bytes | None:
    """A JPEG frame at 1 s (or the first frame of a shorter clip), scaled to
    the thumbnail width. None if ffmpeg is missing or finds no picture."""
    ffmpeg = _tool("ffmpeg")
    if not ffmpeg:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "poster.jpg")
        for seek in ("1", "0"):
            try:
                subprocess.run(
                    [ffmpeg, "-v", "error", "-y", "-ss", seek, "-i", path, "-frames:v", "1",
                     "-vf", f"scale='min({THUMB_PX},iw)':-2", "-q:v", "4", out],
                    capture_output=True, timeout=PROBE_TIMEOUT, check=True,
                )
            except (subprocess.SubprocessError, OSError):
                return None
            if os.path.exists(out) and os.path.getsize(out) > 0:
                with open(out, "rb") as fh:
                    return fh.read()
    return None


# --- the upload pipeline ---------------------------------------------------

def _limit(media: str) -> tuple[int, str]:
    if media == "audio":
        return settings.MAX_AUDIO_BYTES, "audio files"
    if media == "video":
        return settings.MAX_VIDEO_BYTES, "video files"
    return settings.MAX_UPLOAD_BYTES, "files"


def _too_big(limit: int, what: str) -> UploadError:
    return UploadError(f"{what} can be up to {limit // (1024 * 1024)} MB")


def describe(uploaded) -> tuple[dict, bytes]:
    """Validate an uploaded file; its attachment data and its bytes."""
    size = uploaded.size or 0
    if size <= 0:
        raise UploadError("that file is empty")
    name = os.path.basename(uploaded.name or "upload")[:255] or "upload"
    declared = (uploaded.content_type or "").split(";")[0].strip().lower()
    uploaded.seek(0)
    head = uploaded.read(4096)
    sniffed = _sniff(head)
    if sniffed:
        content_type, media = sniffed
    else:
        # Not recognisable media. Whatever the client claims, never keep an
        # audio/ or video/ label on bytes that are not.
        content_type = declared or mimetypes.guess_type(name)[0] or "application/octet-stream"
        if content_type.startswith(("audio/", "video/")):
            content_type = "application/octet-stream"
        media = "image" if content_type.startswith("image/") else "file"
    # Refuse before reading the rest. mp4 and webm may turn out to be audio,
    # so they get the video ceiling for now and the audio one after probing.
    limit, what = _limit(media)
    if size > limit:
        raise _too_big(limit, what)
    raw = head + uploaded.read()
    facts = None
    if sniffed and _tool("ffprobe"):
        # Let ffprobe see the whole file (mp4 keeps its index at the end).
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "probe" + (mimetypes.guess_extension(content_type) or ""))
            with open(path, "wb") as fh:
                fh.write(raw)
            facts = probe(path)
    if sniffed:
        content_type, media = _refine(content_type, media, name, declared, facts)
    limit, what = _limit(media)
    if size > limit:
        raise _too_big(limit, what)
    data = {"name": name, "content_type": content_type[:100], "size": str(size), "media": media}
    if facts:
        if facts["duration"] is not None and media in ("audio", "video"):
            data["duration"] = f"{facts['duration']:.1f}"
        if media == "video" and facts["width"] and facts["height"]:
            data["width"], data["height"] = str(facts["width"]), str(facts["height"])
    return data, raw


def store(attachment, raw: bytes) -> None:
    """Save the file onto the attachment, with a thumbnail if it's an image
    or a poster frame if it's a video and ffmpeg is installed."""
    name = attachment.data.get("name", "upload")
    attachment.file.save(name, ContentFile(raw), save=False)
    if attachment.data.get("content_type", "").startswith("image/"):
        thumb = _thumbnail(raw)
        if thumb:
            jpeg, width, height = thumb
            attachment.thumb.save(os.path.splitext(name)[0] + ".jpg", ContentFile(jpeg), save=False)
            attachment.data = {**attachment.data, "width": str(width), "height": str(height)}
    elif attachment.data.get("media") == "video":
        try:
            path = attachment.file.path
        except NotImplementedError:  # remote storage: no local path to hand ffmpeg
            path = None
        jpeg = _poster(path) if path else None
        if jpeg:
            attachment.thumb.save(os.path.splitext(name)[0] + ".jpg", ContentFile(jpeg), save=False)
    attachment.save()
