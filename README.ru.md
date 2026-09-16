# opencode-idea-inbox

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![opencode](https://img.shields.io/badge/opencode-%E2%89%A51.18.31-blue)](https://opencode.ai)

[English](./README.md) | **Русский**

Плагин для [opencode](https://opencode.ai): постоянный бэклог идей прямо в TUI.
Захватите мысль по ходу диалога, не теряя фокуса, наблюдайте за ней в сайдбаре,
а затем отправьте в работу из палитры команд — в текущее окно или в фоновую сессию.

```text
в диалоге ──/idea "добавить кэш"──▶ ○ pending ──палитра: Ctrl+X → I──▶ ◐ in_progress ──▶ ● done ──▶ ✓ архив
```

## Возможности

- **Захват без трения** — `/idea <текст>`, пункт `✚ Новая идея…` в палитре или `Ctrl+X → Z` (`<leader>z`, модальный ввод без модели — пишет сразу в бэклог); вы остаётесь в текущей задаче
- **Панель в сайдбаре** — живой слот `Idea Inbox (n)` с глифами статусов `○ ◐ ● ✓`, обновление каждые 2 секунды
- **Нативный запуск из палитры** — `Ctrl+X → I` открывает палитру с pending-идеями первыми в Suggested; выбор идеи подаёт миссию оркестратору в основное окно, и выполнение начинается сразу
- **Режим удаления и очистка** — наводите порядок из палитры: `🗑 Удалить идею…` удаляет по одной, `✖ Очистить список` сносит все активные (архив `documented` не трогается)
- **Статусы ставит агент** — оркестратор помечает идею `in_progress` при запуске и `done` по завершении (тул `idea_update`), со страховкой по `session.idle`
- **Фоновая альтернатива** — `/ideas start <id>` выполняет идею в отдельной сессии с агентом `build`
- **Персистентность** — SQLite (WAL) на worktree, переживает рестарты; заархивированные идеи остаются в истории

## Требования

- opencode **1.18.31** или новее (API плагинов: `keymap.registerLayer`, `dispatchCommand`, слоты сайдбара, `tui.appendPrompt`/`submitPrompt`; модальный захват `Ctrl+X → Z` требует 1.18.31 — на 1.18.30 диалоги плагинов не получают Enter)
- Рантайм-зависимости (`@opencode-ai/*`, `@opentui/*`, `solid-js`) ставятся автоматически вместе с npm-пакетом

## Установка

Добавьте плагин в `~/.config/opencode/opencode.json` (или в `opencode.json` проекта):

```json
{
  "plugin": [
    "opencode-idea-inbox"
  ]
}
```

Добавьте TUI-часть в `~/.config/opencode/tui.json` — то же голое имя, без subpath:

```json
{
  "plugin": [
    "opencode-idea-inbox"
  ]
}
```

opencode установит пакет из npm при следующем старте. Слэш-команды лоадером не
поставляются — скопируйте два markdown-файла вручную:

```bash
mkdir -p ~/.config/opencode/command
curl -fsSL -o ~/.config/opencode/command/idea.md https://raw.githubusercontent.com/apilot/opencode-idea-inbox/master/commands/idea.md
curl -fsSL -o ~/.config/opencode/command/ideas.md https://raw.githubusercontent.com/apilot/opencode-idea-inbox/master/commands/ideas.md
```

<details>
<summary>Установка из локального клона (для разработки)</summary>

```bash
git clone https://github.com/apilot/opencode-idea-inbox.git ~/opencode-idea-inbox
```

```json
{ "plugin": ["file:///home/YOU/opencode-idea-inbox"] }
```

```json
{ "plugin": ["file:///home/YOU/opencode-idea-inbox/tui"] }
```

```bash
cp ~/opencode-idea-inbox/commands/*.md ~/.config/opencode/command/
```

</details>

Добавьте `.opencode/idea-inbox/` в `.gitignore` проекта (там живёт база SQLite).

Перезапустите opencode — конфиг не перечитывается на лету.

## Быстрый старт

1. Наберите `/idea добавить кэш ответов провайдера` — агент зафиксирует: `✓ idea_ab12cd — добавить кэш…`
2. Нажмите `Ctrl+X → I` — откроется палитра, pending-идеи первыми в Suggested
3. Нажмите `Enter` на идее — в основное окно уйдёт миссия («делегируй выполнение, используй нужные скилы…»), выполнение начнётся сразу, идея станет `◐`
4. Следите за сайдбаром (`Ctrl+X → B` — переключить): `○ → ◐ → ●` по мере работы
5. Завершив, оркестратор пометит идеу `● done`; задокументируйте результат `/ideas documented <id>` — строка уйдёт из панели

## Использование

### Клавиатура

| Действие | Привязка |
| -------- | -------- |
| Открыть палитру с бэклогом | `Ctrl+X → I` (`<leader>i`; идеи первыми в Suggested, затем `✚ Новая идея…`) |
| Модальный захват без модели | `Ctrl+X → Z` (`<leader>z`) |
| Показать/скрыть сайдбар | `Ctrl+X → B` (`<leader>b`) |

Лидер-ключ по умолчанию `Ctrl+X` (`leader_timeout` 2000 мс — вторую клавишу нажимайте в течение 2 секунд).

### Слэш-команды

| Команда | Действие |
| ------- | -------- |
| `/idea <текст>` | Зафиксировать идею в бэклоге |
| `/ideas` | Показать таблицу активного бэклога |
| `/ideas run <id>` | Выполнить идею в текущей сессии |
| `/ideas start <id>` | Запустить идею в фоновой сессии (агент `build`) |
| `/ideas done <id>` · `/ideas documented <id>` | Сменить статус; `documented` архивирует строку |

### Тулы агента

| Тул | Назначение |
| --- | ---------- |
| `idea_add` | Добавить идею из контекста диалога |
| `idea_list` | Список активных (или отфильтрованных) идей |
| `idea_update` | Сменить статус/текст; `documented` скрывает из панели |
| `idea_start` | Создать фоновую сессию с промптом-миссией |

### Статусы

| Статус | Глиф | Смысл | Кто ставит |
| ------ | ---- | ----- | ---------- |
| `pending` | `○` | Зафиксирована, ждёт отправки | Пользователь (захват), сервер (откат) |
| `in_progress` | `◐` | Выполняется в текущей или фоновой сессии | Оркестратор (миссия `idea_update`) или `idea_start` |
| `done` | `●` | Выполнена — оркестратор отчитался о завершении | Оркестратор (`idea_update`) или `session.idle` |
| `documented` | `✓` | Результат задокументирован → скрыта из панели, остаётся в БД | Рабочий агент или пользователь |

## Как это устроено

```mermaid
flowchart LR
    U[Пользователь] -- "/idea текст" --> AG[Агент]
    AG -- "idea_add" --> DB[(ideas.db SQLite)]
    U -- "Ctrl+X → I" --> PAL[Палитра команд]
    PAL -- "выбор идеи" --> INP[Главный инпут]
    INP -- "appendPrompt + submitPrompt" --> AG
    AG -- "idea_update in_progress / done" --> DB
    DB --> SB[Сайдбар Idea Inbox]
```

Путь через палитру обходит известную проблему upstream: в opencode ≤ 1.18.30
диалоги, открытые из TUI-плагинов, не получают клавиатурный ввод
([#22610](https://github.com/sst/opencode/issues/22610), закрыт как not planned).
На 1.18.31 Enter в `DialogPrompt` работает — на этом построен модальный захват
`Ctrl+X → Z`; всё остальное ездит на командах палитры, инъекции промта и слоте сайдбара.

## Ограничения

- Специфика opencode 1.18.31: поле поиска программно открытой палитры может не принимать клавиши — основной интерфейс список Suggested (идеи всегда регистрируются первыми)
- Сайдбар не открывается автоматически при появлении контента плагина (режим `auto` завязан на нативные todos) — включите один раз через `Ctrl+X → B`
- В палитру попадают только `pending`-идеи

## Разработка

```bash
bun install
bun run typecheck   # tsc --noEmit
bun test            # юнит-тесты стора
```

Структура исходников: `src/store.ts` (SQLite-ядро), `src/server/` (тулы + события сессий), `src/tui/` (команды палитры, слот сайдбара, резолвер worktree), `commands/` (markdown-команды).

## Участие

Issues и PR приветствуются: <https://github.com/apilot/opencode-idea-inbox>.

## Лицензия

[MIT](./LICENSE)
