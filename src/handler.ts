/**
 * RouterGraphQLHandler — the plain-GraphQL face (no MCP involved).
 *
 * getSDL() hands the agent-readable contract; execute() runs documents
 * through the real app with the caller's own headers. readiness() returns
 * the CI-assertable exposure audit (the same classifier the startup notices
 * come from — report and warnings can never drift apart).
 *
 * Hardening (same knobs and defaults as the Python bridge):
 * - `requestTimeoutMs` (30s, null disables) — enforced in the executor.
 * - `maxConcurrency` (16, null disables) — enforced in the executor.
 * - `maxDepth` (10, null disables) — recursive types make depth unbounded and
 *   an MCP caller is an LLM that can emit runaway nesting; over-deep
 *   documents are rejected with a validation-style error before execution.
 * - `documentCacheSize` (128, 0 disables) — LRU for the parse + depth-guard +
 *   validate front half, keyed by the query string. Agents repeat documents
 *   constantly. Execution results are NEVER cached: per-call credentials run
 *   for real every time.
 */
import {
  execute,
  parse,
  printSchema,
  validate,
  GraphQLError,
  type DocumentNode,
  type ExecutionResult,
  type FragmentDefinitionNode,
  type GraphQLFieldConfig,
  type SelectionSetNode,
} from 'graphql'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { scanRoutes, scanValidatorRoutes, type RouteInfo, type ScanFilters } from './scanner.ts'
import {
  buildSchema,
  type DegradedRecord,
  type SkipRecord,
} from './schema-builder.ts'
import { RouteExecutor } from './executor.ts'
import { LruCache } from './lru.ts'
import type { DomainRegistry } from './domains.ts'
import { withExecuteSpan } from './otel.ts'

export interface HandlerOptions extends ScanFilters {
  allowMutation?: boolean
  /** Header names forwarded from the caller to the routes (default: authorization). */
  passthroughHeaders?: string[]
  /** fnmatch globs over route paths limiting WHICH write routes become mutations (requires allowMutation). */
  mutationInclude?: string[]
  /** Per-route-call deadline in ms (default 30000, null disables). */
  requestTimeoutMs?: number | null
  /** Bound on in-flight route calls across all queries (default 16, null disables). */
  maxConcurrency?: number | null
  /** Max selection-set nesting per document (default 10, null disables). */
  maxDepth?: number | null
  /** LRU capacity for the parse+depth+validate front half (default 128, 0 disables). */
  documentCacheSize?: number
}

/** The exposure audit: `ready` is false when anything is skipped or degraded. */
export interface ReadinessReport {
  ready: boolean
  skips: SkipRecord[]
  degraded: DegradedRecord[]
  degradedFields: Array<[string, string]>
}

/** `null` means "off" and must survive the default — only `undefined` takes the default. */
function withDefault<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

interface FrontHalf {
  document: DocumentNode
  errors: readonly GraphQLError[]
}

/**
 * Max selection-set nesting of a document; fragments resolved by name, cycles
 * guarded. Root set = depth 1.
 *
 * Introspection meta-fields (`__`-prefixed) do not count toward depth:
 * standard tooling (GraphiQL, codegen, IDE plugins) ships a fixed, deep
 * introspection document — depth ~16 — whose shape is bounded by the schema
 * itself, not by the caller. The guard targets runaway DATA selections.
 * (Python parity: fastapi-gql-mcp's depth_guard.py skips them the same way.)
 */
export function documentDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>()
  for (const def of document.definitions) {
    if (def.kind === 'FragmentDefinition') fragments.set(def.name.value, def)
  }
  let max = 0
  const visit = (set: SelectionSetNode, depth: number, seenFragments: Set<string>) => {
    max = Math.max(max, depth)
    for (const sel of set.selections) {
      switch (sel.kind) {
        case 'Field':
          if (sel.name.value.startsWith('__')) break // introspection: bounded by the schema, not the caller
          if (sel.selectionSet) visit(sel.selectionSet, depth + 1, seenFragments)
          break
        case 'InlineFragment':
          if (sel.selectionSet) visit(sel.selectionSet, depth + 1, seenFragments)
          break
        case 'FragmentSpread': {
          const frag = fragments.get(sel.name.value)
          if (frag && !seenFragments.has(frag.name.value)) {
            visit(frag.selectionSet, depth + 1, new Set(seenFragments).add(frag.name.value))
          }
          break
        }
      }
    }
  }
  for (const def of document.definitions) {
    if (def.kind === 'OperationDefinition' && def.selectionSet) {
      visit(def.selectionSet, 1, new Set())
    }
  }
  return max
}

