// Flightdeck types are ported from Flightdeck by Stephen Casella (MIT), see third_party/flightdeck-LICENSE.txt.
export type Moment = 'before a plan' | 'error repeats' | 'before done'

export type Bucket = 'file' | 'shell' | 'other'

/** rule: settings allowed it. ask: put to the decider, outcome pending. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'

export type Main = {
  model: string
  effort: string
  mode: string
  steps: number
  isRunning: boolean
  /** The main loop's last answered request: time to its first piece of response, and output tokens
   *  per second from that piece to the stop. Null until one is measured, absent in older state. */
  speed?: { ttftMs: number; tokPerS: number | null } | null
}

export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  costUsd: number | null
  /** `resetsAt`: when the window resets, in ms since the epoch; null when the API gave no time,
   *  absent in state saved before it was kept. */
  limits: { kind: string; pct: number; resetsAt?: number | null }[]
  compactions: number
  lastCompactAt: number | null
}

export type Consult = { id: string; at: number; endAt: number | null; moment: Moment; via: string }

export type Architect = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

export type Check = {
  id: string
  tool: string
  bucket: Bucket
  verdict: Verdict
  inSubagent: boolean
  detail: string
  at: number
}

export type Tally = { rule: number; ask: number; cleared: number; deny: number }

export type Gate = { recent: Check[]; totals: Record<Bucket, Tally> }

export type ToolNote = { tool: string; text: string; isError: boolean }

export type AgentCard = {
  id: string
  type: string
  model: string
  description: string
  status: string
  spawnedAt: number
  endedAt: number | null
  /** The agent's context now: input + cache read + cache write of its latest step. */
  ctx: number
  /** Output tokens summed over its steps. */
  out: number
  steps: number
  lastStop: string | null
  tools: ToolNote[]
  answer: string
}

/** A model loop whose id matches no card: a workflow agent, a compaction or a memory fork. */
export type Loop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

export type LogLine = {
  at: number
  who: string
  text: string
  agentId: string | null
  kind: 'info' | 'error' | 'consult' | 'done'
}

export type Turn = {
  edits: number
  errorStreak: number
  errors: number
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
}

export type Receipt = {
  durationMs: number
  agents: number
  edits: number
  errors: number
  costDelta: number | null
  reason: string
}

export type Layout = 'auto' | 'compact' | 'wide' | 'mini'

export type View = { expanded: string | null; gateOpen: Bucket | null; layout: Layout | null }

export type Roster = { architectTypes: string[] }

// ---------------------------------------------------------------- crew (crew-graph's own)

export type Verb = 'read' | 'edit' | 'search' | 'run' | 'web' | 'spawn' | 'plan' | 'think' | 'done' | 'failed' | 'wait'

/** What one model loop (main or a subagent) is doing right now. */
export type LoopAct = {
  /** 'main' for the main loop, else the agent id. */
  key: string
  verb: Verb
  tool: string
  /** What the call works on (file, pattern, command), already shortened and redacted. */
  target: string
  /** When the current call started (ms). */
  since: number
  calls: number
}

/** A plan / doc / code file some loop touched. */
export type FileNode = {
  path: string
  kind: 'plan' | 'doc' | 'code'
  /** loop key -> 'r' (read), 'w' (wrote), 'rw'. */
  by: Record<string, 'r' | 'w' | 'rw'>
  last: number
}

/** One step of the interaction process, for the web view's particles. */
export type CrewEvent = {
  id: number
  t: number
  kind: 'prompt' | 'spawn' | 'tool' | 'read' | 'write' | 'done' | 'fail' | 'deny' | 'check' | 'consult' | 'answer' | 'compact'
  from: string
  to?: string
  tool?: string
  text: string
}

/** Parent links the engine reports for subagents (agent id -> parent agent id, 'main' for the main loop). */
export type Parents = Record<string, string>

export type Web = { isOn: boolean; dir: string; lastWriteAt: number }

/** The in-pane 3D view: on, its raster size in cells, and what went wrong if anything. */
export type View3d = { isOn: boolean; cols: number; rows: number; status: string }

declare module 'claude-code' {
  interface PluginState {
    'crew-graph': {
      meta: { schemaVersion: number }
      main: Main
      usage: Usage
      architect: Architect
      gate: Gate
      agents: AgentCard[]
      loops: Loop[]
      log: LogLine[]
      turn: Turn
      receipt: Receipt | null
      view: View
      roster: Roster
      acts: Record<string, LoopAct>
      files: FileNode[]
      events: CrewEvent[]
      parents: Parents
      frame: number
      autoOpened: boolean
      web: Web
      view3d: View3d
      /** How many rows the pane's tree has, as the engine last measured it; 0 until measured. */
      paneRows: number
    }
  }
}
