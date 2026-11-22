import { expect, mock, test } from 'claude-code/testing'

const T0 = 1_000_000_000

const BAND = (surface: 'terminal' | 'desktop', bodyColumns = 60, maxRows = 20) =>
  ({
    plugin: 'subagent-monitor',
    surface,
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: true,
      maxRows,
      bodyColumns,
      scroll: { offset: 0, bodyRows: maxRows },
      view: {},
    },
  }) as const

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => [
  { model: 'claude-opus-5-5', input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheWrite },
]

function agent(id: string, type: string, status: string, startAgo: number, model: string, tokens: [number, number, number?, number?], description = `${type} task`) {
  return {
    id,
    type,
    status,
    taskStatus: status === 'running' ? 'running' : status,
    description,
    label: description,
    kind: 'local_agent',
    startTime: T0 - startAgo,
    cwd: '/repo',
    model,
    contextWindowSize: 200_000,
    tokenCount: 0,
    tokenSamples: [],
    usage: usage(tokens[0], tokens[1], tokens[2] ?? 0, tokens[3] ?? 0),
  }
}

/** The band's text, one string per row. */
async function rows(ui: { drawn: () => Promise<unknown> }): Promise<string[]> {
  const out: string[] = []
  const walk = (n: unknown) => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: string; props?: { key?: string; children?: unknown }; children?: unknown }
    if (node.type === 'Button' && node.props?.key !== 'toggle') {
      out.push(texts(node).join(''))
      return
    }
    for (const c of [node.children, node.props?.children].flat(4)) walk(c)
  }
  const texts = (n: unknown): string[] => {
    if (typeof n === 'string') return [n]
    if (!n || typeof n !== 'object') return []
    const node = n as { props?: { children?: unknown }; children?: unknown }
    return [node.children, node.props?.children].flat(4).flatMap(texts)
  }
  walk(await ui.drawn())
  return out
}

test('compact band: sorting, tags, totals, hidden when no agents', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  let list: unknown[] = []
  on('agent.list', () => ({ value: list as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(450)

  // No agents: band falls through to the engine (nothing of ours drawn).
  let ui = await $.ui.mount(BAND('terminal'))
  expect(await rows(ui)).toEqual([])
  await ui.unmount()

  list = [
    agent('a1', 'code-reviewer', 'running', 72_000, 'claude-opus-5-5', [8_000, 10_400, 900_000]),
    agent('a2', 'test-writer', 'running', 48_000, 'claude-sonnet-5-5', [4_000, 5_100]),
    agent('a3', 'docs-checker', 'running', 90_000, 'claude-haiku-5-5', [3_000, 3_200]),
    agent('a4', 'explorer', 'completed', 123_000, 'claude-haiku-5-5', [20_000, 11_000]),
  ]
  // test-writer keeps a todo list; a3 goes quiet; a1 loops.
  await $.tool.call({ tool: 'TodoWrite', agentId: 'a2', todos: [
    { content: 'a', status: 'completed', activeForm: 'a' },
    { content: 'b', status: 'completed', activeForm: 'b' },
    { content: 'c', status: 'completed', activeForm: 'c' },
    { content: 'd', status: 'in_progress', activeForm: 'd' },
    { content: 'e', status: 'pending', activeForm: 'e' },
  ] } as never)
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: 'Bash', command: 'npm test', agentId: 'a1' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/app.ts', content: 'x', agentId: 'a2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'x', new_string: 'y', agentId: 'a3' } as never)

  await clock.advance(450)
  ui = await $.ui.mount(BAND('terminal'))
  const compact = await rows(ui)
  // Red first: a1 loops, a2/a3 conflict; finished last; total on last line.
  // All three red rows come first (ties by start time), the finished one last.
  expect(compact.slice(0, 3).every(r => r.includes('loop') || r.includes('⚠ conflict'))).toBe(true)
  expect(compact.some(r => r.includes('code-reviewer') && r.includes('loop'))).toBe(true)
  expect(compact.some(r => r.includes('3/5') && r.includes('⚠ conflict: app.ts'))).toBe(true)
  expect(compact[3]).toContain('✓ explorer')
  expect(compact.at(-1)).toMatch(/tok$/)
  expect(compact.find(r => r.includes('code-reviewer'))).toMatch(/18\.4k · 1:12$/)
  for (const r of compact) expect(Array.from(r).length).toBeLessThanOrEqual(60)

  // Expand via the hidden hotkey button.
  await ui.press({ key: 'toggle' })
  const expanded = await rows(ui)
  expect(expanded.some(r => r.includes('wrote app.ts'))).toBe(true)
  await ui.unmount()
})

test('stall, folding, many agents, narrow terminal', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const list = [
    agent('s1', 'sleepy-agent', 'running', 1_000, 'claude-sonnet-5-5', [100, 200]),
    agent('d1', 'quick-one', 'completed', 10_000, 'claude-haiku-5-5', [1_000, 2_000]),
    agent('r1', 'runner-a', 'running', 5_000, 'claude-opus-5-5', [1, 1]),
    agent('r2', 'runner-b', 'running', 5_000, 'claude-opus-5-5', [1, 1]),
    agent('r3', 'runner-c', 'running', 5_000, 'claude-opus-5-5', [1, 1]),
    agent('r4', 'a-very-long-subagent-type-name-indeed', 'running', 6_000, 'claude-opus-5-5', [1, 1]),
  ]
  on('agent.list', () => ({ value: list as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Keep runners busy, let s1 go quiet for 31s.
  for (let t = 0; t < 70; t++) {
    await clock.advance(450)
    for (const id of ['r1', 'r2', 'r3', 'r4']) await $.tool.call({ tool: 'Read', file_path: `/f${t}`, agentId: id } as never)
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(BAND(surface, 44))
    const r = await rows(ui)
    expect(r[0]).toContain('sleepy-agent')
    expect(r[0]).toMatch(/idle 3\ds/)
    expect(r.some(x => x.startsWith('+1 more · 1 running'))).toBe(true)
    expect(r.some(x => x.includes('✓ 1 done · 3.0k'))).toBe(true)
    expect(r.some(x => x.includes('…'))).toBe(true)
    for (const x of r) expect(Array.from(x).length).toBeLessThanOrEqual(44)
    await ui.unmount()
  }

  // A short band: never more lines than maxRows, our summary kept.
  for (const maxRows of [2, 3, 4]) {
    const ui = await $.ui.mount(BAND('terminal', 80, maxRows))
    const r = await rows(ui)
    expect(r.length).toBeLessThanOrEqual(maxRows)
    expect(r.at(-1)).toContain('more')
    expect(r.at(-1)).toContain('✓ 1 done')
    expect(r.at(-1)).toMatch(/tok$/)
    await ui.unmount()
  }
})

test('finished agents stay folded after the engine drops them; band hides when the list empties', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  let list = [
    agent('d1', 'quick-one', 'completed', 10_000, 'claude-haiku-5-5', [1_000, 2_000]),
    agent('r1', 'runner', 'running', 5_000, 'claude-opus-5-5', [1, 1]),
  ]
  on('agent.list', () => ({ value: list as never }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(450 * 14)
  list = list.filter(a => a.id !== 'd1')
  await clock.advance(450)
  let ui = await $.ui.mount(BAND('terminal'))
  expect((await rows(ui)).some(x => x.includes('✓ 1 done · 3.0k'))).toBe(true)
  await ui.unmount()
  list = []
  await clock.advance(450)
  ui = await $.ui.mount(BAND('terminal'))
  expect(await rows(ui)).toEqual([])
  await ui.unmount()
})
