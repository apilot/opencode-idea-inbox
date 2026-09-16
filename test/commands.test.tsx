import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { register } from "../src/tui/commands.js"
import * as store from "../src/store.js"

const roots: string[] = []
const PALETTE = "command.palette.show"

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-tui-"))
  roots.push(dir)
  return dir
}

interface LayerCall {
  commands: { name: string; title: string; run: () => void }[]
  bindings: { key: string; cmd: string }[]
  disposed?: boolean
}

/** Минимальный api: keymap/ui/client пишутся в логи, рендер не нужен. */
function stubApi(opts: { submitFails?: boolean } = {}) {
  const layers: LayerCall[] = []
  const dispatched: string[] = []
  const toasts: string[] = []
  const prompts: string[] = []
  const dialogRenders: (() => unknown)[] = []
  const dialogPrompts: Record<string, unknown>[] = []
  const dialogClears = { count: 0 }
  let failNextCount = 0
  const failNext = (count: number): void => {
    failNextCount = count
  }
  const api = {
    keymap: {
      registerLayer: (config: LayerCall) => {
        if (failNextCount > 0) {
          failNextCount -= 1
          throw new Error("keymap boom")
        }
        layers.push(config)
        const index = layers.length - 1
        return () => {
          layers[index]!.disposed = true
        }
      },
      dispatchCommand: (cmd: string) => dispatched.push(cmd),
    },
    ui: {
      toast: ({ message }: { message: string }) => toasts.push(message),
      dialog: {
        replace: (render: () => unknown) => dialogRenders.push(render),
        clear: () => {
          dialogClears.count += 1
        },
      },
      // solid-рантайм (jsx → createComponent) вызывает функцию-компонент
      // синхронно с props: вызов render-колбэка отдаёт onConfirm без рендера
      DialogPrompt: (props: Record<string, unknown>) => {
        dialogPrompts.push(props)
        return null
      },
    },
    client: {
      tui: {
        appendPrompt: async ({ text }: { text: string }) => {
          prompts.push(text)
          return {}
        },
        submitPrompt: async () => {
          if (opts.submitFails) throw new Error("submit boom")
          return {}
        },
      },
    },
  }
  return {
    api: api as unknown as TuiPluginApi,
    layers,
    dispatched,
    toasts,
    prompts,
    failNext,
    dialogRenders,
    dialogPrompts,
    dialogClears,
  }
}

/** run()-колбэки делают структурные операции через setTimeout(0). */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 10))

const names = (layer: LayerCall): string[] => layer.commands.map((command) => command.name)

const byName = (layer: LayerCall, name: string) => layer.commands.find((command) => command.name === name)

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

describe("palette layer (normal mode)", () => {
  test("offers take commands for pending only, fixed tail, leader+i/z bindings", async () => {
    // Arrange
    const dir = await root()
    const pending = store.add(dir, "первая мысль")
    const running = store.add(dir, "в работе")
    store.update(dir, running.id, { status: "in_progress" })

    // Act
    const { api, layers } = stubApi()
    const off = register(api, () => dir)

    // Assert — take только по pending, хвост фиксирован, биндинги на месте
    expect(layers).toHaveLength(1)
    const layer = layers[0] as LayerCall
    expect(names(layer)).toEqual([
      `idea-inbox:take:${pending.id}`,
      "idea-inbox:new",
      "idea-inbox:capture",
      "idea-inbox:delete",
      "idea-inbox:open",
      "idea-inbox:clear",
    ])
    expect(layer.commands[0]?.title).toContain("первая мысль")
    expect(layer.bindings).toEqual([
      { key: "<leader>i", cmd: "idea-inbox:open" },
      { key: "<leader>z", cmd: "idea-inbox:capture" },
    ])

    off()
  })

  test("take command submits mission with idea_update protocol", async () => {
    // Arrange
    const dir = await root()
    const idea = store.add(dir, "задача из палитры")

    const { api, layers, prompts } = stubApi()
    const off = register(api, () => dir)

    // Act
    layers[0]?.commands[0]?.run()
    await settle()

    // Assert — миссия содержит id и обе инструкции статусов
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain(idea.id)
    expect(prompts[0]).toContain("status=in_progress")
    expect(prompts[0]).toContain("status=done")
    // текст идеи обрамлён как данные (анти-инъекция)
    expect(prompts[0]).toContain("<<<")
    expect(prompts[0]).toContain(">>>")
    expect(prompts[0]).toContain("ДАННЫЕ")

    off()
  })

  test("take command failure shows exactly one error toast, no success toast", async () => {
    // Arrange — submitPrompt отклоняется: success-toast «▶ … отправлено» не
    // должен появиться (регрессия двойного тоста: сначала «отправлено»,
    // затем «не удалось»)
    const dir = await root()
    store.add(dir, "падающий сабмит")

    const { api, layers, toasts } = stubApi({ submitFails: true })
    const off = register(api, () => dir)

    // Act
    layers[0]?.commands[0]?.run()
    await settle()

    // Assert — ровно один error-toast, success-тост с ▶ отсутствует
    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain("Не удалось отправить промт")
    expect(toasts.some((message) => message.includes("▶"))).toBeFalse()

    off()
  })

  test("new command appends /idea into the prompt line without submitting", async () => {
    // Arrange
    const dir = await root()
    const { api, layers, prompts } = stubApi()
    const off = register(api, () => dir)

    // Act
    byName(layers[0] as LayerCall, "idea-inbox:new")?.run()
    await settle()

    // Assert — только подстановка подсказки, автосабмита нет (допечатает сам)
    expect(prompts).toEqual(["/idea "])

    off()
  })
})

