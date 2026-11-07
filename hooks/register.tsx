import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { UsageSnapshot as Snapshot } from '../types'

type Reading = {
  context: { percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

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

const toSnapshot = (at: number, { context, rateLimits }: Reading): Snapshot => {
  const week = rateLimits.find(l => l.kind === 'seven_day')
  const five = rateLimits.find(l => l.kind === 'five_hour')
  return {
    at,
    contextPct: context.percent ?? null,
    weekPct: week?.percentUsed ?? null,
    weekResetsAt: week?.resetsAt ?? null,
    fiveHourPct: five?.percentUsed ?? null,
    fiveHourResetsAt: five?.resetsAt ?? null,
  }
}

const minutesUntil = (iso: string | null, now: number): number | null =>
  iso === null ? null : Math.max(0, Math.round((Date.parse(iso) - now) / 60000))

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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const first = await $.session.usage()
    await update($, usage, () => toSnapshot(startedAt, first))

    // Refresh every 30 seconds; the countdowns redraw with the figures.
    $.clock.every(30_000, () => {
      void (async () => {
        const now = await $.clock.now()
        const fresh = await $.session.usage()
        await update($, usage, () => toSnapshot(now, fresh))
      })()
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const measuredAt = await $.clock.now()
    await update($, usage, () => toSnapshot(measuredAt, e))

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (u.at === 0) return next(e)

    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const now = await $.clock.now()
    const fiveLeft = fmtMinutes(minutesUntil(u.fiveHourResetsAt, now))
    const weekLeft = fmtMinutes(minutesUntil(u.weekResetsAt, now))

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
          {Ring(u.fiveHourPct, ORANGE)}
          <Text>
            <Text bold>{fmtPct(u.fiveHourPct)}</Text>
            <Text dimColor> 5h - {fiveLeft}</Text>
          </Text>
        </Box>
        <Box flexDirection="row" alignItems="center" gap={1}>
          {Ring(u.weekPct, BLUE)}
          <Text>
            <Text bold>{fmtPct(u.weekPct)}</Text>
            <Text dimColor> 7d - {weekLeft}</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
