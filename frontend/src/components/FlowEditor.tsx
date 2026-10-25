import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ApiError, linkTasks, unlinkTasks } from "../api/client";
import { describeNode, useFlow } from "../lib/flow";
import { quote } from "../lib/undo";
import { useBoardStore } from "../store/boardStore";
import type { Task } from "../types";

type Pair = [from: string, to: string];

const META = { actor: "board-user" };

/** Can `goal` be reached from `start` along "blocks" links? */
function reaches(start: string, goal: string): boolean {
  const { tasksById } = useBoardStore.getState();
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of tasksById[id]?.links ?? []) if (l.link_type === "blocks") stack.push(l.to_task_id);
  }
  return false;
}

/** Why `from` can't block `to`, or null if it can. */
function refusal(from: string, to: string): string | null {
  const { tasksById } = useBoardStore.getState();
  if (tasksById[from]?.board_id !== tasksById[to]?.board_id) return "board";
  if (reaches(to, from)) return "loop";
  return null;
}

/** The nearest ancestor that scrolls vertically (the drawer). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === "auto" || y === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

// Touch: press and hold to start linking, like dragging cards on the
// board, so a swipe over the flow still scrolls the drawer.
const HOLD_MS = 250;
const HOLD_TOLERANCE = 8;
const EDGE = 36;
const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

interface DragState {
  id: string;
  x: number;
  y: number;
  /** Moved far enough to be a drag (not a tap). */
  on: boolean;
  /** Mouse: at once. Touch: after the hold. */
  armed: boolean;
  timer?: number;
}

function linkIdOf([from, to]: Pair): string | undefined {
  return useBoardStore
    .getState()
    .tasksById[from]?.links.find((l) => l.link_type === "blocks" && l.to_task_id === to)?.id;
}

/** Remove then add "blocks" links, in that order; returns the undo. */
async function rewire(remove: Pair[], add: Pair[]): Promise<() => Promise<void>> {
  for (const pair of remove) {
    const id = linkIdOf(pair);
    if (id) await unlinkTasks(pair[0], id, META);
  }
  for (const [from, to] of add) await linkTasks(from, to, "blocks", META);
  return async () => {
    await rewire(add, remove);
  };
}

interface Wire {
  from: string;
  to: string;
  d: string;
  live: boolean;
}

/** The drawer's flow: this task's subtasks in stage rows, with arrows
 * for "blocks" links. Drag one subtask onto another to make the first
 * block the second; click an arrow to remove it. */
