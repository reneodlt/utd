import { pluginFor } from "../attachments/registry";
import type { OwnerContact, Task } from "../types";
import { useBoardStore } from "../store/boardStore";
import { OwnerBadge } from "./Owners";

/** Contact kinds an owner can have, with the field each keeps its value in. */
export const CONTACT_KINDS: { kind: OwnerContact["kind"]; name: string; field: string; placeholder: string; input: string }[] = [
  { kind: "phone", name: "Phone", field: "number", placeholder: "+44 20 7946 0958", input: "tel" },
  { kind: "email", name: "Email", field: "address", placeholder: "jim@example.com", input: "email" },
  { kind: "link", name: "Website", field: "url", placeholder: "https://example.com", input: "url" },
  { kind: "place", name: "Address", field: "address", placeholder: "12 High St, Bath", input: "text" },
];

export interface ContactDraft {
  kind: OwnerContact["kind"];
  value: string;
  label: string;
}

export function draftsFrom(contacts: OwnerContact[] | undefined): ContactDraft[] {
  return (contacts ?? []).map((c) => {
    const spec = CONTACT_KINDS.find((k) => k.kind === c.kind)!;
    return { kind: c.kind, value: c.data[spec.field] ?? "", label: c.label ?? "" };
  });
}

export function contactsFrom(drafts: ContactDraft[]): OwnerContact[] {
  return drafts
    .filter((d) => d.value.trim())
    .map((d) => {
      const spec = CONTACT_KINDS.find((k) => k.kind === d.kind)!;
      return {
        kind: d.kind,
        data: { [spec.field]: d.value.trim() },
        ...(d.label.trim() ? { label: d.label.trim() } : {}),
      };
    });
}

/** The owner form's "How to reach them": phone, email, website, address. */
export function ContactsEditor({ drafts, onChange }: { drafts: ContactDraft[]; onChange: (d: ContactDraft[]) => void }) {
  const set = (i: number, patch: Partial<ContactDraft>) =>
    onChange(drafts.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <fieldset className="owner-colours owner-contacts-editor">
      <legend>
        How to reach them <em>optional</em>
      </legend>
      {drafts.map((d, i) => {
        const spec = CONTACT_KINDS.find((k) => k.kind === d.kind)!;
        return (
          <div key={i} className="contact-row">
            <select value={d.kind} onChange={(e) => set(i, { kind: e.target.value as ContactDraft["kind"] })} aria-label="Kind">
              {CONTACT_KINDS.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.name}
                </option>
              ))}
            </select>
            <input
              type={spec.input}
              value={d.value}
              placeholder={spec.placeholder}
              onChange={(e) => set(i, { value: e.target.value })}
              aria-label={spec.name}
            />
            <input
              className="contact-label"
              value={d.label}
              maxLength={60}
              placeholder="label (Office, Mobile…)"
              onChange={(e) => set(i, { label: e.target.value })}
              aria-label="Label"
            />
            <button type="button" className="rule-remove-line" onClick={() => onChange(drafts.filter((_, j) => j !== i))} aria-label="Remove">
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="link-button"
        onClick={() => onChange([...drafts, { kind: drafts.length === 0 ? "phone" : "email", value: "", label: "" }])}
      >
        + phone, email, website or address
      </button>
    </fieldset>
  );
}

/** One contact as a button that does the obvious thing (call, email, open). */
function ContactAction({ contact }: { contact: OwnerContact }) {
  const plugin = pluginFor(contact.kind);
  const [primary] = plugin.actions(contact.data, contact.label ?? "");
  if (!primary) return null;
  const verb = contact.kind === "phone" ? "Call" : contact.kind === "email" ? "Email" : contact.kind === "place" ? "Map" : "Website";
  return (
    <a
      className="contact-action"
      href={primary.href}
      target={primary.newTab ? "_blank" : undefined}
      rel={primary.newTab ? "noreferrer" : undefined}
      title={`${verb}: ${plugin.summary(contact.data)}${contact.label ? ` (${contact.label})` : ""}`}
    >
      <span aria-hidden="true">{plugin.icon}</span> {contact.label || verb}
    </a>
  );
}

/** The drawer: ways to reach this task's owners (only those with any). */
export function TaskOwnerContacts({ task }: { task: Task }) {
  const ownersById = useBoardStore((s) => s.ownersById);
  const reachable = task.owner_ids
    .map((id) => ownersById[id])
    .filter((o) => o && !o.archived && (o.contacts?.length ?? 0) > 0);
  if (!reachable.length) return null;
  return (
    <section className="owner-contacts" aria-label="Contact the owners">
      {reachable.map((o) => (
        <div key={o.id} className="owner-contact-line">
          <OwnerBadge owner={o} size="sm" />
          <span className="owner-contact-name">{o.name}</span>
          <span className="owner-contact-actions">
            {o.contacts!.map((c, i) => (
              <ContactAction key={i} contact={c} />
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}

const VERB: Record<OwnerContact["kind"], string> = { phone: "Call", email: "Email", link: "Open website", place: "Map" };

/** One-tap icons for an owner's contacts (call, email, website, map), for
 * the owner popup on cards: the name toggles ownership, these reach them. */
export function QuickContacts({ owner }: { owner: { name: string; contacts?: OwnerContact[] } }) {
  const contacts = (owner.contacts ?? []).slice(0, 4);
  if (!contacts.length) return null;
  return (
    <span className="quick-contacts">
      {contacts.map((c, i) => {
        const plugin = pluginFor(c.kind);
        const [primary] = plugin.actions(c.data, c.label ?? "");
        if (!primary) return null;
        const what = `${VERB[c.kind]} ${owner.name}${c.label ? ` (${c.label})` : ""}: ${plugin.summary(c.data)}`;
        return (
          <a
            key={i}
            className="quick-contact"
            href={primary.href}
            target={primary.newTab ? "_blank" : undefined}
            rel={primary.newTab ? "noreferrer" : undefined}
            title={what}
            aria-label={what}
            onClick={(e) => e.stopPropagation()}
          >
            <span aria-hidden="true">{plugin.icon}</span>
          </a>
        );
      })}
    </span>
  );
}
