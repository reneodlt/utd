import { Extension, InputRule } from "@tiptap/core";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Placeholder } from "@tiptap/extensions";
import { Markdown } from "@tiptap/markdown";
import { EditorContent, useEditor, useEditorState, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef, useState } from "react";
import { ApiError, setTaskDescription } from "../api/client";
import { newOpId } from "../lib/compat";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";

/* Loaded on demand (React.lazy) the first time details are edited: the
   editor is most of the app's weight. */

type Mode = "rich" | "markdown";

/** Typing "[ ] " or "[x] " at the start of a bullet turns the list into a
 * checklist — so "- [ ] " works as in Markdown ("- " makes the bullet
 * first, which the stock task-list rule doesn't expect). */
const BulletToChecklist = Extension.create({
  name: "bulletToChecklist",
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ state, range, match, chain }) => {
          const $from = state.doc.resolve(range.from);
          const inBullet = Array.from({ length: $from.depth + 1 }, (_, d) => $from.node(d).type.name)
            .includes("bulletList");
          if (!inBullet) return null;
          const checked = (match[1] ?? "").toLowerCase() === "x";
          chain()
            .deleteRange(range)
            .toggleTaskList()
            .updateAttributes("taskItem", { checked })
            .run();
        },
      }),
    ];
  },
});

async function save(taskId: string, description: string): Promise<string | null> {
  const store = useBoardStore.getState();
  const opId = newOpId();
  store.registerOp(opId);
  try {
    const updated = await setTaskDescription(taskId, description, { op_id: opId, actor: "board-user" });
    useBoardStore.getState().upsertTask(updated);
    return null;
  } catch (e) {
    useBoardStore.getState().resolveOp(opId);
    return (e instanceof ApiError && e.detail) || "Couldn’t save the details.";
  }
}

export default function DetailsEditor({ task, onDone }: { task: Task; onDone: () => void }) {
  const [mode, setMode] = useState<Mode>("rich");
  const [source, setSource] = useState(task.description);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const original = useRef(task.description);
  const done = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false, autolink: true } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      BulletToChecklist,
      Placeholder.configure({ placeholder: "Notes, checklists, links… (Markdown works too)" }),
      Markdown,
    ],
    content: task.description,
    contentType: "markdown",
    autofocus: "end",
    editorProps: { attributes: { class: "prose details-editor", "aria-label": "Details" } },
  });

  /** The Markdown as it stands, whichever mode is showing. */
  const current = () => (mode === "markdown" ? source : editor?.getMarkdown() ?? source);

  function switchTo(next: Mode) {
    if (next === mode || !editor) return;
    if (next === "markdown") setSource(editor.getMarkdown());
    else editor.commands.setContent(source, { contentType: "markdown" });
    setMode(next);
  }

  async function finish(keep: boolean) {
    const markdown = current().replace(/\s+$/, "");
    done.current = true;
    if (!keep || markdown === original.current.replace(/\s+$/, "")) {
      onDone();
      return;
    }
    setSaving(true);
    const failed = await save(task.id, markdown);
    setSaving(false);
    if (failed) {
      done.current = false;
      setError(failed);
    } else {
      onDone();
    }
  }

  // Closing the drawer mid-edit keeps the work: save what's there.
  const latest = useRef(current);
  latest.current = current;
  useEffect(
    () => () => {
      if (done.current) return;
      const markdown = latest.current().replace(/\s+$/, "");
      if (markdown !== original.current.replace(/\s+$/, "")) save(task.id, markdown);
    },
    [task.id],
  );

  return (
    <section
      className="details is-editing"
      aria-label="Edit details"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation(); // don't also close the drawer
          finish(false);
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(true);
        }
      }}
    >
      <div className="details-bar">
        {mode === "rich" && editor ? <Toolbar editor={editor} /> : <span className="details-hint">Markdown source</span>}
        <div className="segmented details-mode" role="group" aria-label="Editor">
          <button type="button" aria-pressed={mode === "rich"} onClick={() => switchTo("rich")}>
            Rich
          </button>
          <button type="button" aria-pressed={mode === "markdown"} onClick={() => switchTo("markdown")}>
            Markdown
          </button>
        </div>
      </div>

      {/* The rich editor stays mounted while the source shows: Tiptap
          ignores content changes on an editor that isn't attached. */}
      <div hidden={mode !== "rich"}>
        <EditorContent editor={editor} />
      </div>
      {mode === "markdown" && (
        <textarea
          className="details-source"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          autoFocus
          spellCheck
          aria-label="Details as Markdown"
          placeholder={"# Heading\n- [ ] a checklist item\n**bold**, _italic_, [a link](https://…)"}
        />
      )}

      {error && <p className="attach-error" role="alert">{error}</p>}
      <div className="attach-form-buttons">
        <span className="details-keys">⌘↵ save · Esc cancel</span>
        <button type="button" onClick={() => finish(false)}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={saving} onClick={() => finish(true)}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </section>
  );
}

const TOOLS: {
  label: string;
  title: string;
  active: (e: Editor) => boolean;
  run: (e: Editor) => void;
}[] = [
  { label: "B", title: "Bold", active: (e) => e.isActive("bold"), run: (e) => e.chain().focus().toggleBold().run() },
  { label: "I", title: "Italic", active: (e) => e.isActive("italic"), run: (e) => e.chain().focus().toggleItalic().run() },
  { label: "S", title: "Strikethrough", active: (e) => e.isActive("strike"), run: (e) => e.chain().focus().toggleStrike().run() },
  { label: "H", title: "Heading", active: (e) => e.isActive("heading"), run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { label: "•", title: "Bulleted list", active: (e) => e.isActive("bulletList"), run: (e) => e.chain().focus().toggleBulletList().run() },
  { label: "1.", title: "Numbered list", active: (e) => e.isActive("orderedList"), run: (e) => e.chain().focus().toggleOrderedList().run() },
  { label: "☑", title: "Checklist", active: (e) => e.isActive("taskList"), run: (e) => e.chain().focus().toggleTaskList().run() },
  { label: "❝", title: "Quote", active: (e) => e.isActive("blockquote"), run: (e) => e.chain().focus().toggleBlockquote().run() },
  { label: "</>", title: "Code", active: (e) => e.isActive("codeBlock"), run: (e) => e.chain().focus().toggleCodeBlock().run() },
  {
    label: "🔗",
    title: "Link",
    active: (e) => e.isActive("link"),
    run: (e) => {
      if (e.isActive("link")) {
        e.chain().focus().unsetLink().run();
        return;
      }
      const url = window.prompt("Link to", "https://");
      if (url && url !== "https://") e.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
    },
  },
];

function Toolbar({ editor }: { editor: Editor }) {
  // Re-render on selection changes so active states follow the cursor.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => TOOLS.map((t) => t.active(e)),
  });
  return (
    <div className="details-tools" role="toolbar" aria-label="Formatting">
      {TOOLS.map((tool, i) => (
        <button
          key={tool.title}
          type="button"
          title={tool.title}
          aria-label={tool.title}
          aria-pressed={active[i]}
          // Keep the editor's selection: don't take focus on press.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => tool.run(editor)}
        >
          {tool.label}
        </button>
      ))}
    </div>
  );
}
