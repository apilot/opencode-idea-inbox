/** @jsxImportSource @opentui/solid */
import type { JSX } from "@opentui/solid"
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
 *
 * Реактивное состояние — ctx.storage.memory (стор хоста): чтения внутри
 * JSX-функций трекаются эффектами того же экземпляра solid, что и рендер.
 * opts.pollMs переопределяется в тестах.
 */
export function register(
  ctx: Plugin.Context,
  root: () => string | undefined,
  opts: { pollMs?: number } = {},
): () => void {
  const diag = createDiag(root)
  diag.log("sb.register", { build: BUILD })
  const [state, setState] = ctx.storage.memory("idea-inbox.sidebar", { initial: { ideas: [] as Idea[] } })
  const ideas = (): Idea[] => state.ideas

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
      setState((draft) => {
        draft.ideas = next
      })
    } catch (error) {
      diag.log("sb.error", { message: String(error) })
      setState((draft) => {
        draft.ideas = []
      })
    }
  }

  // Короткий poll ловит записи агента из любой сессии (тулы idea_*),
  // событие session.idle — момент завершения фоновой работы.
  // opts.pollMs переопределяется в тестах.
  const timer = setInterval(refresh, opts.pollMs ?? POLL_MS)
  const offIdle = ctx.data.on("session.idle", refresh)

  const unregister = ctx.ui.slot({
    append: "sidebar.content",
    render: (): JSX.Element => {
      const theme = ctx.theme

      // Реактивность: хост вызывает render() один раз при монтировании
      // слота, поэтому ВСЕ живые чтения ideas() — внутри функций-детей.
      // Рендерер @opentui/solid оборачивает accessor-детей в
      // createRenderEffect (Solid-семантика insert) — при изменении
      // сигнала пересобираются только живые узлы. Срез по LIMIT: гигантский
      // бэклог не должен рендерить сотни строк каждые 2 секунды — хвост
      // показываем счётчиком.
      return (
        <box>
          <text fg={theme.text.base}>{() => `Idea Inbox (${ideas().length})`}</text>
          {() => ideas().length === 0 && (
            <text fg={theme.text.muted}>пусто — leader+z записать идею</text>
          )}
          {() =>
            ideas()
              .slice(0, LIMIT)
              .map((idea) => (
                <text fg={color(idea.status, theme)} truncate>
                  {`${glyph(idea.status)} ${trim(idea.text, LIMIT)}`}
                </text>
              ))
          }
          {() => ideas().length > LIMIT && (
            <text fg={theme.text.muted}>{`…и ещё ${ideas().length - LIMIT}`}</text>
          )}
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
