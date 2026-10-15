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
  /** The file's absolute path, as the tool call named it (a relative one joined to the working directory); absent in older state. */
  abs?: string
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

/** A task as the pet and the browser view show it: a to-do item, a task, a subagent's ticket, or (proxy food) a prompt turn. */
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted'

export type TaskItem = {
  /** Namespaced and stable: `todo:<agent>:<hash of the content>`, `task:<id>`, `agent:<agent id>`, `turn:<turn id>`. */
  id: string
  src: 'todo' | 'task' | 'agent' | 'turn'
  /** The agent working on it ('main' or an agent id); absent for a task nobody took. */
  owner?: string
  title: string
  /** The present-continuous form ("Running tests"), shown while it is in progress. */
  active?: string
  status: TaskStatus
  /** Ids of the tasks this one waits for (same namespace as `id`). */
  blockedBy?: string[]
  /** An agent's ticket: the parent that eats it when it is done. */
  deliverTo?: string
  /** When the status last changed (ms since the epoch). */
  t: number
}

/** What the mod keeps of the tasks: the to-do items of every agent, the shared tasks, the prompt turns (proxy food), and how many each agent has finished. Tickets are not stored (they come from the cards). */
export type TaskBook = { todo: TaskItem[]; task: TaskItem[]; turn: TaskItem[]; eaten: Record<string, number> }

/** Parent links the engine reports for subagents (agent id -> parent agent id, 'main' for the main loop). */
export type Parents = Record<string, string>

export type Web = { isOn: boolean; dir: string; lastWriteAt: number }

/** /crew setup: whether the session has Claude Code's own task tools (null = the tool list could not be read). */
export type Setup = { native: boolean | null }

/** What the desktop pet asked the Crew pane to show (overlay/main.js writes it to pet-inbox.json). */
export type PetFocus = {
  kind: 'file'
  abs: string
  path: string
  /** The pet's heuristic summary of the file, when it made one. */
  summary: { title: string; lead: string; heads: string[]; decls: string[] } | null
  /** The file's first lines, when there is no summary. */
  head: string[]
  at: number
}

/** The first words of Claude's answer to a question asked from the desktop pet; the pet shows them as a speech bubble. */
export type LastReply = { at: number; text: string }

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
      tasks: TaskBook
      frame: number
      autoOpened: boolean
      web: Web
      view3d: View3d
      /** The file the desktop pet asked the pane to show; null when none or closed. */
      petFocus: PetFocus | null
      /** Agents the desktop pet dismissed: agent id -> the state it was in then. Hidden from the snapshot and the pane until it works again. Cleared on /clear. */
      dismissed: Record<string, string>
      /** True while the desktop pet is on for this session (`/crew pet` sets it, `/crew pet off` clears it): session.start starts the pet again after a reload or resume. */
      petOn: boolean
      /** The answer to the latest question asked from the pet, clipped and masked; null when none. */
      lastReply: LastReply | null
      /** The session's first prompt, shortened: the name on the desktop pet's nameplate. */
      sessionTitle: string
      /** How many rows the pane's tree has, as the engine last measured it; 0 until measured. */
      paneRows: number
      /** Which task tools this session has; decides whether the prompt turns are food (see food from). */
      setup: Setup
    }
  }
}
