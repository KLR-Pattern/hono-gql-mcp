/**
 * In-app SQLite store — notes survive restarts.
 *
 * One database file (`example/data.sqlite`, or SQLITE_PATH) serves two tenants:
 * better-auth's tables (users/sessions/JWKS/OAuth — created by its own
 * migration runner in auth.ts) and the demo's `notes` table (created here).
 * WAL mode keeps reads and the occasional write from blocking each other.
 *
 * SQLite is the single source of truth. There is no in-memory mirror to drift:
 * every read queries the file, so a second app instance on the same file sees
 * the same notes. Ownership is enforced here — every read takes an `owner` and
 * every query filters by it, so a caller can never reach another caller's row.
 */
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SQLITE_PATH } from './config.ts'

export interface Note {
  id: string
  title: string
  tags: string[]
  owner: string
}

export interface CategoryShape {
  name: string
  children: CategoryShape[]
}

export interface Store {
  /** The shared handle — auth.ts runs its migrations against the same file. */
  db: Database.Database
  categoryTree: CategoryShape[]
  /** The caller's note, or undefined. */
  find(id: string, owner: string): Note | undefined
  /** The caller's notes, newest ids last, optionally filtered by tag and capped. */
  list(owner: string, opts?: { tag?: string; limit?: number }): Note[]
  /** Title substring search over the caller's notes. */
  search(owner: string, query: string, limit: number): Note[]
  /** Counts over the caller's notes. */
  stats(owner: string): { total: number; by_tag: Record<string, number> }
  /** Insert and return the stored note. The id is assigned by the database. */
  create(input: { title: string; tags: string[]; owner: string }): Note
  /** Delete only when the note belongs to `owner`. False when it is not theirs (or absent). */
  remove(id: string, owner: string): boolean
  close(): void
}

/** The module root — the db file lives beside the code, not the cwd. */
const HERE = dirname(fileURLToPath(import.meta.url))
export const DB_PATH = SQLITE_PATH || join(HERE, 'data.sqlite')

/** Owner of the seeded demo notes — a real login never sees them. */
export const DEMO_OWNER = 'demo'

/** Static fixture for the recursive /categories route (public). */
const CATEGORY_TREE: CategoryShape[] = [
  { name: 'docs', children: [{ name: 'guides', children: [{ name: 'quickstart', children: [] }] }] },
  { name: 'src', children: [{ name: 'core', children: [] }] },
]

/** Row shape in sqlite — tags ride as JSON text. */
interface NoteRow {
  id: string
  title: string
  tags: string
  owner: string
}

const rowToNote = (r: NoteRow): Note => ({ ...r, tags: JSON.parse(r.tags) as string[] })

/**
 * The next id is computed BY SQLITE at insert time, not by a process-local
 * counter. Two app instances on the same file used to both start their counter
 * from the same MAX and write the same `n4`; INSERT OR REPLACE then silently
 * lost one of the notes. `MAX(CAST(substr(id,2) AS INTEGER))` reads the live
 * max, so a single INSERT allocates a unique id under SQLite's write lock.
 */
const INSERT_SQL = `
  INSERT INTO notes (id, title, tags, owner)
  VALUES ('n' || (COALESCE((SELECT MAX(CAST(substr(id, 2) AS INTEGER)) FROM notes), 0) + 1), ?, ?, ?)
  RETURNING id, title, tags, owner`

export function createStore(): Store {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')

  db.exec(`CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    owner TEXT NOT NULL
  )`)

  // Seed once: the three demo notes, owned by 'demo' (visible to no real
  // login — seeds exist to show the shape). OR IGNORE makes re-seeding a
  // no-op on an existing database.
  const seed = db.prepare('INSERT OR IGNORE INTO notes (id, title, tags, owner) VALUES (?, ?, ?, ?)')
  db.transaction(() => {
    seed.run('n1', 'Buy milk', JSON.stringify(['errand']), DEMO_OWNER)
    seed.run('n2', 'Ship 0.1.0', JSON.stringify(['work']), DEMO_OWNER)
    seed.run('n3', 'Call mom', JSON.stringify(['family']), DEMO_OWNER)
  })()

  const selectOwned = db.prepare('SELECT id, title, tags, owner FROM notes WHERE owner = ?')
  const selectOne = db.prepare('SELECT id, title, tags, owner FROM notes WHERE id = ? AND owner = ?')
  const insert = db.prepare(INSERT_SQL)
  const del = db.prepare('DELETE FROM notes WHERE id = ? AND owner = ?')

  const rowsOf = (owner: string): Note[] => (selectOwned.all(owner) as NoteRow[]).map(rowToNote)

  return {
    db,
    categoryTree: CATEGORY_TREE,
    find(id, owner) {
      const row = selectOne.get(id, owner) as NoteRow | undefined
      return row ? rowToNote(row) : undefined
    },
    list(owner, opts = {}) {
      const rows = rowsOf(owner)
      const filtered = opts.tag ? rows.filter((n) => n.tags.includes(opts.tag as string)) : rows
      return filtered.slice(0, opts.limit ?? 10)
    },
    search(owner, query, limit) {
      const needle = query.toLowerCase()
      return rowsOf(owner)
        .filter((n) => n.title.toLowerCase().includes(needle))
        .slice(0, limit)
    },
    stats(owner) {
      const by_tag: Record<string, number> = {}
      const rows = rowsOf(owner)
      for (const n of rows) for (const t of n.tags) by_tag[t] = (by_tag[t] ?? 0) + 1
      return { total: rows.length, by_tag }
    },
    create(input) {
      const row = insert.get(input.title, JSON.stringify(input.tags), input.owner) as NoteRow
      return rowToNote(row)
    },
    remove: (id, owner) => del.run(id, owner).changes > 0,
    close: () => db.close(),
  }
}
