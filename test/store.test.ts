import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { active, add, byStatus, claim, clear, find, forSession, load, sanitize, update, remove } from "../src/store.js"

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

describe("sanitize", () => {
  test("collapses newlines, tabs and repeated spaces into single line", () => {
    expect(sanitize("не срабатывает ctrl+x shift+i\nтеряется, нужно проще")).toBe(
      "не срабатывает ctrl+x shift+i теряется, нужно проще",
    )
    expect(sanitize("a\r\nb\rc\td")).toBe("a b c d")
    expect(sanitize("a    b")).toBe("a b")
    expect(sanitize("  крайние   пробелы  ")).toBe("крайние пробелы")
  })

  test("empty after sanitize stays empty (callers guard)", () => {
    expect(sanitize("\n\t  \n")).toBe("")
  })

  test("unicode line separators collapse, invisible/bidi chars stripped", () => {
    // U+2028/U+2029/U+0085 — разделители строк, нарушают однострочный контракт
    expect(sanitize("a\u{2028}b\u{2029}c\u{85}d")).toBe("a b c d")
    // zero-width (U+200B, U+FEFF) и bidi-override (U+202E) вырезаются
    expect(sanitize("ви\u{200b}димый\u{200b}текст")).toBe("видимыйтекст")
    expect(sanitize("\u{feff}префикс")).toBe("префикс")
    expect(sanitize("текст\u{202e}перевёрнут")).toBe("текстперевёрнут")
  })

  test("add and update store sanitized single-line text", async () => {
    // Arrange
    const worktree = await root()
    const idea = add(worktree, "строка один\nстрока два")

    // Act
    update(worktree, idea.id, { text: "новый\tтекст\nиз двух строк" })

    // Assert
    expect(find(worktree, idea.id)?.text).toBe("новый текст из двух строк")
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

describe("claim", () => {
  test("claims pending idea atomically, second claim loses", async () => {
    // Arrange
    const worktree = await root()
    const idea = add(worktree, "гонка")

    // Act + Assert — первый захват проходит, второй видит уже in_progress
    expect(claim(worktree, idea.id)).toBeTrue()
    expect(find(worktree, idea.id)?.status).toBe("in_progress")
    expect(claim(worktree, idea.id)).toBeFalse()
  })

  test("unknown id or non-pending status returns false", async () => {
    const worktree = await root()
    expect(claim(worktree, "idea_missing")).toBeFalse()
    const done = add(worktree, "готово")
    update(worktree, done.id, { status: "done" })
    expect(claim(worktree, done.id)).toBeFalse()
  })
})

describe("remove", () => {
  test("deletes existing row and returns true", async () => {
    // Arrange
    const worktree = await root()
    const idea = add(worktree, "на удаление")

    // Act + Assert
    expect(remove(worktree, idea.id)).toBeTrue()
    expect(find(worktree, idea.id)).toBeUndefined()
  })

  test("unknown id returns false", async () => {
    const worktree = await root()
    expect(remove(worktree, "idea_missing")).toBeFalse()
  })
})

describe("clear", () => {
  test("deletes all active ideas, keeps documented archive, returns count", async () => {
    // Arrange
    const worktree = await root()
    const first = add(worktree, "pending")
    add(worktree, "in_progress")
    const archived = add(worktree, "архивная")
    update(worktree, first.id, { status: "done" })
    update(worktree, archived.id, { status: "documented" })

    // Act
    const removed = clear(worktree)

    // Assert
    expect(removed).toBe(2)
    expect(active(worktree)).toHaveLength(0)
    expect(byStatus(worktree, "documented").map((idea) => idea.id)).toEqual([archived.id])
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
