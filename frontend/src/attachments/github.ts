import type { AttachmentData, AttachmentPlugin } from "./types";

/** What a GitHub URL points at, read from its path. */
export interface GitHubTarget {
  type:
    | "pr" | "issue" | "commit" | "file" | "folder" | "release" | "discussion"
    | "run" | "compare" | "repo" | "profile" | "gist" | "page";
  /** "PR #42", "Commit a1b2c3d", "README.md"... */
  title: string;
  /** "example/utd", or where in it. */
  context: string;
  /** Just "owner/repo" (empty for profiles and pages outside a repo). */
  repo: string;
  icon: string;
  /** What kind of thing, for the drawer: "Pull request", "Commit"... */
  noun: string;
}

const ICONS = {
  pr: "⇄", issue: "◎", commit: "◆", file: "▤", folder: "▣", release: "⚑",
  discussion: "❝", run: "▶", compare: "⇆", repo: "⌂", profile: "☺", gist: "✎", page: "↗",
} as const;

function target(type: GitHubTarget["type"], noun: string, title: string, context: string): GitHubTarget {
  const repo = context.match(/^[^/\s]+\/[^/\s]+/)?.[0] ?? "";
  return { type, noun, title, context, repo, icon: ICONS[type] };
}

export function parseGitHub(url: string): GitHubTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return target("page", "GitHub page", url, "GitHub");
  }
  const parts = u.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (u.hostname.startsWith("gist.")) {
    return target("gist", "Gist", parts[1] ? `Gist ${parts[1].slice(0, 7)}` : "Gist", parts[0] ?? "GitHub");
  }

  const [owner, repo, section, ...rest] = parts;
  if (!owner) return target("page", "GitHub page", "GitHub", "github.com");
  if (!repo) return target("profile", "Profile", owner, "GitHub");
  const where = `${owner}/${repo}`;
  const n = rest[0];

  switch (section) {
    case undefined:
      return target("repo", "Repository", where, "GitHub");
    case "pull":
      if (n) return target("pr", "Pull request", `PR #${n}`, where);
      break;
    case "pulls":
      return target("page", "Pull requests", "Pull requests", where);
    case "issues":
      if (n && /^\d+$/.test(n)) return target("issue", "Issue", `Issue #${n}`, where);
      return target("page", "Issues", "Issues", where);
    case "commit":
      if (n) return target("commit", "Commit", `Commit ${n.slice(0, 7)}`, where);
      break;
    case "commits":
      return target("page", "Commit history", `Commits on ${n ?? "default branch"}`, where);
    case "blob":
    case "tree": {
      const [ref, ...path] = rest;
      const file = section === "blob";
      const line = u.hash.match(/^#L(\d+)(?:-L(\d+))?/);
      const name = path.at(-1) ?? ref ?? repo;
      const lines = line ? (line[2] ? `:${line[1]}–${line[2]}` : `:${line[1]}`) : "";
      return target(
        file ? "file" : "folder",
        file ? "File" : "Folder",
        `${name}${lines}`,
        `${where}${path.length > 1 ? `/${path.slice(0, -1).join("/")}` : ""}${ref ? ` @ ${ref.length > 12 ? ref.slice(0, 7) : ref}` : ""}`,
      );
    }
    case "releases":
      if (rest[0] === "tag" && rest[1]) return target("release", "Release", rest[1], where);
      return target("page", "Releases", "Releases", where);
    case "discussions":
      if (n) return target("discussion", "Discussion", `Discussion #${n}`, where);
      break;
    case "actions":
      if (rest[0] === "runs" && rest[1]) return target("run", "Workflow run", `Run ${rest[1]}`, where);
      return target("run", "Actions", "Actions", where);
    case "compare":
      if (n) return target("compare", "Comparison", n.replace("...", " … "), where);
      break;
    case "wiki":
      return target("page", "Wiki", n ? n.replace(/-/g, " ") : "Wiki", where);
  }
  return target("page", "GitHub page", section ? `${section}${n ? ` ${n}` : ""}` : where, where);
}

const github: AttachmentPlugin = {
  kind: "github",
  name: "GitHub",
  icon: "⌥",
  fields: [
    {
      name: "url",
      label: "GitHub link",
      input: "url",
      required: true,
      placeholder: "Issue, PR, commit, file, repo…",
    },
  ],

  detect(text): AttachmentData | null {
    const t = text.trim();
    if (/\s/.test(t)) return null;
    const url = /^[a-z]+:\/\//i.test(t) ? t : `https://${t}`;
    return /^https?:\/\/(www\.|gist\.)?github\.com(\/|$)/i.test(url) ? { url } : null;
  },

  iconFor: (data) => parseGitHub(data.url).icon,

  summary(data) {
    const t = parseGitHub(data.url);
    return t.repo && t.type !== "repo" ? `${t.title} · ${t.repo}` : t.title;
  },

  detail(data) {
    const t = parseGitHub(data.url);
    return `${t.noun} · ${t.context}`;
  },

  actions: (data) => [{ label: "Open on GitHub", href: data.url, newTab: true }],

  copy: (data) => data.url,
};

export default github;
