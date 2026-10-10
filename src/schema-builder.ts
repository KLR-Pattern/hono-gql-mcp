/**
 * Schema builder — RouteInfo[] → GraphQLSchema.
 *
 * The shape follows the same two rules as fastapi-gql-mcp:
 * - **Tags group the tree** — `tags: ['shop:catalog']` answers at
 *   `{ shop { catalog { … } } }`; `:` nests. A route with several tags lands
 *   in every one of its domains. Untagged routes join the domain of their
 *   first path segment. The tree shapes DISCOVERY only — execution always
 *   runs against the full schema.
 * - **operationId names the leaf** — your own vocabulary; two routes sharing
 *   an operationId in one domain fail fast (DuplicateFieldError, thrown at
 *   construction).
 *
 * Leaf fields are always nullable (a failing route nulls only its own field
 * — a NonNull leaf would propagate the error to its whole domain group).
 *
 * Bucket classification mirrors the Python bridge: typed → structured,
 * void/no-content → Boolean success, untyped 2xx → JSON (still callable),
 * non-JSON bodies / name collisions → skipped with a reason.
 */
import {
  GraphQLBoolean,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLNonNull,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigMap,
  type GraphQLNullableInputType,
  type GraphQLOutputType,
} from 'graphql'
import type { RouteConfig } from '@asteasolutions/zod-to-openapi'
import { GraphQLJSON, ZodGraphqlMapper } from './zod-to-graphql.ts'
import { jsonBodySchemaOf, type RouteInfo } from './scanner.ts'
import type { ExecutionContext, RouteExecutor } from './executor.ts'
import { DomainRegistry, domainsFor, type DomainEntry } from './domains.ts'
import { fnmatchToRegExp } from './fnmatch.ts'
import { DuplicateFieldError } from './errors.ts'

export interface SkipRecord {
  method: string
  path: string
  reason: string
}

/** Route-level raw-JSON degradation (the route is still callable, just not field-selectable). */
export interface DegradedRecord {
  method: string
  path: string
  field: string
  reason: string
}

export interface BuildOptions {
  allowMutation: boolean
  /** fnmatch globs over route paths limiting WHICH write routes become mutations (requires allowMutation). */
  mutationInclude?: string[]
}

export interface BuildResult {
  schema: GraphQLSchema
  skips: SkipRecord[]
  degraded: DegradedRecord[]
  /** Field-level raw-JSON degradations, `[where, reason]` (e.g. `['by_tag', 'zod record → JSON']`). */
  degradedFields: Array<[string, string]>
  /** Type-name disambiguations, `[name, 'reused → name_N']`. Informational — never a readiness failure. */
  renames: Array<[string, string]>
  /** Domain registry answering progressive-disclosure queries. */
  registry: DomainRegistry
  /** (domainPath, fieldName) → field config, for the progressive list tools. */
  queryFields: Map<string, GraphQLFieldConfig<unknown, unknown>>
  mutationFields: Map<string, GraphQLFieldConfig<unknown, unknown>>
  /** Routes that entered the schema (after filtering) — drives mode=auto. */
  routeCount: number
  /** Top-level domain names, for the MCP instructions line. */
  domains: string[]
  /**
   * False when no read route survived the scan, so `type Query` has no fields.
   * GraphQL then considers the whole schema invalid and every execution fails,
   * so the handler refuses documents with a clear error up front instead of
   * letting graphql-js throw. Reachable through ordinary configuration: a
   * write-only app, or filters that kept nothing.
   */
  hasQueryOperations: boolean
}

const LEGAL_GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const pascal = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Root'

/** Group object type name for a domain path — shared with the domain-SDL fragment builder. */
export function groupTypeName(domain: string[], kind: 'query' | 'mutation'): string {
  return pascal(domain.join(' ')) + (kind === 'mutation' ? 'Mutation' : 'Query')
}

interface Leaf {
  domains: string[][]
  fieldName: string
  type: GraphQLOutputType
  args: Record<string, { type: unknown; defaultValue?: unknown; description?: string }>
  description?: string
  deprecationReason?: string
  plan: Parameters<RouteExecutor['call']>[0]
}

