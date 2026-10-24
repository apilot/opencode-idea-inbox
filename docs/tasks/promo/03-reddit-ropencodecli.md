# Reddit r/opencodeCLI — короткий вариант

Куда: https://www.reddit.com/r/opencodeCLI/ — постить через 2–3 дня после
r/opencode. Текст короче, аудитория шире (не только opencode-специфика).

Title:

> idea-inbox: park stray thoughts in a sidebar, dispatch them to your AI agent later

Body:

---

Made a plugin for opencode that solves a small but constant annoyance: random
thoughts showing up mid-task.

`leader+z` parks the thought in a sidebar backlog (direct write, no model
call). Later, `leader+i` dispatches any of them to an agent as a mission —
you watch the status go `○ parked → ◐ running → ● done` right in the sidebar.
Agents can also read and update the backlog via tools.

One line to install on opencode v2:

```jsonc
{ "plugins": ["opencode-idea-inbox"] }
```

Demo GIF: https://raw.githubusercontent.com/apilot/opencode-idea-inbox/master/assets/demo.gif
npm: https://www.npmjs.com/package/opencode-idea-inbox

---

**Чек-лист:**
- [ ] Проверить правила сабреддита (self-promo)
- [ ] Разнести с r/opencode на 2–3 дня
