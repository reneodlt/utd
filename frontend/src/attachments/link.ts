import type { AttachmentData, AttachmentPlugin } from "./types";

const PROVIDERS: [RegExp, string, (m: RegExpMatchArray) => string][] = [
  [/gitlab\.[^/]+\/.+\/-\/merge_requests\/(\d+)/, "gitlab_mr", (m) => `MR !${m[1]}`],
  [/gitlab\.[^/]+\/.+\/-\/issues\/(\d+)/, "gitlab_issue", (m) => `Issue #${m[1]}`],
];

function withScheme(url: string) {
  return /^[a-z][a-z\d+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

function short(url: string): string {
  try {
    const u = new URL(withScheme(url));
    const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
    const text = u.hostname.replace(/^www\./, "") + path;
    return text.length > 40 ? `${text.slice(0, 39)}…` : text;
  } catch {
    return url;
  }
}

const link: AttachmentPlugin = {
  kind: "link",
  name: "Web page",
  icon: "↗",
  fields: [{ name: "url", label: "Address", input: "url", required: true, placeholder: "https://…" }],

  detect(text): AttachmentData | null {
    const t = text.trim();
    if (/\s/.test(t)) return null;
    if (/^https?:\/\//i.test(t) || /^www\./i.test(t) || /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(t)) {
      const url = withScheme(t);
      const provider = PROVIDERS.find(([re]) => re.test(url))?.[1];
      return provider ? { url, provider } : { url };
    }
    return null;
  },

  summary(data: AttachmentData) {
    for (const [re, , name] of PROVIDERS) {
      const m = data.url.match(re);
      if (m) return name(m);
    }
    return short(data.url);
  },

  detail: (data) => data.url,

  actions: (data) => [{ label: "Open", href: withScheme(data.url), newTab: true }],

  copy: (data) => data.url,
};

export default link;
