import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageSnapshot as Snapshot } from '../types'

type Limit = { kind: string; percentUsed: number; resetsAt?: string }
type Reading = {
  context: { percent?: number }
  rateLimits: Limit[]
}

// The rate-limit figures kept across sessions, so a new session (or a reply that
// reports no rate-limit windows) shows the last known values instead of dashes.
type SavedLimits = Pick<
  Snapshot,
  'weekPct' | 'weekResetsAt' | 'fiveHourPct' | 'fiveHourResetsAt'
>
const STORE_KEY = 'limits'

const EMPTY: Snapshot = {
  at: 0,
  contextPct: null,
  weekPct: null,
  weekResetsAt: null,
  fiveHourPct: null,
  fiveHourResetsAt: null,
}

// Change the tag if the snapshot's fields change, so an older value is declined.
const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, EMPTY, {
  shape: 'usage-band-2',
})

const GREEN = '#22c55e'
const ORANGE = '#f97316'
const BLUE = '#3b82f6'

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string'

const asSaved = (v: unknown): SavedLimits | null => {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const pct = (x: unknown) => (isNum(x) ? x : null)
  const iso = (x: unknown) => (isStrOrNull(x) ? x : null)
  return {
    weekPct: pct(o.weekPct),
    weekResetsAt: iso(o.weekResetsAt),
    fiveHourPct: pct(o.fiveHourPct),
    fiveHourResetsAt: iso(o.fiveHourResetsAt),
  }
}

// Merge a reading into the previous snapshot: a window the reading does not
// carry keeps its previous figures; a context reading without a percent keeps
// the previous one.
const merge = (prev: Snapshot, at: number, { context, rateLimits }: Reading): Snapshot => {
  const week = rateLimits.find(l => l.kind === 'seven_day')
  const five = rateLimits.find(l => l.kind === 'five_hour')
  return {
    at,
    contextPct: isNum(context.percent) ? context.percent : prev.contextPct,
    weekPct: week ? week.percentUsed : prev.weekPct,
    weekResetsAt: week ? (week.resetsAt ?? null) : prev.weekResetsAt,
    fiveHourPct: five ? five.percentUsed : prev.fiveHourPct,
    fiveHourResetsAt: five ? (five.resetsAt ?? null) : prev.fiveHourResetsAt,
  }
}

const savedOf = (s: Snapshot): SavedLimits => ({
  weekPct: s.weekPct,
  weekResetsAt: s.weekResetsAt,
  fiveHourPct: s.fiveHourPct,
  fiveHourResetsAt: s.fiveHourResetsAt,
})

const minutesUntil = (iso: string | null, now: number): number | null => {
  if (iso === null) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((t - now) / 60000))
}

// Once a window's reset time has passed, its stored share no longer holds.
const isPast = (iso: string | null, now: number): boolean => {
  if (iso === null) return false
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= now
}

const fmtMinutes = (mins: number | null): string => {
  if (mins === null) return ''
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const minutes = mins % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

// Text fallback where the surface cannot draw vectors: ○ ◔ ◑ ◕ ●
const ring = (pct: number | null): string => {
  if (pct === null) return '○'
  if (pct < 12.5) return '○'
  if (pct < 37.5) return '◔'
  if (pct < 62.5) return '◑'
  if (pct < 87.5) return '◕'
  return '●'
}

const RADIUS = 9
const CIRC = 2 * Math.PI * RADIUS

// A 24-px ring: grey track, coloured arc from the top, clockwise.
const ringSvg = (pct: number | null, color: string): string => {
  const arc = (Math.min(100, Math.max(0, pct ?? 0)) / 100) * CIRC
  const arcEl =
    arc > 0
      ? `<circle cx="12" cy="12" r="${RADIUS}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-dasharray="${arc.toFixed(2)} ${CIRC.toFixed(2)}" transform="rotate(-90 12 12)"/>`
      : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24"><circle cx="12" cy="12" r="${RADIUS}" fill="none" stroke="#3f3f46" stroke-width="3"/>${arcEl}</svg>`
}

const fmtPct = (pct: number | null): string =>
  pct === null ? '–' : `${Math.round(pct)}%`

// Apply a reading: merge it, keep it for the drawing, and remember the
// rate-limit figures across sessions when the reading carried any.
async function apply($: EngineInterface, reading: Reading): Promise<void> {
  const at = await $.clock.now()
  // Merge inside update, against the value it read with its version, so a
  // concurrent write is never overwritten with stale figures.
  let merged: Snapshot | null = null
  await update($, usage, prev => {
    merged = merge(prev, at, reading)
    return merged
  })
  const hasWindows = reading.rateLimits.some(
    l => l.kind === 'five_hour' || l.kind === 'seven_day',
  )
  if (merged !== null && hasWindows) {
    const saved = savedOf(merged)
    // Write only when the kept figures changed.
    const before = asSaved(await $.store.get(STORE_KEY))
    if (JSON.stringify(before) !== JSON.stringify(saved)) {
      await $.store.set(STORE_KEY, saved)
    }
  }
}

// Poll the engine's figures; a failure waits for the next tick.
async function poll($: EngineInterface): Promise<void> {
  try {
    await apply($, await $.session.usage())
  } catch {
    // Nothing to do: the next tick or reply reads again.
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Refresh every 30 seconds; the countdowns redraw with the figures.
    // Started first, so a failure below never leaves the session without it.
    $.clock.every(30_000, () => {
      void poll($)
    })

    // Start from the last known rate limits, so the rings show before the first reply.
    try {
      const saved = asSaved(await $.store.get(STORE_KEY))
      const at = await $.clock.now()
      await update($, usage, prev => ({ ...prev, ...(saved ?? {}), at }))
    } catch {
      // No saved figures: the first reading fills them in.
    }

    await poll($)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    try {
      await apply($, e)
    } catch {
      // The next reading tries again.
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    // Leave the band to the engine while a survey shows, or before any figures.
    if (u.at === 0 || e.props.hasSurvey) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const now = await $.clock.now()

    const fiveDone = isPast(u.fiveHourResetsAt, now)
    const weekDone = isPast(u.weekResetsAt, now)
    const fivePct = fiveDone ? 0 : u.fiveHourPct
    const weekPct = weekDone ? 0 : u.weekPct
    const fiveLeft = fiveDone ? '' : fmtMinutes(minutesUntil(u.fiveHourResetsAt, now))
    const weekLeft = weekDone ? '' : fmtMinutes(minutesUntil(u.weekResetsAt, now))

    // A real ring where the surface draws vectors (the desktop); text glyphs elsewhere.
    const Ring = (pct: number | null, color: string) =>
      Svg ? (
        <Svg
          source={ringSvg(pct, color)}
          alt={`anillo ${fmtPct(pct)}`}
          width={26}
          height={26}
        />
      ) : (
        <Text color={color}>{ring(pct)} </Text>
      )

    return (
      <Box flexDirection="row" alignItems="center" gap={3}>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Ring(u.contextPct, GREEN)}
          <Text>
            <Text bold>{fmtPct(u.contextPct)}</Text>
            <Text dimColor> context</Text>
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Ring(fivePct, ORANGE)}
          <Text>
            <Text bold>{fmtPct(fivePct)}</Text>
            <Text dimColor> 5h{fiveLeft ? ` - ${fiveLeft}` : ''}</Text>
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Ring(weekPct, BLUE)}
          <Text>
            <Text bold>{fmtPct(weekPct)}</Text>
            <Text dimColor> 7d{weekLeft ? ` - ${weekLeft}` : ''}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
