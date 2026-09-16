/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import type { JSX } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { TuiPluginApi, TuiSlotContext, TuiSlotPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import * as store from "../store.js"
import { glyph, trim, type Idea, type IdeaStatus } from "../types.js"

const LIMIT = 36
const POLL_MS = 2000

function color(status: IdeaStatus, palette: TuiThemeCurrent): RGBA {
  switch (status) {
    case "pending":
      return palette.textMuted
    case "in_progress":
      return palette.info
    case "done":
      return palette.success
    case "documented":
      return palette.textMuted
  }
}

/**
 * Сайдбар: живой список активых идей в слоте sidebar_content.
 * SQLite в WAL-режиме читается напрямую; обновление — короткий poll
 * (ловит записи агента из любой сессии) + событие session.idle.
 */
export function register(api: TuiPluginApi, root: () => string | undefined): () => void {
  const [ideas, setIdeas] = createSignal<Idea[]>([])

  const refresh = () => {
    const worktree = root()
    if (worktree === undefined || worktree === "" || worktree === "/") return
    try {
      setIdeas(store.active(worktree))
    } catch {
      setIdeas([])
    }
  }

  // Короткий poll ловит записи агента из любой сессии (тулы idea_*),
  // событие session.idle — момент завершения фоновой работы.
  const timer = setInterval(refresh, POLL_MS)
  const offIdle = api.event.on("session.idle", refresh)

  const render = (ctx: Readonly<TuiSlotContext>, _props: { session_id: string }): JSX.Element => {
    const items = ideas()
    const palette = ctx.theme.current

    return (
      <box>
        <text fg={palette.primary}>{`Idea Inbox (${items.length})`}</text>
        {items.length === 0 && <text fg={palette.textMuted}>пусто — leader+z записать идею</text>}
        {items.map((idea) => (
          <text fg={color(idea.status, palette)} truncate>
            {`${glyph(idea.status)} ${trim(idea.text, LIMIT)}`}
          </text>
        ))}
      </box>
    )
  }

  // SDK 1.4.9: тип TuiSlotPlugin объявляет id как never, но рантайм-контракт
  // @opentui/core Plugin требует строковый id — приводим осознанно.
  const plugin = {
    id: "idea-inbox.sidebar",
    order: 100,
    slots: { sidebar_content: render },
  } as unknown as TuiSlotPlugin

  const unregister = api.slots.register(plugin) as unknown as () => void

  return () => {
    offIdle()
    clearInterval(timer)
    try {
      unregister()
    } catch {
      // регистр уже disposing
    }
  }
}
