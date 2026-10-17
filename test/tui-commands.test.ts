import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createStore, produce } from "solid-js/store/dist/store.js"
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

/**
 * memory-стор как у хоста: реальный solid-store (клиентская сборка через
 * алиас), мутатор — функция над драфтом. Ключ игнорируем — каждый стаб
 * изолирован.
 */
function memoryStore() {
  const [state, setState] = createStore({ ideas: [] as unknown[] })
  return [state, (mutation: (draft: { ideas: unknown[] }) => void) => setState(produce(mutation))] as const
}

/** Минимальный TUI-контекст: слой/диалоги/тосты/роутер пишутся в логи. */
function stubTui(opts: { promptFails?: boolean } = {}) {
  const factories: (() => LayerSnapshot)[] = []
  const prompts: { sessionID: string; text: string }[] = []
  const toasts: { message: string; variant: string }[] = []
  const slots: { append: string }[] = []
  const dialogs = { prompt: [] as unknown[], select: [] as unknown[], confirm: [] as unknown[] }
  // Управляемые ответы диалогов и текущий роут — выставляются в тестах.
  // selectQueue — цепочка ответов (меню → выбор-удаление → …); пустая
  // очередь — одиночный answers.select, как раньше.
  const answers = {
    prompt: undefined as string | undefined,
    select: undefined as string | undefined,
    selectQueue: [] as (string | undefined)[],
    confirm: false,
    route: { type: "session", sessionID: "ses_main" } as { type: string; sessionID?: string },
  }

  const ctx = {
    storage: { memory: (_key: string, _options: { initial: object }) => memoryStore() },
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
          return answers.selectQueue.length > 0 ? answers.selectQueue.shift() : answers.select
        },
        confirm: async (args: unknown) => {
          dialogs.confirm.push(args)
          return answers.confirm
        },
        // footer-action закрывает пикер перед открытием меню — стаб-нооперация
        clear: () => {},
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
    expect(ids(layer(stub))).toEqual(["idea-inbox.open", "idea-inbox.capture", "idea-inbox.remove"])
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
  test("полностью пустой бэклог — toast, диалог не открывается", async () => {
    const dir = await root()
    const stub = stubTui()
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(stub.dialogs.select).toHaveLength(0)
    expect(stub.toasts.some((toast) => toast.message.includes("Бэклог пуст"))).toBeTrue()

    off()
  })

  test("pending пуст, но done есть — пункты удаления доступны и работают", async () => {
    // Arrange — завершённая идея не попадает в пикер, но удаление должно быть доступно
    const dir = await root()
    const done = store.add(dir, "завершённая")
    store.update(dir, done.id, { status: "done" })
    const stub = stubTui()
    stub.answers.selectQueue = [undefined, "__remove__", undefined]
    const off = register(stub.ctx, () => dir)

    // Act 1 — пикер открыт: три пункта удаления, идей нет
    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(stub.dialogs.select).toHaveLength(1)
    const selectArgs = stub.dialogs.select[0] as {
      options: { value: string; title: string }[]
    }
    expect(selectArgs.options.map((option) => option.value)).toEqual([
      "__remove__",
      "__done__",
      "__clearall__",
    ])
    expect(selectArgs.options.find((option) => option.value === "__done__")?.title).toContain("1")

    // Act 2 — повторное открытие пикера, выбор «🗑 Удалить идеи…»
    byId(layer(stub), "idea-inbox.open").run()
    await settle()
    expect(stub.dialogs.select).toHaveLength(3)
    const multiArgs = stub.dialogs.select[2] as { options: { title: string; value: string }[] }
    expect(multiArgs.options.some((option) => option.value === done.id && option.title.startsWith("☐"))).toBeTrue()
    expect(multiArgs.options.some((option) => option.value === "__commit__")).toBeTrue()

    off()
  })

  test("пункт «Очистить завершённые»: confirm удаляет только done, тост с числом", async () => {
    // Arrange — 1 pending, 2 done
    const dir = await root()
    const pending = store.add(dir, "в очереди")
    const doneA = store.add(dir, "готова один")
    const doneB = store.add(dir, "готова два")
    store.update(dir, doneA.id, { status: "done" })
    store.update(dir, doneB.id, { status: "done" })
    const stub = stubTui()
    stub.answers.select = "__done__"
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(store.find(dir, pending.id)?.status).toBe("pending")
    expect(store.find(dir, doneA.id)).toBeUndefined()
    expect(store.find(dir, doneB.id)).toBeUndefined()
    expect(stub.toasts.some((toast) => /удалено: 2/i.test(toast.message))).toBeTrue()

    off()
  })

  test("«Очистить завершённые» без done — info-тост, стор не тронут", async () => {
    const dir = await root()
    store.add(dir, "в очереди")
    const stub = stubTui()
    stub.answers.select = "__done__"
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(store.active(dir)).toHaveLength(1)
    expect(stub.dialogs.confirm).toHaveLength(0)
    expect(stub.toasts).toHaveLength(1)
    expect(stub.toasts[0]?.variant).toBe("info")

    off()
  })

  test("пункт «Очистить всё»: confirm чистит активные, архив остаётся", async () => {
    const dir = await root()
    store.add(dir, "первая")
    store.add(dir, "вторая")
    const archived = store.add(dir, "архивная")
    store.update(dir, archived.id, { status: "documented" })
    const stub = stubTui()
    stub.answers.select = "__clearall__"
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.open").run()
    await settle()

    expect(store.active(dir)).toHaveLength(0)
    expect(store.byStatus(dir, "documented")).toHaveLength(1)
    expect(stub.toasts.some((toast) => toast.message.includes("удалено 2"))).toBeTrue()

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

describe("мульти-выбор удаления (idea-inbox.remove)", () => {
  test("пустой список — toast, диалог не открывается", async () => {
    const dir = await root()
    const stub = stubTui()
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    expect(stub.dialogs.select).toHaveLength(0)
    expect(stub.toasts.some((toast) => toast.message.includes("пуст"))).toBeTrue()

    off()
  })

  test("все активные идеи с ☐, счётчик «отмечено: 0», пункт удаления с нулём", async () => {
    // Arrange — pending, in_progress и done: мульти-выбор показывает ВСЕ активные
    const dir = await root()
    store.add(dir, "в очереди")
    const running = store.add(dir, "в работе")
    store.update(dir, running.id, { status: "in_progress" })
    const stub = stubTui()
    stub.answers.select = undefined
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    const args = stub.dialogs.select[0] as {
      title: string
      options: { value: string; title: string }[]
    }
    expect(args.title).toContain("отмечено: 0")
    expect(args.options).toHaveLength(3)
    expect(
      args.options
        .filter((option) => option.value !== "__commit__")
        .every((option) => option.title.startsWith("☐")),
    ).toBeTrue()
    expect(args.options.find((option) => option.value === "__commit__")?.title).toContain(
      "Удалить отмеченные (0)",
    )

    off()
  })

  test("Enter отмечает идею: галочка в пункте, курсор на месте, счётчик растёт", async () => {
    // Arrange — очередь: первая идея, вторая, Esc
    const dir = await root()
    const first = store.add(dir, "первая")
    const second = store.add(dir, "вторая")
    const stub = stubTui()
    stub.answers.selectQueue = [first.id, second.id, undefined]
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    // Диалогов: старт + два reopen; ничего не удалено, тостов нет
    expect(stub.dialogs.select).toHaveLength(3)
    expect(store.active(dir)).toHaveLength(2)
    expect(stub.toasts).toHaveLength(0)
    // Второй диалог: первая отмечена, курсор на ней
    const reopen1 = stub.dialogs.select[1] as {
      title: string
      options: { value: string; title: string }[]
      current?: string
    }
    expect(reopen1.title).toContain("отмечено: 1")
    expect(reopen1.options.find((option) => option.value === first.id)?.title.startsWith("☑")).toBeTrue()
    expect(reopen1.options.find((option) => option.value === second.id)?.title.startsWith("☐")).toBeTrue()
    expect(reopen1.current).toBe(first.id)
    // Третий: обе отмечены, курсор на второй
    const reopen2 = stub.dialogs.select[2] as {
      title: string
      options: { value: string; title: string }[]
      current?: string
    }
    expect(reopen2.title).toContain("отмечено: 2")
    expect(reopen2.current).toBe(second.id)
    expect(
      reopen2.options
        .filter((option) => option.value === first.id || option.value === second.id)
        .every((option) => option.title.startsWith("☑")),
    ).toBeTrue()

    off()
  })

  test("повторный Enter снимает галочку", async () => {
    const dir = await root()
    const idea = store.add(dir, "единственная")
    const stub = stubTui()
    stub.answers.selectQueue = [idea.id, idea.id, undefined]
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    const reopened = stub.dialogs.select[2] as { title: string; options: { title: string }[] }
    expect(reopened.title).toContain("отмечено: 0")
    expect(reopened.options[0]?.title.startsWith("☐")).toBeTrue()

    off()
  })

  test("«Удалить отмеченные» одним махом: один confirm, тост с числом", async () => {
    // Arrange — отметили две, третья не отмечена, затем пункт удаления
    const dir = await root()
    const first = store.add(dir, "под удаление")
    const second = store.add(dir, "тоже под удаление")
    const keep = store.add(dir, "остаётся")
    const stub = stubTui()
    stub.answers.selectQueue = [first.id, second.id, "__commit__"]
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    expect(store.find(dir, first.id)).toBeUndefined()
    expect(store.find(dir, second.id)).toBeUndefined()
    expect(store.find(dir, keep.id)?.text).toBe("остаётся")
    expect(stub.dialogs.confirm).toHaveLength(1)
    expect(stub.toasts.some((toast) => /удалено: 2/i.test(toast.message))).toBeTrue()

    off()
  })

  test("пункт удаления без отмеченных — info-тост, confirm не открывается, диалог вернулся", async () => {
    const dir = await root()
    store.add(dir, "нетронутая")
    const stub = stubTui()
    stub.answers.selectQueue = ["__commit__"]
    stub.answers.confirm = true
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    expect(store.active(dir)).toHaveLength(1)
    expect(stub.dialogs.confirm).toHaveLength(0)
    expect(stub.toasts).toHaveLength(1)
    expect(stub.toasts[0]?.variant).toBe("info")
    // вернулись к выбору
    expect(stub.dialogs.select).toHaveLength(2)

    off()
  })

  test("отказ в confirm возвращает к выбору с сохранёнными отметками", async () => {
    const dir = await root()
    const idea = store.add(dir, "живая")
    const stub = stubTui()
    stub.answers.selectQueue = [idea.id, "__commit__"]
    stub.answers.confirm = false
    const off = register(stub.ctx, () => dir)

    byId(layer(stub), "idea-inbox.remove").run()
    await settle()

    // Assert — идея цела, диалог вернулся с отметкой на месте
    expect(store.find(dir, idea.id)?.text).toBe("живая")
    expect(stub.dialogs.select).toHaveLength(3)
    const returned = stub.dialogs.select[2] as { options: { value: string; title: string }[] }
    expect(returned.options.find((option) => option.value === idea.id)?.title.startsWith("☑")).toBeTrue()

    off()
  })
})
