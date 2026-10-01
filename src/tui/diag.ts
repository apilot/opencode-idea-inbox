import fs from "node:fs"
import path from "node:path"

const MAX_BYTES = 128 * 1024
export const BUILD = "0.5.3"

export interface Diag {
  log(event: string, detail?: Record<string, unknown>): void
}

/**
 * Диагностика TUI-части: append-only лог рядом со стором
 * (<worktree>/.opencode/idea-inbox/diag.log). Никогда не бросает —
 * диагностика не имеет права ронять плагин. Ротация по размеру.
 */
export function create(root: () => string | undefined): Diag {
  const file = (): string | undefined => {
    const worktree = root()
    if (worktree === undefined || worktree === "" || worktree === "/") return undefined
    return path.join(worktree, ".opencode", "idea-inbox", "diag.log")
  }
  // Каталог создаёт и стор (connect → mkdirSync), но cmd.register пишется
  // ДО первого тика — на свежем worktree каталога ещё нет. Ленивый
  // одноразовый mkdir: иначе первые строки лога молча терялись бы.
  let dirReady = false
  return {
    log(event, detail) {
      const target = file()
      if (target === undefined) return
      try {
        if (!dirReady) {
          fs.mkdirSync(path.dirname(target), { recursive: true })
          dirReady = true
        }
        try {
          const size = fs.statSync(target).size
          if (size > MAX_BYTES) fs.writeFileSync(target, "")
        } catch {
          // файла ещё нет — не ошибка
        }
        const line = `${new Date().toISOString()} ${event}${detail === undefined ? "" : ` ${JSON.stringify(detail)}`}\n`
        fs.appendFileSync(target, line)
      } catch {
        // тихо: диск/права — не наша забота
      }
    },
  }
}