describe("delete mode", () => {
  test("enter lists every active idea (any status) plus back command", async () => {
    // Arrange
    const dir = await root()
    const pending = store.add(dir, "ожидает")
    const running = store.add(dir, "в работе")
    store.update(dir, running.id, { status: "in_progress" })
    const done = store.add(dir, "готово")
    store.update(dir, done.id, { status: "done" })
    store.update(dir, store.add(dir, "в архиве").id, { status: "documented" })

    const { api, layers, dispatched } = stubApi()
    const off = register(api, () => dir)

    // Act
    byName(layers[0] as LayerCall, "idea-inbox:delete")?.run()
    await settle()

    // Assert — все активные (○ ◐ ●), архив не участвует, палитра открыта
    const deleteLayer = layers[layers.length - 1] as LayerCall
    expect(names(deleteLayer)).toEqual([
      `idea-inbox:rm:${pending.id}`,
      `idea-inbox:rm:${running.id}`,
      `idea-inbox:rm:${done.id}`,
      "idea-inbox:back",
    ])
    expect(dispatched).toEqual([PALETTE])

    off()
  })

  test("removing one by one re-opens palette until backlog is empty, then restores normal layer", async () => {
    // Arrange
    const dir = await root()
    const first = store.add(dir, "мусор один")
    const second = store.add(dir, "мусор два")

    const { api, layers, dispatched, toasts } = stubApi()
    const off = register(api, () => dir)
    byName(layers[0] as LayerCall, "idea-inbox:delete")?.run()
    await settle()

    // Act — удаляем первую: остаток непуст → палитра с rm-командами переоткрыта
    ;(layers[1] as LayerCall).commands[0]?.run()
    await settle()
    expect(store.find(dir, first.id)).toBeUndefined()
    expect(store.find(dir, second.id)?.status).toBe("pending")
    expect(dispatched).toEqual([PALETTE, PALETTE])

    // Удаляем последнюю: остаток пуст → нормальный слой + toast
    ;(layers[2] as LayerCall).commands[0]?.run()
    await settle()
    expect(store.find(dir, second.id)).toBeUndefined()
    const finalLayer = layers[layers.length - 1] as LayerCall
    expect(names(finalLayer)).not.toContain("idea-inbox:back")
    expect(names(finalLayer)).toContain("idea-inbox:new")
    expect(toasts.some((message) => message.includes("Список пуст"))).toBeTrue()

    off()
  })

  test("back command re-registers normal layer and reopens palette", async () => {
    // Arrange
    const dir = await root()
    store.add(dir, "останется")

    const { api, layers, dispatched } = stubApi()
    const off = register(api, () => dir)
    byName(layers[0] as LayerCall, "idea-inbox:delete")?.run()
    await settle()

    // Act
    byName(layers[1] as LayerCall, "idea-inbox:back")?.run()
    await settle()

    // Assert — слой нормальный, идея на месте, палитра открыта
    const finalLayer = layers[layers.length - 1] as LayerCall
    expect(names(finalLayer)[0]).toMatch(/^idea-inbox:take:/)
    expect(store.active(dir)).toHaveLength(1)
    expect(dispatched).toEqual([PALETTE, PALETTE])

    off()
  })
})

describe("clear command", () => {
  test("wipes active ideas, keeps documented archive, restores normal layer", async () => {
    // Arrange
    const dir = await root()
    store.add(dir, "первая")
    store.add(dir, "вторая")
    const archived = store.add(dir, "архивная")
    store.update(dir, archived.id, { status: "documented" })

    const { api, layers, toasts } = stubApi()
    const off = register(api, () => dir)

    // Act
    byName(layers[0] as LayerCall, "idea-inbox:clear")?.run()
    await settle()

    // Assert
    expect(store.active(dir)).toHaveLength(0)
    expect(store.byStatus(dir, "documented")).toHaveLength(1)
    expect(toasts.some((message) => message.includes("удалено 2"))).toBeTrue()
    expect(names(layers[layers.length - 1] as LayerCall)).toContain("idea-inbox:new")

    off()
  })
})

