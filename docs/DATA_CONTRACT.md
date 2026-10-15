# crew-graph web view — data contract

The mod writes these files into `~/.claude/crew-graph/`:

| File | Who writes it | What it is |
| --- | --- | --- |
| `index.html`, `app.js`, `three.min.js`, `gltf-loader.classic.js`, `characters-core.js`, `characters.js` | Copied by the mod from `plugins/crew-graph/web/` on `/crew web` and `/crew pet`. | The viewer itself, with its GLB loader and the built-in characters. |
| `characters/` | Created by the mod (with a `README.txt`) if missing; the **user** puts `*.json` voxel packs and `*.glb` skinned models here. | The user's own characters (see below). |
| `characters-user.js` | Rewritten by the mod when it starts the viewer and on `/crew characters reload`, from a scan of `characters/`. | The manifest of the user's characters. |
| `characters-glb/<id>.<n>.js` | Written with the manifest, one or more per `.glb` up to 4 MiB. | A GLB as base64 script parts. |
| `data.js` | Rewritten by the mod about every 500 ms while work runs, and once more after the work stops. Whichever session wrote last wins. | The live state, for `/crew web`. |
| `sessions/<session id>.js` | Written with every `data.js`, with the same content, by the session it is named for. | That session's own live state. The desktop pet (`index.html?overlay&session=<id>`) reads this, one window per session. |

The page runs from `file://` without a server and makes no network requests. It cannot `fetch` JSON under `file://`, so it polls by adding a `<script src="data.js?t=<now>">` tag about every 500 ms (the pet: `sessions/<id>.js`, once a second). That script calls the global hook:

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
    cwd: string               // basename of the session folder
    cwdAbs?: string           // the full path, forward slashes (optional: older data has none)
    title?: string            // the session's first prompt on one line, credentials masked, about 32 cells (optional)
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
  chars?: [who: string, character: string][]   // the `characters` option, parsed (see below); absent when the option is empty
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
  abs?: string                // the absolute path, forward slashes (optional: older data has none). The desktop pet opens and summarizes only paths listed here.
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

## Characters

Every agent is drawn as a character; the default (no `chars`) is the crab. `chars` carries the `characters` option as parsed pairs, for example `[["main","crab"],["Explore","bunny"],["*","random"]]`. The viewer takes the first pair whose `who` equals the agent's `id` or `type` (case-insensitive; `architect` also matches `isArchitect`; a trailing `*` is a prefix), and uses its `character`, an id from the built-ins or the user's files; `random` and an agent no pair matches get a stable pick by hash of the agent's id among all available character ids (built-ins first, then the user's by name). An unknown id shows the crab.

The user's characters are read from `window.__crewUserCharacters` (set by `characters-user.js`; the page loads it again every few seconds and rebuilds when `window.__crewUserRev` changes):

```ts
type UserCharacters = (
  | { file: string; id: string; name: string; json: VoxelCharacter }   // a *.json pack, inlined
  | { id: string; name: string; kind: 'glb'; rev: string; glb: { file: string; parts: number; bytes: number } }   // a *.glb
)[]
```

A GLB with `parts > 0` has its base64 in `characters-glb/<id>.<0..parts-1>.js`, each calling `window.__crewGlbPart(id, n, base64)`. With `parts: 0` (over 4 MiB) the page reads `glb.file` itself (the Electron pet can; a browser on `file://` usually cannot).

```ts
// A voxel character: boxes on the shared rig. Units: voxels of the crab (7 wide); x right, y up, z toward the viewer.
type Rig = 'root'|'body'|'head'|'earL'|'earR'|'eyeL'|'eyeR'|'mouth'|'armL'|'handL'|'armR'|'handR'|'legL1'|'legL2'|'legL3'|'legR1'|'legR2'|'legR3'|'tail'
type Box = { size: [number, number, number]; at: [number, number, number]; color: string /* #rrggbb or "@base" */; rot?: [number, number, number]; unlit?: boolean; fixed?: boolean }
type VoxelCharacter = {
  id: string; name?: string; scale?: number            // id: 1-40 of A-Z a-z 0-9 . _ -
  base?: { h: number; s: number; l: number; spread?: number }   // the "@base" colour (degrees, 0-1, 0-1); spread: hue shift per agent type
  bones: { [bone in Rig]?: { parent?: Rig; at: [number, number, number]; rot?: [number, number, number]; gait?: 0|1|2|3; boxes?: Box[]; mirror?: Rig } }
  eyes?: { x?: Box[]; squint?: Box[]; happy?: Box[]; sleepy?: Box[]; dizzy?: Box[] }   // the left eye's boxes per expression; the right one is mirrored
  props?: { page?: { at: [number, number, number] }; hat?: { at: [number, number, number]; s?: number }; anten?: { at: [number, number, number]; spread?: number } }
  hit?: { y?: number; r?: number }; shadow?: [number, number]; travel?: number
}
```

A bone's `at` is relative to its parent (default `body`) and the bone turns about its own origin. `mirror` copies another bone with x flipped (boxes, `at`, the turn, the parent's L/R). `gait` picks which of the four leg phases a leg uses (the run cycle). Numbers are clamped and at most 400 boxes are read. GLB bones are matched by node name to the rig, case and `_` `.` space `-` ignored.

## How the viewer animates it

- **Agents** are voxel characters (the Clawd crab unless `chars` says otherwise), arranged as a tree with main at the root. Their status and verb drive the pose, through the bones of the shared rig.
- **Files** gather beside the agent that touched them last (the newest five in an arc, `+N` for the rest): plans are purple cubes, docs are yellow sheets, code is grey chips.
- **Links:** an agent→child link is one smooth tube in the child's colour, with dashes running along it while the child works. There are no standing agent→file lines: a read (blue) or write (orange) event draws a short arc that fades in about 1.5 s, and hovering a node lights its related lines and dims the rest.
- **Events** become particles that travel along a link:
  - `spawn`: parent→child
  - `answer` / `done`: child→parent
  - `read`: file→agent
  - `write`: agent→file
  - `deny` / `fail`: a red burst
- **HUD:** context gauge, cost, rate-limit windows, gate counters, turn receipt, and a scrolling event log.
