/** Invalid construction options — thrown before anything is derived. */
export class HonoGqlMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HonoGqlMcpConfigError'
  }
}

/** Two routes sharing one field name in one domain — thrown at construction, never at first query. */
export class DuplicateFieldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DuplicateFieldError'
  }
}
