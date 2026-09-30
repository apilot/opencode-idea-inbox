/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import * as store from "../store.js"
import { glyph, trim, type Idea, type IdeaStatus } from "../types.js"
import { BUILD, create as createDiag } from "./diag.js"

const LIMIT = 36
const POLL_MS = 2000

function color(status: IdeaStatus, theme: Plugin.Context["theme"]): RGBA {
  switch (status) {
    case "pending":
      return theme.text.muted
    case "in_progress":
      return theme.text.feedback.info.base
    case "done":
      return theme.text.feedback.success.base
    case "documented":
      return theme.text.muted
  }
}

/**
 * Сайдбар: живой список активых идей в слоте sidebar.content.
 * SQLite в WAL-режиме читается напрямую; обновление — короткий poll
 * (ловит записи агента из любой сессии) + событие session.idle.
 */
export function register(ctx: Plugin.Context, root: () => string | undefined): () => void {
  const diag = createDiag(root)
  diag.log("sb.register", { build: BUILD })
  const [ideas, setIdeas] = createSignal<Idea[]>([])

  // Диагностика живости: счётчик успешных чтений (раз в 30 — строка в лог)
  // и дешёвый снапшот id:status — post-mortem видно, что сайдбар реально
  // читает БД и реагирует на переходы статусов.
  let refreshes = 0
  let lastSnapshot = ""

  const refresh = () => {
    const worktree = root()
    if (worktree === undefined || worktree === "" || worktree === "/") return
    try {
      const next = store.active(worktree)
      refreshes++
      const snapshot = next.map((idea) => `${idea.id}:${idea.status}`).join(",")
      if (snapshot !== lastSnapshot) {
        lastSnapshot = snapshot
        diag.log("sb.change", { snapshot })
      }
      if (refreshes % 30 === 0) diag.log("sb.alive", { count: next.length })
      setIdeas(next)
    } catch (error) {
      diag.log("sb.error", { message: String(error) })
      setIdeas([])
    }
  }

  // Короткий poll ловит записи агента из любой сессии (тулы idea_*),
  // событие session.idle — момент завершения фоновой работы.
  const timer = setInterval(refresh, POLL_MS)
  const offIdle = ctx.data.on("session.idle", refresh)

  const unregister = ctx.ui.slot({
    append: "sidebar.content",
    render: (): JSX.Element => {
      // Срез по LIMIT: гигантский бэклог не должен рендерить сотни строк
      // каждые 2 секунды — хвост показываем счётчиком.
      const all = ideas()
      const items = all.slice(0, LIMIT)
      const rest = all.length - items.length
      const theme = ctx.theme

      return (
        <box>
          <text fg={theme.text.base}>{`Idea Inbox (${all.length})`}</text>
          {items.length === 0 && <text fg={theme.text.muted}>пусто — leader+z записать идею</text>}
          {items.map((idea) => (
            <text fg={color(idea.status, theme)} truncate>
              {`${glyph(idea.status)} ${trim(idea.text, LIMIT)}`}
            </text>
          ))}
          {rest > 0 && <text fg={theme.text.muted}>{`…и ещё ${rest}`}</text>}
        </box>
      )
    },
  })

  return () => {
    diag.log("sb.unregister", {})
    offIdle()
    clearInterval(timer)
    try {
      unregister()
    } catch {
      // регистр уже disposing
    }
  }
}
