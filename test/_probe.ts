import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'

const mw = zValidator('query', z.object({ q: z.string() }))
const tagged = Object.assign(mw, { [Symbol.for('probe')]: 'FOUND' })

const app = new Hono()
app.get('/search', tagged, (c) => c.json({ ok: true }))
app.get('/plain', (c) => c.text('x'))

const routes = (app as any).routes as Array<any>
for (const r of routes) {
  console.log('route:', r.method, r.path, '| handler type:', typeof r.handler, Array.isArray(r.handler) ? 'ARRAY' : '')
  const h = r.handler
  // probe shapes: array? chained? single function?
  if (Array.isArray(h)) console.log('  array of', h.length, 'items:', h.map((x: any) => typeof x).join(','))
  // can we find the symbol on it or nested?
  const find = (obj: any, depth = 0): any => {
    if (!obj || depth > 4) return null
    if (obj[Symbol.for('probe')]) return obj[Symbol.for('probe')]
    if (Array.isArray(obj)) { for (const x of obj) { const f = find(x, depth + 1); if (f) return f } }
    if (typeof obj === 'function') {
      for (const key of Object.getOwnPropertyNames(obj)) {
        try { const f = find((obj as any)[key], depth + 1); if (f) return f } catch {}
      }
    }
    return null
  }
  console.log('  symbol found via shallow walk:', find(h))
  console.log('  handler own props:', Object.getOwnPropertyNames(h).filter((k) => k !== 'length' && k !== 'name').join(',') || '(none)')
}
