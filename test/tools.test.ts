import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { Info, Result, ToolContext } from "@opencode/plugin/promise/tool"
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-tools-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

/** Тулы игнорируют большую часть контекста, но контракт требует его presence. */
const toolCtx = {
  sessionID: "ses_test" as ToolContext["sessionID"],
  agent: "build" as ToolContext["agent"],
  messageID: "msg_test" as ToolContext["messageID"],
  id: "call_test" as ToolContext["id"],
  signal: new AbortController().signal,
  progress: async () => {},
} satisfies ToolContext

/** V2-тулы отвечают Result{content}, а не строкой. */
const text = (result: Result): string => (typeof result === "string" ? result : (result.content as string) ?? "")

type ServerContext = Parameters<typeof create>[1]

interface SessionSpy {
  ctx: ServerContext
  created: { value: unknown }
  prompted: { value: unknown }
}

/** Plugin.Context с записью вызовов: idea_start создаёт сессию и шлёт промт. */
function fakeSession(sessionID: string): SessionSpy {
  const spy: SessionSpy = {
    created: { value: undefined },
    prompted: { value: undefined },
    ctx: undefined as unknown as ServerContext,
  }
  spy.ctx = {
    session: {
      // V2: create возвращает SessionInfo напрямую, prompt принимает {sessionID, text}
      create: async (args: unknown) => {
        spy.created.value = args
        return { id: sessionID }
      },
      prompt: async (args: unknown) => {
        spy.prompted.value = args
        return {}
      },
    },
  } as unknown as ServerContext
  return spy
}

/** Контекст, у которого API лежит: session.create бросает. */
function failingSession(): ServerContext {
  return {
    session: {
      create: async () => {
        throw new Error("api down")
      },
      prompt: async () => {
        throw new Error("api down")
      },
    },
  } as unknown as ServerContext
}

/** Корень, в котором стор не может создать каталог (например, /proc). */
const badRoot = () => "/proc/idea-inbox-cannot-exist"

describe("idea_add", () => {
  test("saves pending idea and answers with id and resume directive", async () => {
    // Arrange
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    // Act
    const out = text(await tool(tools, "idea_add").execute({ text: "добавить поиск" }, toolCtx))

    // Assert
    const saved = store.active(worktree)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.status).toBe("pending")
    expect(out).toContain(saved[0]?.id ?? "")
    expect(out).toContain("Активных в бэклоге: 1")
    // директива возобновления прерванной задачи
    expect(out).toContain("немедленно продолжи")
  })

  test("empty text is rejected without touching the store", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    const out = text(await tool(tools, "idea_add").execute({ text: "   " }, toolCtx))

    expect(out).toContain("пустой текст")
    expect(store.active(worktree)).toHaveLength(0)
  })

  test("multiline text is sanitized to one line", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    await tool(tools, "idea_add").execute({ text: "строка один\nстрока два" }, toolCtx)

    expect(store.active(worktree)[0]?.text).toBe("строка один строка два")
  })

  test("saves origin session id from tool context", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    await tool(tools, "idea_add").execute({ text: "идея из сессии" }, toolCtx)

    expect(store.active(worktree)[0]?.originSessionID).toBe("ses_test")
  })

  test("store failure returns error string instead of throwing", async () => {
    const tools = create(badRoot, fakeSession("ses_x").ctx)

    const out = text(await tool(tools, "idea_add").execute({ text: "обречена" }, toolCtx))

    expect(out).toContain("Ошибка хранилища")
  })
})

describe("idea_list", () => {
  test("empty backlog reports emptiness", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    expect(text(await tool(tools, "idea_list").execute({}, toolCtx))).toContain("Бэклог пуст")
  })

  test("renders markdown table of active ideas only", async () => {
    // Arrange
    const worktree = await root()
    const first = store.add(worktree, "первая")
    store.add(worktree, "вторая")
    store.update(worktree, first.id, { status: "documented" })

    // Act
    const out = text(await tool(create(() => worktree, fakeSession("ses_x").ctx), "idea_list").execute({}, toolCtx))

    // Assert — documented скрыт, активная в таблице со своим id
    expect(out.startsWith("| id | статус | идея |")).toBeTrue()
    expect(out).toContain("вторая")
    expect(out).not.toContain("первая")
  })

  test("status filter returns exactly that status", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const done = store.add(worktree, "выполнено")
    store.add(worktree, "ждёт")
    store.update(worktree, done.id, { status: "done" })

    const out = text(await tool(tools, "idea_list").execute({ status: "done" }, toolCtx))

    expect(out).toContain("выполнено")
    expect(out).not.toContain("ждёт")
  })
})

