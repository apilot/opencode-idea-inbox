import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { create } from "../src/server/tools.js"
import * as store from "../src/store.js"

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

/** Тулы игнорируют context, но контракт требует его presence. */
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

interface ClientSpy {
  client: Client
  created: { value: unknown }
  prompted: { value: unknown }
}

/** SDK-клиент с записью вызовов: idea_start создаёт сессию и шлёт промт. */
function fakeClient(sessionID: string): ClientSpy {
  const spy: ClientSpy = {
    created: { value: undefined },
    prompted: { value: undefined },
    client: undefined as unknown as Client,
  }
  spy.client = {
    session: {
      create: async (args: unknown) => {
        spy.created.value = args
        return { data: { id: sessionID } }
      },
      promptAsync: async (args: unknown) => {
        spy.prompted.value = args
        return {}
      },
    },
  } as unknown as Client
  return spy
}

/** SDK-клиент, у которого API лежит: session.create бросает. */
function failingClient(): Client {
  return {
    session: {
      create: async () => {
        throw new Error("api down")
      },
      promptAsync: async () => {
        throw new Error("api down")
      },
    },
  } as unknown as Client
}

/** Корень, в котором стор не может создать каталог (например, /proc). */
const badRoot = () => "/proc/idea-inbox-cannot-exist"

describe("idea_add", () => {
  test("saves pending idea and answers with id and resume directive", async () => {
    // Arrange
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    // Act
    const out = text(await tools.idea_add.execute({ text: "добавить поиск" }, ctx))

    // Assert
    const saved = store.active(worktree)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.status).toBe("pending")
    expect(out).toContain(saved[0]?.id ?? "")
    expect(out).toContain("Активных в бэклоге: 1")
    // директива возобновления прерванной задачи (фикс «прерывается и останавливается»)
    expect(out).toContain("немедленно продолжи")
  })

  test("empty text is rejected without touching the store", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    const out = text(await tools.idea_add.execute({ text: "   " }, ctx))

    expect(out).toContain("пустой текст")
    expect(store.active(worktree)).toHaveLength(0)
  })

  test("multiline text is sanitized to one line", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    await tools.idea_add.execute({ text: "строка один\nстрока два" }, ctx)

    expect(store.active(worktree)[0]?.text).toBe("строка один строка два")
  })

  test("saves origin session id from tool context", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    await tools.idea_add.execute({ text: "идея из сессии" }, ctx)

    expect(store.active(worktree)[0]?.originSessionID).toBe("ses_test")
  })

  test("store failure returns error string instead of throwing", async () => {
    const tools = create(badRoot, fakeClient("ses_x").client)

    const out = text(await tools.idea_add.execute({ text: "обречена" }, ctx))

    expect(out).toContain("Ошибка хранилища")
  })
})

describe("idea_list", () => {
  test("empty backlog reports emptiness", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    expect(text(await tools.idea_list.execute({}, ctx))).toContain("Бэклог пуст")
  })

  test("renders markdown table of active ideas only", async () => {
    // Arrange
    const worktree = await root()
    const first = store.add(worktree, "первая")
    store.add(worktree, "вторая")
    store.update(worktree, first.id, { status: "documented" })

    // Act
    const out = text(await create(() => worktree, fakeClient("ses_x").client).idea_list.execute({}, ctx))

    // Assert — documented скрыт, активная в таблице со своим id
    expect(out.startsWith("| id | статус | идея |")).toBeTrue()
    expect(out).toContain("вторая")
    expect(out).not.toContain("первая")
  })

  test("status filter returns exactly that status", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const done = store.add(worktree, "выполнено")
    store.add(worktree, "ждёт")
    store.update(worktree, done.id, { status: "done" })

    const out = text(await tools.idea_list.execute({ status: "done" }, ctx))

    expect(out).toContain("выполнено")
    expect(out).not.toContain("ждёт")
  })
})

