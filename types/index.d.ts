export type UsageSnapshot = {
  /** When the figures were read, in epoch milliseconds. */
  at: number
  /** Share of the context window in use, 0 to 100. */
  contextPct: number | null
  weekPct: number | null
  weekResetsAt: string | null
  fiveHourPct: number | null
  fiveHourResetsAt: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Shaped<UsageSnapshot> }
  }
}
