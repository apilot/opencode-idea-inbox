import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { register as registerCommands } from "./commands.js"
import { create as createRoot } from "./root.js"
import { register as registerSidebar } from "./sidebar.js"

/**
 * TUI-часть idea-inbox (концепция v2): нативный выбор идеи из палитры
 * (Ctrl+X → I), запуск в основное окно через tui.appendPrompt/submitPrompt,
 * сайдбар со статусами. Данные и тулы агента — в серверной части.
 *
 * Важно: в момент активации api.state.path.worktree навсегда "/" — любые
 * обращения к стору должны читать путь лениво (см. root.ts).
 */
const plugin: TuiPlugin = async (api) => {
  const root = createRoot(api)
  const offCommands = registerCommands(api, root)
  const offSidebar = registerSidebar(api, root)
  api.lifecycle.onDispose(() => {
    offCommands()
    offSidebar()
  })
}

export const tui: TuiPlugin = plugin
export default { id: "idea-inbox", tui: plugin } satisfies TuiPluginModule
