/** Статус идеи на конвейере pending → in_progress → done → documented. */
export type IdeaStatus = "pending" | "in_progress" | "done" | "documented"

/** Единица бэклога; сериализуется одной JSON-строкой в backlog.jsonl. */
export interface Idea {
  id: string
  text: string
  status: IdeaStatus
  createdAt: string
  updatedAt: string
  originSessionID: string | null
  sessionID: string | null
}

const STATUSES: readonly IdeaStatus[] = ["pending", "in_progress", "done", "documented"]

export function isStatus(value: unknown): value is IdeaStatus {
  return typeof value === "string" && STATUSES.includes(value as IdeaStatus)
}

export function isIdea(value: unknown): value is Idea {
  if (typeof value !== "object" || value === null) return false
  const idea = value as Record<string, unknown>
  return (
    typeof idea.id === "string" &&
    typeof idea.text === "string" &&
    isStatus(idea.status) &&
    typeof idea.createdAt === "string" &&
    typeof idea.updatedAt === "string"
  )
}

/** Обрезает текст до max символов с многоточием. */
export function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Глиф статуса для отображения в сайдбаре. */
export function glyph(status: IdeaStatus): string {
  switch (status) {
    case "pending":
      return "○"
    case "in_progress":
      return "◐"
    case "done":
      return "●"
    case "documented":
      return "✓"
  }
}
