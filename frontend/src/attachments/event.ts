import type { AttachmentData, AttachmentPlugin } from "./types";

const HOUR = 60 * 60 * 1000;

/** "2026-10-01T09:00" as a local Date. */
function parse(value: string): Date {
  return new Date(value.length === 10 ? `${value}T00:00` : value);
}

function endOf(data: AttachmentData): Date {
  return data.end ? parse(data.end) : new Date(parse(data.start).getTime() + HOUR);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Floating local time (no zone), which calendars read as "your time". */
function icsTime(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
}

function icsText(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");
}

function ics(data: AttachmentData): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//UTD//Board//EN",
    "BEGIN:VEVENT",
    `UID:${icsTime(parse(data.start))}-${encodeURIComponent(data.title).slice(0, 40)}@utd`,
    `DTSTAMP:${icsTime(new Date())}`,
    `DTSTART:${icsTime(parse(data.start))}`,
    `DTEND:${icsTime(endOf(data))}`,
    `SUMMARY:${icsText(data.title)}`,
    ...(data.location ? [`LOCATION:${icsText(data.location)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.join("\r\n");
}

function day(data: AttachmentData): string {
  return parse(data.start).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function when(data: AttachmentData): string {
  const start = parse(data.start);
  const day = start.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `${day} ${time(start)}–${time(endOf(data))}`;
}

const event: AttachmentPlugin = {
  kind: "event",
  name: "Calendar entry",
  icon: "▦",
  fields: [
    { name: "title", label: "What", input: "text", required: true, placeholder: "Kickoff call" },
    { name: "start", label: "Starts", input: "datetime-local", required: true },
    { name: "end", label: "Ends", input: "datetime-local", placeholder: "An hour later if empty" },
    { name: "location", label: "Where", input: "text", placeholder: "Optional" },
  ],

  summary: (data) => `${data.title} · ${day(data)}`,

  detail: (data) => [when(data), data.location].filter(Boolean).join(" · "),

  actions(data) {
    const range = `${icsTime(parse(data.start))}/${icsTime(endOf(data))}`;
    const google = new URLSearchParams({
      action: "TEMPLATE",
      text: data.title,
      dates: range,
      ...(data.location ? { location: data.location } : {}),
    });
    return [
      {
        label: "Add to calendar",
        href: `data:text/calendar;charset=utf-8,${encodeURIComponent(ics(data))}`,
        download: `${data.title.replace(/[^\w -]+/g, "").trim() || "event"}.ics`,
      },
      {
        label: "Google Calendar",
        href: `https://calendar.google.com/calendar/render?${google}`,
        newTab: true,
      },
    ];
  },

  copy: (data) => `${data.title}, ${when(data)}${data.location ? `, ${data.location}` : ""}`,
};

export default event;
