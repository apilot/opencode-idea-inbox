import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info, ToolContext } from "@opencode/plugin/promise/tool"
import { create } from "../src/server/tools.js"
import * as store from "../src/store.js"

/** V2 create() возвращает массив — доступ к тулу по имени. */
const tool = (tools: Info[], name: string): Info => {
  const found = tools.find((candidate) => candidate.name === name)
  if (found === undefined) throw new Error(`тул ${name} не зарегистрирован`)
  return found
}

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

/** Тулы игнорируют большую часть контекста, но контракт требует его presence (как в tools.test.ts). */
const toolCtx = {
  sessionID: "ses_test" as ToolContext["sessionID"],
  agent: "build" as ToolContext["agent"],
  messageID: "msg_test" as ToolContext["messageID"],
  id: "call_test" as ToolContext["id"],
  signal: new AbortController().signal,
  progress: async () => {},
} satisfies ToolContext

type ServerContext = Parameters<typeof create>[1]

/** Контекст-заглушка: add/list/update клиента не трогают. */
function fakeSession(): ServerContext {
  return {
    session: {
      create: async () => ({ id: "ses_unused" }),
      prompt: async () => ({}),
    },
  } as unknown as ServerContext
}

describe("жизненный цикл идеи через тулы", () => {
  test("add → in_progress → done остаются активными, documented уходит в архив, updatedAt растёт", async () => {
    // Arrange — фиксированное время: тулы не принимают now, детерминизм через setSystemTime
    const worktree = await root()
    const tools = create(() => worktree, fakeSession())
    setSystemTime(new Date("2026-09-13T10:00:00.000Z"))

    // Act 1 — идея добавлена и видна в списке
    const id = store.add(worktree, "дожить до архива").id
    const stamps: (string | undefined)[] = [store.find(worktree, id)?.updatedAt]

    // Assert 1 — pending, глиф ○ в статусной колонке
    expect(store.find(worktree, id)?.status).toBe("pending")
    const listPending = await tool(tools, "idea_list").execute({}, toolCtx)
    expect(String(listPending.content)).toContain(id)
    expect(String(listPending.content)).toContain("○ pending")

    // Act 2 — в работу
    setSystemTime(new Date("2026-09-13T10:01:00.000Z"))
    await tool(tools, "idea_update").execute({ id, status: "in_progress" }, toolCtx)
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 2 — статус в сторе, ◐ в таблице
    expect(store.find(worktree, id)?.status).toBe("in_progress")
    const listRunning = String((await tool(tools, "idea_list").execute({}, toolCtx)).content)
    expect(listRunning).toContain(id)
    expect(listRunning).toContain("◐ in_progress")

    // Act 3 — выполнена
    setSystemTime(new Date("2026-09-13T10:02:00.000Z"))
    await tool(tools, "idea_update").execute({ id, status: "done" }, toolCtx)
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 3 — ● и всё ещё в активном списке
    expect(store.find(worktree, id)?.status).toBe("done")
    const listDone = String((await tool(tools, "idea_list").execute({}, toolCtx)).content)
    expect(listDone).toContain(id)
    expect(listDone).toContain("● done")

    // Act 4 — документирована
    setSystemTime(new Date("2026-09-13T10:03:00.000Z"))
    const archived = await tool(tools, "idea_update").execute({ id, status: "documented" }, toolCtx)
    stamps.push(store.find(worktree, id)?.updatedAt)

    // Assert 4 — из дефолтного списка скрыта («Бэклог пуст»), в архиве по фильтру,
    // store.active её больше не возвращает
    expect(String(archived.content)).toContain("✓ documented")
    expect(String(archived.content)).toContain("в архиве")
    expect(String((await tool(tools, "idea_list").execute({}, toolCtx)).content)).toContain("Бэклог пуст")
    const archive = String((await tool(tools, "idea_list").execute({ status: "documented" }, toolCtx)).content)
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