/** operationId verbatim; otherwise derive `verb_path_parts` (params dropped). */
function fieldNameOf(route: RouteConfig, method: string): string {
  if (route.operationId) return route.operationId
  const parts = route.path
    .split('/')
    .filter((p) => p && !p.startsWith('{'))
    .map((p) => p.replace(/[^A-Za-z0-9]+/g, '_'))
  return [method.toLowerCase(), ...parts].join('_').replace(/^_+/, '')
}

/** The ZodObject shape behind a params/query schema, cast through unknown (the route type unions ZodPipe etc.). */
function shapeOf(schema: unknown): Record<string, unknown> {
  return ((schema as { shape?: unknown } | undefined)?.shape as Record<string, unknown>) ?? {}
}

const defType = (schema: unknown): string | undefined =>
  (schema as { def?: { type?: string } } | undefined)?.def?.type

/** True when the schema accepts absence — an optional/default anywhere in the wrapper chain. */
function isOptionalSchema(schema: unknown): boolean {
  let cur: unknown = schema
  for (let depth = 0; depth < 64 && cur; depth++) {
    const def = (cur as { def?: Record<string, any> }).def
    if (!def) return false
    if (def.type === 'optional' || def.type === 'default') return true
    cur = def.type === 'pipe' ? def.in : def.type === 'lazy' ? def.getter?.() : undefined
  }
  return false
}

/**
 * Python-bridge parity: a REQUIRED header/cookie parameter cannot become a
 * GraphQL argument, so the field could never be called correctly — skip with
 * a reason instead of deriving a broken field. Optional ones stay callable
 * (caller credentials ride passthroughHeaders, not GraphQL arguments).
 */
function requiredHeaderCookieReason(route: RouteConfig): string | null {
  const locations: Array<[string, unknown]> = [
    ['header', route.request?.headers],
    ['cookie', route.request?.cookies],
  ]
  for (const [kind, schema] of locations) {
    if (!schema) continue
    const names = Array.isArray(schema) ? schema.map((_, i) => `#${i}`) : Object.keys(shapeOf(schema))
    const subs = Array.isArray(schema) ? schema : Object.values(shapeOf(schema))
    for (const [i, name] of names.entries()) {
      if (!isOptionalSchema(subs[i])) {
        return (
          `required ${kind} parameter '${name}' cannot be a GraphQL argument — ` +
          'make it optional (caller credentials ride passthroughHeaders instead of GraphQL arguments)'
        )
      }
    }
  }
  return null
}

/** A NonNull leaf would null its whole domain group on a single route error — unwrap. */
function nullableLeaf(t: GraphQLOutputType): GraphQLOutputType {
  return t instanceof GraphQLNonNull ? t.ofType : t
}

