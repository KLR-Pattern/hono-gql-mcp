/**
 * Zod → graphql-js type mapper — the TS counterpart of the Pydantic→GraphQL
 * mapper in fastapi-gql-mcp, and the one piece with no existing wheel.
 *
 * Mapping rules (mirroring the Python bridge's buckets):
 * - scalars: string→String, number→Int/Float, boolean→Boolean, date→Date
 * - z.object → GraphQLObjectType (output) / GraphQLInputObjectType (input)
 * - z.enum  → GraphQLEnumType (member names must be legal GraphQL identifiers)
 * - z.array → GraphQLList; required elements become NonNull
 * - z.pipe  → input side maps from `.in`, output side from `.out`
 * - dynamic shapes degrade to the JSON scalar with a recorded reason:
 *   union / record / literal / any / unknown — same bucket as the Python
 *   bridge's raw-JSON fallback, never a silently vanishing route.
 *
 * Zod v4's `.def` is a public API. `z.toJSONSchema()` throws on
 * date/bigint/map/set, so the mapper reads `.def` directly and never goes
 * through JSON Schema.
 */
import {
  GraphQLEnumType,
  GraphQLBoolean,
  GraphQLFloat,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  valueFromASTUntyped,
  type GraphQLInputType,
  type GraphQLOutputType,
  type GraphQLNullableInputType,
  type GraphQLNullableOutputType,
} from 'graphql'
import { globalRegistry, type ZodType } from 'zod'

/** Any-typed view of a Zod v4 `.def` — the introspection surface is public but untyped. */
type AnyDef = { type: string } & Record<string, any>
const defOf = (schema: ZodType): AnyDef => (schema as unknown as { def: AnyDef }).def

/** Raw-JSON fallback scalar — the "still callable, just not field-selectable" bucket. */
export const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description:
    'Raw JSON. The source shape is dynamic (union / record / untyped) and cannot promise per-field selection.',
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => valueFromASTUntyped(ast),
})

/** Date as ISO-8601 string on the wire — same contract as the Python bridge's custom scalars. */
const GraphQLDate = new GraphQLScalarType({
  name: 'Date',
  serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : String(v)),
  parseValue: (v: unknown) => (v instanceof Date ? v : new Date(v as string)),
  parseLiteral: (ast) => new Date(valueFromASTUntyped(ast) as string),
})

interface Unwrapped {
  inner: ZodType
  optional: boolean
  nullable: boolean
  hasDefault: boolean
  defaultValue?: unknown
}

/**
 * Peel the wrapper chain (optional / nullable / default / pipe / lazy),
 * collecting requiredness flags. `mode` decides which side of a `z.pipe`
 * transform to follow — input args map from `.in`, response fields from `.out`.
 */
function unwrap(schema: ZodType, mode: 'input' | 'output'): Unwrapped {
  const out: Unwrapped = { inner: schema, optional: false, nullable: false, hasDefault: false }
  let cur = schema
  for (let depth = 0; depth < 64; depth++) {
    const def = defOf(cur)
    switch (def.type) {
      case 'optional':
        out.optional = true
        cur = def.innerType
        break
      case 'nullable':
        out.nullable = true
        cur = def.innerType
        break
      case 'default':
        out.hasDefault = true
        out.optional = true
        out.defaultValue = def.defaultValue
        cur = def.innerType
        break
      case 'pipe':
        cur = mode === 'input' ? def.in : def.out
        break
      case 'lazy':
        cur = def.getter()
        break
      default:
        out.inner = cur
        return out
    }
  }
  out.inner = cur
  return out
}

/** z.int() carries the format check at the top level; z.number().int() puts it in `checks`. */
function isIntNumber(def: AnyDef): boolean {
  const isSafeInt = (d: any) =>
    d?.check === 'number_format' && (d?.format === 'safeint' || d?.format === 'int')
  return isSafeInt(def) || (Array.isArray(def.checks) && def.checks.some((c: any) => isSafeInt(c?.def)))
}