describe("idea_update", () => {
  test("unknown status is rejected with the allowed list", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const idea = store.add(worktree, "текст")

    const out = text(await tool(tools, "idea_update").execute({ id: idea.id, status: "archived" }, toolCtx))

    expect(out).toContain("неизвестный статус")
    expect(out).toContain("pending | in_progress | done | documented")
    expect(store.find(worktree, idea.id)?.status).toBe("pending") // без изменений
  })

  test("unknown id reports not found", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    expect(text(await tool(tools, "idea_update").execute({ id: "idea_missing", status: "done" }, toolCtx))).toContain("не найдена")
  })

  test("documented status mentions archive hiding", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const idea = store.add(worktree, "в архив")

    const out = text(await tool(tools, "idea_update").execute({ id: idea.id, status: "documented" }, toolCtx))

    expect(out).toContain("documented")
    expect(out).toContain("в архиве")
    expect(store.find(worktree, idea.id)?.status).toBe("documented")
  })

  test("blank text is rejected without erasing the stored idea (C1)", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const idea = store.add(worktree, "важный текст")

    const out = text(await tool(tools, "idea_update").execute({ id: idea.id, text: "   " }, toolCtx))

    expect(out).toContain("пустой текст")
    expect(store.find(worktree, idea.id)?.text).toBe("важный текст") // текст не тронут
  })

  test("text patch rewrites the stored text (positive path beside the C1 guard)", async () => {
    // Arrange — правка текста через тул проверена только на отказ (C1), позитивный путь — нет
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const idea = store.add(worktree, "черновик формулировки")

    // Act
    const out = text(await tool(tools, "idea_update").execute({ id: idea.id, text: "уточнённая формулировка" }, toolCtx))

    // Assert
    expect(out).toContain("Обновлено")
    expect(store.find(worktree, idea.id)?.text).toBe("уточнённая формулировка")
  })

  test("store failure returns error string instead of throwing", async () => {
    const tools = create(badRoot, fakeSession("ses_x").ctx)

    const out = text(await tool(tools, "idea_update").execute({ id: "idea_x", status: "done" }, toolCtx))

    expect(out).toContain("Ошибка хранилища")
  })
})

describe("idea_start", () => {
  test("unknown id reports not found", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)

    expect(text(await tool(tools, "idea_start").execute({ id: "idea_missing" }, toolCtx))).toContain("не найдена")
  })

  test("rejects ideas that are not pending", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeSession("ses_x").ctx)
    const idea = store.add(worktree, "уже в работе")
    store.update(worktree, idea.id, { status: "in_progress" })

    const out = text(await tool(tools, "idea_start").execute({ id: idea.id }, toolCtx))

    expect(out).toContain("только pending")
  })

  test("creates background session, prompts mission, marks in_progress", async () => {
    // Arrange
    const worktree = await root()
    const spy = fakeSession("ses_bg_1")
    const tools = create(() => worktree, spy.ctx)
    const idea = store.add(worktree, "написать тесты плагина")

    // Act
    const out = text(await tool(tools, "idea_start").execute({ id: idea.id }, toolCtx))

    // Assert — статус и ответ
    const stored = store.find(worktree, idea.id)
    expect(stored?.status).toBe("in_progress")
    expect(stored?.sessionID).toBe("ses_bg_1")
    expect(out).toContain("ses_bg_1")

    // Сессия создана с заголовком из текста идеи и агентом build
    const created = spy.created.value as { title: string; agent: string }
    expect(created.title).toContain("написать тесты плагина")
    expect(created.agent).toBe("build")

    // Миссия адресована фоновой сессии, с инструкцией idea_update;
    // текст идеи обрамлён как данные (анти-инъекция)
    const prompted = spy.prompted.value as { sessionID: string; text: string }
    expect(prompted.sessionID).toBe("ses_bg_1")
    expect(prompted.text).toContain(idea.id)
    expect(prompted.text).toContain("idea_update")
    expect(prompted.text).toContain("<<<")
    expect(prompted.text).toContain(">>>")
  })

  test("api failure rolls the idea back to pending (C2)", async () => {
    // Arrange
    const worktree = await root()
    const tools = create(() => worktree, failingSession())
    const idea = store.add(worktree, "упадёт при запуске")

    // Act
    const out = text(await tool(tools, "idea_start").execute({ id: idea.id }, toolCtx))

    // Assert — идея не залипла in_progress без сессии
    expect(out).toContain("возвращена в pending")
    expect(store.find(worktree, idea.id)?.status).toBe("pending")
    expect(store.find(worktree, idea.id)?.sessionID).toBeNull()
  })
})
