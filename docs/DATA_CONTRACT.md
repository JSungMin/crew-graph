# crew-graph web view — data contract

The mod writes these files into `~/.claude/crew-graph/`:

| File | Who writes it | What it is |
| --- | --- | --- |
| `index.html`, `app.js`, `three.min.js`, `gltf-loader.classic.js`, `characters-core.js`, `characters.js`, `tasks.js` | Copied by the mod from `plugins/crew-graph/web/` on `/crew web` and `/crew pet`. | The viewer itself, with its GLB loader, the built-in characters and the tasks (the to-do items as food). |
| `characters/` | Created by the mod (with a `README.txt`) if missing; the **user** puts `*.json` voxel packs and `*.glb` skinned models here. | The user's own characters (see below). |
| `characters-user.js` | Rewritten by the mod when it starts the viewer, on `/crew characters reload` and when the pet's Settings ask for a rescan, from a scan of `characters/`. | The manifest of the user's characters and the problems of every pack file. |
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
  lastReply?: { at: number; text: string }     // the answer to the latest question asked from the desktop pet (see below); absent until there is one
  petAck?: number                              // the seq of the newest desktop-pet request (ask, dismiss, stop) the mod accepted (see below); absent until there is one
  tasks: Task[]               // see Tasks below; always there, empty when nobody has a to-do list
  eaten?: Record<string, number>   // agent id -> how many tasks it has finished (the pet's "✓ N"); absent while it is all zero
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

## Asking Claude and dismissing agents from the desktop pet

`lastReply`: when a turn that came from a question asked in the pet ends, the mod sets `{ at, text }`: `at` is the time (ms) the turn ended and `text` the first 200 terminal cells of the answer on one line, credentials masked (`(the turn ended: <reason>)` when there was no answer). Only a question sent from the pet gives one: the mod notes the user's text when it submits the prompt, matches it to the main-loop turn that starts with it, and takes that turn's answer; any other turn leaves `lastReply` as it was. The pet shows it as a speech bubble from the main character for 12 s (not when it is older than 45 s on arrival, and each `at` once) and in the ticker. It is cleared on `/clear`.

`agents`, `files` and `events` leave out the agents the pet dismissed (state `dismissed`: agent id to what the agent looked like when it was dismissed, so a later step, tool call or end brings it back), the file links only they made (a file nobody else touched is dropped), and the events they took part in; their children hang from the nearest agent that is shown. `/clear` forgets the set. With `autoDismiss` in `overlay/pet-settings.json` (5, 10 or 30 minutes; anything else is off) the mod also dismisses an agent that has been finished that long.

