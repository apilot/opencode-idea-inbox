# Reddit r/opencode — черновик поста

Куда: https://www.reddit.com/r/opencode/ (проверено: там постят плагины
в формате «I built a plugin...»).

Title:

> I built a plugin so stray thoughts stop derailing my AI coding sessions

Body:

---

You're twenty minutes deep in a refactor when a completely unrelated thought
shows up: *"I should really try caching provider responses."*

Three traditional outcomes: type it into the chat and derail the agent, switch
to a notes app and lose your terminal, or tell yourself you'll remember it
later (you won't).

So I built a fourth option — **idea-inbox**, a sidebar backlog that lives
inside opencode:

- `leader+z` — quick capture. The thought is parked instantly, no model
  round-trip, you never left your task
- `leader+i` — pick an idea, it gets dispatched to an agent as a mission
- watch the sidebar: `○ parked → ◐ running → ● done`
- agents manage the backlog themselves via tools (list, update status,
  document results)

Install (opencode v2 ≥ 2.0.20):

```jsonc
{ "plugins": ["opencode-idea-inbox"] }
```

npm: https://www.npmjs.com/package/opencode-idea-inbox
GitHub: https://github.com/apilot/opencode-idea-inbox

The whole loop: https://raw.githubusercontent.com/apilot/opencode-idea-inbox/master/assets/demo.gif

Curious whether this scratches an itch for anyone else — feedback welcome,
especially on the capture flow.

---

**Чек-лист:**
- [ ] Постить во вторник–четверг, утро US (лучший охват)
- [ ] Не постить одновременно с r/opencodeCLI — разнести на 2–3 дня
- [ ] Ответить на комментарии от автора, тон — разговорный
