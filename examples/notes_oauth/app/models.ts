/**
 * Request/response schemas for the notes demo — the zod counterparts of
 * app/models.py. `.meta({ title })` names the GraphQL type, `.describe()`
 * carries the field descriptions over.
 */
import { z } from '@hono/zod-openapi'

/** The logged-in identity (from GitHub). */
export const GitHubUser = z
  .object({
    login: z.string().describe('GitHub username'),
    name: z.string().nullish().describe('display name'),
    avatar_url: z.string().nullish().describe('profile picture URL'),
  })
  .meta({ title: 'GitHubUser', description: 'The logged-in identity (from GitHub).' })

/** A Bearer token minted from the browser session (for MCP clients). */
export const TokenOut = z
  .object({
    access_token: z
      .string()
      .describe('HMAC-signed session token — pass as Authorization: Bearer <token>'),
    token_type: z.string().default('Bearer').describe('how to present the token'),
  })
  .meta({ title: 'TokenOut' })

/** A note owned by the logged-in user. */
export const NoteOut = z
  .object({
    id: z.int().describe('stable note identifier'),
    title: z.string().describe('note headline'),
    body: z.string().describe('note content'),
    owner: z.string().describe('GitHub login of the owner'),
  })
  .meta({ title: 'NoteOut', description: 'A note owned by the logged-in user.' })

/** Payload for creating a note. */
export const NoteCreate = z
  .object({
    title: z.string().describe('note headline'),
    body: z.string().default('').describe('note content'),
  })
  .meta({ title: 'NoteCreate', description: 'Payload for creating a note.' })

/** Public aggregate counters. */
export const StatsOut = z
  .object({
    notes: z.int().describe('notes stored across all users'),
    users: z.int().describe('distinct note owners'),
  })
  .meta({ title: 'StatsOut', description: 'Public aggregate counters.' })

/** Sparse note view for list widgets — deliberately optional-heavy. */
export const NoteSummary = z
  .object({
    id: z.int().describe('stable note identifier'),
    title: z.string().describe('note headline'),
    pinned: z.boolean().default(false).describe('pinned to the top'),
    color: z.string().nullish().describe('accent color, when themed'),
  })
  .meta({ title: 'NoteSummary', description: 'Sparse note view for list widgets.' })