export function buildSchema(routes: RouteInfo[], executor: RouteExecutor, opts: BuildOptions): BuildResult {
  const skips: SkipRecord[] = []
  const degraded: DegradedRecord[] = []
  const mapper = new ZodGraphqlMapper()
  const leaves: { query: Leaf[]; mutation: Leaf[] } = { query: [], mutation: [] }
  const mutationInclude = opts.mutationInclude?.map(fnmatchToRegExp)

  for (const { route } of routes) {
    const method = route.method === 'query' ? 'GET' : route.method.toUpperCase()
    const skip = (reason: string) => skips.push({ method, path: route.path, reason })
    const kind = ['GET', 'HEAD'].includes(method) ? 'query' : 'mutation'

    if (kind === 'mutation' && !opts.allowMutation) {
      skip('write verb with allowMutation=false (default) — opt in with allowMutation: true')
      continue
    }
    if (kind === 'mutation' && mutationInclude && !mutationInclude.some((re) => re.test(route.path))) {
      skip('write route not matching mutation_include globs')
      continue
    }

    const bodySchema = jsonBodySchemaOf(route)
    if (route.request?.body && !bodySchema) {
      skip('non-JSON request body — MCP tool arguments are JSON, the protocol has no file channel')
      continue
    }

    const headerCookieReason = requiredHeaderCookieReason(route)
    if (headerCookieReason) {
      skip(headerCookieReason)
      continue
    }

    const paramsShape = shapeOf(route.request?.params)
    const queryShape = shapeOf(route.request?.query)
    const paramsKeys = Object.keys(paramsShape)
    const queryKeys = Object.keys(queryShape)
    const collisions = paramsKeys.filter((k) => queryKeys.includes(k) || k === 'body')
    if (collisions.length > 0) {
      skip(`argument name collision: '${collisions.join("', '")}' appears at two locations`)
      continue
    }

    // ---- output bucket: typed / Boolean success / raw JSON ----------------
    const successStatuses = Object.keys(route.responses ?? {})
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n >= 200 && n < 300)
      .sort((a, b) => a - b)
    let responseSchema: unknown
    for (const status of successStatuses) {
      const cfg = (route.responses as Record<string, { content?: { 'application/json'?: { schema?: unknown } } }>)[
        String(status)
      ]
      const media = cfg?.content?.['application/json']
      responseSchema = media && !('$ref' in media) ? media.schema : undefined
      if (responseSchema) break
    }

    const fieldNameRaw = fieldNameOf(route, method)
    const fieldName = LEGAL_GRAPHQL_NAME.test(fieldNameRaw) ? fieldNameRaw : `_${fieldNameRaw.replace(/\W/g, '_')}`
    const hint = pascal(fieldName)

    let type: GraphQLOutputType
    let booleanSuccess = false
    if (responseSchema && defType(responseSchema) === 'void') {
      // Declared void → Boolean success (the `-> None` bucket).
      type = GraphQLBoolean
      booleanSuccess = true
    } else if (responseSchema) {
      // Nullable at the leaf: a failing route nulls only its own field.
      type = nullableLeaf(mapper.outputType(responseSchema as never, hint))
    } else if (
      successStatuses.length > 0 &&
      !(route.responses as Record<string, { content?: unknown }>)[String(successStatuses[0])]?.content
    ) {
      // A 2xx with no content at all — the 204-style `-> None` analog.
      type = GraphQLBoolean
      booleanSuccess = true
    } else {
      type = GraphQLJSON
      degraded.push({
        method,
        path: route.path,
        field: fieldName,
        reason: 'no typed 2xx response schema — add a JSON response schema for field selection',
      })
    }

    // ---- args: params (required) + query (optional/default) + one body ----
    const args: Leaf['args'] = {}
    for (const key of paramsKeys) {
      const sub = paramsShape[key]
      // Path params always render into the URL — force required.
      const mapped = mapper.inputType(sub as never, `${hint}${pascal(key)}`)
      const unwrapped = mapped instanceof GraphQLNonNull ? mapped.ofType : mapped
      args[key] = {
        type: new GraphQLNonNull(unwrapped as GraphQLNullableInputType),
        description: (sub as { description?: string }).description,
      }
    }
    for (const key of queryKeys) {
      const sub = queryShape[key]
      const arg = mapper.inputArg(sub as never, `${hint}${pascal(key)}`)
      args[key] = {
        type: arg.type,
        ...(arg.hasDefault ? { defaultValue: arg.defaultValue } : {}),
        description: (sub as { description?: string }).description,
      }
    }
    if (bodySchema) {
      const arg = mapper.inputArg(bodySchema as never, hint)
      args['body'] = {
        type: arg.type,
        ...(arg.hasDefault ? { defaultValue: arg.defaultValue } : {}),
        description: 'The request body.',
      }
    }

    leaves[kind].push({
      domains: domainsFor(route.tags, route.path),
      fieldName,
      type,
      args,
      description: route.summary ?? route.description,
      ...(route.deprecated ? { deprecationReason: 'Deprecated upstream route.' } : {}),
      plan: { route, method, booleanSuccess },
    })
  }

  // ---- assemble the group tree -------------------------------------------
  const isPrefix = (prefix: string[], full: string[]) =>
    full.length >= prefix.length && prefix.every((v, i) => full[i] === v)

  const seenFields = new Map<string, string>() // `${kind}|${domain}|${field}` → owning path
  const groupTypes = new Map<string, GraphQLObjectType>()
  const queryFields = new Map<string, GraphQLFieldConfig<unknown, unknown>>()
  const mutationFields = new Map<string, GraphQLFieldConfig<unknown, unknown>>()

  const groupTypeFor = (domain: string[], kind: 'query' | 'mutation'): GraphQLObjectType => {
    const cacheKey = `${kind}:${domain.join(':')}`
    const cached = groupTypes.get(cacheKey)
    if (cached) return cached
    const type = new GraphQLObjectType({
      name: groupTypeName(domain, kind),
      description: `Domain group for '${domain.join(':')}'.`,
      fields: () => groupFields(domain, kind),
    })
    groupTypes.set(cacheKey, type)
    return type
  }

  const groupFields = (domain: string[], kind: 'query' | 'mutation'): GraphQLFieldConfigMap<unknown, unknown> => {
    const fields: GraphQLFieldConfigMap<unknown, unknown> = {}
    const nested = new Set<string>()
    for (const leaf of leaves[kind]) {
      // A multi-tag leaf belongs when ANY of its domain paths sits at/below this group.
      for (const leafDomain of leaf.domains) {
        if (!isPrefix(domain, leafDomain)) continue
        if (leafDomain.length === domain.length) {
          const dupKey = `${kind}|${leafDomain.join(':')}|${leaf.fieldName}`
          const existing = seenFields.get(dupKey)
          if (existing) {
            // Dedicated class (catchable by type) + the message prefix, so
            // message-matching assertions keep working too.
            throw new DuplicateFieldError(
              `DuplicateFieldError: '${leaf.fieldName}' in domain '${leafDomain.join(':')}' ` +
                `(already used by ${existing}). Give the routes distinct operationId values.`,
            )
          }
          seenFields.set(dupKey, leaf.plan.route.path)
          const field: GraphQLFieldConfig<unknown, unknown> = {
            type: leaf.type,
            args: leaf.args as never,
            description: leaf.description,
            ...(leaf.deprecationReason ? { deprecationReason: leaf.deprecationReason } : {}),
            resolve: (_src, args, ctx) => {
              const context = ctx as ExecutionContext | undefined
              const invoke = () =>
                executor.call(leaf.plan, args as Record<string, unknown>, context?.headers)
              // Writes serialized per document — see SerialQueue. Reads stay
              // concurrent: sibling fields still overlap freely.
              return kind === 'mutation' && context?.writer ? context.writer.run(invoke) : invoke()
            },
          }
          fields[leaf.fieldName] = field
          ;(kind === 'mutation' ? mutationFields : queryFields).set(`${leafDomain.join(':')}|${leaf.fieldName}`, field)
        } else {
          nested.add(leafDomain[domain.length])
        }
      }
    }
    for (const segment of nested) {
      fields[segment] = {
        type: new GraphQLNonNull(groupTypeFor([...domain, segment], kind)),
        // Domain groups are virtual: the resolver hands each group an empty
        // source object (the default resolver would read a property that
        // does not exist and null the NonNull group).
        resolve: () => ({}),
      }
    }
    return fields
  }

  const query = new GraphQLObjectType({ name: 'Query', fields: () => groupFields([], 'query') })
  const mutation =
    leaves.mutation.length > 0
      ? new GraphQLObjectType({ name: 'Mutation', fields: () => groupFields([], 'mutation') })
      : undefined
  const schema = new GraphQLSchema({ query, ...(mutation ? { mutation } : {}) })

  // Force every field thunk NOW: DuplicateFieldError and the degradation
  // audit become construction-time facts instead of first-query surprises.
  for (const type of Object.values(schema.getTypeMap())) {
    if ('getFields' in type) (type as { getFields: () => unknown }).getFields()
  }

  const registry = new DomainRegistry([
    ...leaves.query.map<DomainEntry>((leaf) => ({ domains: leaf.domains, field: leaf.fieldName, isMutation: false })),
    ...leaves.mutation.map<DomainEntry>((leaf) => ({ domains: leaf.domains, field: leaf.fieldName, isMutation: true })),
  ])

  return {
    schema,
    skips,
    degraded,
    degradedFields: mapper.degradations,
    renames: mapper.renames,
    registry,
    queryFields,
    mutationFields,
    routeCount: leaves.query.length + leaves.mutation.length,
    domains: registry.summary().map((s) => s.name),
    hasQueryOperations: leaves.query.length > 0,
  }
}