export function FlowEditor({ task }: { task: Task }) {
  const flow = useFlow(task.id);
  const tasksById = useBoardStore((s) => s.tasksById);
  const lanes = useBoardStore((s) => s.lanes);
  const openDetail = useBoardStore((s) => s.openDetail);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [wires, setWires] = useState<Wire[]>([]);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [temp, setTemp] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; ok: boolean } | null>(null);
  const [holding, setHolding] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const drag = useRef<DragState | null>(null);

  const titleOf = useCallback((id: string) => tasksById[id]?.title ?? "a task elsewhere", [tasksById]);
  const laneOf = (id: string) => lanes.find((l) => l.id === tasksById[id]?.lane_id);

  // Arrows from the bottom of one node to the top of the one it blocks.
  const measure = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const box = canvas.getBoundingClientRect();
    setSize({ width: canvas.scrollWidth, height: canvas.scrollHeight });
    const node = (id: string) => canvas.querySelector<HTMLElement>(`[data-flow-node="${id}"]`);
    setWires(
      flow.links.flatMap(({ from, to }) => {
        const a = node(from)?.getBoundingClientRect();
        const b = node(to)?.getBoundingClientRect();
        if (!a || !b) return [];
        const x1 = a.left + a.width / 2 - box.left;
        const y1 = a.bottom - box.top + canvas.scrollTop;
        const x2 = b.left + b.width / 2 - box.left;
        const y2 = b.top - box.top + canvas.scrollTop - 2;
        const dy = Math.max(14, (y2 - y1) / 2);
        return [{
          from,
          to,
          d: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`,
          live: flow.nodes[from]?.state !== "done",
        }];
      }),
    );
  }, [flow]);

  useLayoutEffect(() => {
    measure();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [measure]);

  // While a touch drag is armed, stop the drawer scrolling under it.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const stop = (e: TouchEvent) => {
      if (drag.current?.armed) e.preventDefault();
    };
    canvas.addEventListener("touchmove", stop, { passive: false });
    return () => canvas.removeEventListener("touchmove", stop);
  }, []);

  function say(text: string, bad = false) {
    setMessage({ text, bad });
  }

  async function run(label: string, remove: Pair[], add: Pair[], done: string) {
    setBusy(true);
    try {
      const undo = await rewire(remove, add);
      say(done);
      useBoardStore.getState().offerUndo(label, undo);
    } catch (e) {
      say((e instanceof ApiError && e.detail) || "Couldn’t change those links.", true);
    } finally {
      setBusy(false);
    }
  }

  function link(from: string, to: string) {
    if (flow.links.some((l) => l.from === from && l.to === to)) {
      say(`${quote(titleOf(from))} already comes before ${quote(titleOf(to))}.`);
      return;
    }
    const why = refusal(from, to);
    if (why === "loop") {
      say(`${quote(titleOf(to))} already comes before ${quote(titleOf(from))}, so that would make a loop.`, true);
      return;
    }
    if (why === "board") {
      say("Those two live on different boards, and links only work within a board for now.", true);
      return;
    }
    run(
      `Linked ${quote(titleOf(from))}`,
      [],
      [[from, to]],
      `${quote(titleOf(from))} now comes before ${quote(titleOf(to))}.`,
    );
  }

  function unlink(from: string, to: string) {
    run(
      "Link removed",
      [[from, to]],
      [],
      `${quote(titleOf(from))} no longer blocks ${quote(titleOf(to))}.`,
    );
  }

  const siblingPairs = (): Pair[] => flow.links.map((l) => [l.from, l.to]);

  function chain() {
    // Finished work first, then the furthest-along lanes; top to bottom.
    const ids = Object.keys(flow.nodes);
    const order = (id: string) => laneOf(id)?.order ?? 0;
    const pos = (id: string) => useBoardStore.getState().taskIdsByLane[tasksById[id].lane_id]?.indexOf(id) ?? 0;
    ids.sort((a, b) => order(b) - order(a) || pos(a) - pos(b));
    const wanted: Pair[] = ids.slice(1).map((id, i) => [ids[i], id]);
    const has = (p: Pair) => flow.links.some((l) => l.from === p[0] && l.to === p[1]);
    const keep = (p: Pair) => wanted.some((w) => w[0] === p[0] && w[1] === p[1]);
    const remove = siblingPairs().filter((p) => !keep(p));
    const add = wanted.filter((p) => !has(p));
    if (!remove.length && !add.length) {
      say("Already chained in board order.");
      return;
    }
    run(
      "Chained in order",
      remove,
      add,
      "Chained in board order: furthest-along first, top to bottom in each lane.",
    );
  }

  function clear() {
    run("Links cleared", siblingPairs(), [], "Links cleared: every subtask runs in parallel.");
  }

  // Drag one node onto another.
  function onPointerDown(e: React.PointerEvent, id: string) {
    if (e.button > 0 || busy) return;
    const mouse = e.pointerType === "mouse";
    const d: DragState = { id, x: e.clientX, y: e.clientY, on: false, armed: mouse };
    if (mouse) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    else
      d.timer = window.setTimeout(() => {
        d.armed = true;
        setHolding(id);
      }, HOLD_MS);
    drag.current = d;
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const canvas = canvasRef.current;
    if (!d || !canvas) return;
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
    if (!d.armed) {
      // A touch that moves before the hold is a scroll, not a drag.
      if (moved > HOLD_TOLERANCE) endDrag();
      return;
    }
    if (!d.on && moved < 6) return;
    d.on = true;
    // Near the drawer's top or bottom edge: scroll it to reach more nodes.
    const scroller = scrollerOf(canvas);
    if (scroller) {
      const r = scroller.getBoundingClientRect();
      if (e.clientY > r.bottom - EDGE) scroller.scrollTop += 12;
      else if (e.clientY < r.top + EDGE) scroller.scrollTop -= 12;
    }
    const box = canvas.getBoundingClientRect();
    const a = canvas.querySelector<HTMLElement>(`[data-flow-node="${d.id}"]`)?.getBoundingClientRect();
    if (!a) return;
    const x1 = a.left + a.width / 2 - box.left;
    const y1 = a.bottom - box.top;
    setTemp(`M${x1},${y1} L${e.clientX - box.left},${e.clientY - box.top}`);
    const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
      ?.closest<HTMLElement>("[data-flow-node]")
      ?.dataset.flowNode;
    setOver(target && target !== d.id ? { id: target, ok: !refusal(d.id, target) } : null);
  }

  function endDrag() {
    const d = drag.current;
    if (d?.timer) window.clearTimeout(d.timer);
    drag.current = null;
    setTemp(null);
    setOver(null);
    setHolding(null);
    return d;
  }

  function onPointerUp(id: string) {
    const target = over;
    const d = endDrag();
    if (!d) return;
    if (!d.on) openDetail(id);
    else if (target) link(d.id, target.id);
  }

  return (
    <section className="flow-editor" aria-labelledby="flow-title">
      <div className="attachments-bar">
        <h3 id="flow-title">Flow</h3>
        <div className="flow-actions">
          <button type="button" className="attach-add" disabled={busy} onClick={chain}
            title="Make each subtask wait for the one before it, in board order">
            Chain in order
          </button>
          {flow.links.length > 0 && (
            <button type="button" className="attach-add" disabled={busy} onClick={clear}>
              Clear links
            </button>
          )}
        </div>
      </div>
      <p className="attachments-empty">
        {TOUCH ? "Press and hold a subtask, then drag it" : "Drag a subtask"} onto another: the first must be
        done before the second. {TOUCH ? "Tap" : "Click"} an arrow to remove it.
      </p>
      <div className="flow-canvas" ref={canvasRef}>
        {flow.stages.map((stage, si) => (
          <div className="flow-col" key={si}>
            <span className="flow-col-head">{si === 0 ? "Start" : "Then"}</span>
            {stage.map((id) => {
              const node = flow.nodes[id];
              const lane = laneOf(id);
              const next = flow.next === id;
              return (
                <div
                  key={id}
                  role="button"
                  tabIndex={0}
                  data-flow-node={id}
                  className={[
                    "flow-node",
                    `flow-${node.state}`,
                    next && "flow-next",
                    over?.id === id && (over.ok ? "is-drop-ok" : "is-drop-bad"),
                    holding === id && "is-holding",
                    drag.current?.on && drag.current.id === id && "is-dragging",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  title={`${titleOf(id)}: ${describeNode(node, next, titleOf)}`}
                  onPointerDown={(e) => onPointerDown(e, id)}
                  onPointerMove={onPointerMove}
                  onPointerUp={() => onPointerUp(id)}
                  onPointerCancel={endDrag}
                  onKeyDown={(e) => e.key === "Enter" && openDetail(id)}
                >
                  {next && <span className="flow-star">★ Next</span>}
                  <span className="flow-node-title">{titleOf(id)}</span>
                  <span className="flow-node-lane">
                    <span className="subtask-dot" style={{ background: lane?.color } as CSSProperties} />
                    {lane?.name}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        <svg className="flow-wires" aria-hidden="true" width={size.width} height={size.height}>
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
              <path className="flow-arrowhead" d="M0,0 L8,4 L0,8 z" />
            </marker>
          </defs>
          {wires.map((w) => (
            <g key={`${w.from}>${w.to}`} className="flow-wire" onClick={() => !busy && unlink(w.from, w.to)}>
              <title>{`${titleOf(w.from)} → ${titleOf(w.to)} (click to remove)`}</title>
              <path className="flow-hit" d={w.d} />
              <path className={`flow-line${w.live ? " is-live" : ""}`} d={w.d} markerEnd="url(#flow-arrow)" />
            </g>
          ))}
          {temp && <path className="flow-temp" d={temp} />}
        </svg>
      </div>
      {message && (
        <p className={`flow-message${message.bad ? " is-bad" : ""}`} aria-live="polite">
          {message.text}
        </p>
      )}
    </section>
  );
}
