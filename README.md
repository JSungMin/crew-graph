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
| **3d** | The three.js view itself, inside the pane (`/crew 3d`): a headless browser renders it, and the pane draws it as half-block colour cells, two pixels a cell. |
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

- **How it works:** `bin/crew-3d.mjs` opens the same viewer in a headless Chrome or Edge. It shrinks each frame to the pane's size and streams it as Raster cells. The mod blits each frame in place, about 8 frames a second (`view3dFps`), in a panel `view3dRows` rows tall (default 20). Labels are dropped and the camera frames tighter, because a cell holds only two pixels.
- **Size and teardown:** when the pane width changes, the renderer restarts at the new size. When the pane is closed for about 5 s, or on `/crew 3d off`, the browser is stopped.
- **Needs:** Node 22+ on `PATH`, and Chrome, Edge or Chromium (or `CREW_CHROME=<path>`).
- **Isolation:** the browser runs headless with a throwaway profile, over `--remote-debugging-pipe`. It opens no port, and it exits when the renderer process does.
- **Where it shows:** terminal only (Raster). In the desktop app, use `/crew web`.

## 3D web view

```text
/crew web
```

This copies the viewer to `~/.claude/crew-graph/` and opens `index.html` in your browser. While work runs, the mod rewrites `data.js` there at most every 450 ms. The page reloads it by script-tag injection, so it works from `file://` with no server and no network.

- Every agent is a voxel Clawd that poses like its terminal twin. Agents are laid out as a tree with main at the root.
- Plans, docs and code float beside the agents that touched them. Read edges are blue, write edges orange.
- Every interaction is a particle: spawn travels parent→child, an answer child→parent, a read file→agent, a write agent→file, and a denial or failure is a red burst.
- The HUD shows the session vitals, the gate counters, the turn receipt and a live event log. Click a crab for its details.

Other `/crew web` forms:
- `/crew web noopen` starts the export without opening a browser.
- `/crew web off` stops it.
- The `webOnStart` option starts the export when a session starts.

`index.html?demo` runs the view on synthetic data.

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

Focus the pane with `ctrl+x tab`:
- `1`…`6` expand an agent card.
- `f` `s` `o` open the gate drill-downs.

## Configure

All of Flightdeck's options apply. Set them in `/config` or under `pluginConfigs["crew-graph"].options`:
- `architectPattern`, `architectLabel`, `gateLabel`, `panels`, `motion`, `moments`, `matchDescriptions`, `maxCards`, `layout`, `palette`, `openOnStart`, `statusLine`
- `webOnStart`, `view3dFps` and `view3dRows` (crew-graph only)

The default `panels` value is `3d,main,crew,architect,gate,agents,loops,receipt,log`. The 3d panel shows only while `/crew 3d` runs.

## What it can reach

The mod only watches: every hook passes its event on unchanged, and a hook that throws passes the event on. It does reach outside the session in three places:
- **Files:** it writes files only under `~/.claude/crew-graph/`, and only after `/crew web` (or `webOnStart`).
- **Processes:** it starts the OS "open" command (`explorer`, `open` or `xdg-open`) when `/crew web` opens the page. With `/crew 3d` it also starts `node bin/crew-3d.mjs`, which starts a headless browser.
- **Network:** none. three.js r158 is bundled in `web/three.min.js` (MIT).

What it keeps:
- **Session state:** short summaries (tool name plus path or command, with credentials masked), which end with the session.
- **`data.js`:** the folder's basename (never the full path), agent descriptions, file paths relative to the session folder, and short event texts.

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