export class RouterGraphQLHandler {
  readonly schema: ReturnType<typeof buildSchema>['schema']
  readonly skips: SkipRecord[]
  readonly degraded: DegradedRecord[]
  readonly degradedFields: Array<[string, string]>
  readonly registry: DomainRegistry
  readonly queryFields: Map<string, GraphQLFieldConfig<unknown, unknown>>
  readonly mutationFields: Map<string, GraphQLFieldConfig<unknown, unknown>>
  /** Routes that entered the schema (after path/tag filtering) — drives mode=auto. */
  readonly routeCount: number
  /** Top-level domain names. */
  readonly domains: string[]
  /** The filtered RouteInfo list, for callers that want the raw scan. */
  readonly routes: RouteInfo[]
  readonly #maxDepth: number | null
  readonly #cache: LruCache<FrontHalf>
  #sdl?: string

  constructor(app: OpenAPIHono<any>, opts: HandlerOptions = {}) {
    // Two introspection sources: the zod-openapi registry, and Hono's own
    // route table for bridgeValidator middleware (same filters on both).
    this.routes = [...scanRoutes(app.openAPIRegistry, opts), ...scanValidatorRoutes(app, opts)]
    const executor = new RouteExecutor(app as never, opts.passthroughHeaders ?? ['authorization'], {
      requestTimeoutMs: withDefault(opts.requestTimeoutMs, 30_000),
      maxConcurrency: withDefault(opts.maxConcurrency, 16),
    })
    const built = buildSchema(this.routes, executor, {
      allowMutation: opts.allowMutation ?? false,
      ...(opts.mutationInclude ? { mutationInclude: opts.mutationInclude } : {}),
    })
    this.schema = built.schema
    this.skips = built.skips
    this.degraded = built.degraded
    this.degradedFields = built.degradedFields
    this.registry = built.registry
    this.queryFields = built.queryFields
    this.mutationFields = built.mutationFields
    this.routeCount = built.routeCount
    this.domains = built.domains
    this.#maxDepth = withDefault(opts.maxDepth, 10)
    this.#cache = new LruCache<FrontHalf>(withDefault(opts.documentCacheSize, 128))
  }

  getSDL(): string {
    return (this.#sdl ??= printSchema(this.schema))
  }

  /** The exposure audit — `assert report.ready` in CI pins what the bridge serves. */
  readiness(): ReadinessReport {
    return {
      ready: this.skips.length === 0 && this.degraded.length === 0 && this.degradedFields.length === 0,
      skips: this.skips,
      degraded: this.degraded,
      degradedFields: this.degradedFields,
    }
  }

  #validateDocument(document: DocumentNode): readonly GraphQLError[] {
    const depth = documentDepth(document)
    if (this.#maxDepth !== null && depth > this.#maxDepth) {
      return [
        new GraphQLError(
          `Document depth ${depth} exceeds max_depth ${this.#maxDepth}; rejected before execution. ` +
            'Raise maxDepth or disable it with maxDepth: null.',
        ),
      ]
    }
    return validate(this.schema, document)
  }

  /**
   * Execute a GraphQL document against the bridged schema. `headers` are the
   * caller's own credentials — they travel to every route call through the
   * passthrough whitelist. The parse+depth+validate front half is cached by
   * query string; execution results are not. Execution runs inside a
   * `graphql.execute` span (OTel): resolvers and their route calls nest
   * under it — no-op without a registered OTel SDK.
   */
  async execute(
    query: string,
    variables?: Record<string, unknown>,
    options?: { headers?: Headers | Record<string, string>; operationName?: string },
  ): Promise<ExecutionResult> {
    const cached = this.#cache.get(query)
    let front: FrontHalf
    if (cached) {
      front = cached
    } else {
      let document: DocumentNode
      try {
        document = parse(query)
      } catch (err) {
        // Syntax errors are not cached — a typo fixed by the agent re-parses.
        return { errors: [err as GraphQLError] }
      }
      front = { document, errors: this.#validateDocument(document) }
      this.#cache.set(query, front)
    }
    if (front.errors.length > 0) return { errors: front.errors }
    const operation =
      front.document.definitions.find((def) => def.kind === 'OperationDefinition')?.operation ?? 'unknown'
    return withExecuteSpan(async (span) => {
      span.setAttribute('graphql.operation', operation)
      const result = await execute({
        schema: this.schema,
        document: front.document,
        variableValues: variables,
        operationName: options?.operationName,
        contextValue: { headers: options?.headers },
      })
      if (result.errors?.length) span.setAttribute('graphql.errors', result.errors.length)
      return result
    })
  }
}
