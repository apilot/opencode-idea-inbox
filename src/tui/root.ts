import type { Plugin } from "@opencode/plugin/tui"
import { execSync } from "node:child_process"

/**
 * Резолвер корня проекта для TUI-части.
 *
 * ctx.location в CLI-плагине опционален (может быть undefined до
 * инициализации); источник правды — data.location.default(). Реальный
 * корень берём git rev-parse --show-toplevel с кешем на directory;
 * fallback — directory, затем cwd процесса.
 */
export function create(ctx: Plugin.Context): () => string | undefined {
  let cachedRoot: string | undefined
  let cachedFrom = ""

  return () => {
    const directory = ctx.location?.directory ?? ctx.data.location.default().directory
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
