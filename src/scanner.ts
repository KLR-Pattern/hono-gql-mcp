/**
 * Scanner — the TS counterpart of fastapi-gql-mcp's RouterScanner.
 *
 * It reads the same registry `getOpenAPIDocument()` walks:
 * `app.openAPIRegistry.definitions` holds the ORIGINAL `createRoute()` config
 * objects (Zod schemas, tags, summaries, descriptions) — not converted
 * OpenAPI fragments. Routes registered with `hide: true` never enter the
 * registry; they stay served over HTTP but invisible to the bridge (same
 * semantics as FastAPI's `include_in_schema=False`).
 *
 * Filters (fnmatch globs) remove routes by configuration — filtering you
 * asked for, not a skip; drops are silent like the Python bridge.
 * exclude wins over include; tag filters AND with path filters.
 */
import type { OpenAPIRegistry, RouteConfig } from '@asteasolutions/zod-to-openapi'
import type { ZodType } from 'zod'
import { fnmatchToRegExp } from './fnmatch.ts'

export interface RouteInfo {
  /** The original createRoute() config — schemas, tags and docs, verbatim. */
  route: RouteConfig
}

export interface ScanFilters {
  /** fnmatch globs over route paths — keep only matching routes. */
  include?: string[]
  /** fnmatch globs over route paths — drops win over include. */
  exclude?: string[]
  /**
   * fnmatch globs over route tags. A route matches when ANY of its string
   * tags matches ANY pattern. Strict whitelist: untagged routes drop.
   */
  includeTags?: string[]
  /** fnmatch globs over route tags — wins over includeTags. With only this set, untagged routes stay. */
  excludeTags?: string[]
  /** Drop routes declared `deprecated: true` (a config-level silent drop; routes that stay keep their GraphQL-native deprecation mark). */
  excludeDeprecated?: boolean
}

export function scanRoutes(registry: OpenAPIRegistry, filters: ScanFilters = {}): RouteInfo[] {
  const include = filters.include?.map(fnmatchToRegExp)
  const exclude = filters.exclude?.map(fnmatchToRegExp)
  const includeTags = filters.includeTags?.map(fnmatchToRegExp)
  const excludeTags = filters.excludeTags?.map(fnmatchToRegExp)

  return registry.definitions
    .filter((d): d is { type: 'route'; route: RouteConfig } => d.type === 'route')
    .map((d) => ({ route: d.route }))
    .filter(({ route }) => {
      if (include && !include.some((re) => re.test(route.path))) return false
      if (exclude?.some((re) => re.test(route.path))) return false
      const tags = (route.tags ?? []).filter((t): t is string => typeof t === 'string')
      if (includeTags && !tags.some((t) => includeTags.some((re) => re.test(t)))) return false
      if (excludeTags?.length && tags.some((t) => excludeTags.some((re) => re.test(t)))) return false
      if (filters.excludeDeprecated && route.deprecated) return false
      return true
    })
}

/** The JSON body schema, ignoring $ref entries (createRoute() always yields inline Zod). */
export function jsonBodySchemaOf(route: RouteConfig): ZodType | undefined {
  const media = route.request?.body?.content?.['application/json']
  return media && !('$ref' in media) ? (media.schema as ZodType | undefined) : undefined
}