describe("capture (модал <leader>z, DialogPrompt)", () => {
  /** Модал ставится без setTimeout: render-колбэк отдаёт props синхронно. */
  function openCapture(layers: LayerCall[], dialogRenders: (() => unknown)[], dialogPrompts: Record<string, unknown>[]) {
    byName(layers[0] as LayerCall, "idea-inbox:capture")?.run()
    expect(dialogRenders).toHaveLength(1)
    dialogRenders[0]?.()
    return dialogPrompts[0] as { onConfirm: (text: string) => void }
  }

  test("непустой текст сохраняется в стор обрезанной строкой, toast с ✓, диалог закрыт", async () => {
    // Arrange
    const dir = await root()
    const { api, layers, dialogRenders, dialogPrompts, dialogClears, toasts } = stubApi()
    const off = register(api, () => dir)

    // Act — Enter в модале
    const prompt = openCapture(layers, dialogRenders, dialogPrompts)
    prompt.onConfirm("  записанная мысль  ")

    // Assert — идея persisted в активных, подтверждение, диалог сброшен
    const saved = store.active(dir)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.text).toBe("записанная мысль")
    expect(saved[0]?.status).toBe("pending")
    expect(toasts.some((message) => message.startsWith("✓"))).toBeTrue()
    expect(dialogClears.count).toBe(1)

    off()
  })

  test("whitespace-only подтверждение ничего не пишет и не тостит, диалог закрыт", async () => {
    // Arrange
    const dir = await root()
    const { api, layers, dialogRenders, dialogPrompts, dialogClears, toasts } = stubApi()
    const off = register(api, () => dir)

    // Act
    const prompt = openCapture(layers, dialogRenders, dialogPrompts)
    prompt.onConfirm("   \n\t ")

    // Assert — стор нетронут, модал закрыт, лишних сообщений нет
    expect(store.active(dir)).toHaveLength(0)
    expect(toasts).toHaveLength(0)
    expect(dialogClears.count).toBe(1)

    off()
  })

  test("сбой стора показывает error-toast, диалог всё равно закрыт", async () => {
    // Arrange — слой поднят на живом корне, стор «умер» к моменту Enter
    // (мёртвый корень на регистрации не оставил бы слой вообще: tick глотает ошибку)
    let dir = await root()
    const { api, layers, dialogRenders, dialogPrompts, dialogClears, toasts } = stubApi()
    const off = register(api, () => dir)
    dir = "/proc/idea-inbox-cannot-exist"

    // Act
    const prompt = openCapture(layers, dialogRenders, dialogPrompts)
    prompt.onConfirm("обречена")

    // Assert — ошибка пользователю, модал не залипает
    expect(toasts.some((message) => message.includes("Не удалось сохранить идею"))).toBeTrue()
    expect(dialogClears.count).toBe(1)

    off()
  })
})

describe("layer invariants (регрессия смерти leader-биндингов)", () => {
  test("every registered layer: bindings reference commands present in that layer; delete layer has none", async () => {
    // Arrange — проходим нормальный режим и режим удаления
    const dir = await root()
    store.add(dir, "мысль")
    const { api, layers, dispatched } = stubApi()
    const off = register(api, () => dir)
    byName(layers[0] as LayerCall, "idea-inbox:delete")?.run()
    await settle()
    expect(dispatched).toEqual([PALETTE])

    // Act + Assert — каждый биндинг каждого слоя ссылается на команду СВОЕГО слоя
    expect(layers.length).toBeGreaterThanOrEqual(2)
    for (const layer of layers) {
      const own = new Set(names(layer))
      for (const binding of layer.bindings) {
        expect(own.has(binding.cmd)).toBeTrue()
      }
    }
    const deleteLayer = layers[layers.length - 1] as LayerCall
    expect(deleteLayer.bindings).toBeEmpty()

    off()
  })

  test("failed re-registration keeps previous layer alive and retries later", async () => {
    // Arrange
    const dir = await root()
    store.add(dir, "мысль")
    const { api, layers, failNext } = stubApi()
    const off = register(api, () => dir)
    expect(layers).toHaveLength(1)

    // Act — принудительная перерегистрация (open) падает: keymap бросает
    failNext(1)
    byName(layers[0] as LayerCall, "idea-inbox:open")?.run()
    await settle()

    // Assert — новый слой не создан, прежний ЖИВ (dispose только после успеха)
    expect(layers).toHaveLength(1)
    expect((layers[0] as LayerCall).disposed).not.toBeTrue()

    // Act 2 — повторная попытка успешна: слой перерегистрирован, старый освобождён
    byName(layers[0] as LayerCall, "idea-inbox:open")?.run()
    await settle()
    expect(layers).toHaveLength(2)
    expect((layers[0] as LayerCall).disposed).toBeTrue()
    expect((layers[1] as LayerCall).disposed).not.toBeTrue()
    expect(names(layers[1] as LayerCall)).toContain("idea-inbox:open")

    off()
  })

  test("empty backlog still registers the normal layer with bindings", async () => {
    // Arrange + Act
    const dir = await root()
    const { api, layers } = stubApi()
    const off = register(api, () => dir)

    // Assert — пустой бэклог ≠ отсутствие слоя: биндинги обязаны жить
    expect(layers).toHaveLength(1)
    const layer = layers[0] as LayerCall
    expect(layer.commands.length).toBeGreaterThan(0)
    expect(layer.bindings).toHaveLength(2)

    off()
  })
})

