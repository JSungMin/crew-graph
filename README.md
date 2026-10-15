# crew-graph

A Claude Code **mod** that shows your agent crew at work: a live dashboard pane in the terminal, and a **three.js 3D view** in the browser where Clawd crabs act out what every agent is doing and particles show how the agents interact.

crew-graph absorbs **[Flightdeck](https://github.com/scasella/claude-flightdeck)** by Stephen Casella (MIT): every Flightdeck panel is here, under the `/crew` command. crew-graph adds the Clawd crabs, the agent tree, the plan/doc graph and the web view.

```
╭──────────────────────────────────────────────────────────────╮
│ crew                                  1 running · 3 files    │
│  ▐▛███▜▌ ✎  Opus 5.5 · edit                                  │
│ ▗▟█████▙▖   docs/guide.md                                    │
│   ▘▘ ▝▝     12 calls · 9 req                                 │
│ └─▝▜█▛▘?  Explore find the hooks  search register            │
│ plans & docs                                                 │
│  ■ plan plans/plan.md ◄─ main:r Explore:r                    │
│  □ doc  docs/guide.md ◄─ main:w                              │
│  · code 1: register.tsx ◄─ Explore:r                         │
╰──────────────────────────────────────────────────────────────╯
```

## Panels

| Panel | Shows |
| --- | --- |
| **3d** | The three.js view itself, inside the pane (`/crew 3d`): a headless browser renders it, and the pane draws it as block glyphs fitted to 4x8 pixels a cell. |
| **main** | Model, effort, permission mode and request count. A context gauge with compactions (⟲). Cost and rate-limit windows with reset countdowns. Time to first token and tok/s. |
| **crew** | Clawd for the main loop (big) and for each subagent (mini), animated per action. The subagent tree, with grandchildren. Every plan, doc and code file a loop touched, with who read (`r`) or wrote (`w`) it. |
| **architect** | Consults on a timeline, and the inferred moment of each one. |
| **gate** | One cell per permission check (allowed, asked, pending or denied), totals, and a drill-down per tool family. Credentials are masked. |
| **agents** | Subagent cards (task, type, context, output tokens, steps, clock), or swimlanes when there are many. |
| **loops** | Model loops that match no card: workflow agents, compactions, memory forks. |
| **receipt** | The running turn, or the last one: duration, agents, edits, errors, cost added. |
| **log** | Prompts, spawns, completions, consults, edits, errors and denials. |

### Clawd poses

| Verb | When | Pose |
| --- | --- | --- |
| think | No tool running | Blinks, `zZ` |
| read | Read | Looks down at a page `▤` |
| edit | Edit / Write | Claws snap up and down, `✎` |
| search | Grep / Glob | Sidesteps, `?!` |
| run | Bash / PowerShell | Legs patter, `»` |
| web | WebFetch / WebSearch | Claws up, `@` |
| spawn | Agent | Hops, `+` |
| plan | Task / plan tools | Scribbles, `…` |
| done / failed | — | Cheers `✓` / X eyes `✗` |

The crabs animate on the surface's own frame clock, so the pane does not redraw for them.

## 3D view in the pane

```text
/crew 3d
```

The three.js view runs inside the Crew pane, and you can touch it.

| Do | What happens |
| --- | --- |
| Drag empty space | Rotate the camera (right-drag or shift-drag pans) |
| Wheel over the view | Zoom (the pane does not scroll) |
| Click a crab | **Pinch** it: it squashes, hops, squints `> <` and pops a red `!`. Three pinches in 2 s and it pinches back, red and grumpy. |
| Stroke a crab | **Pet** it, by dragging from the crab or hovering back and forth: `^ ^` eyes, a purring wiggle, rising hearts and a happy hop |

- **How it draws:** `bin/crew-3d.mjs` opens the viewer (`index.html?embed`) in a headless Chrome or Edge and streams each frame into the pane, in one of two modes:
  - **Block glyphs:** in any truecolour terminal. Each cell takes the block glyph and the two colours that best fit its 4x8 rendered pixels (`bin/cells.mjs`). The glyphs are the quadrants, the lower eighths and the left quarter and three-quarter blocks, so an edge lands to an eighth of a cell's height. Each frame stays within the Raster's 1024 colour pairs, dropping colour bits only when it must.
  - **Real pixels:** on kitty and Ghostty, an `Image` frame (`view3dMode: auto|cells|image`). Claude Code draws pictures only in those two, through kitty Unicode placeholders. Where it cannot, the mod says why in a toast and goes on in block glyphs.
- **Orca:** Orca's terminal (xterm.js) has kitty graphics but no Unicode placeholders yet, so the pane uses block glyphs there. For full resolution, `/crew web` opens the same view in an Orca browser tab beside the terminal. Placeholder support is in progress in Orca (stablyai/orca#26031, #28200). Once Orca launches Claude with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` set, `view3dMode: auto` picks real pixels there.
- **Scrolling:** with the 3D view on, the pane is usually taller than its window. Scroll it with the wheel outside the picture, or with the arrow and page keys while the pane is focused. A docked pane draws a scrollbar in its last column.
- **How input works:** an input layer (a `Client` region over the picture) catches the pointer. The mod forwards it to the helper on `127.0.0.1`, authenticated by a token, and the helper replays it as DOM pointer and wheel events in the page.
- **Cost:** the browser renders on the CPU (SwiftShader), so the view renders only when a frame is grabbed. That is `view3dFps` (default 10) for 3 s after input and 4 fps when idle, at 4x8 CSS pixels a cell, with no MSAA.
- **Size and teardown:** `/crew 3d` asks the pane for `view3dColumns` (default 110) columns, and the view is `view3dRows` (default 28) rows tall. When the pane width changes, the renderer restarts at the new size. When the pane stays closed for about 5 s, or on `/crew 3d off`, the browser is stopped.
- **Needs:** Node 22+ on `PATH`, and Chrome, Edge or Chromium (or `CREW_CHROME=<path>`).
- **Isolation:** the browser runs headless with a throwaway profile, over `--remote-debugging-pipe`, and exits when the helper does.

## 3D web view

```text
/crew web
```

This copies the viewer to `~/.claude/crew-graph/` and opens `index.html` in your browser (inside Orca, in an Orca browser tab via `orca tab create`). While work runs, the mod rewrites `data.js` there at most every 450 ms. The page reloads it by script-tag injection, so it works from `file://` with no server and no network.

- Every agent is a voxel Clawd that poses like its terminal twin. Agents are laid out as a tree with main at the root. Pinch it by clicking it, and pet it by stroking it.
- A child hangs from its parent on one smooth tube in the child's colour; dashes run along it only while the child works, and a finished child's link is faint.
- Plans, docs and code float in a small arc beside the agent that touched them last: five at most, with a `+N` chip for the rest. A file two agents share sits between them. There are no standing agent→file lines.
- Every interaction is a particle: spawn travels parent→child, an answer child→parent, a read file→agent, a write agent→file, and a denial or failure is a red burst. A read or write also draws a short arc, blue for read and orange for write, that fades in about a second and a half.
- Hover an agent to light up its files and dim everything else; hover a file to see who touched it.
- The HUD shows the session vitals, the gate counters, the turn receipt and a live event log. Click a crab for its details.

Other `/crew web` forms:
- `/crew web noopen` starts the export without opening a browser.
- `/crew web off` stops it.
- The `webOnStart` option starts the export when a session starts.

`index.html?demo` runs the view on synthetic data, and `?demo=busy` on a busier set (six agents, eighteen files).

## Desktop pet

```text
/crew pet
/crew pet off          close this session's window
/crew pet off all      quit the pet, every window
```

The crabs on your desktop: a transparent, frameless, always-on-top window with the same three.js view and no background (no grid, floor or fog), like an idle pet app. The first `/crew pet` installs Electron (pinned to 44.4.5, about 100 MB) with npm into `~/.claude/crew-graph/overlay-runtime/`, once, in the background, and starts the pet when that is done. The pet is its own process: it outlives the session and `/reload-plugins`.

Several sessions can run at once. Each session writes its own `~/.claude/crew-graph/sessions/<session id>.js` next to `data.js` (which stays as it was, for `/crew web`), and the one pet process opens one window per session, each cascaded 40 px from the last. A pill at the top of each window names its session: a colour dot, the folder, and the first prompt shortened to about 32 characters. The same colour rings the main crab. A session whose file has not changed for 10 minutes is shown dimmed as "ended", and its crabs sleep.

| You do | It does |
| --- | --- |
| Drag a crab (a pull of about 40 px, or hold it a moment first) or drag the name pill or any other part of the picture | Carries the window. The crab dangles, its legs swing and its body sways against the movement; set down, it squash-bounces. |
| Click a crab | Pinch (as in the browser view) |
| Scrub a crab: short strokes back and forth, with the button down or just hovering | Pet. Two turns of direction with the button down count as a stroke, and then the window stays put. |
| Click (or double-click) a file paper | Opens it (inside Orca with `orca file open --focus`, else the system opens it; programs and scripts are shown in the folder instead of run) |
| Click a `+N` chip | A list of the files folded behind it; click one to open it |
| Shift+click a file | Shows it in the file manager |
| Double-click the name pill, or right-click it and choose Collapse | Folds the window down to its title bar, with the 3D view closed; the same again expands it |
| Hover a crab or a file | A card: the agent's status, steps and last events; or the file's readers and writers and a summary of its first 64 KB (title, first paragraph and headings for text, leading comment and top-level names for code), made by heuristics, no model |
| Right-drag | Rotate the camera |
| Wheel | Zoom |
| Ctrl+wheel, or drag the corner grip | Resize (the grip shows whenever the pointer is in the window) |
| Right-click | A menu: Show in Crew pane (an agent's card, or a file's focus panel), Open, Show in folder, Copy path, and the window options |
| Double-click | Refit the camera |

Where the picture is transparent, clicks go through to the desktop. The page reads the alpha under the pointer, with a two-miss hysteresis, and never lets clicks through while a drag or a resize runs. The crabs turn their eyes toward a near pointer, blink, shuffle, doze with `zZ` when the session is idle for two minutes (or not running), and wake with a stretch. The window draws about 30 frames a second while something moves and about 12 when idle.

Each working crab shows a small speech bubble with what it does (`✎ app.js`, `» npm test`, `? register`). An optional ticker at the bottom (tray menu, "Activity ticker") lists the last three events for about six seconds each.

The tray icon (a crab) offers Show, Always on top, Activity ticker, Reset position & size, a list of the open sessions (Show, Close) and Quit. Window positions and sizes are kept per session in `~/.claude/crew-graph/overlay/overlay-state.json`.

The `petOnStart` option starts the pet when a session starts.

## Install

Requires **Claude Code 2.1.287+** (mods).

```text
/plugin marketplace add JSungMin/crew-graph
/plugin install crew-graph@crew-graph
/reload-plugins
```

If you also have Flightdeck installed, turn it off. crew-graph includes all of it.

## Commands

| Command | Does |
| --- | --- |
| `/crew` | Open the pane. It also opens by itself on session start (`openOnStart`) and once on the first subagent. |
| `/crew close` · `/crew reset` | Close the pane, or clear the agents, checks, consults, log, files and events. |
| `/crew layout auto\|compact\|wide\|mini` | Set the layout for this session. |
| `/crew 3d [off]` | The 3D view inside the pane. |
| `/crew web [noopen\|off]` | The 3D browser view. |
| `/crew pet` | The desktop pet: the crabs in a transparent always-on-top window, one window per session. |
| `/crew pet off [all]` | Close this session's pet window, or (`all`) quit the pet. |

Focus the pane with `ctrl+x tab`:
- `1`…`6` expand an agent card.
- `f` `s` `o` open the gate drill-downs.

## Configure

All of Flightdeck's options apply. Set them in `/config` or under `pluginConfigs["crew-graph"].options`:
- `architectPattern`, `architectLabel`, `gateLabel`, `panels`, `motion`, `moments`, `matchDescriptions`, `maxCards`, `layout`, `palette`, `openOnStart`, `statusLine`
- `webOnStart`, `petOnStart`, `view3dFps`, `view3dRows`, `view3dColumns` and `view3dMode` (crew-graph only)

The default `panels` value is `3d,main,crew,architect,gate,agents,loops,receipt,log`. The 3d panel shows only while `/crew 3d` runs.

## What it can reach

The mod only watches: every hook passes its event on unchanged, and a hook that throws passes the event on. It does reach outside the session in three places:
- **Files:** it writes files only under `~/.claude/crew-graph/`, and only after `/crew web` or `/crew pet` (or `webOnStart`, `petOnStart`). The pet's own window state, its quit and close requests and its "show in Crew pane" requests live in `~/.claude/crew-graph/overlay/`.
- **Processes:** it starts the OS "open" command (`explorer`, `open` or `xdg-open`), or `orca tab create` inside Orca, when `/crew web` opens the page. With `/crew 3d` it also starts `node bin/crew-3d.mjs`, which starts a headless browser and listens on 127.0.0.1 (token-protected) for the pane's pointer input. With `/crew pet` it runs `npm install electron@44.4.5` (and Electron's own binary download) once, into `~/.claude/crew-graph/overlay-runtime/`, then `node overlay/launch.mjs`, which starts Electron detached, so the pet outlives the session. The pet opens a file (`orca file open`, or the OS) only when you click it, and only a file listed in that session's snapshot; it reads at most the first 64 KB of such a file, for the hover summary.
- **Network:** none from the mod or the viewer. three.js r158 is bundled in `web/three.min.js` (MIT). Installing Electron downloads it from npm and from Electron's release host, once.

What it keeps:
- **Session state:** short summaries (tool name plus path or command, with credentials masked), which end with the session.
- **`data.js` and `sessions/<id>.js`:** the folder's basename, agent descriptions, the session's first prompt (shortened to about 32 characters, credentials masked), file paths relative to the session folder, and short event texts. Each file also lists its absolute path (`abs`) and the session folder's full path (`cwdAbs`), so the pet can open and summarize files. Both files are local, under your home.

## Develop

```bash
claude plugin validate plugins/crew-graph
claude plugin test plugins/crew-graph
claude --plugin-dir plugins/crew-graph
```

## Credits and license

MIT, see `LICENSE`.

- **Flightdeck:** © 2026 Stephen Casella, MIT. See `third_party/flightdeck-LICENSE.txt`. The ported files carry a header note.
- **three.js:** © three.js authors, MIT. See `plugins/crew-graph/web/THREE_LICENSE.txt`.
- **Clawd:** Clawd is Claude Code's mascot. The block-art and voxel crabs here are drawn from scratch as fan art.
