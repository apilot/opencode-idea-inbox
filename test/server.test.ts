import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/server/index.js"
import * as store from "../src/store.js"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-server-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

/** Событие шины V2: {type, data}. */
type BusEvent = { type: string; data?: unknown }

/** Управляемая шина: push кормит итератор subscribe, close завершает цикл. */
function eventBus() {
  const queue: BusEvent[] = []
  const waiters: ((result: IteratorResult<BusEvent>) => void)[] = []
  return {
    push(event: BusEvent): void {
      const resolve = waiters.shift()
      if (resolve !== undefined) resolve({ value: event, done: false })
      else queue.push(event)
    },
    close(): void {
      while (waiters.length > 0) waiters.shift()!({ value: undefined, done: true })
    },
    subscribe(options: { signal?: AbortSignal } = {}) {
      // cleanup() плагина абортит сигнал — шина обязана завершить итерацию,
      // как это делает настоящий EventDomain
      options.signal?.addEventListener("abort", () => this.close(), { once: true })
      return {
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<IteratorResult<BusEvent>> =>
            queue.length > 0
              ? Promise.resolve({ value: queue.shift()!, done: false })
              : new Promise((resolve) => waiters.push(resolve)),
        }),
      }
    },
  }
}

interface RegistrationSpy {
  disposed: boolean
  dispose: () => Promise<void>
}

/** Прокачка микротасков: pump потребляет события асинхронно. */
const flush = async (ticks = 4): Promise<void> => {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Минимальный V2-Context: transform-моки собирают регистрации, event-шина
 * управляется вручную. Возвращает cleanup и спи-стейт для проверок.
 */
async function harness(directory: string) {
  const tools: { name: string }[] = []
  const commands: { name: string }[] = []
  const registrations: RegistrationSpy[] = []
  const bus = eventBus()

  const registration = (): RegistrationSpy => {
    const spy: RegistrationSpy = { disposed: false, dispose: async () => {} }
    spy.dispose = async () => {
      spy.disposed = true
    }
    registrations.push(spy)
    return spy
  }

  const ctx = {
    location: { directory },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (definition: { name: string }) => tools.push(definition) })
        return registration()
      },
    },
    command: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({ add: (definition: { name: string }) => commands.push(definition) })
        return registration()
      },
    },
    event: { subscribe: (options: { signal?: AbortSignal }) => bus.subscribe(options) },
  } as unknown as Plugin.Context

  const cleanup = await plugin.setup(ctx)
  return { tools, commands, registrations, bus, cleanup: cleanup ?? (() => {}) }
}

describe("setup", () => {
  test("registers four tools and two commands, cleanup disposes everything", async () => {
    // Arrange + Act
    const worktree = await root()
    const h = await harness(worktree)

    // Assert — тулы и нативные слэш-команды
    expect(h.tools.map((tool) => tool.name)).toEqual(["idea_add", "idea_list", "idea_update", "idea_start"])
    expect(h.commands.map((command) => command.name)).toEqual(["idea", "ideas"])
    expect(h.registrations.every((registration) => !registration.disposed)).toBeTrue()

    // Cleanup — регистрации освобождены
    h.cleanup()
    await flush()
    expect(h.registrations.every((registration) => registration.disposed)).toBeTrue()
  })

  test("after cleanup events no longer settle statuses", async () => {
    // Arrange
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "опоздала на автобус")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_late" })
    h.cleanup()
    await flush()

    // Act — событие пришло после выгрузки плагина
    h.bus.push({ type: "session.idle", data: { sessionID: "ses_late" } })
    await flush()

    // Assert — цикл событий мёртв, статус не тронут
    expect(store.find(worktree, idea.id)?.status).toBe("in_progress")
  })
})

describe("session.idle", () => {
  test("marks in_progress ideas of the session done", async () => {
    // Arrange
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "фоновая задача")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_bg" })

    // Act — V2-форма события: {type, data:{sessionID}}
    h.bus.push({ type: "session.idle", data: { sessionID: "ses_bg" } })
    await flush()

    // Assert
    expect(store.find(worktree, idea.id)?.status).toBe("done")
    expect(store.find(worktree, idea.id)?.sessionID).toBe("ses_bg")
  })

  test("ignores ideas of other sessions and non-running statuses", async () => {
    // Arrange
    const worktree = await root()
    const h = await harness(worktree)
    const foreign = store.add(worktree, "чужая сессия")
    store.update(worktree, foreign.id, { status: "in_progress", sessionID: "ses_other" })
    const pending = store.add(worktree, "ещё не запущена")
    store.update(worktree, pending.id, { status: "pending", sessionID: "ses_bg" })

    // Act
    h.bus.push({ type: "session.idle", data: { sessionID: "ses_bg" } })
    await flush()

    // Assert
    expect(store.find(worktree, foreign.id)?.status).toBe("in_progress")
    expect(store.find(worktree, pending.id)?.status).toBe("pending")
  })
})

describe("session.deleted", () => {
  test("returns in_progress ideas of the session to pending and clears binding", async () => {
    // Arrange
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "сессию удалили")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_gone" })

    // Act
    h.bus.push({ type: "session.deleted", data: { sessionID: "ses_gone" } })
    await flush()

    // Assert
    const stored = store.find(worktree, idea.id)
    expect(stored?.status).toBe("pending")
    expect(stored?.sessionID).toBeNull()
  })

  test("legacy info.id form is supported too", async () => {
    // Arrange — sessionIDOf поддерживает v1-форму data.info.id
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "легаси-событие")
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_legacy" })

    // Act
    h.bus.push({ type: "session.deleted", data: { info: { id: "ses_legacy" } } })
    await flush()

    // Assert
    expect(store.find(worktree, idea.id)?.status).toBe("pending")
    expect(store.find(worktree, idea.id)?.sessionID).toBeNull()
  })

  test("session without ideas is a no-op", async () => {
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "не привязана")

    h.bus.push({ type: "session.deleted", data: { sessionID: "ses_empty" } })
    await flush()

    expect(store.find(worktree, idea.id)?.status).toBe("pending")
  })

  test("malformed event without sessionID does not kill the pump (H3)", async () => {
    // Arrange
    const worktree = await root()
    const h = await harness(worktree)
    const idea = store.add(worktree, "целость")

    // Act — data без sessionID и info не должен ронять цикл
    h.bus.push({ type: "session.deleted", data: {} })
    await flush()
    h.bus.push({ type: "session.idle", data: {} })
    await flush()
    h.bus.push({ type: "session.deleted", data: undefined })
    await flush()

    // Assert — pump жив: следующее валидное событие отрабатывает
    store.update(worktree, idea.id, { status: "in_progress", sessionID: "ses_ok" })
    h.bus.push({ type: "session.idle", data: { sessionID: "ses_ok" } })
    await flush()
    expect(store.find(worktree, idea.id)?.status).toBe("done")
  })

  test("store failure inside settle does not kill the pump (H2)", async () => {
    // корень, в котором стор не может создать каталог
    const h = await harness("/proc/idea-inbox-cannot-exist")

    // Act — оба события проглатываются, цикл не падает
    h.bus.push({ type: "session.idle", data: { sessionID: "ses_any" } })
    await flush()
    h.bus.push({ type: "session.deleted", data: { sessionID: "ses_any" } })
    await flush()

    h.cleanup()
  })
})
