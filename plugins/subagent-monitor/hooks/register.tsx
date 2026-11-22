// subagent-monitor: a compact live band above the prompt listing every
// subagent of the session, its state and its token usage.
//
// Read-only by design: every hook passes its event on unchanged with
// `next(e)` and only records what it saw. Nothing here denies, rewrites or
// delays what Claude Code does.

import { atom, read, update } from 'claude-code'
import type { AgentInfo, Register } from 'claude-code'

import type { AgentRow, RowState, Snapshot } from '../types'


// Change the tag when AgentRow/Snapshot change shape: a value stored by an
// older version is then read as `null` instead of drawn wrong.
const snapshot = atom({ plugin: 'subagent-monitor', key: 'snapshot' } as const, null, { shape: 'snap-1' })
const isExpanded = atom({ plugin: 'subagent-monitor', key: 'isExpanded' } as const, false)

const TICK_MS = 450
const STALL_MS = 30_000
const LOOP_REPEATS = 3
const FOLD_AFTER_MS = 5_000
const CTX_WARN_PCT = 80
const MAX_ROWS = 4
const PULSE = ['●', '◉', '○', '◉']

const LIVE = new Set(['pending', 'running', 'waiting', 'idle'])
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
// Fields a tool call carries besides the tool's own input; left out of the
// loop signature so two identical calls compare equal.
const ENVELOPE = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta'])

// ---------------------------------------------------------------------------
// Module-level state, shared by every hook. What the band draws is derived
// from it on each tick and written to the `snapshot` atom.

type Track = {
  lastEventAt: number
  sig?: string
  sigCount: number
  todos?: { done: number; total: number }
  tasks: Map<string, string>
  taskCreates: number
  files: Set<string>
  /** Tokens in context at the agent's latest step. */
  ctxTokens?: number
  /** Fallback token sum from steps seen, when the engine has no usage yet. */
  stepTokens: number
  finishedAt?: number
  lastTokens: number
}

const tracks = new Map<string, Track>()
/** Finished agents' last rows, kept after the engine drops them from its list. */
const finished = new Map<string, AgentRow>()
let tick = 0
let lastData = ''
let isBusy = false

function track(id: string, now: number): Track {
  let t = tracks.get(id)
  if (!t) {
    t = { lastEventAt: now, sigCount: 0, tasks: new Map(), taskCreates: 0, files: new Set(), stepTokens: 0, lastTokens: 0 }
    tracks.set(id, t)
  }
  return t
}

function touch(agentId: string | undefined, now: number) {
  if (agentId) track(agentId, now).lastEventAt = now
}

async function nowMs($: { clock: { now: () => Promise<number> } }): Promise<number> {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// ---------------------------------------------------------------------------
// Recording (never throws into the engine's path)

function noteCall(input: Record<string, unknown>, now: number) {
  try {
    const agentId = input.agentId as string | undefined
    if (!agentId) return
    const t = track(agentId, now)
    t.lastEventAt = now

    // Loop detection: same tool, same input, back to back.
    const rest: Record<string, unknown> = {}
    for (const k of Object.keys(input).sort()) if (!ENVELOPE.has(k)) rest[k] = input[k]
    const sig = `${String(input.tool)}:${JSON.stringify(rest)}`
    t.sigCount = sig === t.sig ? t.sigCount + 1 : 1
    t.sig = sig

    const tool = String(input.tool)
    if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
      const todos = input.todos as { status?: string }[]
      t.todos = { done: todos.filter(x => x.status === 'completed').length, total: todos.length }
    } else if (tool === 'TaskCreate') {
      t.taskCreates += 1
    } else if (tool === 'TaskUpdate' && typeof input.taskId === 'string' && typeof input.status === 'string') {
      t.tasks.set(input.taskId, input.status)
    }
  } catch {
    // bookkeeping only
  }
}

