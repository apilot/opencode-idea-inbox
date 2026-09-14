import { tool } from "@opencode-ai/plugin"
import type { createOpencodeClient } from "@opencode-ai/sdk"
import * as store from "../store.js"
import { glyph, isStatus, trim, type Idea } from "../types.js"

type Client = ReturnType<typeof createOpencodeClient>

const LIMIT = 40
const AGENT = "build"

/** Промпт фоновой сессии: выполнить, задокументировать, закрыть идею. */
function mission(idea: Idea): string {
  return [
    `Выполни пункт бэклога idea-inbox \`${idea.id}\`: «${idea.text}».`,
    ``,
    `Порядок работы:`,
    `1. Полностью выполни задачу.`,
    `2. Задокументируй результат в документации задачи (кратко, по делу).`,
    `3. Вызови тул idea_update с id="${idea.id}" и status="documented".`,
  ].join("\n")
}

/**
 * Тулы idea-inbox для агента.
 *
 * Корень стора передаётся фабрикой и резолвится на каждый вызов:
 * в момент активации плагина путь может быть ещё "/" (глобальный
 * сервер-инстанс до привязки проекта). Клиент нужен idea_start
 * для создания фоновой сессии.
 */
export function create(root: () => string, client: Client) {
  return {
    idea_add: tool({
      description:
        "Зафиксировать идею в бэклоге idea-inbox (сайдбар пользователя). Используй, когда пользователь озвучивает мысль вида «хорошо бы ещё…», которую надо не забыть, но не делать сейчас.",
      args: {
        text: tool.schema.string().describe("Текст идеи, одна строка без переносов"),
      },
      async execute(args) {
        const text = args.text.trim()
        if (text === "") return "Ошибка: пустой текст идеи"

        const worktree = root()
        const idea = store.add(worktree, text)
        return `Идея сохранена: \`${idea.id}\` (○ pending). Активных в бэклоге: ${store.active(worktree).length}.`
      },
    }),

    idea_list: tool({
      description:
        "Показать бэклог idea-inbox. По умолчанию — активные идеи (pending/in_progress/done); параметр status фильтрует по одному статусу (documented — архив/история).",
      args: {
        status: tool.schema
          .string()
          .optional()
          .describe("Фильтр: pending | in_progress | done | documented. Опустить — все активные"),
      },
      async execute(args) {
        const worktree = root()
        const filtered = isStatus(args.status)
          ? store.byStatus(worktree, args.status)
          : store.active(worktree)
        if (filtered.length === 0) return "Бэклог пуст."

        const rows = filtered.map(
          (idea) => `| \`${idea.id}\` | ${glyph(idea.status)} ${idea.status} | ${idea.text} |`,
        )
        return ["| id | статус | идея |", "| --- | --- | --- |", ...rows].join("\n")
      },
    }),

    idea_update: tool({
      description:
        "Изменить идею в бэклоге idea-inbox. Основной сценарий: после документирования результата работы вызвать со статусом documented — идея уйдёт из сайдбара в архив.",
      args: {
        id: tool.schema.string().describe("ID идеи, например idea_k3j2h9"),
        status: tool.schema
          .string()
          .optional()
          .describe("Новый статус: pending | in_progress | done | documented"),
        text: tool.schema.string().optional().describe("Новый текст идеи"),
      },
      async execute(args) {
        if (args.status !== undefined && !isStatus(args.status)) {
          return `Ошибка: неизвестный статус "${args.status}". Допустимо: pending | in_progress | done | documented`
        }
        const status = isStatus(args.status) ? args.status : undefined

        const result = store.update(root(), args.id, { status, text: args.text })
        if (result === undefined) return `Ошибка: идея \`${args.id}\` не найдена`

        const suffix = result.status === "documented" ? " (в архиве, из панели скрыта)" : ""
        return `Обновлено: \`${result.id}\` → ${glyph(result.status)} ${result.status}${suffix}`
      },
    }),

    idea_start: tool({
      description:
        "Отправить идею из бэклога idea-inbox в работу: создаёт фоновую сессию, помечает идею in_progress. По завершении (session.idle) идея автоматически станет done.",
      args: {
        id: tool.schema.string().describe("ID идеи, например idea_k3j2h9"),
      },
      async execute(args) {
        const worktree = root()
        const idea = store.find(worktree, args.id)
        if (idea === undefined) return `Ошибка: идея \`${args.id}\` не найдена`
        if (idea.status !== "pending") {
          return `Идея \`${args.id}\` уже ${glyph(idea.status)} ${idea.status}. Запускать можно только pending.`
        }

        const created = await client.session.create({ body: { title: `Idea: ${trim(idea.text, LIMIT)}` } })
        const sessionID = created.data?.id
        if (sessionID === undefined) return "Ошибка: session.create не вернул id"

        await client.session.promptAsync({
          path: { id: sessionID },
          body: { agent: AGENT, parts: [{ type: "text", text: mission(idea) }] },
        })
        store.update(worktree, idea.id, { status: "in_progress", sessionID })
        return `Запущено в фон: \`${idea.id}\` ◐ in_progress, сессия \`${sessionID}\`.`
      },
    }),
  }
}
