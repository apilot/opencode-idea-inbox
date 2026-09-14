import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import * as store from "../store.js"
import { create } from "./tools.js"

/**
 * Резолвит рабочую директорию для стора — лениво, на каждый вызов.
 *
 * Глобальный сервер-инстанс может активировать плагин до привязки
 * проекта: тогда worktree === "/" и mkdir "/.opencode" падает с EACCES
 * (наблюдалось в 1.18.30). Берём первый валидный путь из inputs,
 * fallback — cwd процесса.
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
 * Серверная часть idea-inbox: тулы для агента + автоматические переходы
 * статусов по событиям шины. UI и запуск сессий — в TUI-части плагина.
 *
 * Пути из PluginInput capture'ятся, но резолвятся лениво (см. resolve):
 * в момент активации они могут быть ещё не заполнены.
 */
const plugin: Plugin = async (input) => {
  const root = () => resolve([input.worktree, input.directory])

  return {
    tool: create(root, input.client),

    event: async ({ event }) => {
      if (event.type === "session.idle") {
        settle(root(), event.properties.sessionID, "idle")
        return
      }
      if (event.type === "session.deleted") {
        settle(root(), event.properties.info.id, "deleted")
      }
    },
  }
}

export const server: Plugin = plugin
export default { id: "idea-inbox", server: plugin } satisfies PluginModule
