/** What one model loop (main or a subagent) is doing right now. */
export type LoopAct = {
  /** 'main' for the main loop, else the agent id. */
  key: string
  /** Short verb shown beside the critter: read, edit, search, run, web, spawn, think, done, failed. */
  verb: string
  /** Tool name of the last call. */
  tool: string
  /** What the call works on (file, pattern, command), already shortened. */
  target: string
  /** clock.now() when the current call started. */
  since: number
  /** Number of tool calls this loop has made. */
  calls: number
}

/** A plan / doc / code file some loop touched. */
export type FileNode = {
  path: string
  kind: 'plan' | 'doc' | 'code'
  /** loop key → 'r' (read), 'w' (wrote), 'rw'. */
  by: Record<string, string>
  last: number
}

/** One subagent row, refreshed from $.agent.list(). */
export type AgentRow = {
  id: string
  type: string
  description: string
  status: string
  parentId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'crew-graph': {
      loops: Record<string, LoopAct>
      nodes: FileNode[]
      agents: AgentRow[]
      frame: number
      isBusy: boolean
      autoOpened: boolean
    }
  }
}
