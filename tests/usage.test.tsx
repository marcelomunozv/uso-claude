import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-band',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 4,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const FUTURE_5H = '2099-01-01T05:00:00Z'
const FUTURE_7D = '2099-01-07T00:00:00Z'

const LIMITS = [
  { kind: 'five_hour', percentUsed: 8, resetsAt: FUTURE_5H },
  { kind: 'seven_day', percentUsed: 3, resetsAt: FUTURE_7D },
]

test('the band shows 5h and 7d from a reading, and keeps them when a later reading has none', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  // The first reading reports the windows; every later one (the 30 s poll) reports none,
  // as the engine does before a reply carries them: they must not be wiped.
  let reads = 0
  on('session.usage', () => (reads++ === 0
    ? { value: { startedAt: 0, context: { window: 200000, tokens: 36000, percent: 18 }, rateLimits: LIMITS } }
    : { value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2099-01-01T00:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // A later reply that reports no rate-limit windows must not wipe them.
  await $.session.measure({
    context: { window: 200000, tokens: 40000, percent: 20 },
    rateLimits: [],
    changed: ['context'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /context/ }))?.text).toBe('20% context')
    expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('8% 5h - 5h 0m')
    expect((await ui.find({ type: 'Text', text: /7d/ }))?.text).toBe('3% 7d - 6d 0h')
    await ui.unmount()
  }

  // The figures were kept for the next session.
  expect(store.get('limits')).toEqual({
    weekPct: 3,
    weekResetsAt: FUTURE_7D,
    fiveHourPct: 8,
    fiveHourResetsAt: FUTURE_5H,
  })
})

test('a new session shows the last known 5h and 7d before its first reply', async ($, on) => {
  const store = new Map<string, unknown>([
    ['limits', { weekPct: 12, weekResetsAt: FUTURE_7D, fiveHourPct: 28, fiveHourResetsAt: FUTURE_5H }],
  ])
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  // A fresh session: no reply yet, so no context fill and no rate-limit windows.
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2099-01-01T00:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toContain('28%')
  expect((await ui.find({ type: 'Text', text: /7d/ }))?.text).toContain('12%')
  await ui.unmount()
})

test('a reading with new rate limits updates the band', async ($, on) => {
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2099-01-01T00:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({
    context: { window: 200000, tokens: 40000, percent: 20 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 9, resetsAt: FUTURE_5H },
      { kind: 'seven_day', percentUsed: 4, resetsAt: FUTURE_7D },
    ],
    changed: ['context', 'rateLimits'],
  })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toContain('9%')
  expect((await ui.find({ type: 'Text', text: /7d/ }))?.text).toContain('4%')
  expect((await ui.find({ type: 'Text', text: /context/ }))?.text).toContain('20%')
  expect(store.get('limits')).toEqual({ weekPct: 4, weekResetsAt: FUTURE_7D, fiveHourPct: 9, fiveHourResetsAt: FUTURE_5H })
  await ui.unmount()
})

test('the band still draws when the saved figures cannot be read', async ($, on) => {
  on('store.get', () => {
    throw new Error('store down')
  })
  on('store.set', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { window: 200000, tokens: 36000, percent: 18 }, rateLimits: LIMITS },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: Date.parse('2099-01-01T00:00:00Z') }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /context/ }))?.text).toBe('18% context')
  expect((await ui.find({ type: 'Text', text: /5h/ }))?.text).toBe('8% 5h - 5h 0m')
  await ui.unmount()
})
