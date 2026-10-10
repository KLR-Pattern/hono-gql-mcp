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
import type { Hono } from 'hono'
import type { ZodType } from 'zod'
import { fnmatchToRegExp } from './fnmatch.ts'
import { VALIDATOR_SCHEMA, type ValidatorAttachment } from './zvalidator.ts'

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

// ---- second introspection source: bridgeValidator middleware ---------------------

/** Hono path → OpenAPI path: `:id` → `{id}`; `{...}` regex constraints keep their name. */
function honoPathToOpenApi(path: string): string | null {
  if (path.includes('*')) return null // wildcards have no OpenAPI shape
  return path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, '{$1}')
}

/**
 * Scan Hono's own route table for bridgeValidator middleware and synthesize
 * zod-openapi-shaped RouteConfigs from the attached schemas. Hono registers
 * every handler of `app.get(path, mw, handler)` as its own route entry —
 * the validator middleware (carrying our Symbol) is one of them. Routes
 * without a bridgeValidator stay invisible, so zod-openapi routes (registered
 * via app.openapi) never duplicate here.
 */
export function scanValidatorRoutes(app: Hono<any, any, any>, filters: ScanFilters = {}): RouteInfo[] {
  const include = filters.include?.map(fnmatchToRegExp)
  const exclude = filters.exclude?.map(fnmatchToRegExp)
  const includeTags = filters.includeTags?.map(fnmatchToRegExp)
  const excludeTags = filters.excludeTags?.map(fnmatchToRegExp)

  // (METHOD path) → merged attachments of that business route
  const grouped = new Map<string, { method: string; openApiPath: string | null; attachments: ValidatorAttachment[] }>()
  for (const route of app.routes as unknown as Array<{ method: string; path: string; handler: unknown }>) {
    const attachment = (route.handler as { [VALIDATOR_SCHEMA]?: ValidatorAttachment } | undefined)?.[
      VALIDATOR_SCHEMA
    ]
    if (!attachment) continue
    const method = route.method.toUpperCase()
    const key = `${method} ${route.path}`
    const openApiPath = honoPathToOpenApi(route.path)
    const group = grouped.get(key)
    if (group) {
      group.attachments.push(attachment)
    } else {
      grouped.set(key, { method, openApiPath, attachments: [attachment] })
    }
  }

  const routes: RouteInfo[] = []
  for (const { method, openApiPath, attachments } of grouped.values()) {
    if (openApiPath === null) continue // wildcard path — not representable
    const first = (target: ValidatorAttachment['target']) => attachments.find((a) => a.target === target)
    const param = first('param')
    const query = first('query')
    const body = first('json')
    const opts = attachments[0].options

    // form bodies are not JSON — the same skip as zod-openapi routes.
    if (!body && first('form')) continue

    // The same filter semantics as registry routes (tags AND with paths).
    const tags = opts.tags ?? []
    if (include && !include.some((re) => re.test(openApiPath))) continue
    if (exclude?.some((re) => re.test(openApiPath))) continue
    if (includeTags && !tags.some((t) => includeTags.some((re) => re.test(t)))) continue
    if (excludeTags?.length && tags.some((t) => excludeTags.some((re) => re.test(t)))) continue
    if (filters.excludeDeprecated && opts.deprecated) continue

    routes.push({
      route: {
        method: method.toLowerCase() as RouteConfig['method'],
        path: openApiPath,
        ...(tags.length > 0 ? { tags } : {}),
        ...(opts.summary ? { summary: opts.summary } : {}),
        ...(opts.description ? { description: opts.description } : {}),
        ...(opts.deprecated ? { deprecated: true } : {}),
        request: {
          ...(param ? { params: param.schema } : {}),
          ...(query ? { query: query.schema } : {}),
          ...(body
            ? { body: { content: { 'application/json': { schema: body.schema } } } }
            : {}),
        },
        ...(opts.responseSchema
          ? {
              responses: {
                200: { description: 'ok', content: { 'application/json': { schema: opts.responseSchema } } },
              },
            }
          : {}),
      } as RouteConfig,
    })
  }
  return routes
}