function scalarFor(def: AnyDef): GraphQLScalarType | undefined {
  switch (def.type) {
    case 'string':
      return GraphQLString
    case 'number':
      return isIntNumber(def) ? GraphQLInt : GraphQLFloat
    case 'boolean':
      return GraphQLBoolean
    case 'date':
      return GraphQLDate
    default:
      return undefined
  }
}

const pascal = (s: string): string =>
  s
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('') || 'Unnamed'

const LEGAL_GRAPHQL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface ArgMapping {
  type: GraphQLInputType
  hasDefault: boolean
  defaultValue?: unknown
}

export class ZodGraphqlMapper {
  /** Object/enum/list types per schema instance, shared between input and output sides? No — separate. */
  private outCache = new Map<ZodType, GraphQLOutputType>()
  private inCache = new Map<ZodType, GraphQLInputType>()
  /**
   * …except enums: a GraphQLEnumType serves both directions unchanged, so
   * ONE instance per schema is shared — otherwise the same z.enum would
   * print twice (Speed + Speed_2 via the name-reuse suffix).
   */
  private enumCache = new Map<ZodType, GraphQLEnumType | GraphQLScalarType>()
  private names = new Set<string>(['Query', 'Mutation', 'JSON', 'Date', 'String', 'Int', 'Float', 'Boolean', 'ID'])
  /** Degradation audit: `[where, reason]` tuples, surfaced as startup notices and readiness().degradedFields. */
  readonly degradations: Array<[string, string]> = []
  /**
   * Name disambiguations — a second `.meta({ title })` reusing a taken name.
   * Kept apart from `degradations` on purpose: GraphQL has one global type
   * namespace, so renaming is unavoidable and costs no capability. It is
   * reported (readiness().renames) but must not mark the bridge unready — a
   * CI `assert report.ready` gate has to stay meaningful.
   */
  readonly renames: Array<[string, string]> = []

  // ---- output side -------------------------------------------------------

  outputType(schema: ZodType, hint: string): GraphQLOutputType {
    const { inner, optional, nullable } = unwrap(schema, 'output')
    // outputBase never returns a NonNull wrapper by construction.
    const base = this.outputBase(inner, hint) as GraphQLNullableOutputType
    return optional || nullable ? base : new GraphQLNonNull(base)
  }

  private outputBase(schema: ZodType, hint: string): GraphQLOutputType {
    const cached = this.outCache.get(schema)
    if (cached) return cached

    const def = defOf(schema)
    const scalar = scalarFor(def)
    if (scalar) {
      this.outCache.set(schema, scalar)
      return scalar
    }

    switch (def.type) {
      case 'array': {
        const list = new GraphQLList(this.outputType(def.element, `${hint}Item`))
        this.outCache.set(schema, list)
        return list
      }
      case 'object': {
        const type = this.buildObjectOutput(schema, hint)
        this.outCache.set(schema, type)
        return type
      }
      case 'enum': {
        const type = this.buildEnum(schema, hint)
        this.outCache.set(schema, type)
        return type
      }
      default: {
        this.degradations.push([hint, `zod ${def.type} → JSON`])
        return GraphQLJSON
      }
    }
  }

  private buildObjectOutput(schema: ZodType, hint: string): GraphQLObjectType {
    const def = defOf(schema)
    const meta = globalRegistry.get(schema) as { title?: string; description?: string } | undefined
    const name = this.uniqueName(meta?.title ?? pascal(hint))
    // Fields are a thunk: recursion through z.lazy resolves against the cache
    // set by outputBase AFTER the constructor returns, before first execution.
    return new GraphQLObjectType({
      name,
      description: schema.description ?? meta?.description,
      fields: () => {
        const fields: Record<string, { type: GraphQLOutputType; description?: string }> = {}
        for (const [key, sub] of Object.entries(def.shape as Record<string, ZodType>)) {
          const subMeta = globalRegistry.get(sub) as { description?: string } | undefined
          fields[key] = {
            // Raw key as hint: degradation messages carry the real field name
            // (uniqueName pascal-cases whatever falls through to type naming).
            type: this.outputType(sub, key),
            description: sub.description ?? subMeta?.description,
          }
        }
        return fields
      },
    })
  }

