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

- Every agent is a voxel Clawd (or another character, see [Characters](#characters)) that poses like its terminal twin. Agents are laid out as a tree with main at the root. Pinch it by clicking it, and pet it by stroking it.
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

The crabs on your desktop: a transparent, frameless, always-on-top window with the same three.js view and no background (no grid, floor or fog), like an idle pet app. The first `/crew pet` installs Electron (pinned to 44.4.5, about 100 MB) with npm into `~/.claude/crew-graph/overlay-runtime/`, once, in the background, and opens the pet by itself when that is done: a toast says "installing Electron (~100 MB)…" at the start and "ready" (or the error with the end of npm's output) at the end. One install runs at a time even when several sessions start together (a lock file `install.lock` in that folder; a lock older than 15 minutes is taken as a crashed install): the others wait, then open their own window. The pet is its own process: it outlives the session and `/reload-plugins`.

Several sessions can run at once. Each session writes its own `~/.claude/crew-graph/sessions/<session id>.js` next to `data.js` (which stays as it was, for `/crew web`), and the one pet process opens one window per session, each cascaded 40 px from the last. A pill at the top of each window names its session: a colour dot, the folder, and the first prompt shortened to about 32 characters. The same colour rings the main crab. A session whose file has not changed for 10 minutes is shown dimmed as "ended", and its crabs sleep.

| You do | It does |
| --- | --- |
| Press a crab and pull (more than a few pixels), or drag the name pill or any other part of the picture | Carries the window, always. The crab dangles, its limbs swing and its body sways against the movement; set down, it squash-bounces. |
| **Shake the window while carrying a crab** | It gets dizzy. Three or more direction reversals within 1.2 s, each fast enough, count as a shake; a hard shake looks different from a sway. While it lasts, the carried character flails (arms, legs, ears and tail follow through with lag, the other way from the motion), its eyes turn to spirals `@ @` and sweat drops and stars fly off. The other characters in the window are knocked about and the files rattle, then everything settles. Set down, it staggers for about 2 s with stars circling its head and then shakes it off; after a very hard shake it sits down first. |
| Click a crab (press and release without moving) | Pinch (as in the browser view) |
| Stroke a crab: short strokes back and forth with the button up (just hovering) | Pet |
| Click (or double-click) a file paper | Opens it (inside Orca with `orca file open --focus`, else the system opens it; programs and scripts are shown in the folder instead of run) |
| Click a `+N` chip | A list of the files folded behind it; click one to open it |
| Shift+click a file | Shows it in the file manager |
| Double-click the name pill, or right-click it and choose Collapse | Folds the window down to its title bar, with the 3D view closed; the same again expands it |
| Hover a crab or a file | A card: the agent's status, steps, which character it is and why (`robot · matched: code, test`) and last events; or the file's readers and writers and a summary of its first 64 KB (title, first paragraph and headings for text, leading comment and top-level names for code), made by heuristics, no model |
| Right-drag | Rotate the camera |
| Wheel | Zoom |
| Ctrl+wheel, or drag the corner grip | Resize (the grip shows whenever the pointer is in the window) |
| Right-click a character | **Character >** (Match role, Random and every character, yours included, as radio items: the choice applies to this agent's type), **Only this agent** (a check box: ticked, the choice is for this one agent), Show in Crew pane, and the window options with **Settings…** |
| Right-click a file or elsewhere | Show in Crew pane (a file's focus panel), Open, Show in folder, Copy path, and the window options with **Settings…** |
| Double-click | Refit the camera |

Where the picture is transparent, clicks go through to the desktop. The page reads the alpha under the pointer, with a two-miss hysteresis, and never lets clicks through while a drag or a resize runs. The crabs turn their eyes toward a near pointer, blink, shuffle, doze with `zZ` when the session is idle for two minutes (or not running), and wake with a stretch. The window draws about 30 frames a second while something moves and about 12 when idle. When the pet hands a file to its viewer (Open, Show in folder) it ends any drag in flight and keeps itself on top of the viewer's new window for about 15 seconds, without taking the focus; "Show" in the tray raises it too.

Each working crab shows a small speech bubble with what it does (`✎ app.js`, `» npm test`, `? register`). An optional ticker at the bottom (tray menu, "Activity ticker") lists the last three events for about six seconds each.

The tray icon (a crab) offers Show, **Settings…**, Always on top, Activity ticker, Reset position & size, a list of the open sessions (Show, Close) and Quit. Window positions and sizes are kept per session in `~/.claude/crew-graph/overlay/overlay-state.json`.

The `petOnStart` option starts the pet when a session starts.

### Settings in the pet

Right-click anything and choose **Settings…**, or use the tray icon. It opens one small window (shared by all sessions; dark and rounded like the cards) whose changes apply to every pet window at once:

- **Characters.** A *default for all agents* (a character, **Match role (auto)**, **Random**, or follow the `characters` option), each character as a tile with a live 3D preview (the same character code, idling; your own characters appear too), a character per *agent type* (the types seen in your sessions, `main`, and `*` for any other type) and one for a single *agent*. The right-click menu on a character sets the same things. When a character changes, the old one spins away, a puff of smoke, and the new one pops in.
- **Show.** Speech bubbles, the activity ticker, file papers and the nameplate, each on or off.
- **Motion.** *Reduce motion* turns off the idle shuffles, drops the particle bursts and caps the frame rate lower (about 15 busy, 6 idle).
- **Window.** Always on top, opacity (60 to 100 %), a size preset S, M or L (besides dragging the grip), and **Reset to defaults**.

The pet keeps these in `~/.claude/crew-graph/overlay/pet-settings.json`; only the pet's main process reads, checks (every key) and writes it, and it never writes `~/.claude/settings.json`. For each agent the character comes from, first match wins: its own entry, the pet's rule for its type (specific types first, `*` last), the mod's `characters` option, the pet's default. With no default and no option an agent is a crab.

`pet-settings.json`:

```json
{ "default": "auto", "types": { "Explore": "cat", "*": "auto" }, "agents": { "<session id>|<agent id>": "robot" },
  "show": { "bubbles": true, "ticker": true, "papers": true, "nameplate": true },
  "reduceMotion": false, "alwaysOnTop": true, "opacity": 100, "size": "M" }
```

`/crew characters` prints what it says about characters (or that there is none yet) and what `auto` would pick for the agents of the latest snapshot, with the reason. To try the Settings window without a session: `electron overlay/main.js --page web/index.html --state <dir> --shot-settings out.png --demo`.

## Characters

Every agent can be drawn as a different cute character. They all stand on one **shared skeleton**, so every animation (the work-verb poses, pinch, pet, the carry dangle and the shake, dozing, the hello wave, looking at the cursor) works for all of them: the animation sets bones by name and skips the ones a character does not have (a bunny has no middle legs, a crab no ears).

| Id | Character | Traits (for `auto`) |
| --- | --- | --- |
| `crab` | Clawd, the default | lead, main, generalist |
| `bunny` | A round lilac blob with long ears | docs, write, summarize, quick, web |
| `cat` | A ginger loaf with pointed ears and a curled tail | explore, search, investigate, review, locate |
| `mochi` | A hamster-ish ball with a brown cap and pink cheeks | plan, architect, design, think, advisor |
| `robot` | A little steel box with LED eyes and an antenna | code, build, fix, test, implement |

The built-in characters are original designs. Without the `characters` option every agent is a crab, exactly as before.

**Who is who.** The `characters` option is a list of `who=character` pairs:

```text
main=crab, Explore=bunny, sonnet-coder=robot, architect=mochi, *=auto
```

- `who` is an agent id or type (case does not matter), `architect`, or a prefix ending in `*`; the first pair that matches wins.
- `character` is a built-in id, one of yours (below), `random` (a stable pick by hash of the agent's id), or `auto` (the character whose traits fit the agent's role, see below).
- A part without `=` means `*=`: `random`, `auto` or `bunny` alone work, and so does `main=crab, random`.
- An agent no pair matches gets a **stable pick** by hash of its id among all available characters, yours included, so it keeps its look. A name that no character has (a pack that is not there) shows a crab.
- With the option empty, everyone is a crab.
- The pet's own settings (above) come first: a per-agent entry, then a per-type rule, then this option, then the pet's default.

**Match role (`auto`).** A character can declare `traits`, role words. An agent's role is read from its type (`Explore`, `Plan`, `sonnet-coder`, `code-reviewer`, `general-purpose`, `architect`, ...), the words of its task text and the verb it is doing (many edits and runs mean code; reads and searches mean explore), with a small fixed table of keywords and weights. `auto` takes the character whose traits overlap the role most; ties go to a stable hash of the agent id. Siblings are spread: a character that a sibling already took costs a little, so equally good alternatives share the work. An agent keeps the character it was first given for as long as the pet window lives, whatever its verb does later. Words that count: `lead main generalist code build fix test implement run explore search investigate locate review docs write summarize quick web plan architect design think advisor`; other words are fine, they never match. The hover card says why (`robot · matched: code, test`).

`/crew characters` lists the built-in and your characters with their traits, what was wrong with a file, how the current option reads, what the pet's Settings say about characters, and what `auto` would pick for the agents of the latest snapshot. `/crew characters reload` rescans your folder; a running pet or browser view picks the change up within a few seconds. `?demo=lineup` shows every character in a row (`&verbs=think,edit,run` picks the rows).

**Your own characters** go in `~/.claude/crew-graph/characters/`. The mod creates the folder, with a `README.txt` that repeats the format below, when the viewer starts (`/crew web`, `/crew pet`) or on `/crew characters reload`. A page on `file://` cannot list a folder, so the mod scans it and writes `characters-user.js` next to the viewer.

- **`*.json`: a voxel character.** Boxes on the named rig; small and editable by hand:

  ```json
  {
    "id": "mybot", "name": "My bot", "scale": 1,
    "bones": {
      "body":  { "boxes": [ { "size": [5,3,4], "at": [0,2,0], "color": "#88aaff" } ] },
      "head":  { "at": [0,3.5,0], "boxes": [ { "size": [4,3,4], "at": [0,1.5,0], "color": "#99bbff" } ] },
      "eyeL":  { "parent": "head", "at": [-1,1.6,2.1], "boxes": [ { "size": [0.8,1,0.3], "at": [0,0,0], "color": "#10131c" } ] },
      "eyeR":  { "mirror": "eyeL" },
      "armL":  { "at": [-2.8,2.5,0], "boxes": [ { "size": [1.4,1,1], "at": [-0.7,0,0], "color": "#88aaff" } ] },
      "armR":  { "mirror": "armL" },
      "legL1": { "at": [-1.2,0.5,0], "gait": 0, "boxes": [ { "size": [1.2,1,1.4], "at": [0,0,0], "color": "#5570c0" } ] },
      "legR1": { "mirror": "legL1", "gait": 2 }
    }
  }
  ```

  The rig is `root body head earL earR eyeL eyeR mouth armL handL armR handR legL1 legL2 legL3 legR1 legR2 legR3 tail`; every bone is optional. Units are voxels of the crab (7 wide); x is right, y up, z toward the viewer. A bone's `at` is relative to its `parent` (default `body`) and it turns about its own origin, so put the origin where it should bend. `mirror` copies another bone with x flipped. A box is `{ size, at, color }`, with optional `rot` (radians), `unlit` (an LED) and `fixed` (not tinted when the agent fails or is done). Optional top-level keys: `scale`, `base` (`{ h, s, l, spread }`, the `@base` colour, hue-shifted a little per agent type), `eyes` (boxes per expression for the left eye: `x`, `squint`, `happy`, `sleepy`, `dizzy`; the right eye is mirrored, missing ones are generated), `props` (where the reading page, the architect's hat and the web antenna sit), `hit`, `shadow`, `travel`, and `traits` (role words for `auto`, e.g. `["code", "test", "cheerful"]`: up to 16 words of letters, digits, `-` and `_`, see "Match role" above).

- **`*.glb`: a skinned model.** A glTF binary whose bones (nodes) are named like the rig. Case and `_` `.` space `-` do not matter: `Head`, `arm_L`, `Arm.R`, `mixamorig:Head`, `left arm` and `L_Leg` all match. The viewer turns the bones relative to the model's own rest pose (whatever their local axes), bobs, leans and squashes the model as a whole, scales it to the crab's footprint (about 7 wide and 6.5 tall) and stands it on the ground facing +z (a model whose eyes are at its back is turned around). Extra nodes named `eyeL_happy`, `eyeL_x`, `eyeL_squint`, `eyeL_sleepy`, `eyeL_dizzy` (and `eyeR_...`), placed beside the eye bones, are shown instead of the eye for that expression; without them the eyes just blink shut. Draco, Meshopt and KTX2 are not supported.
  - **How the bytes get to the page.** Files up to 4 MiB (the most the mod's `fs.read` can hand over) are embedded as base64 script parts in `characters-glb/`, which works everywhere, in a browser on `file://` and in the pet. A larger file is read from the folder by the page itself: the pet (Electron) can do that, a browser on `file://` usually refuses unless it runs with file access, and then the character falls back to a crab and the console says why.
  - `node tools/make-test-glb.mjs out.glb` (run it from a checkout of this repository; the installed plugin does not carry `tools/`) writes a small test model (a made-up "puff") with a rig-named skeleton, for trying the path.

Characters you load are yours: the repository ships only the five original ones above.

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
| `/crew characters [reload]` | List the built-in characters, yours (with traits) and the current assignment, the pet's own character settings and what `auto` gives the current agents; `reload` rescans `~/.claude/crew-graph/characters/`. |

Focus the pane with `ctrl+x tab`:
- `1`…`6` expand an agent card.
- `f` `s` `o` open the gate drill-downs.

## Configure

All of Flightdeck's options apply. Set them in `/config` or under `pluginConfigs["crew-graph"].options`:
- `architectPattern`, `architectLabel`, `gateLabel`, `panels`, `motion`, `moments`, `matchDescriptions`, `maxCards`, `layout`, `palette`, `openOnStart`, `statusLine`
- `webOnStart`, `petOnStart`, `characters`, `view3dFps`, `view3dRows`, `view3dColumns` and `view3dMode` (crew-graph only)
- `characters`: `who=character` pairs, e.g. `main=crab, Explore=bunny, *=auto` (a part without `=` means `*=`). Empty: every agent is a crab. The pet's Settings window sets characters too and wins over this. See [Characters](#characters).

The default `panels` value is `3d,main,crew,architect,gate,agents,loops,receipt,log`. The 3d panel shows only while `/crew 3d` runs.

## What it can reach

The mod only watches: every hook passes its event on unchanged, and a hook that throws passes the event on. It does reach outside the session in three places:
- **Files:** it writes files only under `~/.claude/crew-graph/` (this includes the `characters/` folder with its `README.txt`, the `characters-user.js` manifest and `characters-glb/` parts, written from the files you put there), and only after `/crew web` or `/crew pet` or `/crew characters reload` (or `webOnStart`, `petOnStart`). The pet's own window state, its quit and close requests and its "show in Crew pane" requests live in `~/.claude/crew-graph/overlay/`.
- **Processes:** it starts the OS "open" command (`explorer`, `open` or `xdg-open`), or `orca tab create` inside Orca, when `/crew web` opens the page. With `/crew 3d` it also starts `node bin/crew-3d.mjs`, which starts a headless browser and listens on 127.0.0.1 (token-protected) for the pane's pointer input. With `/crew pet` it runs `npm install electron@44.4.5` (and Electron's own binary download) once, into `~/.claude/crew-graph/overlay-runtime/`, then `node overlay/launch.mjs`, which starts Electron detached, so the pet outlives the session. The pet opens a file (`orca file open`, or the OS) only when you click it, and only a file listed in that session's snapshot; it reads at most the first 64 KB of such a file, for the hover summary.
- **Network:** none from the mod or the viewer. three.js r158 is bundled in `web/three.min.js` (MIT). Installing Electron downloads it from npm and from Electron's release host, once.

What it keeps:
- **`overlay/pet-settings.json`:** the pet's settings (characters per type and per agent, what is shown, motion, window). Written by the pet process only, with a temp file and a rename; `<session id>|<agent id>` keys are the only session ids in it.
- **Session state:** short summaries (tool name plus path or command, with credentials masked), which end with the session.
- **`data.js` and `sessions/<id>.js`:** the folder's basename, agent descriptions, the session's first prompt (shortened to about 32 characters, credentials masked), file paths relative to the session folder, and short event texts. Each file also lists its absolute path (`abs`) and the session folder's full path (`cwdAbs`), so the pet can open and summarize files. Both files are local, under your home.

## Develop

```bash
claude plugin validate plugins/crew-graph
claude plugin test plugins/crew-graph
claude --plugin-dir plugins/crew-graph
```

`CREW_PET_RUNTIME=<folder>` (an environment variable, for tests) makes `/crew pet` install Electron into that folder instead of `~/.claude/crew-graph/overlay-runtime`.

## Credits and license

MIT, see `LICENSE`.

- **Flightdeck:** © 2026 Stephen Casella, MIT. See `third_party/flightdeck-LICENSE.txt`. The ported files carry a header note.
- **three.js:** © three.js authors, MIT. See `plugins/crew-graph/web/THREE_LICENSE.txt`. `web/gltf-loader.classic.js` is three.js r158's `GLTFLoader` turned into a classic script by `tools/build-gltf-classic.mjs` (license: `third_party/three-LICENSE.txt`).
- **Clawd:** Clawd is Claude Code's mascot. The block-art and voxel crabs here are drawn from scratch as fan art.