describe("idea_update", () => {
  test("unknown status is rejected with the allowed list", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const idea = store.add(worktree, "текст")

    const out = text(await tools.idea_update.execute({ id: idea.id, status: "archived" }, ctx))

    expect(out).toContain("неизвестный статус")
    expect(out).toContain("pending | in_progress | done | documented")
    expect(store.find(worktree, idea.id)?.status).toBe("pending") // без изменений
  })

  test("unknown id reports not found", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    expect(text(await tools.idea_update.execute({ id: "idea_missing", status: "done" }, ctx))).toContain("не найдена")
  })

  test("documented status mentions archive hiding", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const idea = store.add(worktree, "в архив")

    const out = text(await tools.idea_update.execute({ id: idea.id, status: "documented" }, ctx))

    expect(out).toContain("documented")
    expect(out).toContain("в архиве")
    expect(store.find(worktree, idea.id)?.status).toBe("documented")
  })

  test("blank text is rejected without erasing the stored idea (C1)", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const idea = store.add(worktree, "важный текст")

    const out = text(await tools.idea_update.execute({ id: idea.id, text: "   " }, ctx))

    expect(out).toContain("пустой текст")
    expect(store.find(worktree, idea.id)?.text).toBe("важный текст") // текст не тронут
  })

  test("text patch rewrites the stored text (positive path beside the C1 guard)", async () => {
    // Arrange — правка текста через тул проверена только на отказ (C1), позитивный путь — нет
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const idea = store.add(worktree, "черновик формулировки")

    // Act
    const out = text(await tools.idea_update.execute({ id: idea.id, text: "уточнённая формулировка" }, ctx))

    // Assert
    expect(out).toContain("Обновлено")
    expect(store.find(worktree, idea.id)?.text).toBe("уточнённая формулировка")
  })

  test("store failure returns error string instead of throwing", async () => {
    const tools = create(badRoot, fakeClient("ses_x").client)

    const out = text(await tools.idea_update.execute({ id: "idea_x", status: "done" }, ctx))

    expect(out).toContain("Ошибка хранилища")
  })
})

describe("idea_start", () => {
  test("unknown id reports not found", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)

    expect(text(await tools.idea_start.execute({ id: "idea_missing" }, ctx))).toContain("не найдена")
  })

  test("rejects ideas that are not pending", async () => {
    const worktree = await root()
    const tools = create(() => worktree, fakeClient("ses_x").client)
    const idea = store.add(worktree, "уже в работе")
    store.update(worktree, idea.id, { status: "in_progress" })

    const out = text(await tools.idea_start.execute({ id: idea.id }, ctx))

    expect(out).toContain("только pending")
  })

  test("creates background session, prompts mission, marks in_progress", async () => {
    // Arrange
    const worktree = await root()
    const spy = fakeClient("ses_bg_1")
    const tools = create(() => worktree, spy.client)
    const idea = store.add(worktree, "написать тесты плагина")

    // Act
    const out = text(await tools.idea_start.execute({ id: idea.id }, ctx))

    // Assert — статус и ответ
    const stored = store.find(worktree, idea.id)
    expect(stored?.status).toBe("in_progress")
    expect(stored?.sessionID).toBe("ses_bg_1")
    expect(out).toContain("ses_bg_1")

    // Сессия создана с заголовком из текста идеи
    const created = spy.created.value as { body: { title: string } }
    expect(created.body.title).toContain("написать тесты плагина")

    // Миссия адресована фоновой сессии, билд-агенту, с инструкцией idea_update;
    // текст идеи обрамлён как данные (анти-инъекция)
    const prompted = spy.prompted.value as { path: { id: string }; body: { agent: string; parts: { text: string }[] } }
    expect(prompted.path.id).toBe("ses_bg_1")
    expect(prompted.body.agent).toBe("build")
    expect(prompted.body.parts[0]?.text).toContain(idea.id)
    expect(prompted.body.parts[0]?.text).toContain("idea_update")
    expect(prompted.body.parts[0]?.text).toContain("<<<")
    expect(prompted.body.parts[0]?.text).toContain(">>>")
  })

  test("api failure rolls the idea back to pending (C2)", async () => {
    // Arrange
    const worktree = await root()
    const tools = create(() => worktree, failingClient())
    const idea = store.add(worktree, "упадёт при запуске")

    // Act
    const out = text(await tools.idea_start.execute({ id: idea.id }, ctx))

    // Assert — идея не залипла in_progress без сессии
    expect(out).toContain("возвращена в pending")
    expect(store.find(worktree, idea.id)?.status).toBe("pending")
    expect(store.find(worktree, idea.id)?.sessionID).toBeNull()
  })
})
