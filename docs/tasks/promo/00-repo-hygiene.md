# Этап 0 — гигиена точки входа

Сейчас на https://github.com/apilot/opencode-idea-inbox пустые description,
homepage и topics — страница репо не продаёт плагин и не находится по топикам.

Команды (нужно одобрение, выполняю через gh):

```bash
gh api --method PATCH repos/apilot/opencode-idea-inbox \
  -f description="Sidebar idea backlog for opencode: park stray thoughts (leader+z), dispatch them to agents as missions (leader+i)" \
  -f homepage="https://www.npmjs.com/package/opencode-idea-inbox"

gh api --method PUT repos/apilot/opencode-idea-inbox/topics \
  -f names[]="opencode" -f names[]="opencode-plugin" -f names[]="tui" \
  -f names[]="productivity" -f names[]="backlog" -f names[]="ai-agents"
```

Дополнительно проверить:

- [ ] assets/demo.png и demo.gif соответствуют текущему UI 0.6.1
  (multi-select delete, leader+i hub появились в 0.5.12)
- [ ] shield-бейджи в README кликабельны и ведут куда надо

## Почему это до постов

Каждый пост ведёт на репо. Первое, что видит человек — шапка репо.
Пустое description в поиске GitHub и в unfurl-превью ссылки выглядит мертво.
