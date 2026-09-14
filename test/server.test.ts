import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { server } from "../src/server/index.js"
import * as store from "../src/store.js"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-events-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

/** Плагин с минимальным input: интересен только обработчик событий. */
async function handler(worktree: string) {
  const handlers = await server({ worktree, client: {} } as never)
  return handlers.event as (payload: unknown) => Promise<void>
}

describe("session.idle", () => {
  test("marks in_progress ideas of the session done", async () => {
    // Arrange
    const worktree = await root()
    const event = await handler(worktree)
    const idea = store.add(worktree, "фоновая задача")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_bg" })

    // Act
    await event({ event: { type: "session.idle", properties: { sessionID: "ses_bg" } } })

    // Assert
    expect(store.find(worktree, idea.id)?.status).toBe("done")
    expect(store.find(worktree, idea.id)?.sessionID).toBe("ses_bg")
  })

  test("ignores ideas of other sessions and non-running statuses", async () => {
    // Arrange
    const worktree = await root()
    const event = await handler(worktree)
    const foreign = store.add(worktree, "чужая сессия")
    store.update(worktree, foreign.id, { status: "in_progress", sessionID: "ses_other" })
    const pending = store.add(worktree, "ещё не запущена")
    store.update(worktree, pending.id, { status: "pending", sessionID: "ses_bg" })

    // Act
    await event({ event: { type: "session.idle", properties: { sessionID: "ses_bg" } } })

    // Assert
    expect(store.find(worktree, foreign.id)?.status).toBe("in_progress")
    expect(store.find(worktree, pending.id)?.status).toBe("pending")
  })
})

describe("session.deleted", () => {
  test("returns in_progress ideas of the session to pending and clears binding", async () => {
    // Arrange
    const worktree = await root()
    const event = await handler(worktree)
    const idea = store.add(worktree, "сессию удалили")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_gone" })

    // Act
    await event({ event: { type: "session.deleted", properties: { info: { id: "ses_gone" } } } })

    // Assert
    const stored = store.find(worktree, idea.id)
    expect(stored?.status).toBe("pending")
    expect(stored?.sessionID).toBeNull()
  })

  test("session without ideas is a no-op", async () => {
    const worktree = await root()
    const event = await handler(worktree)
    const idea = store.add(worktree, "не привязана")

    await event({ event: { type: "session.deleted", properties: { info: { id: "ses_empty" } } } })

    expect(store.find(worktree, idea.id)?.status).toBe("pending")
  })
})
