/**
 * OpenTelemetry — one waterfall per query, mirroring the Python bridge:
 *
 *   tools/call graphql_query            (tool layer — we emit; the MCP SDK emits nothing)
 *     └─ graphql.execute                (orchestration layer — handler.execute)
 *          └─ GET /notes (route span)   (route layer — the host's @hono/otel
 *                                        middleware extracts the traceparent we
 *                                        inject into every in-process route call)
 *
 * `@opentelemetry/api` is a direct dependency by OTel convention: without a
 * registered SDK everything here is a no-op (non-recording spans, no headers
 * injected) — install an OTel SDK next to your app and that is the whole
 * setup.
 *
 * Bonus over the Python bridge: the MCP protocol (2026-07-28) carries the
 * client's W3C trace context in the envelope `_meta` (`traceparent`). When
 * present, the tool span parents to the CALLER's trace — end to end from the
 * agent client through GraphQL orchestration down to the business routes.
 */
import * as api from '@opentelemetry/api'
import { W3CTraceContextPropagator } from '@opentelemetry/core'

// Keep in sync with package.json.
const TRACER = api.trace.getTracer('hono-gql-mcp', '0.1.0')
// Own propagator instance: the api's GLOBAL propagator stays a no-op until
// something registers one (NodeSDK usually does) — extraction and injection
// must not depend on the host's registration state.
const W3C = new W3CTraceContextPropagator()

/** The currently active span, if any (executor events land on graphql.execute). */
export function activeSpan(): api.Span | undefined {
  return api.trace.getSpan(api.context.active())
}

/** The MCP envelope's trace keys (2026-07-28 `_meta`), as surfaced on ctx.mcpReq.envelope. */
export interface EnvelopeTrace {
  traceparent?: unknown
  tracestate?: unknown
}

/** Context with the envelope's W3C trace context as parent, when the client propagated one. */
export function envelopeParentContext(envelope: EnvelopeTrace | undefined): api.Context {
  if (typeof envelope?.traceparent !== 'string' || envelope.traceparent.length === 0) {
    return api.context.active()
  }
  const carrier: Record<string, string> = { traceparent: envelope.traceparent }
  if (typeof envelope.tracestate === 'string') carrier.tracestate = envelope.tracestate
  return W3C.extract(api.context.active(), carrier, api.defaultTextMapGetter)
}

/**
 * Manual span + context wiring — deliberately NOT `tracer.startActiveSpan`.
 * The api package's exports map (module/default, no import condition) loads
 * TWO instances under tsx-style bundler resolution: our import and the
 * SDK-internal one. startActiveSpan's internal context.with would land on the
 * instance whose global context manager is never registered — nesting would
 * silently break. Doing both halves on OUR api instance pins the chain.
 */
function runInSpan<T>(
  name: string,
  fn: (span: api.Span) => Promise<T>,
  opts: api.SpanOptions,
  parent: api.Context,
): Promise<T> {
  const span = TRACER.startSpan(name, opts, parent)
  const ctx = api.trace.setSpan(parent, span)
  return api.context.with(ctx, async () => {
    try {
      return await fn(span)
    } catch (err) {
      span.recordException(err as Error)
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: (err as Error).message })
      throw err
    } finally {
      span.end()
    }
  })
}

/** Wrap a tool invocation in a `tools/call <name>` span, parented to the caller's trace when the envelope carried one. */
export function withToolSpan<T>(
  tool: string,
  envelope: EnvelopeTrace | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return runInSpan(`tools/call ${tool}`, async () => fn(), {}, envelopeParentContext(envelope))
}

/** The graphql.execute span around document execution (resolvers and their route calls nest inside). */
export function withExecuteSpan<T>(fn: (span: api.Span) => Promise<T>): Promise<T> {
  return runInSpan('graphql.execute', fn, {}, api.context.active())
}

/**
 * W3C inject into an in-process route call's headers — independent of the
 * passthrough whitelist (credentials are the caller's; the trace context is
 * ours). No-op without a recording span in the active context.
 */
export function injectTraceContext(headers: Record<string, string>): void {
  W3C.inject(api.context.active(), headers, api.defaultTextMapSetter)
}
