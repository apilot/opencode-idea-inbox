import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { create } from "../src/server/tools.js"
import * as store from "../src/store.js"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-lifecycle-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  setSystemTime() // снять мок времени
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

/** Тулы игнорируют context, но контракт требует его presence (как в tools.test.ts). */
const ctx = {
  sessionID: "ses_test",
  messageID: "msg_test",
  agent: "build",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} satisfies ToolContext

const text = (result: ToolResult): string => (typeof result === "string" ? result : result.output)

type Client = Parameters<typeof create>[1]

/** Клиент-заглушка: add/list/update клиента не трогают. */
function fakeClient(): Client {
  return {
    session: {
      create: async () => ({ data: { id: "ses_unused" } }),
      promptAsync: async () => ({}),
    },
  } as unknown as Client
}

describe("жизненный цикл идеи через тулы", () => {
  test("add → in_progress → done остаются активными, documented уходит в архив, updatedAt растёт", async () => {
    // Arrange — фиксированное время: тулы не принимают now, детерминизм через setSystemTime
    const worktree = await root()
    const tools = create(() => worktree, fakeClient())
    setSystemTime(new Date("2026-09-13T10:00:00.000Z"))

    // Act 1 — идея добавлена и видна в списке
    const addOut = text(await tools.idea_add.execute({ text: "дожить до архива" }, ctx))
    const id = store.active(worktree)[0]!.id
    const stamps: (string | undefined)[] = [store.find(worktree, id)?.updatedAt]

    // Assert 1 — pending, ответ и список содержат id с глифом ○
    expect(store.find(worktree, id)?.status).toBe("pending")
    expect(addOut).toContain(id)
    expect(addOut).toContain("(○ pending)")
    const listPending = text(await tools.idea_list.execute({}, ctx))
    expect(listPending).toContain(id)
    expect(listPending).toContain("○ pending")

    // Act 2 — в работу
    setSystemTime(new Date("2026-09-13T10:01:00.000Z"))
    const runningOut = text(await tools.idea_update.execute({ id, status: "in_progress" }, ctx))
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 2 — статус в сторе, ◐ в таблице
    expect(store.find(worktree, id)?.status).toBe("in_progress")
    expect(runningOut).toContain("◐ in_progress")
    const listRunning = text(await tools.idea_list.execute({}, ctx))
    expect(listRunning).toContain(id)
    expect(listRunning).toContain("◐ in_progress")

    // Act 3 — выполнена
    setSystemTime(new Date("2026-09-13T10:02:00.000Z"))
    const doneOut = text(await tools.idea_update.execute({ id, status: "done" }, ctx))
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 3 — ● и всё ещё в активном списке
    expect(store.find(worktree, id)?.status).toBe("done")
    expect(doneOut).toContain("● done")
    const listDone = text(await tools.idea_list.execute({}, ctx))
    expect(listDone).toContain(id)
    expect(listDone).toContain("● done")

    // Act 4 — документирована
    setSystemTime(new Date("2026-09-13T10:03:00.000Z"))
    const archivedOut = text(await tools.idea_update.execute({ id, status: "documented" }, ctx))
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 4 — из дефолтного списка скрыта («Бэклог пуст»), в архиве по фильтру,
    // store.active её больше не возвращает
    expect(archivedOut).toContain("✓ documented")
    expect(archivedOut).toContain("в архиве")
    expect(text(await tools.idea_list.execute({}, ctx))).toContain("Бэклог пуст")
    const archive = text(await tools.idea_list.execute({ status: "documented" }, ctx))
    expect(archive).toContain(id)
    expect(archive).toContain("✓ documented")
    expect(store.active(worktree)).toHaveLength(0)
    expect(store.byStatus(worktree, "documented").map((idea) => idea.id)).toEqual([id])

    // Assert — updatedAt монотонно растёт по всем переходам (ISO-строки сортируются как время)
    expect([...stamps].sort()).toEqual(stamps)
    expect(new Set(stamps).size).toBe(stamps.length)
    expect(stamps[0]).toBe("2026-09-13T10:00:00.000Z")
    expect(stamps.at(-1)).toBe("2026-09-13T10:03:00.000Z")
    expect(store.find(worktree, id)?.createdAt).toBe("2026-09-13T10:00:00.000Z")
  })
})
