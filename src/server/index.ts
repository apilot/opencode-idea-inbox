import { Plugin } from "@opencode/plugin"
import * as store from "../store.js"
import { create } from "./tools.js"

/**
 * Резолвит рабочую директорию для стора — лениво, на каждый вызов.
 *
 * Глобальный сервер-инстанс может активировать плагин до привязки
 * проекта: тогда directory === "/" и mkdir "/.opencode" падает с EACCES.
 * Берём первый валидный путь, fallback — cwd процесса.
 */
function resolve(candidates: (string | undefined)[]): string {
  for (const path of candidates) {
    if (path !== undefined && path !== "" && path !== "/") return path
  }
  return process.cwd()
}

/** Переводит идеи привязанной сессии: idle → done, deleted → обратно в pending. */
function settle(worktree: string, sessionID: string, kind: "idle" | "deleted"): void {
  const mine = store.forSession(worktree, sessionID)
  if (mine.length === 0) return

  for (const idea of mine) {
    if (kind === "idle") {
      if (idea.status !== "in_progress") continue
      store.update(worktree, idea.id, { status: "done" })
      continue
    }
    store.update(worktree, idea.id, { status: "pending", sessionID: null })
  }
}

/**
 * Достаёт sessionID из data события V2. Форма не гарантирована рантаймом:
 * session.idle несёт {sessionID}, у session.deleted поле может лежать
 * в info.id (как в V1) — поддерживаем оба варианта.
 */
function sessionIDOf(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  const record = data as Record<string, unknown>
  if (typeof record.sessionID === "string") return record.sessionID
  const info = record.info
  if (typeof info === "object" && info !== null) {
    const id = (info as Record<string, unknown>).id
    if (typeof id === "string") return id
  }
  return undefined
}

/**
 * Серверная часть idea-inbox (V2): тулы для агента + автоматические
 * переходы статусов по событиям шины. UI и запуск сессий — в TUI-части.
 *
 * Путь из ctx.location capture'ится, но резолвится лениво (см. resolve):
 * в момент активации он может быть ещё не заполнен.
 */
export default Plugin.define({
  id: "idea-inbox",
  async setup(ctx) {
    const root = () => resolve([ctx.location.directory])

    const tools = await ctx.tool.transform((editor) => {
      for (const tool of create(root, ctx)) editor.add(tool)
    })

    // Шина событий: idle отмечает работу ideas выполненной, deleted
    // возвращает их в очередь. AbortSignal из cleanup останавливает цикл.
    const controller = new AbortController()
    const pump = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // Стор может быть временно недоступен (конкурентная запись → BUSY
        // после таймаута): событие не должно ронять цикл — статус доедет
        // следующим событием или ручным idea_update.
        try {
          if (event.type === "session.idle") {
            const sessionID = sessionIDOf(event.data)
            if (sessionID !== undefined) settle(root(), sessionID, "idle")
            continue
          }
          if (event.type === "session.deleted") {
            const deletedID = sessionIDOf(event.data)
            if (deletedID !== undefined) settle(root(), deletedID, "deleted")
          }
        } catch {
          // транзиентная ошибка стора — молча пропускаем
        }
      }
    })()
    // Обрыв шины не должен ронять хост; причина видна в логах сервера.
    void pump.catch(() => {})

    return () => {
      controller.abort()
      void tools.dispose()
    }
  },
})
