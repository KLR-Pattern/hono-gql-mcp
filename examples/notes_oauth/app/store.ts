/** In-memory note store (single-process demo) — the port of app/store.py. */

export interface Note {
  id: number
  title: string
  body: string
  owner: string
}

export const NOTES = new Map<number, Note>([
  [1, { id: 1, title: 'Try the OAuth flow', body: 'Login, then query notes via GraphiQL.', owner: 'demo' }],
  [2, { id: 2, title: 'Ask an agent', body: 'Point an MCP client at /mcp and let it explore.', owner: 'demo' }],
])
let nextId = 3

export function createNote(owner: string, title: string, body: string): Note {
  const note: Note = { id: nextId, title, body, owner }
  NOTES.set(nextId, note)
  nextId++
  return note
}

export function ownedNotes(owner: string): Note[] {
  return [...NOTES.values()].filter((n) => n.owner === owner)
}
