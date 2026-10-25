/** The plugin contract for attachment kinds. A plugin describes one kind of
 * thing a task can carry (web page, phone number, place...): the form to
 * add it, how to spot it in pasted text, how to show it, and what opening
 * it does. Everything else — chips on cards, the drawer section, the add
 * menu — is generic and driven from the registry.
 *
 * The `kind` must match a kind registered on the server
 * (backend/boards/attachments.py), which validates the data. */

export type AttachmentData = Record<string, string>;

export interface FieldSpec {
  name: string;
  label: string;
  input: "text" | "url" | "tel" | "email" | "datetime-local";
  required?: boolean;
  placeholder?: string;
}

export interface AttachmentAction {
  label: string;
  href: string;
  /** Save as a file (e.g. an .ics) rather than navigate. */
  download?: string;
  /** http(s) targets open in a new tab; tel:/mailto: hand off in place. */
  newTab?: boolean;
}

export interface AttachmentPlugin {
  kind: string;
  /** Menu name, e.g. "Web page". */
  name: string;
  /** A single glyph, shown on chips and in the menu. */
  icon: string;
  /** A glyph for this particular item, when it varies (a GitHub PR vs a
   * commit). Falls back to `icon`. */
  iconFor?(data: AttachmentData): string;
  fields: FieldSpec[];
  /** Data for this kind if the pasted text looks like one, else null.
   * Plugins are asked in registry order; the first match wins. */
  detect?(text: string): AttachmentData | null;
  /** Short text for a chip when there's no label. */
  summary(data: AttachmentData): string;
  /** A fuller second line for the drawer (optional). */
  detail?(data: AttachmentData): string | undefined;
  /** What opening does. The first is the primary action (chip click). */
  actions(data: AttachmentData, label: string): AttachmentAction[];
  /** The value "Copy" puts on the clipboard. */
  copy?(data: AttachmentData): string;
}
