# Task-management mechanisms: research catalogue & UTD roadmap

Research pass over kanban method theory, Trello/Butler, Linear, GTD tools
(Todoist, Things 3), Amazing Marvin, and Habitica — distilled into mechanisms
UTD could adopt, ranked by fit with our architecture (websocket-first,
immutable audit trail, animation catalogue, task graph).

## Shipped (see git history)

| Mechanism | Origin | UTD implementation |
|---|---|---|
| **WIP limits** | Kanban method | Per-lane `wip_limit`, soft: count turns red |
| **Card aging** | Kanban "aging WIP" / Trello aging power-up | Cards tint amber (default >3d) then red (>7d) in non-final lanes, driven by `lane_entered_at`; thresholds per board via `metadata.aging = {stale_hours, old_hours}` |
| **Blocked chains + unblock ripple** | Jira issue links, kanban blocked escalation | `blocks` links; blocking is *flow-aware* (a blocker in the final lane or archived stops blocking). When a blocker crosses the final-lane boundary, every task whose state flips gets an audited `task.updated` broadcast — pulse on unblock, alarm on re-block, ticker says "unblocked" |
| **Flow analytics** | Kanban flow metrics (cycle time, throughput) | `GET /api/boards/{id}/analytics/` computed from the audit trail: cycle-time p50/p85/avg, 7d/30d throughput, per-lane average residency. Header chip shows `cycle p50 / p85 · n done/7d`; hover for per-lane residency |
| **Subtask containment rule** | Jira parent/subtask discipline | Parent can never sit right of its children; violations flash the blockers |
| **Automation rules engine** | Trello Butler, Linear Triage | `AutomationRule` per board: trigger `{event, to_lane?, from_lane?, source?, actor?, title_contains?}` → actions `set_animation` (default flourish; explicit caller animation wins), `create_subtask` (deduped while active), `move_task`. Evaluated in `services._record()` so every mutation path hits them; actions run back through services as `actor="rule:<name>", source=system` — automation is itself audited and broadcast. Rule-caused events don't re-trigger rules, plus a depth cap. Configured via Django admin; demo board ships `celebrate-done` and `review-checklist` |
| **Playable media attachments** | Audio-review workflows (pick the take from the card, no download) | `file` attachments of audio/video are sniffed from the bytes (`uploads.py`: per-class limits 20/100 MB, optional ffprobe duration and ffmpeg poster in `data`), served with HTTP Range from `/api/files/<id>/`, and play inline in the drawer and log (`MediaRows.tsx`; one clip at a time via `lib/mediaPlayer.ts`). Editable `label` ("chosen", "runner-up") goes through `services.update_attachment`, so it is audited and broadcast |

The mechanisms **compose**: `review-checklist` auto-creates a subtask when a
task enters Review, and the subtask-containment rule then blocks the parent
from reaching Done until the checklist is finished — a Definition-of-Done
gate that emerged from two orthogonal features (verified in e2e).

Rules engine next steps: `webhook_out` and `add_link` actions, a
`wip_age_exceeds` trigger fed by analytics (auto-expedite), and a rules API +
UI (admin-only today).

## Worth stealing, ordered by leverage

1. **Classes of service** (Kanban method): `expedite / fixed-date / standard`
   on Task.metadata. Expedite renders as a glowing card pinned to lane top and
   is exempt from WIP counts; fixed-date shows a countdown. Pairs perfectly
   with the animation catalogue ("alarm" as a date approaches).
2. **Defer / snooze ("tickler")** (Things 3, GTD): `deferred_until` hides a
   card until a date, then it *animates back in* via websocket — a scheduled
   job is the natural first use of a `system` actor cron.
3. **Aging → auto-escalate** (Businessmap/Kanbanize): when WIP age passes the
   board's p50 cycle time (we already compute it!), auto-set expedite class.
   Analytics feeding automation — no other tool of this size does this.
4. **Recurring tasks** (Todoist): recurrence rule on a template task;
   completion (arrival in final lane) spawns the next instance. Needs the
   scheduler from (2).
5. **Procrastination count** (Amazing Marvin): we can *derive* it from audit —
   count of times a task re-entered lane 0 or was reordered down. Surface as
   a shame-badge (configurable — it's a personal-mode feature).
6. **Triage lane** (Linear): tasks created by external systems (`source=api`)
   land in a designated triage lane unless the rule engine routes them.
7. **SLAs** (Linear): per-lane max residency; breach fires the rules engine
   (flash, escalate, webhook out).
8. **Weekly review mode** (GTD): a modal sweep through stale + blocked +
   someday cards, one at a time — keep/move/archive. Marvin's "super focus"
   single-task presentation is the right UI shape.
9. **Streaks & rewards** (Habitica): celebrate animation is already the hook;
   a streak counter on throughput ("5 tasks shipped this week — best streak")
   in the header would gamify gently without the RPG cosplay.
10. **Cycles** (Linear): time-boxed groupings with auto-rollover of unfinished
    work. Big feature; needs multi-board/views work first.

## Deliberately rejected

- **Hard WIP enforcement** (rejecting moves over the limit) — the research is
  clear WIP limits work as social signals; a hard block fights the
  websocket-first "external systems act on the board" premise.
- **Habitica-style XP/HP economy** — fun, but it inverts the tool's center of
  gravity; a streak stat gets 80% of the value.
- **Lexorank ordering** — revisited and re-rejected; single-writer service
  layer makes float midpoint + rebalance strictly simpler.

## Sources

- [Kanban University — Official Kanban Guide](https://kanban.university/kanban-guide/)
- [Scrum.org — Classes of Service in Kanban](https://www.scrum.org/resources/blog/classes-service-kanban-what-are-they)
- [Kanban Zone — Aging Work in Progress](https://kanbanzone.com/2019/aging-work-in-progress/)
- [Businessmap — Kanban swimlanes](https://businessmap.io/kanban-resources/kanban-software/kanban-swimlanes)
- [Atlassian — Butler workflow automation](https://blog.trello.com/butler-power-up-trello-automation) · [5 easy Butler rules](https://blog.trello.com/five-easy-butler-rules)
- [Linear docs — Triage](https://linear.app/docs/triage) · [Workflows](https://linear.app/docs/configuring-workflows) · [Auto-archive changelog](https://linear.app/changelog/2021-04-15-auto-archive-cycles-and-projects-and-deleting-issues)
- [Todoist — GTD guide](https://www.todoist.com/productivity-methods/getting-things-done) · [Weekly review](https://www.todoist.com/productivity-methods/weekly-review)
- [Things 3 + GTD walkthrough](https://johnny.chadda.se/getting-things-done-with-things-3/)
- [Amazing Marvin](https://amazingmarvin.com/) · [Procrastination count](https://help.amazingmarvin.com/en/articles/1950154-procrastination-count)
- [Habitica](https://habitica.com/) · [Gamifying your lists](https://habitica.fandom.com/wiki/Gamifying_Your_Lists)
