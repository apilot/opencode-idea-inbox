import { Database, type SQLQueryBindings } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { isIdea, type Idea, type IdeaStatus } from "./types.js"

/** Каталог хранилища внутри worktree. */
function dir(worktree: string): string {
  return path.join(worktree, ".opencode", "idea-inbox")
}

/**
 * Канонизация текста идеи: ровно одна строка. Переносы, табы и
 * повторные пробелы схлопываются в один пробел, края обрезаются.
 * Unicode-разделители строк (U+0085, U+2028, U+2029) приравнены к
 * переносу; невидимые символы (zero-width, bidi-переопределения)
 * вырезаются — они нарушают однострочный контракт и позволяют
 * визуально подменять текст в сайдбаре и таблицах.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[\r\n\t\u0085\u2028\u2029]+/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
}

function dbFile(worktree: string): string {
  return path.join(dir(worktree), "ideas.db")
}

// Один коннект на файл в рамках процесса; WAL допускает параллельный доступ TUI и сервера.
// Глобальный сервер-инстанс может обслужить много worktree за время жизни —
// пул ограничен (LRU по порядку Map), иначе fd расходуются неограниченно.
const MAX_CONNECTIONS = 16
const connections = new Map<string, Database>()

function evict(except: string): void {
  while (connections.size > MAX_CONNECTIONS) {
    const oldest = connections.keys().next().value
    if (oldest === undefined || oldest === except) break
    const db = connections.get(oldest)
    connections.delete(oldest)
    try {
      db?.close()
    } catch {
      // уже закрыт
    }
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS ideas (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin_session_id TEXT,
    session_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
  CREATE INDEX IF NOT EXISTS idx_ideas_session ON ideas(session_id);
`

export function connect(worktree: string): Database {
  const file = dbFile(worktree)
  const existing = connections.get(file)
  if (existing) {
    // LRU touch: передвигаем в конец как самый свежий.
    connections.delete(file)
    connections.set(file, existing)
    return existing
  }

  fs.mkdirSync(dir(worktree), { recursive: true })
  const database = new Database(file)
  database.exec("PRAGMA journal_mode = WAL;")
  // Несколько копий opencode пишут в одну БД: дефолтный busy_timeout у
  // bun:sqlite — 0мс, и конкурентная запись мгновенно падает с
  // "database is locked". 5с ожидания покрывает любой autocommit-конфликт.
  database.exec("PRAGMA busy_timeout = 5000;")
  database.exec(SCHEMA)
  connections.set(file, database)
  evict(file)
  return database
}

interface Row {
  id: string
  text: string
  status: string
  created_at: string
  updated_at: string
  origin_session_id: string | null
  session_id: string | null
}

function toIdea(row: Row): Idea | null {
  const idea: unknown = {
    id: row.id,
    text: row.text,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originSessionID: row.origin_session_id,
    sessionID: row.session_id,
  }
  return isIdea(idea) ? idea : null
}

function rows(db: Database, sql: string, params: SQLQueryBindings[] = []): Idea[] {
  return (db.query(sql).all(...params) as Row[])
    .map((row) => toIdea(row))
    .filter((idea): idea is Idea => idea !== null)
}

/** Все идеи, включая задокументированные (история). */
export function load(worktree: string): Idea[] {
  return rows(connect(worktree), "SELECT * FROM ideas ORDER BY created_at, id")
}

/** Идеи, видимые в панели: всё, кроме documented. */
export function active(worktree: string): Idea[] {
  return rows(connect(worktree), "SELECT * FROM ideas WHERE status != 'documented' ORDER BY created_at, id")
}

/** Фильтр по статусу; undefined → активные. */
export function byStatus(worktree: string, status?: IdeaStatus): Idea[] {
  return status === undefined ? active(worktree) : rows(connect(worktree), "SELECT * FROM ideas WHERE status = ? ORDER BY created_at, id", [status])
}

/** Идеи, привязанные к сессии (для реакций на session.idle / session.deleted). */
export function forSession(worktree: string, sessionID: string): Idea[] {
  return rows(connect(worktree), "SELECT * FROM ideas WHERE session_id = ?", [sessionID])
}

function mint(): string {
  return `idea_${Math.random().toString(36).slice(2, 8)}`
}

export function add(worktree: string, text: string, originSessionID: string | null = null, now: Date = new Date()): Idea {
  const stamp = now.toISOString()
  const idea: Idea = {
    id: mint(),
    text: sanitize(text),
    status: "pending",
    createdAt: stamp,
    updatedAt: stamp,
    originSessionID,
    sessionID: null,
  }
  const db = connect(worktree)
  for (let attempt = 0; ; attempt++) {
    try {
      db.run(
        "INSERT INTO ideas (id, text, status, created_at, updated_at, origin_session_id, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [idea.id, idea.text, idea.status, idea.createdAt, idea.updatedAt, idea.originSessionID, idea.sessionID],
      )
      return idea
    } catch (error) {
      // PK-коллизия (пространство 36^6): крайне маловероятна, но без повтора
      // превращается в несанкционированный сбой тула. Перегенерируем id.
      if (attempt >= 4 || !/PRIMARYKEY/i.test(String(error))) throw error
      idea.id = mint()
    }
  }
}

export interface Patch {
  status?: IdeaStatus
  text?: string
  sessionID?: string | null
}

/** Точечный UPDATE только переданных полей; undefined, если id не найден. */
export function update(worktree: string, id: string, patch: Patch, now: Date = new Date()): Idea | undefined {
  const sets: string[] = []
  const values: SQLQueryBindings[] = []

  if (patch.status !== undefined) {
    sets.push("status = ?")
    values.push(patch.status)
  }
  if (patch.text !== undefined) {
    sets.push("text = ?")
    values.push(sanitize(patch.text))
  }
  if (patch.sessionID !== undefined) {
    sets.push("session_id = ?")
    values.push(patch.sessionID)
  }
  if (sets.length === 0) return find(worktree, id)

  sets.push("updated_at = ?")
  values.push(now.toISOString())
  values.push(id)

  const result = connect(worktree).run(`UPDATE ideas SET ${sets.join(", ")} WHERE id = ?`, values)
  if (result.changes === 0) return undefined
  return find(worktree, id)
}

export function find(worktree: string, id: string): Idea | undefined {
  const row = connect(worktree).query("SELECT * FROM ideas WHERE id = ?").get(id) as Row | null
  return row === null ? undefined : toIdea(row) ?? undefined
}

/**
 * Атомарный захват идеи под запуск: pending → in_progress одним UPDATE
 * с условием статуса. False, если идея уже не pending (запущена другим
 * процессом/вызовом) — снимает TOCTOU-гонку в idea_start.
 */
export function claim(worktree: string, id: string, now: Date = new Date()): boolean {
  return (
    connect(worktree).run("UPDATE ideas SET status = 'in_progress', updated_at = ? WHERE id = ? AND status = 'pending'", [
      now.toISOString(),
      id,
    ]).changes > 0
  )
}

/** Жёсткое удаление одной идеи; false, если id не найден. */
export function remove(worktree: string, id: string): boolean {
  return connect(worktree).run("DELETE FROM ideas WHERE id = ?", [id]).changes > 0
}

/**
 * Удаление всех активных идей (pending/in_progress/done) — сайдбар
 * пустеет. Архив documented не трогается: история сохраняется как
 * страховка от необратимости очистки без диалога подтверждения.
 * Возвращает число удалённых записей.
 */
export function clear(worktree: string): number {
  return connect(worktree).run("DELETE FROM ideas WHERE status != 'documented'").changes
}
