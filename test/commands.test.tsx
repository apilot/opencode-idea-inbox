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
function stubApi() {
  const layers: LayerCall[] = []
  const dispatched: string[] = []
  const toasts: string[] = []
  const prompts: string[] = []
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
      dialog: { replace: () => {}, clear: () => {} },
    },
    client: {
      tui: {
        appendPrompt: async ({ text }: { text: string }) => {
          prompts.push(text)
          return {}
        },
        submitPrompt: async () => ({}),
      },
    },
  }
  return { api: api as unknown as TuiPluginApi, layers, dispatched, toasts, prompts, failNext }
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
