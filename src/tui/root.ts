import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { execSync } from "node:child_process"

/**
 * Резолвер корня проекта для TUI-части.
 *
 * api.state.path.worktree в TUI-процессе — статический снимок на момент
 * активации плагинов и навсегда "/" (проверено на 1.18.30). Реальный корень
 * берём из state.path.directory + git rev-parse --show-toplevel с кешем на
 * directory; fallback — directory, затем cwd процесса.
 */
export function create(api: TuiPluginApi): () => string | undefined {
  let cachedRoot: string | undefined
  let cachedFrom = ""

  return () => {
    const directory = api.state.path.directory
    if (directory === undefined || directory === "" || directory === "/") return process.cwd()
    if (cachedFrom === directory && cachedRoot !== undefined) return cachedRoot
    try {
      // stdio pipe: stderr git (напр. "not a git repository") не должен
      // утекать в терминал TUI — execSync по умолчанию печатает его.
      cachedRoot = execSync("git rev-parse --show-toplevel", {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim()
    } catch {
      cachedRoot = directory
    }
    cachedFrom = directory
    return cachedRoot
  }
}