  // ---- input side --------------------------------------------------------

  /**
   * Map a Zod schema to a GraphQL input arg: requiredness follows
   * optional/default wrappers; a default value travels onto the arg.
   * (A nullable-but-required zod input maps as optional — GraphQL args are
   * either NonNull or optional, there is no "required but nullable".)
   */
  inputArg(schema: ZodType, hint: string): ArgMapping {
    const { inner, optional, nullable, hasDefault, defaultValue } = unwrap(schema, 'input')
    // inputBase never returns a NonNull wrapper by construction.
    const base = this.inputBase(inner, hint) as GraphQLNullableInputType
    const type = optional || nullable || hasDefault ? base : new GraphQLNonNull(base)
    return hasDefault ? { type, hasDefault: true, defaultValue } : { type, hasDefault: false }
  }

  inputType(schema: ZodType, hint: string): GraphQLInputType {
    return this.inputArg(schema, hint).type
  }

  private inputBase(schema: ZodType, hint: string): GraphQLInputType {
    const cached = this.inCache.get(schema)
    if (cached) return cached

    const def = defOf(schema)
    const scalar = scalarFor(def)
    if (scalar) {
      this.inCache.set(schema, scalar)
      return scalar
    }

    switch (def.type) {
      case 'array': {
        const list = new GraphQLList(this.inputType(def.element, `${hint}Item`))
        this.inCache.set(schema, list)
        return list
      }
      case 'object': {
        const type = this.buildObjectInput(schema, hint)
        this.inCache.set(schema, type)
        return type
      }
      case 'enum': {
        const type = this.buildEnum(schema, hint)
        this.inCache.set(schema, type)
        return type
      }
      default: {
        this.degradations.push([hint, `zod ${def.type} → JSON (argument)`])
        return GraphQLJSON
      }
    }
  }

  private buildObjectInput(schema: ZodType, hint: string): GraphQLInputObjectType {
    const def = defOf(schema)
    const meta = globalRegistry.get(schema) as { title?: string; description?: string } | undefined
    const name = this.uniqueName((meta?.title ?? pascal(hint)) + 'Input')
    return new GraphQLInputObjectType({
      name,
      description: schema.description ?? meta?.description,
      fields: () => {
        const fields: Record<string, { type: GraphQLInputType; defaultValue?: unknown; description?: string }> = {}
        for (const [key, sub] of Object.entries(def.shape as Record<string, ZodType>)) {
          const arg = this.inputArg(sub, key)
          fields[key] = {
            type: arg.type,
            ...(arg.hasDefault ? { defaultValue: arg.defaultValue } : {}),
            description: sub.description,
          }
        }
        return fields
      },
    })
  }

  // ---- shared ------------------------------------------------------------

  private buildEnum(schema: ZodType, hint: string): GraphQLEnumType | GraphQLScalarType {
    const cached = this.enumCache.get(schema)
    if (cached) return cached
    const def = defOf(schema)
    const entries = def.entries as Record<string, string | number>
    // Same rule as the Python bridge: member names must be legal GraphQL
    // identifiers, else the whole enum degrades to JSON.
    if (!Object.keys(entries).every((k) => LEGAL_GRAPHQL_NAME.test(k))) {
      this.degradations.push([hint, 'enum with non-identifier member names → JSON'])
      this.enumCache.set(schema, GraphQLJSON)
      return GraphQLJSON
    }
    const type = new GraphQLEnumType({
      name: this.uniqueName(pascal(hint)),
      description: schema.description,
      values: Object.fromEntries(
        Object.entries(entries).map(([name, value]) => [name, { value }]),
      ),
    })
    this.enumCache.set(schema, type)
    return type
  }

  private uniqueName(preferred: string): string {
    let name = pascal(preferred)
    if (this.names.has(name)) {
      let n = 2
      while (this.names.has(`${name}_${n}`)) n++
      this.renames.push([name, `reused → ${name}_${n}`])
      name = `${name}_${n}`
    }
    this.names.add(name)
    return name
  }
}
