/** Invalid construction options — thrown before anything is derived. */
export class HonoGqlMcpConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HonoGqlMcpConfigError'
  }
}