function noteResult(input: Record<string, unknown>, ran: { deny?: string; isError?: boolean }, now: number) {
  try {
    const agentId = input.agentId as string | undefined
    if (!agentId) return
    const t = track(agentId, now)
    t.lastEventAt = now
    const tool = String(input.tool)
    if (WRITE_TOOLS.has(tool) && ran.deny === undefined && ran.isError !== true) {
      const path = (input.file_path ?? input.notebook_path) as string | undefined
      if (typeof path === 'string' && path) t.files.add(path)
    }
  } catch {
    // bookkeeping only
  }
}

function noteStep(agentId: string | undefined, usage: Usage | null | undefined, now: number) {
  try {
    if (!agentId) return
    const t = track(agentId, now)
    t.lastEventAt = now
    if (usage) {
      t.ctxTokens = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens
      t.stepTokens += counted(usage)
    }
  } catch {
    // bookkeeping only
  }
}

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The token figure the band shows: new input + cache writes + output. Cache reads are excluded. */
function counted(u: Usage): number {
  return (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0)
}

// ---------------------------------------------------------------------------
// Deriving the snapshot

function shortModel(model?: string): string {
  if (!model) return ''
  const m = model.toLowerCase()
  for (const k of ['opus', 'sonnet', 'haiku', 'fable']) if (m.includes(k)) return k
  return model.replace(/^claude-/, '').slice(0, 12)
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function progressOf(t: Track): string | undefined {
  if (t.todos && t.todos.total > 0) return `${t.todos.done}/${t.todos.total}`
  if (t.taskCreates > 0 || t.tasks.size > 0) {
    let done = 0
    let deleted = 0
    for (const s of t.tasks.values()) {
      if (s === 'completed') done += 1
      else if (s === 'deleted') deleted += 1
    }
    const total = Math.max(t.taskCreates - deleted, done)
    if (total > 0) return `${done}/${total}`
  }
  return undefined
}

function derive(list: AgentInfo[], now: number): AgentRow[] {
  // Files written by live agents, to find conflicts.
  const writers = new Map<string, Set<string>>()
  for (const a of list) {
    if (!LIVE.has(a.status)) continue
    for (const f of tracks.get(a.id)?.files ?? []) {
      let s = writers.get(f)
      if (!s) writers.set(f, (s = new Set()))
      s.add(a.id)
    }
  }

  const rows: AgentRow[] = []
  for (const a of list) {
    const t = track(a.id, Math.max(a.startTime, 0) || now)
    const isLive = LIVE.has(a.status)
    if (!isLive && t.finishedAt === undefined) t.finishedAt = now
    if (isLive) t.finishedAt = undefined

    const usageTokens = (a.usage ?? []).reduce((n, u) => n + counted(u), 0)
    const tokens = usageTokens > 0 ? usageTokens : t.stepTokens
    t.lastTokens = tokens

    const conflicts: string[] = []
    if (isLive) {
      for (const f of t.files) if ((writers.get(f)?.size ?? 0) > 1) conflicts.push(basename(f))
    }
    const ctxPct = t.ctxTokens !== undefined && a.contextWindowSize ? Math.round((t.ctxTokens / a.contextWindowSize) * 100) : undefined
    const idleMs = now - Math.max(t.lastEventAt, a.startTime)
    const isLooping = isLive && t.sigCount >= LOOP_REPEATS
    const isStalled = isLive && idleMs >= STALL_MS

    let state: RowState
    if (!isLive) state = a.status === 'completed' ? 'done' : 'failed'
    else if (isLooping) state = 'looping'
    else if (isStalled) state = 'stalled'
    else state = 'running'

    const isRed = isLive && (isLooping || conflicts.length > 0)
    const isAmber = isLive && (isStalled || (ctxPct ?? 0) >= CTX_WARN_PCT)
    const rank = isRed ? 0 : isAmber ? 1 : isLive ? 2 : 3

    rows.push({
      id: a.id,
      name: a.type || a.name || 'agent',
      model: shortModel(a.model),
      state,
      rank,
      startTime: a.startTime,
      idleSec: isStalled ? Math.floor(idleMs / 1000) : undefined,
      progress: progressOf(t),
      ctxPct,
      conflicts,
      tokens,
      elapsedMs: (t.finishedAt ?? now) - a.startTime,
      finishedAgoMs: t.finishedAt !== undefined ? now - t.finishedAt : undefined,
      description: a.description,
      files: [...t.files].map(basename),
    })
  }

  // The engine drops a finished agent from its list after a while. Keep it
  // (folded) while the band shows, so the done count and tokens stay put.
  const listed = new Set(list.map(a => a.id))
  for (const r of rows) if (r.rank === 3) finished.set(r.id, r)
  if (list.length > 0) {
    for (const [id, r] of finished) {
      if (listed.has(id)) continue
      const doneAt = tracks.get(id)?.finishedAt
      rows.push({ ...r, finishedAgoMs: doneAt !== undefined ? now - doneAt : FOLD_AFTER_MS })
    }
  }

  rows.sort((x, y) => x.rank - y.rank || x.startTime - y.startTime)
  return rows
}

// ---------------------------------------------------------------------------
// Formatting

function fmtTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

type Seg = { text: string; color?: string; dim?: boolean }

const len = (s: string) => Array.from(s).length
const segsLen = (segs: Seg[]) => segs.reduce((n, s) => n + len(s.text), 0)

function cut(s: string, max: number): string {
  const chars = Array.from(s)
  if (chars.length <= max) return s
  if (max <= 1) return max === 1 ? '…' : ''
  return chars.slice(0, max - 1).join('') + '…'
}

/** Truncate from the end so the segments fit `budget` cells. */
function clip(segs: Seg[], budget: number): Seg[] {
  const out: Seg[] = []
  let used = 0
  for (const s of segs) {
    const room = budget - used
    if (room <= 0) break
    const l = len(s.text)
    if (l <= room) {
      out.push(s)
      used += l
    } else {
      out.push({ ...s, text: cut(s.text, room) })
      break
    }
  }
  return out
}

/**
 * Lay out one line: left segments, right text flush right, within `width`.
 * `nameIdx` is the segment shrunk first (to at least 6 cells) before the
 * whole left side is clipped from the end.
 */
function line(left: Seg[], right: Seg[], width: number, nameIdx = -1): Seg[] {
  const rLen = segsLen(right)
  const budget = Math.max(0, width - rLen - (rLen > 0 ? 1 : 0))
  let segs = left
  if (segsLen(segs) > budget && nameIdx >= 0) {
    const over = segsLen(segs) - budget
    const name = segs[nameIdx]!
    const target = Math.max(6, len(name.text) - over)
    segs = segs.map((s, i) => (i === nameIdx ? { ...s, text: cut(s.text, target) } : s))
  }
  segs = clip(segs, budget)
  const pad = Math.max(rLen > 0 ? 1 : 0, width - segsLen(segs) - rLen)
  return [...segs, { text: ' '.repeat(pad) }, ...right]
}

function dot(state: RowState, frame: number): Seg {
  switch (state) {
    case 'done':
      return { text: '✓', color: 'success' }
    case 'failed':
      return { text: '✗', color: 'error' }
    case 'stalled':
      return { text: PULSE[Math.floor(frame / 2) % PULSE.length] ?? "●", color: 'warning' }
    case 'looping':
      return { text: PULSE[frame % PULSE.length] ?? "●", color: 'error' }
    default:
      return { text: PULSE[frame % PULSE.length] ?? "●", color: 'success' }
  }
}

function agentLine(a: AgentRow, frame: number, width: number, isExpanded: boolean): Seg[] {
  const isFinished = a.state === 'done' || a.state === 'failed'
  const left: Seg[] = [dot(a.state, frame), { text: ' ' }, { text: a.name, dim: isFinished }]
  if (a.model) left.push({ text: `  ${a.model}`, dim: true })
  const tags: Seg[] = []
  if (a.progress) tags.push({ text: a.progress, dim: true })
  if (a.state === 'stalled' && a.idleSec !== undefined) tags.push({ text: `idle ${a.idleSec}s`, color: 'warning' })
  if (a.state === 'looping') tags.push({ text: 'loop', color: 'error' })
  if (!isExpanded && a.ctxPct !== undefined && a.ctxPct >= CTX_WARN_PCT) tags.push({ text: `ctx ${a.ctxPct}%`, color: 'warning' })
  if (a.conflicts.length > 0) {
    const more = a.conflicts.length > 1 ? ` +${a.conflicts.length - 1}` : ''
    tags.push({ text: `⚠ conflict: ${a.conflicts[0]}${more}`, color: 'error' })
  }
  for (const t of tags) left.push({ text: '  ' }, t)
  const right: Seg[] = [{ text: `${fmtTokens(a.tokens)} · ${fmtTime(a.elapsedMs)}`, dim: true }]
  return line(left, right, width, 2)
}

function detailLine(a: AgentRow, width: number): Seg[] {
  const parts: Seg[] = [{ text: '    ' }, { text: a.description || '(no description)', dim: true }]
  const ctx = a.ctxPct === undefined ? 'ctx –' : `ctx ${a.ctxPct}%`
  parts.push({ text: ' · ', dim: true }, a.ctxPct !== undefined && a.ctxPct >= CTX_WARN_PCT ? { text: ctx, color: 'warning' } : { text: ctx, dim: true })
  parts.push({ text: ' · ', dim: true }, { text: a.files.length ? `wrote ${a.files.join(', ')}` : 'no writes', dim: true })
  return line(parts, [], width)
}

type Line = { key: string; segs: Seg[] }

/** Every line the band draws, worked out from the snapshot. */
function layout(snap: Snapshot, isExpanded: boolean, width: number, maxRows = 99): Line[] {
  const lines: Line[] = []
  const totalSeg: Seg[] = [{ text: `${fmtTokens(snap.total)} tok`, dim: true }]

  if (isExpanded) {
    for (const a of snap.agents) {
      lines.push({ key: `row-${a.id}`, segs: agentLine(a, snap.tick, width, true) })
      lines.push({ key: `detail-${a.id}`, segs: detailLine(a, width) })
    }
    lines.push({ key: 'total', segs: line([], totalSeg, width) })
    return lines
  }

  const folded = snap.agents.filter(a => a.finishedAgoMs !== undefined && a.finishedAgoMs >= FOLD_AFTER_MS)
  const shown = snap.agents.filter(a => !folded.includes(a))
  // At most MAX_ROWS agent rows, fewer when the band is short on height, so
  // our own "+N more" line shows instead of the engine scrolling the band.
  // At most MAX_ROWS agent rows. When the band is short on height, first put
  // the "+N more" and folded lines on one line, then drop agent rows, so our
  // own summary shows instead of the engine scrolling the band.
  const hasFold = folded.length > 0
  let cap = Math.min(MAX_ROWS, shown.length)
  let isMerged = false
  const hasMore = () => shown.length > cap
  const need = () => cap + (hasMore() && hasFold && !isMerged ? 2 : 1)
  if (need() > maxRows) isMerged = true
  while (need() > maxRows && cap > 1) cap -= 1
  const rows = shown.slice(0, cap)
  const hidden = shown.slice(cap)
  for (const a of rows) lines.push({ key: `row-${a.id}`, segs: agentLine(a, snap.tick, width, false) })

  const tail: { key: string; left: Seg[] }[] = []
  if (hidden.length > 0) {
    const count = (s: RowState[]) => hidden.filter(a => s.includes(a.state)).length
    const parts = [
      `+${hidden.length} more`,
      count(['running', 'looping']) ? `${count(['running', 'looping'])} running` : '',
      count(['stalled']) ? `${count(['stalled'])} idle` : '',
      count(['done']) ? `${count(['done'])} done` : '',
      count(['failed']) ? `${count(['failed'])} failed` : '',
    ].filter(Boolean)
    tail.push({ key: 'more', left: [{ text: parts.join(' · '), dim: true }] })
  }
  if (hasFold) {
    const done = folded.filter(a => a.state === 'done').length
    const failed = folded.length - done
    const tokens = folded.reduce((n, a) => n + a.tokens, 0)
    const left: Seg[] = []
    if (done) left.push({ text: '✓', color: 'success' }, { text: ` ${done} done`, dim: true })
    if (failed) left.push({ text: done ? '  ' : '' }, { text: '✗', color: 'error' }, { text: ` ${failed} failed`, dim: true })
    left.push({ text: ` · ${fmtTokens(tokens)}`, dim: true })
    tail.push({ key: 'fold', left })
  }
  if (isMerged && tail.length === 2) {
    const [more, fold] = tail as [{ key: string; left: Seg[] }, { key: string; left: Seg[] }]
    tail.splice(0, 2, { key: 'more', left: [...more.left, { text: '   ' }, ...fold.left] })
  }
  if (tail.length === 0) tail.push({ key: 'total', left: [] })
  tail.forEach((tl, i) => {
    const isLast = i === tail.length - 1
    lines.push({ key: tl.key, segs: line(tl.left, isLast ? totalSeg : [], width) })
  })
  return lines
}

// ---------------------------------------------------------------------------

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      if (isBusy) return
      isBusy = true
      void (async () => {
        try {
          const list = await $.agent.list()
          const now = await nowMs($)
          const agents = derive(list, now)
          const total = [...tracks.values()].reduce((n, t) => n + t.lastTokens, 0)
          const hasLive = agents.some(a => a.rank < 3)
          // Redraw every tick while something is live (pulse, clocks);
          // otherwise only when what is shown changes.
          const data = JSON.stringify({ agents: agents.map(a => ({ ...a, elapsedMs: 0, finishedAgoMs: (a.finishedAgoMs ?? 0) >= FOLD_AFTER_MS })), total })
          if (agents.length === 0 && lastData === '') return
          if (!hasLive && data === lastData) return
          lastData = agents.length === 0 ? '' : data
          tick += 1
          const value: Snapshot | null = agents.length === 0 ? null : { tick, agents, total }
          await update($, snapshot, () => value)
        } catch {
          // a failed tick just skips a frame
        } finally {
          isBusy = false
        }
      })()
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    timer?.cancel()
    timer = undefined

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>
    noteCall(input, await nowMs($))
    const ran = await next(e)
    noteResult(input, ran, await nowMs($))

    return ran
  }).catch(($, e, next) => next(e))

  // turn.step streams: forward every chunk untouched, then note the usage.
  on('turn.step', async function* ($, e, next) {
    touch(e.agentId, await nowMs($))
    const res = yield* next(e)
    noteStep(e.agentId, res.usage, await nowMs($))

    return res
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const snap = await read($, snapshot)
    const expanded = await read($, isExpanded)

    if (e.props.hasSurvey || snap === null || snap.agents.length === 0) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    // One spare cell: the invisible hotkey beside the last line must not wrap it.
    const width = Math.max(20, e.props.bodyColumns - 1)
    const toggle = () => update($, isExpanded, v => !v)
    const lines = layout(snap, expanded, width, e.props.maxRows)

    return (
      <Box flexDirection="column">
        {lines.map((l, i) => {
          const row = (
            <Button key={l.key} plain autoFocus={i === 0 ? true : undefined} label={l.segs.map(s => s.text).join('').trimEnd() || ' '} onPress={toggle}>
              {l.segs.map(s => (
                <Text color={s.color} dimColor={s.dim}>
                  {s.text}
                </Text>
              ))}
            </Button>
          )
          // The `e` hotkey rides, invisible, on the last line so it costs no row.
          return i < lines.length - 1 ? (
            row
          ) : (
            <Box key={`${l.key}-wrap`} flexDirection="row">
              {row}
              <Box key="hotkeys" width={0} height={1} overflow="hidden">
                <Button key="toggle" plain hotkey="e" label="e" onPress={toggle} />
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
