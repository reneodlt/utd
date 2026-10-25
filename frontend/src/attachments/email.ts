import type { AttachmentPlugin } from "./types";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const email: AttachmentPlugin = {
  kind: "email",
  name: "Email address",
  icon: "✉",
  fields: [
    { name: "address", label: "Address", input: "email", required: true, placeholder: "name@example.com" },
    { name: "subject", label: "Subject", input: "text", placeholder: "Optional, used when you email" },
  ],

  detect(text) {
    const t = text.trim().replace(/^mailto:/i, "");
    return EMAIL.test(t) ? { address: t } : null;
  },

  summary: (data) => data.address,

  detail: (data) => (data.subject ? `Subject: ${data.subject}` : undefined),

  actions: (data) => [
    {
      label: "Email",
      href: `mailto:${data.address}${data.subject ? `?subject=${encodeURIComponent(data.subject)}` : ""}`,
    },
  ],

  copy: (data) => data.address,
};

export default email;
