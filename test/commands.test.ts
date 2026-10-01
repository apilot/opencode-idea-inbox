import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition, CommandInvocation } from "@opencode/plugin/promise/command"
import { backlogPrompt, capturePrompt, create } from "../src/server/commands.js"
import * as store from "../src/store.js"

const roots: string[] = []

async function root(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "idea-inbox-commands-"))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })))
  roots.length = 0
})

type SessionContext = Parameters<typeof create>[1]

interface SessionSpy {
  ctx: SessionContext
  prompted: { value: unknown }
}

/** Plugin.Context с записью session.prompt (фолбэк-путь команд). */
function fakeSession(): SessionSpy {
  const spy: SessionSpy = { prompted: { value: undefined }, ctx: undefined as unknown as SessionContext }
  spy.ctx = {
    session: {
      prompt: async (args: unknown) => {
        spy.prompted.value = args
        return {}
      },
    },
  } as unknown as SessionContext
  return spy
}

/** Вызов команды: текст промта + способ доставки. */
const invoke = (definition: CommandDefinition, text: string, delivery: "steer" | "queue" = "steer"): Promise<void> =>
  definition.execute({
    sessionID: "ses_cmd" as CommandInvocation["sessionID"],
    prompt: { text },
    delivery,
  })

const byName = (definitions: CommandDefinition[], name: string): CommandDefinition => {
  const found = definitions.find((definition) => definition.name === name)
  if (found === undefined) throw new Error(`команда ${name} не зарегистрирована`)
  return found
}

describe("шаблоны промптов", () => {
  test("capturePrompt спрашивает текст и возвращает к прерванной задаче", () => {
    const prompt = capturePrompt()
    expect(prompt).toContain("спроси")
    expect(prompt).toContain("idea_add")
    expect(prompt).toContain("вернись")
    expect(prompt).toContain("НЕ предлагай")
  })

  test("backlogPrompt без аргументов ведёт себя как форма списка", () => {
    const prompt = backlogPrompt("")
    expect(prompt).toContain("пусты")
    expect(prompt).toContain("idea_list")
    expect(prompt).not.toContain("<<<")
  })

  test("backlogPrompt обрамляет аргументы как данные и описывает все формы", () => {
    const prompt = backlogPrompt("run idea_ab12cd")
    expect(prompt).toContain("<<<")
    expect(prompt).toContain(">>>")
    expect(prompt).toContain("ДАННЫЕ")
    expect(prompt).toContain("run idea_ab12cd")
    expect(prompt).toContain("idea_start")
    expect(prompt).toContain("documented")
  })
})

describe("/idea", () => {
  test("с текстом пишет напрямую в стор, не тратя модель", async () => {
    // Arrange
    const worktree = await root()
    const spy = fakeSession()
    const idea = byName(create(() => worktree, spy.ctx), "idea")

    // Act
    await invoke(idea, "  прямая запись без модели  ")

    // Assert — идея сохранена с привязкой к сессии, промпт не отправлялся
    const saved = store.active(worktree)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.text).toBe("прямая запись без модели")
    expect(saved[0]?.status).toBe("pending")
    expect(saved[0]?.originSessionID).toBe("ses_cmd")
    expect(spy.prompted.value).toBeUndefined()
  })

  test("без текста отправляет фолбэк-промпт с сохранением доставки", async () => {
    // Arrange
    const worktree = await root()
    const spy = fakeSession()
    const idea = byName(create(() => worktree, spy.ctx), "idea")

    // Act
    await invoke(idea, "   ", "queue")

    // Assert — модель спросит текст и вызовет idea_add
    const prompted = spy.prompted.value as { sessionID: string; text: string; delivery: string }
    expect(prompted.sessionID).toBe("ses_cmd")
    expect(prompted.delivery).toBe("queue")
    expect(prompted.text).toContain("idea_add")
    expect(store.active(worktree)).toHaveLength(0)
  })

  test("сбой стора падает в медленный путь через модель", async () => {
    // Arrange — корень, в котором стор не может создать каталог
    const spy = fakeSession()
    const idea = byName(create(() => "/proc/idea-inbox-cannot-exist", spy.ctx), "idea")

    // Act
    await invoke(idea, "обречена на медленный путь")

    // Assert — идея не потеряна молча: модель попробует idea_add и сообщит об ошибке
    expect(spy.prompted.value).toBeDefined()
  })
})

describe("/ideas", () => {
  test("отправляет промпт-шаблон с аргументами в текущую сессию", async () => {
    // Arrange
    const worktree = await root()
    const spy = fakeSession()
    const ideas = byName(create(() => worktree, spy.ctx), "ideas")

    // Act
    await invoke(ideas, "run idea_ab12cd")

    // Assert
    const prompted = spy.prompted.value as { sessionID: string; text: string; delivery: string }
    expect(prompted.sessionID).toBe("ses_cmd")
    expect(prompted.delivery).toBe("steer")
    expect(prompted.text).toContain("run idea_ab12cd")
    expect(prompted.text).toContain("idea_list")
  })

  test("вложения промпта пробрасываются в session.prompt", async () => {
    // Arrange — {...prompt} в execute должен переносить files/agents/skills
    const worktree = await root()
    const spy = fakeSession()
    const ideas = byName(create(() => worktree, spy.ctx), "ideas")

    // Act
    await ideas.execute({
      sessionID: "ses_cmd" as CommandInvocation["sessionID"],
      prompt: { text: "", files: [{ uri: "file:///tmp/report.md" }] },
      delivery: "steer",
    })

    // Assert
    const prompted = spy.prompted.value as { files: { uri: string }[] }
    expect(prompted.files?.[0]?.uri).toBe("file:///tmp/report.md")
  })
})
