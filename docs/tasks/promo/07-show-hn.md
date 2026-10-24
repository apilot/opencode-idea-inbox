# Show HN — заготовка (этап 3, опционально)

Постить только если есть настроение отвечать на комментарии несколько часов.
Лучшее время: будний день 8–10 утра US Eastern.

Title (строго факты, без маркетинга):

> Show HN: Idea Inbox – a sidebar backlog for stray thoughts in a terminal AI agent

Text:

---

I kept losing good ideas mid-task: type them into the AI coding agent chat and
derail it, or switch to a notes app and never come back.

idea-inbox is an npm plugin for opencode (terminal AI coding agent) that adds
a backlog panel to the sidebar: leader+z captures a thought (direct write, no
model call), leader+i later dispatches any idea to an agent as a delegation
mission. The status ticks over in the sidebar: parked → running → done, and
the agent itself marks ideas documented when it writes the results down.
Agents can also read and update the backlog through tools.

One JSON line to install: `"plugins": ["opencode-idea-inbox"]`
(opencode v2 ≥ 2.0.20; separate legacy-v1 line for opencode v1).

GitHub: https://github.com/apilot/opencode-idea-inbox
npm: https://www.npmjs.com/package/opencode-idea-inbox

Happy to answer questions about the plugin architecture (server half + TUI
half in one package) and the delegation flow.

---

**Чек-лист:**
- [ ] Не постить в один день с Reddit/X
- [ ] Заголовок без превосходных степеней — HN это наказывает