The pet talks to the mod through `~/.claude/crew-graph/overlay/pet-inbox-<session id>.json` (one message, overwritten, `seq` rising; the mod polls it about once a second and acts on each `seq` once, only on a message newer than the pet's start). Besides `focus-agent` and `focus-file` (show in the Crew pane) it carries three that need a token:

```ts
type PetRequest = { seq: number; at: number; sessionId: string; token: string } & (
  | { kind: 'ask'; mode: 'send' | 'draft'; text: string; agentId?: string }   // text: trimmed, 1-4000 characters
  | { kind: 'dismiss'; ids: string[] }
  | { kind: 'stop'; id: string }
)
```

`token` is made by the mod each time it starts the pet for a session (`launch.mjs --token`, handed to a running window by the second start) and never leaves the mod and the window; the mod acts only when `sessionId` is its own session and `token` its own, and logs and ignores any other request. `send` calls `$.prompt.submit({ text })`, framed as the plugin's (never `asUser`); `draft` calls `$.prompt.fill` (`replace`, or `append` when the prompt box already holds text). With `agentId`, `text` is followed by a short context block (type, id, status, task, last 5 event texts, files touched). `petAck` is the largest `seq` among the requests the mod accepted (right token and session), set before it acts on them, so the pet can tell a request reached a live mod: a request whose `seq` is above `petAck` eight seconds after the pet wrote it is shown as not delivered. A refused request does not raise it, and it starts again from none when the mod is reloaded. The mod records in its state that the pet is on for the session (`petOn`; `/crew pet` sets it, `/crew pet off [all]` clears it) and starts the pet again on `session.start` while it is set. `stop` asks Claude, in a framed prompt, to stop that agent when the mod knows it as running; the mod cannot stop an agent itself.

## Tasks

`tasks` lists what the agents have to do, from four sources, as one list. Every title is one line, credentials masked, cut to about 80 cells (`active` to about 60; a `turn` title to about 60).

```ts
type Task = {
  id: string                  // stable and namespaced: "todo:<agent>:<hash of the content>" (a repeat of the same text in one list gets "#2"...),
                              // "task:<id>" for TaskCreate / TaskUpdate, "agent:<agent id>" for a subagent's ticket,
                              // "turn:<turn id>" for a prompt turn of the main loop (a waiting prompt: "turn:q<n>" until its turn starts)
  src: 'todo' | 'task' | 'agent' | 'turn'
  owner?: string              // the agent working on it ("main" or an agent id); absent for a task nobody took
  title: string
  active?: string             // the present-continuous form ("Running tests"), for while it is in progress
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'deleted'
  blockedBy?: string[]        // ids (same namespace) of the tasks it waits for
  deliverTo?: string          // a ticket: the parent that eats it when the child is done
  t: number                   // when the status last changed (ms epoch)
}
```

- **`todo`** is a `TodoWrite` call. Each call is that agent's *whole* list and replaces its previous one. An item that was open and is missing from the new list becomes `deleted`; a closed one just leaves. The agent is the one whose loop made the call (the call's `agentId`, `main` when it has none).
- **`task`** is `TaskCreate` (its id comes from the result's `task.id`) and `TaskUpdate` (`status`, `subject`, `activeForm`, `addBlockedBy`, `owner`). The owner is the agent that last set the task `in_progress`, or the `owner` field when it names a known agent (an id, or the type or name it was started under); a task nobody took has no owner.
- **`agent`** is a ticket for every subagent card, so there are tickets even when no agent uses the task tools. `owner` is the child, `title` its description, `deliverTo` its parent. `running` is `in_progress`, `done` is `completed`, `failed` and `stopped` are `failed`. An architect started as a consult has no card, so no ticket.
- **`turn`** is proxy food, for a session whose model has no task tools (and on request, see *food from* in the guide): each prompt the user sends is one item owned by `main`. `title` is the prompt (the user's own words; a question typed into the pet is titled by those words, not by the frame the engine puts round it), one line, credentials masked, about 60 cells. It is `pending` while it waits behind a running turn, `in_progress` while its turn runs, `completed` when the turn answers (`main` eats it) and `failed` when the turn is aborted or ends in an error or a refusal. Turns the engine opens on its own (a hand-back, a task notification) and subagents' turns are not items. A page that does not know `turn` can read it as `todo` (an item with an owner and a status).
- **What is listed:** every open task (up to 40; the subagent tickets come first, so the cap never cuts one), the last 10 closed ones (`completed`, `failed`), and `deleted` ones for 5 s after they were deleted, so the page can play the smoke puff.
- **`eaten`** counts, per agent, the tasks that turned `completed` since the session began (or `/crew reset`): the counter does not shrink when old closed tasks fall out of the list, and it is back to nothing after `/crew reset`. A ticket counts for the parent; a `task` for its owner, or for `main` when it has none; a `turn` for `main`.

## Characters

Every agent is drawn as a character; the default (no `chars`) is the crab. `chars` carries the `characters` option as parsed pairs, for example `[["main","crab"],["Explore","bunny"],["*","random"]]`. The viewer takes the first pair whose `who` equals the agent's `id` or `type` (case-insensitive; `architect` also matches `isArchitect`; a trailing `*` is a prefix), and uses its `character`, an id from the built-ins or the user's files; `random` and an agent no pair matches get a stable pick by hash of the agent's id among all available character ids (built-ins first, then the user's by name). An unknown id shows the crab.

The user's characters are read from `window.__crewUserCharacters` (set by `characters-user.js`; the page loads it again every few seconds and rebuilds when `window.__crewUserRev` changes):

```ts
type UserCharacters = (
  | { file: string; id: string; name: string; json: VoxelCharacter }   // a *.json pack, inlined
  | { id: string; name: string; kind: 'glb'; rev: string; glb: { file: string; parts: number; bytes: number } }   // a *.glb
)[]
```

Next to it, `window.__crewUserPacks` lists **every** `.json` and `.glb` file of the folder, also those that did not load (a pack that fails to parse has no entry above), with what is wrong with it; `window.__crewUserScanned` is when the scan ran (ms, absent from a manifest written without a clock). `window.__crewUserRev` changes when any of this does, problems included, so a fixed (or newly broken) file is noticed.

```ts
type UserPacks = {
  file: string                      // "puff.json"
  id: string                        // the id it has (a pack that did not load: the id it would have had, from "id" or the file name)
  kind: 'voxel' | 'glb'
  problems: { level: 'error' | 'warn'; code: string; text: string; fix: string }[]   // worst first; empty: nothing to say
}[]
```

The codes are listed in the guide ([Pack problems](guide.md#pack-problems)); the mod's `lintVoxel` / `problem()` in `hooks/characters.ts` and `lintVoxel` / `problem()` in `web/characters-core.js` give the same list for the same pack (a test holds them together). The page adds what only it can see to a loaded pack's list (a model that failed to load: `glb-failed`, `glb-too-big`, `glb-empty`; its node names: `glb-no-rig`, `no-hands`, `no-mouth`).

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
  food?: string | { boxes: Box[] } | Box[]   // the tasks' food: a built-in id (fish carrot treat seed battery ticket) or boxes like a bone's; see Tasks
}
```

`food` is for the tasks: up to 40 boxes on the same rules as a bone's, centred on 0, about 2.5 voxels long with the long side along x. Without it (or with one that is not valid) a character gets the food of its own kind (crab: fish, bunny: carrot, cat: treat stick, mochi: sunflower seed, robot: battery), a user's pack the sunflower seed; a `.glb` has no food and eats the seed. A bone's `at` is relative to its parent (default `body`) and the bone turns about its own origin. `mirror` copies another bone with x flipped (boxes, `at`, the turn, the parent's L/R). `gait` picks which of the four leg phases a leg uses (the run cycle). Numbers are clamped and at most 400 boxes are read. GLB bones are matched by node name to the rig, case and `_` `.` space `-` ignored.

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
- **Tasks** (`tasks`, `eaten`) are voxel food, one kind per character, drawn only for changes the page sees live (the first snapshot after a start, a reload or a session switch is the baseline, so old eats do not replay). Pending items stack on a plate beside the owner (five at most, `+N` for the rest; unowned ones sit on a table by main), the one in progress is held in the owner's hand while it works on it, a `completed` one is eaten (about 2.3 s, one after another when several finish together; then a `+1` flies to the owner's `✓ N`), a ticket is carried along its link to the parent first, a `failed` one turns grey, a `deleted` one goes in a puff of smoke, and one whose `blockedBy` lists an open task has a lock. Details in the guide.
- **HUD:** context gauge, cost, rate-limit windows, gate counters, turn receipt, and a scrolling event log.
