import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { active, add, byStatus, find, forSession, load, update } from "../src/store.js"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

describe("add", () => {
  test("inserts pending idea with timestamps and origin session", async () => {
    // Arrange
    const worktree = await root()
    const now = new Date("2026-09-13T10:00:00.000Z")

    // Act
    const idea = add(worktree, "первая идея", "ses_origin", now)

    // Assert
    expect(idea.status).toBe("pending")
    expect(idea.originSessionID).toBe("ses_origin")
    expect(idea.sessionID).toBeNull()
    expect(idea.createdAt).toBe("2026-09-13T10:00:00.000Z")
    expect(find(worktree, idea.id)?.text).toBe("первая идея")
  })
})

describe("update", () => {
  test("changes only provided fields and bumps updated_at", async () => {
    // Arrange
    const worktree = await root()
    const idea = add(worktree, "текст", null, new Date("2026-09-13T10:00:00.000Z"))

    // Act
    const result = update(worktree, idea.id, { status: "in_progress", sessionID: "ses_2" }, new Date("2026-09-13T11:00:00.000Z"))

    // Assert
    expect(result?.status).toBe("in_progress")
    expect(result?.sessionID).toBe("ses_2")
    expect(result?.text).toBe("текст")
    expect(result?.updatedAt).toBe("2026-09-13T11:00:00.000Z")
    expect(result?.createdAt).toBe("2026-09-13T10:00:00.000Z")
  })

  test("unknown id returns undefined", async () => {
    const worktree = await root()
    expect(update(worktree, "idea_missing", { status: "done" })).toBeUndefined()
  })

  test("empty patch returns current row unchanged", async () => {
    const worktree = await root()
    const idea = add(worktree, "текст")
    expect(update(worktree, idea.id, {})?.updatedAt).toBe(idea.updatedAt)
  })
})

describe("queries", () => {
  test("active excludes documented, load keeps history", async () => {
    // Arrange
    const worktree = await root()
    const first = add(worktree, "готово")
    add(worktree, "ждёт")
    update(worktree, first.id, { status: "documented" })

    // Act + Assert
    expect(active(worktree).map((idea) => idea.text)).toEqual(["ждёт"])
    expect(load(worktree)).toHaveLength(2)
  })

  test("byStatus filters one status", async () => {
    const worktree = await root()
    const first = add(worktree, "a")
    const second = add(worktree, "b")
    update(worktree, first.id, { status: "done" })
    update(worktree, second.id, { status: "in_progress" })

    expect(byStatus(worktree, "done")).toHaveLength(1)
    expect(byStatus(worktree, "in_progress")[0]?.text).toBe("b")
    expect(byStatus(worktree)).toHaveLength(2) // без фильтра — активные
  })

  test("forSession returns only ideas bound to the session", async () => {
    const worktree = await root()
    const first = add(worktree, "связанная")
    add(worktree, "посторонняя")
    update(worktree, first.id, { status: "in_progress", sessionID: "ses_work" })

    expect(forSession(worktree, "ses_work")).toHaveLength(1)
    expect(forSession(worktree, "ses_other")).toHaveLength(0)
  })
})
