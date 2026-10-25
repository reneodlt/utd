import type { AttachmentPlugin } from "./types";

const PHONE = /^\+?[\d\s().-]+$/;

const phone: AttachmentPlugin = {
  kind: "phone",
  name: "Phone number",
  icon: "☏",
  fields: [
    { name: "number", label: "Number", input: "tel", required: true, placeholder: "+44 20 7946 0958" },
  ],

  detect(text) {
    const t = text.trim().replace(/^tel:/i, "");
    const digits = t.replace(/\D/g, "").length;
    return PHONE.test(t) && digits >= 6 && digits <= 15 ? { number: t } : null;
  },

  summary: (data) => data.number,

  actions: (data) => [{ label: "Call", href: `tel:${data.number.replace(/[^\d+]/g, "")}` }],

  copy: (data) => data.number,
};

export default phone;
