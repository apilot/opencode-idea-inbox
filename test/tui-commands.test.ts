import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin/tui"
import { register } from "../src/tui/commands.js"
import * as store from "../src/store.js"

/**
 * V2-порт тестов TUI-команд. V1-специфика (registerLayer с биндингами,
 * delete-mode, программное открытие палитры, DialogPrompt-хак) в V2 исчезла —
 * здесь проверяем новый контракт: реактивный keymap-слой, диалоги ui.dialog,
 * mission через client.session.prompt, guard устаревших take-команд.
 */

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-tui-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

interface LayerCommand {
  id: string
  title: string
  bind?: string
  run: () => void
}

interface LayerSnapshot {
  mode: string
  priority: number
  commands: LayerCommand[]
}

/** Минимальный TUI-контекст: слой/диалоги/тосты/роутер пишутся в логи. */
function stubTui(opts: { promptFails?: boolean } = {}) {
  const factories: (() => LayerSnapshot)[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const toasts: { message: string; variant: string }[] = []
  const slots: { append: string }[] = []
  const dialogs = { prompt: [] as unknown[], select: [] as unknown[], confirm: [] as unknown[] }
  // Управляемые ответы диалогов и текущий роут — выставляются в тестах.
  const answers = {
    prompt: undefined as string | undefined,
    select: undefined as string | undefined,
    confirm: false,
    route: { type: "session", sessionID: "ses_main" } as { type: string; sessionID?: string },
  }

  const ctx = {
    keymap: {
      layer: (factory: () => LayerSnapshot) => {
        factories.push(factory)
        return () => {}
      },
    },
    ui: {
      // Слой keymap создаётся только внутри смонтированного render()
      // (вне дерева TUI хост бросает «Keymap.Provider is missing») —
      // стаб монтирует render немедленно, как это делает хост.
      slot: (claim: { append: string; render: () => unknown }) => {
        slots.push({ append: claim.append })
        claim.render()
        return () => {}
      },
      toast: { show: (toast: { message: string; variant: string }) => toasts.push(toast) },
      dialog: {
        prompt: async (args: unknown) => {
          dialogs.prompt.push(args)
          return answers.prompt
        },
        select: async (args: unknown) => {
          dialogs.select.push(args)
          return answers.select
        },
        confirm: async (args: unknown) => {
          dialogs.confirm.push(args)
          return answers.confirm
        },
      },
      router: { current: () => answers.route },
    },
    client: {
      session: {
        prompt: async (args: { sessionID: string; text: string }) => {
          if (opts.promptFails) throw new Error("submit boom")
          prompts.push(args)
          return {}
        },
      },
    },
  } as unknown as Plugin.Context

  return { ctx, factories, prompts, toasts, answers, dialogs, slots }
}

/** Хост читает слой повторно при изменении сигнала — эмулируем это вручную. */
const layer = (stub: ReturnType<typeof stubTui>): LayerSnapshot => {
  const factory = stub.factories[0]
  if (factory === undefined) throw new Error("слой не зарегистрирован")
  return factory()
}

const byId = (snapshot: LayerSnapshot, id: string): LayerCommand => {
  const found = snapshot.commands.find((command) => command.id === id)
  if (found === undefined) throw new Error(`команда ${id} не найдена в слое`)
  return found
}

/** run()-колбэки асинхронны внутри — даём микротаскам прокрутиться. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

const ids = (snapshot: LayerSnapshot): string[] => snapshot.commands.map((command) => command.id)

describe("keymap-слой", () => {
  test("take только по pending, статический хвост, биндинги leader+i/z", async () => {
    // Arrange
    const dir = await root()
    const pending = store.add(dir, "первая мысль")
    const running = store.add(dir, "в работе")
    store.update(dir, running.id, { status: "in_progress" })
    const stub = stubTui()

    // Act
    const off = register(stub.ctx, () => dir)
    const snapshot = layer(stub)

    // Assert — состав, порядок и биндинги
    expect(snapshot.mode).toBe("global")
    expect(snapshot.priority).toBe(100)
    // Слой обязан владеть смонтированный компонент слота app
    expect(stub.slots).toEqual([{ append: "app" }])
    expect(ids(snapshot)).toEqual([
      `idea-inbox.take.${pending.id}`,
      "idea-inbox.open",
      "idea-inbox.capture",
      "idea-inbox.remove",
      "idea-inbox.clear",
    ])
    expect(snapshot.commands[0]?.title).toContain("первая мысль")
    expect(byId(snapshot, "idea-inbox.open").bind).toBe("<leader>i")
    expect(byId(snapshot, "idea-inbox.capture").bind).toBe("<leader>z")

    off()
  })

  test("пустой бэклог — слой всё равно зарегистрирован со статическим хвостом", async () => {
    const dir = await root()
    const stub = stubTui()

    const off = register(stub.ctx, () => dir)

    expect(stub.factories).toHaveLength(1)
    expect(ids(layer(stub))).toEqual(["idea-inbox.open", "idea-inbox.capture", "idea-inbox.remove", "idea-inbox.clear"])
    off()
  })

  test("poll: новая идея доезжает до слоя, статусы слой не перестраивают", async () => {
    // Arrange — быстрый poll: сигнатура от статусов не зависит
    const dir = await root()
    const idea = store.add(dir, "переживёт статусы")
    const stub = stubTui()
    const off = register(stub.ctx, () => dir, { pollMs: 20 })
    expect(ids(layer(stub))).toContain(`idea-inbox.take.${idea.id}`)

    // Act 1 — pending → in_progress: сигнатура не меняется, слой не трогаем
    store.update(dir, idea.id, { status: "in_progress" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(ids(layer(stub))).toContain(`idea-inbox.take.${idea.id}`)

    // Act 2 — новая идея: poll-тик обновляет сигнал, слой видит свежую take-команду
    const fresh = store.add(dir, "вторая")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(ids(layer(stub))).toContain(`idea-inbox.take.${fresh.id}`)

    off()
  })
})

describe("take", () => {
  test("отправляет миссию с протоколом idea_update в текущую сессию", async () => {
    // Arrange
    const dir = await root()
    const idea = store.add(dir, "задача из пикера")
    const stub = stubTui()

    const off = register(stub.ctx, () => dir)

    // Act
    byId(layer(stub), `idea-inbox.take.${idea.id}`).run()
    await settle()

    // Assert — миссия содержит id, обе инструкции статусов и анти-инъекцию
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]?.sessionID).toBe("ses_main")
    expect(stub.prompts[0]?.text).toContain(idea.id)
    expect(stub.prompts[0]?.text).toContain("status=in_progress")
    expect(stub.prompts[0]?.text).toContain("status=done")
    expect(stub.prompts[0]?.text).toContain("<<<")
    expect(stub.prompts[0]?.text).toContain(">>>")
    expect(stub.prompts[0]?.text).toContain("ДАННЫЕ")
    expect(stub.toasts.some((toast) => toast.message.includes("▶"))).toBeTrue()

    off()
  })

  test("сбой отправки — ровно один error-toast, success с ▶ отсутствует", async () => {
    // Arrange — регрессия двойного тоста из v1
    const dir = await root()
    const idea = store.add(dir, "падающий сабмит")
    const stub = stubTui({ promptFails: true })

    const off = register(stub.ctx, () => dir)

    // Act
    byId(layer(stub), `idea-inbox.take.${idea.id}`).run()
    await settle()

    // Assert
    expect(stub.toasts).toHaveLength(1)
    expect(stub.toasts[0]?.message).toContain("Не удалось отправить промт")
    expect(stub.toasts.some((toast) => toast.message.includes("▶"))).toBeFalse()

    off()
  })

  test("guard устаревшей команды: done-идея не запускается, toast с объяснением", async () => {
    // Arrange — слой построен, пока идея была pending
    const dir = await root()
    const idea = store.add(dir, "уже выполнена")
    const stub = stubTui()
    const off = register(stub.ctx, () => dir)

    // Act — статус сменился, слой не перестроен (guard должен перехватить)
    store.update(dir, idea.id, { status: "done" })
    byId(layer(stub), `idea-inbox.take.${idea.id}`).run()
    await settle()

    // Assert
    expect(stub.prompts).toHaveLength(0)
    expect(stub.toasts.some((toast) => /уже не в очереди/.test(toast.message))).toBeTrue()

    off()
  })

  test("без открытой сессии — error-toast, промт не уходит", async () => {
    const dir = await root()
    const idea = store.add(dir, "некуда отправлять")
    const stub = stubTui()
    stub.answers.route = { type: "home" }
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), `idea-inbox.take.${idea.id}`).run()
    await settle()

    expect(stub.prompts).toHaveLength(0)
    expect(stub.toasts.some((toast) => toast.message.includes("Откройте сессию"))).toBeTrue()

    off()
  })
})

describe("capture (<leader>z, dialog.prompt)", () => {
  test("непустой текст сохраняется обрезанной строкой, toast с ✓", async () => {
    const dir = await root()
    const stub = stubTui()
    stub.answers.prompt = "  записанная мысль  "
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.capture").run()
    await settle()

    const saved = store.active(dir)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.text).toBe("записанная мысль")
    expect(saved[0]?.status).toBe("pending")
    expect(stub.toasts.some((toast) => toast.message.startsWith("✓"))).toBeTrue()

    off()
  })

  test("пустой ответ ничего не пишет и не тостит", async () => {
    const dir = await root()
    const stub = stubTui()
    stub.answers.prompt = "   "
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.capture").run()
    await settle()

    expect(store.active(dir)).toHaveLength(0)
    expect(stub.toasts).toHaveLength(0)

    off()
  })

  test("сбой стора показывает error-toast", async () => {
    // Arrange — слой поднят на живом корне, стор «умер» к моменту ввода
    let dir = await root()
    const stub = stubTui()
    stub.answers.prompt = "обречена"
    const off = register(stub.ctx, () => dir)
    dir = "/proc/idea-inbox-cannot-exist"

    byId(layer(stub), "idea-inbox.capture").run()
    await settle()

    expect(stub.toasts.some((toast) => toast.message.includes("Не удалось сохранить идею"))).toBeTrue()

    off()
  })
})

describe("open (пикер бэклога)", () => {
  test("пустой бэклог — toast, диалог не открывается", async () => {
    const dir = await root()
    const stub = stubTui()
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(stub.dialogs.select).toHaveLength(0)
    expect(stub.toasts.some((toast) => toast.message.includes("Бэклог пуст"))).toBeTrue()

    off()
  })

  test("выбор pending-идеи отправляет миссию", async () => {
    const dir = await root()
    const idea = store.add(dir, "выбор из пикера")
    store.add(dir, "в работе").id // вторая тоже pending — порядок списка не важен
    const stub = stubTui()
    stub.answers.select = idea.id
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    // Диалог получил опцию с id, миссия ушла в текущую сессию
    const selectArgs = stub.dialogs.select[0] as { options: { value: string }[] }
    expect(selectArgs.options.some((option) => option.value === idea.id)).toBeTrue()
    expect(stub.prompts).toHaveLength(1)
    expect(stub.prompts[0]?.text).toContain(idea.id)

    off()
  })
})

describe("remove и clear", () => {
  test("remove удаляет выбранную идею", async () => {
    const dir = await root()
    const idea = store.add(dir, "мусор")
    const stub = stubTui()
    stub.answers.select = idea.id
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    expect(store.find(dir, idea.id)).toBeUndefined()
    expect(stub.toasts.some((toast) => toast.message.includes("удалено"))).toBeTrue()

    off()
  })

  test("clear с подтверждением чистит активные, архив остаётся", async () => {
    const dir = await root()
    store.add(dir, "первая")
    store.add(dir, "вторая")
    const archived = store.add(dir, "архивная")
    store.update(dir, archived.id, { status: "documented" })
    const stub = stubTui()
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.clear").run()
    await settle()

    expect(store.active(dir)).toHaveLength(0)
    expect(store.byStatus(dir, "documented")).toHaveLength(1)
    expect(stub.toasts.some((toast) => toast.message.includes("удалено 2"))).toBeTrue()

    off()
  })

  test("clear без подтверждения не трогает стор", async () => {
    const dir = await root()
    store.add(dir, "останется")
    const stub = stubTui()
    stub.answers.confirm = false
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.clear").run()
    await settle()

    expect(store.active(dir)).toHaveLength(1)
    expect(stub.toasts).toHaveLength(0)

    off()
  })
})
