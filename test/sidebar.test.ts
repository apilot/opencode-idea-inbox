import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createStore, produce } from "solid-js/store/dist/store.js"
import type { Plugin } from "@opencode/plugin/tui"
import { register } from "../src/tui/sidebar.js"
import * as store from "../src/store.js"

/**
 * Живой рендер-тест сайдбара: настоящий @opentui/solid-рендер (testRender),
 * настоящий стор (SQLite в tempdir), настоящий poll-таймер. Проверяем
 * главный контракт пользовательского UX: идея, добавленная БЕЗ перемонти-
 * рования сайдбара (capture-хоткеем, тулом агента из другой сессии),
 * появляется на экране сама — свежим кадром, без переоткрытия сайдбара.
 *
 * Кадры берём captureCharFrame после wall-clock сна: проходы waitForFrame
 * длятся ~1мс каждый, poll-интервал (25мс в тестах) между ними не
 * простреливается — таймер голодает и предикат не дожидается.
 */

const roots: string[] = []
const renders: { dispose: () => void }[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Кадр после 3+ poll-тиков: состояние долетело до стора, рендер сброшен во flush. */
async function frameOf(tui: { flush: () => Promise<void>; captureCharFrame: () => string }): Promise<string> {
  await sleep(90)
  await tui.flush()
  return tui.captureCharFrame()
}

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-sb-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  renders.forEach((r) => r.dispose())
  renders.length = 0
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

/** Минимальный стаб TUI-контекста: забираем render слота, тема — реальные RGBA. */
function stubTui() {
  const claims: { append: string; render: () => unknown }[] = []
  const [memoryState, setMemoryState] = createStore({ ideas: [] as unknown[] })
  const ctx = {
    ui: {
      slot: (claim: { append: string; render: () => unknown }) => {
        claims.push(claim)
        return () => {}
      },
    },
    // memory-стор как у хоста: реальный solid-store (клиентская сборка),
    // мутатор — produce-семантика над драфтом
    storage: {
      memory: (_key: string, _options: { initial: object }) =>
        [
          memoryState,
          (mutation: (draft: { ideas: unknown[] }) => void) => setMemoryState(produce(mutation)),
        ] as const,
    },
    data: { on: () => () => {} },
    theme: {
      text: {
        base: RGBA.fromHex("#ffffff"),
        muted: RGBA.fromHex("#888888"),
        feedback: {
          info: { base: RGBA.fromHex("#88aaff") },
          success: { base: RGBA.fromHex("#88ff88") },
        },
      },
    },
  } as unknown as Plugin.Context
  return { ctx, claims }
}

describe("сайдбар: живой рендер бэклога", () => {
  test("свежая идея появляется в кадре после poll-тиков, без перемонтирования", async () => {
    // Arrange — стор с одной идеей, сайдбар смонтирован
    const dir = await root()
    store.add(dir, "уже в бэклоге")
    const { ctx, claims } = stubTui()
    const off = register(ctx, () => dir, { pollMs: 25 })
    const tui = await testRender(() => claims[0]!.render() as never)
    renders.push({ dispose: () => tui.renderer.destroy() })

    const before = await frameOf(tui)
    expect(before).toContain("уже в бэклоге")

    // Act — добавляем свежую идею мимо UI (как capture-хоткей или тул агента)
    store.add(dir, "свежая мысль")
    const after = await frameOf(tui)

    // Assert — тот же смонтированный сайдбар показывает обе строки и счётчик 2
    expect(after).toContain("уже в бэклоге")
    expect(after).toContain("свежая мысль")
    expect(after).toMatch(/Idea Inbox \(2\)/)
    off()
  })

  test("удаление идеи исчезает из кадра само", async () => {
    // Arrange
    const dir = await root()
    const idea = store.add(dir, "временная мысль")
    const { ctx, claims } = stubTui()
    const off = register(ctx, () => dir, { pollMs: 25 })
    const tui = await testRender(() => claims[0]!.render() as never)
    renders.push({ dispose: () => tui.renderer.destroy() })

    const before = await frameOf(tui)
    expect(before).toContain("временная мысль")

    // Act — удаляем мимо UI (команда remove из другой сессии)
    store.remove(dir, idea.id)
    const after = await frameOf(tui)

    // Assert — строка ушла, счётчик обнулился, пусто-подсказка вернулась
    expect(after).not.toContain("временная мысль")
    expect(after).toMatch(/Idea Inbox \(0\)/)
    expect(after).toContain("пусто")
    off()
  })

  test("счётчик Idea Inbox (n) растёт без переоткрытия", async () => {
    // Arrange — пустой бэклог
    const dir = await root()
    const { ctx, claims } = stubTui()
    const off = register(ctx, () => dir, { pollMs: 25 })
    const tui = await testRender(() => claims[0]!.render() as never)
    renders.push({ dispose: () => tui.renderer.destroy() })

    const empty = await frameOf(tui)
    expect(empty).toMatch(/Idea Inbox \(0\)/)

    // Act — две идеи подряд
    store.add(dir, "первая после пустого")
    const one = await frameOf(tui)
    expect(one).toMatch(/Idea Inbox \(1\)/)
    store.add(dir, "вторая после пустого")
    const two = await frameOf(tui)

    // Assert
    expect(two).toMatch(/Idea Inbox \(2\)/)
    expect(two).toContain("первая после пустого")
    expect(two).toContain("вторая после пустого")
    off()
  })
})
