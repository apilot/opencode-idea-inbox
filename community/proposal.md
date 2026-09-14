# Community proposal draft

Post this to <https://github.com/awesome-opencode/awesome-opencode/discussions>
(category: plugin proposals / showcase) before or alongside the YAML PR.

---

**Title:** Plugin proposal: opencode-idea-inbox — a persistent idea backlog with native TUI dispatch

**Body:**

## The problem

During a long session you constantly get stray thoughts — "it would be nice to also add caching here", "the tests for that module need a rerun" — but acting on them immediately breaks your focus, and writing them into a file means they are never seen again. Native todos are agent-managed and per-session; there is no user-owned backlog that lives in the TUI, survives restarts, and can be dispatched when you are ready.

## What it does

`opencode-idea-inbox` adds a capture → park → dispatch loop to the TUI:

- **Capture** — `/idea <text>` or the `✚ New idea…` palette entry; one turn, you stay in your current task
- **Park** — ideas live in a per-worktree SQLite backlog, shown in the `Idea Inbox` sidebar slot with live statuses (`○ pending`, `◐ in_progress`, `● done`, `✓ documented`)
- **Dispatch** — `Ctrl+X → I` opens the command palette with pending ideas first in Suggested; picking one injects a delegation mission ("delegate this task, use the right skills, mark it in_progress now and done when finished") into the main window and execution starts immediately. `/ideas start <id>` runs an idea in a background session instead

Statuses are set by the agent itself via the `idea_update` tool (with a `session.idle` safety net), so the sidebar always reflects reality.

## Why palette instead of a dialog

opencode 1.18.30 has an upstream issue where dialogs opened from TUI plugins do not receive keyboard input. The plugin is therefore built entirely on supported primitives: keymap command layers (ideas registered first in Suggested), prompt injection via `tui.appendPrompt`/`submitPrompt`, and the `sidebar_content` slot. No dialogs, no hacks — and the UX still feels native: one hotkey, one Enter.

## Compatibility

- opencode 1.18.30 (verified end-to-end); no runtime dependencies
- MIT license; English and Russian READMEs

Repository: <https://github.com/apilot/opencode-idea-inbox>

Happy to hear feedback on the UX and the status semantics — in particular whether `documented` (auto-hide from the panel, keep in DB history) matches how others would expect a backlog to behave.
