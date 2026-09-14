import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import * as store from "../store.js"
import { trim, type Idea } from "../types.js"

const LIMIT = 60
const POLL_MS = 2000
const PALETTE = "command.palette.show"

/**
 * Команды TUI idea-inbox (концепция v2: нативный выбор из бэклога).
 *
 * Диалоги, открытые внешним TUI-плагином, в 1.18.30 не получают клавиатурный
 * ввод (upstream-баг), поэтому «модалкой» выбора служит нативная палитра
 * команд: Ctrl+X → I программно открывает её (dispatchCommand), а каждая
 * pending-идея — отдельная команда с suggested:true (первой строкой списка).
 *
 * Выбор идеи подаёт миссию оркестратору в основное окно через
 * tui.appendPrompt + submitPrompt (SDK v2; сервер сам адресует её текущему
 * инпуту — id сессии плагину не нужен: api.route в 1.18.30 статичен, а слот
 * session_prompt не рендерится для плагинов). Статусы ставит сам агент по
 * инструкции миссии: idea_update in_progress в начале, done по завершении.
 *
 * Ограничение @opentui/keymap: структурный re-entry не поддерживается —
 * перерегистрация слоя (sync) только вне dispatch-контекста (poll-тик или
 * setTimeout-дефер).
 */
export function register(api: TuiPluginApi, root: () => string | undefined): () => void {
  let layer: (() => void) | undefined
  // undefined = синхронизация ещё не выполнялась. Пустая строка — валидная
  // сигнатура пустого бэклога: если бы начальный stamp был "", первый tick
  // с пустым бэклогом выходил бы ранним возвратом и слой с биндингом
  // <leader>i никогда не регистрировался (наблюдалось вживую).
  let stamp: string | undefined

  const signature = (ideas: Idea[]): string =>
    ideas
      .filter((idea) => idea.status === "pending")
      .map((idea) => `${idea.id}:${idea.text}`)
      .join("|")

  const mission = (idea: Idea): string =>
    [
      idea.text,
      "",
      `Сначала вызови тул idea_update с id=${idea.id} и status=in_progress — отметит идею «в работе» в бэклоге.`,
      "Затем делегируй выполнение подходящему сабагенту (task tool), используй нужные скилы. Если задачу проще выполнить самому — сделай сам.",
      `По завершении вызови тул idea_update с id=${idea.id} и status=done — отметит идею выполненной.`,
    ].join("\n")

  const take = (idea: Idea): void => {
    api.client.tui
      .appendPrompt({ text: mission(idea) })
      .then(() => api.client.tui.submitPrompt())
      .catch(() => {
        api.ui.toast({ title: "idea-inbox", message: "Не удалось отправить промт — попробуйте ещё раз", variant: "error" })
      })
    api.ui.toast({ title: "idea-inbox", message: `▶ ${idea.id} — отправлено в основное окно`, variant: "info" })
  }

  // Порядок = порядку в Suggested-секции палитры: сначала идеи (Enter на
  // первой — запуск), затем «новая идея», открывалка — последней.
  const build = (ideas: Idea[]) => [
    ...ideas
      .filter((idea) => idea.status === "pending")
      .map((idea) => ({
        namespace: "palette",
        name: `idea-inbox:take:${idea.id}`,
        title: `▸ ${trim(idea.text, LIMIT)}`,
        desc: `idea-inbox: взять в работу (${idea.id})`,
        category: "Idea Inbox",
        suggested: true,
        run: () => take(idea),
      })),
    {
      namespace: "palette",
      name: "idea-inbox:new",
      title: "✚ Новая идея…",
      desc: "idea-inbox: подставить /idea в строку промпта",
      category: "Idea Inbox",
      suggested: true,
      run: () => {
        void api.client.tui.appendPrompt({ text: "/idea " }).catch(() => {
          api.ui.toast({ title: "idea-inbox", message: "Наберите /idea <мысль>", variant: "info" })
        })
      },
    },
    {
      namespace: "palette",
      name: "idea-inbox:open",
      title: "Idea Inbox: открыть список",
      desc: "Палитра выбора идеи из бэклога",
      category: "Idea Inbox",
      suggested: true,
      run: () => {
        // setTimeout(0): выходим из dispatch-стека — структурные операции
        // (sync) во время dispatch не поддерживаются @opentui/keymap.
        setTimeout(() => {
          tick()
          api.keymap.dispatchCommand(PALETTE)
        }, 0)
      },
    },
  ]

  const sync = (ideas: Idea[]): void => {
    layer?.()
    layer = api.keymap.registerLayer({
      // Палитра (Suggested) перечисляет команды в порядке state.sortedLayers:
      // compareLayers = priority DESC, затем order ASC. Слой перерегистрируется
      // при каждом изменении набора идей и получает максимальный order — без
      // повышенного priority он опускался бы в конец списка. Приоритет держит
      // наши идеи первыми в Suggested всегда.
      priority: 100,
      commands: build(ideas),
      bindings: [{ key: "<leader>i", cmd: "idea-inbox:open" }],
    })
  }

  const tick = (): void => {
    const worktree = root()
    if (worktree === undefined) return
    try {
      const ideas = store.active(worktree)
      const next = signature(ideas)
      if (stamp !== undefined && next === stamp) return
      stamp = next
      sync(ideas)
    } catch {
      // БД недоступна — слой остаётся прежним
    }
  }

  tick()
  const timer = setInterval(tick, POLL_MS)

  return () => {
    clearInterval(timer)
    layer?.()
  }
}
