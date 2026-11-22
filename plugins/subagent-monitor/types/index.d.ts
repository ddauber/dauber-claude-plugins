/** Where an agent stands, as the band draws it. */
export type RowState = 'running' | 'stalled' | 'looping' | 'done' | 'failed'

/** One subagent, already worked out by the tick; the band only lays it out. */
export type AgentRow = {
  id: string
  /** The subagent type (`code-reviewer`, `Explore`, ...). */
  name: string
  /** Short model tag: opus, sonnet, haiku, fable, or a trimmed id. */
  model: string
  state: RowState
  /** 0 red warning, 1 amber warning, 2 running, 3 finished: the sort key. */
  rank: number
  startTime: number
  /** Seconds since the agent's last event, when stalled. */
  idleSec?: number
  /** `done/total` from the agent's own todo or task list; absent without one. */
  progress?: string
  /** Context fill in percent, when known. */
  ctxPct?: number
  /** Basenames of files another running agent has also written. */
  conflicts: string[]
  /** New input + cache-creation input + output tokens; cache reads excluded. */
  tokens: number
  elapsedMs: number
  /** How long ago it finished, for folding; absent while live. */
  finishedAgoMs?: number
  /** The short description it was spawned with. */
  description: string
  /** Basenames of files it has written. */
  files: string[]
}

export type Snapshot = {
  /** Pulse counter, one step per tick (~450 ms). */
  tick: number
  agents: AgentRow[]
  /** Session total over every subagent seen, same counting as `tokens`. */
  total: number
}

declare module 'claude-code' {
  interface PluginState {
    'subagent-monitor': {
      snapshot: Shaped<Snapshot | null>
      isExpanded: boolean
    }
  }
}
