/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { register as registerCommands } from "./commands.js"
import { create as createRoot } from "./root.js"
import { register as registerSidebar } from "./sidebar.js"

/**
 * TUI-часть idea-inbox (V2 CLI plugin): палитра/dialog-выбор идеи из
 * бэклога, отправка миссии в текущую сессию через session.prompt,
 * сайдбар со статусами. Данные и тулы агента — в серверной части.
 *
 * Путь локации может быть не заполнен в момент активации — любые
 * обращения к стору читают его лениво (см. root.ts).
 */
export default Plugin.define({
  id: "idea-inbox.tui",
  setup(ctx) {
    const root = createRoot(ctx)
    const offCommands = registerCommands(ctx, root)
    const offSidebar = registerSidebar(ctx, root)
    return () => {
      offCommands()
      offSidebar()
    }
  },
})
