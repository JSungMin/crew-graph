# crew-graph web view — data contract

The mod writes three files into `~/.claude/crew-graph/`:

| File | Who writes it | What it is |
| --- | --- | --- |
| `index.html`, `app.js`, `three.min.js` | Copied by the mod from `plugins/crew-graph/web/` on `/crew web`. | The viewer itself. |
| `data.js` | Rewritten by the mod about every 500 ms while work runs, and once more after the work stops. | The live state. |

The page runs from `file://` without a server and makes no network requests. It cannot `fetch` JSON under `file://`, so it polls by adding a `<script src="data.js?t=<now>">` tag about every 500 ms. That script calls the global hook:

```js
window.__crewUpdate({ ...snapshot })
```

## Snapshot (v1)

```ts
type Snapshot = {
  v: 1
  now: number                 // ms epoch at write time
  session: {
    id: string
    cwd: string               // basename only (never a full path)
    model: string             // e.g. "claude-opus-5-5"
    effort?: string
    mode?: string             // permission mode
    requests: number
    ctx?: { used: number; max: number }          // context tokens
    compactions: number
    costUsd?: number
    rate?: { label: string; pct: number; resetsAt?: number }[]
    ttftMs?: number
    tokPerSec?: number
    turn?: { running: boolean; startedAt: number; endedAt?: number; edits: number; errors: number; agents: number }
  }
  agents: Agent[]             // always includes the main loop as id "main"
  files: FileNode[]           // up to 60, most recent first
  events: CrewEvent[]         // last 200, oldest first; ids increase monotonically
  gate: { allowed: number; asked: number; denied: number; pending: number }
  architect?: { consults: number; running: boolean; lastMs?: number }
}

type Verb = 'read' | 'edit' | 'search' | 'run' | 'web' | 'spawn' | 'plan' | 'think' | 'done' | 'failed' | 'wait'

type Agent = {
  id: string                  // "main" or the agent id
  parentId: string | null     // null for main; children of main have "main"
  type: string                // "main", "Explore", "sonnet-coder", ...
  description: string         // short task text
  status: 'running' | 'pending' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  verb: Verb                  // what it does right now
  target: string              // short: file path, pattern, command
  since: number               // when the current verb started (ms)
  steps: number               // model requests made
  calls: number               // tool calls made
  ctxTokens?: number
  outTokens?: number
  startedAt: number
  endedAt?: number
  isArchitect?: boolean
}

type FileNode = {
  path: string                // relative to cwd, shortened
  kind: 'plan' | 'doc' | 'code'
  by: Record<string, 'r' | 'w' | 'rw'>   // agent id -> what it did
  last: number
}

type CrewEvent = {
  id: number
  t: number
  kind: 'prompt' | 'spawn' | 'tool' | 'read' | 'write' | 'done' | 'fail' | 'deny' | 'check' | 'consult' | 'answer' | 'compact'
  from: string                // agent id that acted
  to?: string                 // agent id (spawn: child; answer: parent) or file path (read/write)
  tool?: string
  text: string                // short, already sanitized (credentials masked)
}
```

## How the viewer animates it

- **Agents** are voxel Clawd crabs, arranged as a tree with main at the root. Their status and verb drive the pose.
- **Files** float near the agents that touch them: plans are purple cubes, docs are yellow sheets, code is grey chips.
- **Edges:** agent→child edges are solid; agent→file edges are blue for read and orange for write.
- **Events** become particles that travel along an edge:
  - `spawn`: parent→child
  - `answer` / `done`: child→parent
  - `read`: file→agent
  - `write`: agent→file
  - `deny` / `fail`: a red burst
- **HUD:** context gauge, cost, rate-limit windows, gate counters, turn receipt, and a scrolling event log.
