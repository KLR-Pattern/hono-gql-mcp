/**
 * Tag-based domain grouping for progressive disclosure — a port of
 * fastapi-gql-mcp's domains.py.
 *
 * Domains form a tree via the `':'` separator (`tags: ['billing:invoice']` →
 * ['billing', 'invoice']). A route with several tags belongs to every one of
 * them. The tree only shapes *discovery* (which slice of the schema an agent
 * looks at); execution always runs against the full schema.
 */

const CAMEL_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g

/** camelCase → snake_case, `-` → `_`, lowercase, anything else → `_` (Python `_sanitize_segment`). */
export function sanitizeSegment(segment: string): string {
  const snake = segment.replace(CAMEL_BOUNDARY, '_').replace(/-/g, '_').toLowerCase()
  return snake.replace(/[^a-z0-9_]/g, '_') || '_'
}

/**
 * The domain paths a route belongs to (each tag becomes one path; without
 * tags the first non-parameter path segment; fallback `general`).
 */
export function domainsFor(tags: readonly unknown[] | undefined, path: string): string[][] {
  const stringTags = (tags ?? []).filter((t): t is string => typeof t === 'string' && t.length > 0)
  if (stringTags.length > 0) {
    const seen = new Set<string>()
    const paths: string[][] = []
    for (const tag of stringTags) {
      const domain = tag.split(':').map(sanitizeSegment)
      const key = domain.join(':')
      if (!seen.has(key)) {
        seen.add(key)
        paths.push(domain)
      }
    }
    return paths
  }
  for (const segment of path.split('/')) {
    if (segment && !(segment.startsWith('{') && segment.endsWith('}'))) {
      return [[sanitizeSegment(segment)]]
    }
  }
  return [['general']]
}

export interface DomainEntry {
  /** Every domain path the route belongs to (one per tag). */
  domains: string[][]
  field: string
  isMutation: boolean
}

export interface DomainSummary {
  name: string
  path: string[]
  queries: number
  mutations: number
  subdomains?: string[]
}

const key = (path: string[]): string => path.join(':')

/** Indexes routes by domain path and answers tree-shaped discovery queries. */
export class DomainRegistry {
  #paths = new Set<string>()
  #queryFields = new Map<string, Set<string>>()
  #mutationFields = new Map<string, Set<string>>()
  #children = new Map<string, Set<string>>()

  constructor(entries: DomainEntry[]) {
    for (const { domains, field, isMutation } of entries) {
      for (const domain of domains) {
        for (let depth = 1; depth <= domain.length; depth++) {
          const pathKey = key(domain.slice(0, depth))
          this.#paths.add(pathKey)
          // Only the leaf level carries the field; parents aggregate counts
          // through their subtree at query time.
          if (depth === domain.length) {
            const map = isMutation ? this.#mutationFields : this.#queryFields
            const set = map.get(pathKey) ?? new Set<string>()
            set.add(field)
            map.set(pathKey, set)
          }
        }
      }
    }
    // Precomputed child index: children() answers in O(1). Single-segment
    // paths parent to the root ('' key).
    for (const pathKey of this.#paths) {
      const parts = pathKey.split(':')
      const parent = parts.slice(0, -1).join(':')
      const children = this.#children.get(parent) ?? new Set<string>()
      children.add(parts[parts.length - 1])
      this.#children.set(parent, children)
    }
  }

  /** Does this exact domain path exist (at any level, with or without fields)? */
  has(path: string[]): boolean {
    return this.#paths.has(key(path))
  }

  /** Direct child segment names under `path` (root: `[]`). */
  children(path: string[]): string[] {
    return [...(this.#children.get(key(path)) ?? [])].sort()
  }

  /** All (domainPath, fieldName) pairs at or below `path`, split by kind. */
  subtreeFields(path: string[]): { queries: Array<[string[], string]>; mutations: Array<[string[], string]> } {
    const prefix = key(path)
    const queries: Array<[string[], string]> = []
    const mutations: Array<[string[], string]> = []
    const collect = (map: Map<string, Set<string>>, out: Array<[string[], string]>) => {
      for (const [pathKey, fields] of map) {
        if (pathKey === prefix || pathKey.startsWith(prefix + ':')) {
          const owner = pathKey.split(':')
          for (const field of fields) out.push([owner, field])
        }
      }
    }
    collect(this.#queryFields, queries)
    collect(this.#mutationFields, mutations)
    return { queries, mutations }
  }

  /** Top-level domain summaries (for the `list_domains` MCP tool). */
  summary(): DomainSummary[] {
    const roots = new Set<string>()
    for (const pathKey of this.#paths) roots.add(pathKey.split(':')[0])
    const result: DomainSummary[] = []
    for (const root of [...roots].sort()) {
      const path = [root]
      const { queries, mutations } = this.subtreeFields(path)
      const children = this.children(path)
      result.push({
        name: root,
        path,
        queries: queries.length,
        mutations: mutations.length,
        ...(children.length > 0 ? { subdomains: children } : {}),
      })
    }
    return result
  }
}