describe("инварианты обновления слоя (регрессия замерзания сайдбара 2026-09-16)", () => {
  test("статусные переходы не перерегистрируют слой", async () => {
    // Arrange — быстрый poll, но сигнатура от статусов не зависит
    const dir = await root()
    const idea = store.add(dir, "переживёт статусы")
    const { api, layers } = stubApi()
    const off = register(api, () => dir, { pollMs: 20 })
    expect(layers).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(layers).toHaveLength(1)

    // Act + Assert — pending → in_progress (делает тул idea_update): слой не тронут
    store.update(dir, idea.id, { status: "in_progress" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(layers).toHaveLength(1)

    // in_progress → done: снова без churn registerLayer/dispose
    store.update(dir, idea.id, { status: "done" })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(layers).toHaveLength(1)

    off()
  })

  test("появление новой идеи перерегистрирует слой со свежей take-командой", async () => {
    // Arrange
    const dir = await root()
    store.add(dir, "первая")
    const { api, layers } = stubApi()
    const off = register(api, () => dir, { pollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(layers).toHaveLength(1)

    // Act
    const second = store.add(dir, "вторая")
    await new Promise((resolve) => setTimeout(resolve, 80))

    // Assert — ровно один rebuild: новый слой знает вторую идею, прежний освобождён
    expect(layers).toHaveLength(2)
    expect(names(layers[1] as LayerCall)).toContain(`idea-inbox:take:${second.id}`)
    expect((layers[0] as LayerCall).disposed).toBeTrue()
    expect((layers[1] as LayerCall).disposed).not.toBeTrue()

    off()
  })

  test("смена текста перерегистрирует слой: take-заголовок показывает новый текст", async () => {
    // Arrange — в отличие от статусов, текст входит в сигнатуру через `${id}:${text}`
    const dir = await root()
    const idea = store.add(dir, "старая формулировка")
    const { api, layers } = stubApi()
    const off = register(api, () => dir, { pollMs: 20 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(layers).toHaveLength(1)

    // Act — правка текста (тулом idea_update / capture-редактированием)
    store.update(dir, idea.id, { text: "свежая формулировка" })
    await new Promise((resolve) => setTimeout(resolve, 80))

    // Assert — ровно один rebuild, take-команда ведёт себя как для новой идеи
    expect(layers).toHaveLength(2)
    const take = (layers[1] as LayerCall).commands.find((command) => command.name === `idea-inbox:take:${idea.id}`)
    expect(take?.title).toContain("свежая формулировка")
    expect(take?.title).not.toContain("старая")
    expect((layers[0] as LayerCall).disposed).toBeTrue()
    expect((layers[1] as LayerCall).disposed).not.toBeTrue()

    off()
  })
})

describe("take staleness guard (команда осталась от старого снапшота палитры)", () => {
  test("take по устаревшей done-идее показывает toast и не отправляет промт", async () => {
    // Arrange — слой построен, пока идея была pending
    const dir = await root()
    const idea = store.add(dir, "уже выполнена")
    const { api, layers, prompts, toasts } = stubApi()
    const off = register(api, () => dir)

    // Act — done слой НЕ перестраивает (в этом суть фикса), take остаётся
    // от старого снапшота; запуск должен быть перехвачен guard-ом
    store.update(dir, idea.id, { status: "done" })
    layers[0]?.commands[0]?.run()
    await settle()

    // Assert — промт не ушёл в основное окно, пользователь получил объяснение
    expect(prompts).toHaveLength(0)
    expect(toasts.some((message) => /уже не в очереди/.test(message))).toBeTrue()

    off()
  })
})
