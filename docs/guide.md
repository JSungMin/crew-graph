# crew-graph guide

The full reference. For the short version, see the [README](../README.md) ([한국어](../README.ko.md)).

- [Panels](#panels) · [3D view in the pane](#3d-view-in-the-pane) · [3D web view](#3d-web-view) · [Desktop pet](#desktop-pet) · [Settings in the pet](#settings-in-the-pet) · [Tasks](#tasks) · [No task tools?](#food-when-the-model-has-no-task-tools)
- [Characters](#characters) · [Commands](#commands) · [Configure](#configure) · [What it can reach](#what-it-can-reach) · [Develop](#develop)

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

`index.html?demo` runs the view on synthetic data, `?demo=busy` on a busier set (six agents, eighteen files) and `?demo=tasks` on one that plays every state of the [tasks](#tasks).

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
| Hover a task (the food an agent holds or keeps on its plate) | A card: its title, state, owner and what it is doing now (see [Tasks](#tasks)) |
| Shift+click a file | Shows it in the file manager |
| Double-click the name pill, or right-click it and choose Collapse | Folds the window down to its title bar, with the 3D view closed; the same again expands it |
| Hover a crab or a file | A card: the agent's status, steps, which character it is and why (`robot · matched: code, test`) and last events; or the file's readers and writers and a summary of its first 64 KB (title, first paragraph and headings for text, leading comment and top-level names for code), made by heuristics, no model |
| Right-drag | Rotate the camera |
| Wheel | Zoom |
| Ctrl+wheel, or drag the corner grip | Resize (the grip shows whenever the pointer is in the window) |
| Right-click a character | **Character >** (Match role, Random and every character, yours included, as radio items: the choice applies to this agent's type), **Only this agent** (a check box: ticked, the choice is for this one agent), **Ask Claude…** (about that agent), Show in Crew pane, **Dismiss** (a finished agent) or **Ask Claude to stop it** (a running one), and the window options with **Settings…** |
| Right-click a file or elsewhere | Show in Crew pane (a file's focus panel), Open, Show in folder, Copy path, **Ask Claude…** (about nothing in particular), **Dismiss all finished**, and the window options with **Settings…** |
| Double-click | Refit the camera |

Where the picture is transparent, clicks go through to the desktop. The page reads the alpha under the pointer, with a two-miss hysteresis, and never lets clicks through while a drag or a resize runs. The crabs turn their eyes toward a near pointer, blink, shuffle, doze with `zZ` when the session is idle for two minutes (or not running), and wake with a stretch. The window draws about 30 frames a second while something moves and about 12 when idle. When the pet hands a file to its viewer (Open, Show in folder) it ends any drag in flight and keeps itself on top of the viewer's new window for about 15 seconds, without taking the focus; "Show" in the tray raises it too.

Each working crab shows a small speech bubble with what it does (`✎ app.js`, `» npm test`, `? register`). An optional ticker at the bottom (tray menu, "Activity ticker") lists the last three events for about six seconds each.

### Ask Claude from the pet

Right-click a character, the name pill or empty space and choose **Ask Claude…** (the tray has it in each session's submenu). A small dark card opens in the pet window with a text box (up to 4000 characters) and two buttons: **Send** (Ctrl+Enter) puts the question to Claude as a turn of its own, once the session is idle; **Put in prompt box** only writes it into the prompt box as a draft (below what you had typed there, if anything). Esc closes the card and keeps what you typed. Asked from a character, the question goes with a short context block about that agent: its type, id, status and task, its last 5 events and the files it touched. Asked from the pill or empty space, it goes alone.

The pet window cannot take the keyboard otherwise (it never steals focus from your editor): it becomes focusable only while the card is open, and not focusable again when it closes. A collapsed window opens up first.

After **Send** the main character shows a small `✉ sent` bubble. When the turn that came from the pet ends, the main character says the first words of the answer (about 200 cells, credentials masked) in a speech bubble for 12 s, and the ticker shows it; click the bubble for the whole clipped text. Turns that did not come from the pet never produce a bubble, even if one ends first.

What the mod does with it, and why it is hard to abuse:
- **Framed.** The mod submits with `$.prompt.submit` and never `asUser`, so Claude reads it as a message from the crew-graph plugin ("The crew-graph plugin sent a message: …"), not as your own words. The text is yours, typed in the card; nothing else the pet shows (file contents, other agents' text) is added to it except the context block above.
- **Token and session.** The mod makes a random token when it launches a pet window for a session and passes it to the window (`--token`; a second `/crew pet` hands a new one to the running window, which is also how a window picks up the new token after `/reload-plugins`). The window writes it, with the session id, into every request in its inbox file (`overlay/pet-inbox-<session id>.json`); the page itself never sees it. The mod acts on an ask, a dismiss or a stop only from its own session's inbox, only with that session id and that token, and logs and ignores anything else (a stale or foreign file, another session, a wrong or missing token, an empty or over-long text, an agent id it does not have).
- **One at a time.** Requests go to the inbox at least 1.3 s apart, so a question followed at once by a dismissal loses neither.
- **A reload does not strand the pet.** `/crew pet` records in the session's state that the pet is on (`/crew pet off` and `/crew pet off all` clear it). When the session starts again (after `/reload-plugins`, or when it is resumed) and the mark is set, the mod starts the pet the same way `/crew pet` does: a new token, handed to the window that is already running, and the inbox poll resumes.
- **Delivered or not.** Every request the mod accepts is acknowledged in the snapshot (`petAck`, the request's sequence number). The `✉ sent` bubble stays until then; with no acknowledgement within 8 s (no live mod behind the window, an older mod, a mod that refused the token) it turns into a red `✉ not delivered: run /crew pet`, with a line in the ticker.

### Dismiss finished agents

Right-click an agent that has finished, failed, was stopped, or sits idle or waiting with no work running: **Dismiss**. It waves goodbye and pops away in a puff. **Dismiss all finished** (right-click anywhere) does it for every such agent in the window. The mod keeps a per-session set of dismissed agents and leaves them, their events, their log lines and the file links only they made out of the snapshot and the Crew pane. An agent that works again (a step, a tool call, a new end) is shown again by itself; `/clear` forgets the set. The set records only what each agent looked like when it was dismissed.

A running agent has no Dismiss. Its menu has **Ask Claude to stop it**: the mod's plugin API has no call that stops an agent (`$.agent` can spawn, list and register agents, and `$.turn.abort` ends only the main loop's turn), so it submits a framed request naming the agent's id and type and asks Claude to stop it (Claude can, with its own TaskStop tool). That also keeps the stop in the transcript, where you see it. Like any submitted prompt it waits until the session is idle, so a long main turn delays it.

**Auto-dismiss** (Settings, *Agents*): off by default; after 5, 10 or 30 minutes a finished agent is dismissed by itself. The mod reads `autoDismiss` from `pet-settings.json` about every 10 s, tolerantly (a missing or unreadable file, or any other value, means off).

The tray icon (a crab) offers Show, **Settings…**, Always on top, Activity ticker, Reset position & size, a list of the open sessions (Show, Close) and Quit. Window positions and sizes are kept per session in `~/.claude/crew-graph/overlay/overlay-state.json`.

The `petOnStart` option starts the pet when a session starts.

### Settings in the pet

Right-click anything and choose **Settings…**, or use the tray icon. It opens one small window (shared by all sessions; dark and rounded like the cards) whose changes apply to every pet window at once:

- **Characters.** A *default for all agents* (a character, **Match role (auto)**, **Random**, or follow the `characters` option), each character as a tile with a live 3D preview (the same character code, idling; your own characters appear too), a character per *agent type* (the types seen in your sessions, `main`, and `*` for any other type) and one for a single *agent*. The right-click menu on a character sets the same things. When a character changes, the old one spins away, a puff of smoke, and the new one pops in.
- **Character packs.** Every file of your characters folder with its status (ok, warnings or error) and each problem with what to change, plus a **Rescan** button (the same as `/crew characters reload`; it asks the mod of a connected session, so it needs a pet window of one). A tile of a character whose pack has problems wears a red or amber `!`; click the tile or the badge to see them under the tiles. The right-click menu of such a character has **Pack problems…**, which opens Settings at that pack. See [Pack problems](#pack-problems).
- **Show.** Speech bubbles, the activity ticker, file papers, the nameplate, the tasks and pack warnings, each on or off (*Pack warnings* off hides the amber badges on the characters; a red one always shows). **Food** gives the tasks as each character's own food (the default) or as paper tickets.
- **Motion.** *Reduce motion* turns off the idle shuffles, drops the particle bursts and caps the frame rate lower (about 15 busy, 6 idle).
- **Agents.** *Auto-dismiss finished agents* after 5, 10 or 30 minutes, or off.
- **Window.** Always on top, opacity (60 to 100 %), a size preset S, M or L (besides dragging the grip), and **Reset to defaults**.

The pet keeps these in `~/.claude/crew-graph/overlay/pet-settings.json`; only the pet's main process reads, checks (every key) and writes it, and it never writes `~/.claude/settings.json`. For each agent the character comes from, first match wins: its own entry, the pet's rule for its type (specific types first, `*` last), the mod's `characters` option, the pet's default. With no default and no option an agent is a crab.

`pet-settings.json`:

```json
{ "default": "auto", "types": { "Explore": "cat", "*": "auto" }, "agents": { "<session id>|<agent id>": "robot" },
  "show": { "bubbles": true, "ticker": true, "papers": true, "nameplate": true, "tasks": true, "packWarnings": true }, "food": "character",
  "reduceMotion": false, "alwaysOnTop": true, "opacity": 100, "size": "M", "autoDismiss": 0 }
```

`/crew characters` prints what it says about characters (or that there is none yet) and what `auto` would pick for the agents of the latest snapshot, with the reason. To try the Settings window without a session: `electron overlay/main.js --page web/index.html --state <dir> --shot-settings out.png --demo`.

## Tasks

Every agent's to-do list is shown as food. The pet and `/crew web` draw the same thing from the snapshot's `tasks` (see [the data contract](DATA_CONTRACT.md#tasks)); the 3D view inside the pane (`/crew 3d`) does not.

**Where the tasks come from.** The mod only reads the calls; it changes nothing.

| Source | What it reads | Whose it is |
| --- | --- | --- |
| `TodoWrite` | The agent's whole list. Every call replaces that agent's previous list. An item gets a stable id (the agent and a hash of its text), so the page can tell when one changed. | The agent that made the call |
| `TaskCreate` / `TaskUpdate` | The subject, `activeForm`, status (`pending`, `in_progress`, `completed`, `deleted`), `addBlockedBy` and `owner`. A new task's id comes from the result of `TaskCreate` (or, failing that, the `#n` in its text). | The agent that last set it `in_progress`, or the `owner` field when it names a known agent (an id, or the type or name it was started under); else nobody |
| Subagents | Every subagent card is a ticket: its task as the title; running is in progress, done is completed, failed or stopped is failed. These need no task tool at all. | The child; its parent eats it when it is done |

The agent is the one the call's `agentId` names (main when it has none), the same field the mod uses to tell who read or wrote a file. A task of an agent that is not on show is main's. An architect started as a consult has no card, so no ticket.

**What you see.**

| State | The agent |
| --- | --- |
| pending | A small stack on a plate beside its owner: five at most, then a `+N` chip. A task nobody took sits on a shared table beside main. |
| in progress | Holds it in its hand and works on it: the robot hammers it, the cat paws at it, the bunny nibbles at its corner, the crab snips, the hamster rolls it. It does this only while its verb leaves the arms free (thinking, planning, waiting), so reading, editing and running are never hidden. The speech bubble says the item's `activeForm` ("Running tests"). |
| completed | Eats it: to the mouth, three chomps while it shrinks and crumbs fly, happy eyes and a hop, about 1.2 s in all. Then the `✓ N` beside its plate counts it. A subagent's ticket is first carried by the child along its link to the parent, who eats it. |
| failed | The food turns grey and lies on the ground; the agent sighs. |
| deleted | A puff of smoke. |
| blocked | A little lock on the item (its `blockedBy` lists an open task), and the owner taps a foot. |

Hover an item for a card: its title, state, owner and what it is doing now.

**Food.** One kind per character: the crab a fish, the bunny a carrot, the cat a treat stick, the hamster (`mochi`) a sunflower seed, the robot a battery, and your own characters (voxel packs and models) a sunflower seed, the hamster's; a paper ticket only when nobody holds the task. A voxel pack picks its own with a `food` key: the id of a built-in food (`fish`, `carrot`, `treat`, `seed`, `battery`, `ticket`), or boxes like a bone (`"food": { "boxes": [...] }`: up to 40, centred on 0, about 2.5 voxels long with the long side along x). A pack without a valid `food` gets the seed; an invalid one (an id that is not a built-in food, a list with no box) is reported as a pack problem. A `.glb` has no `food` and always eats the seed. In the pet's Settings, **Food** switches every character to paper tickets.

**Only what happens while you watch is played.** The page compares each snapshot with the last by task id. The first snapshot after a start, a reload or a switch of session is the baseline: what is done stays eaten and its count shows at once, and nothing is eaten again. A task that arrives already done (the mod writes about twice a second, so two steps can land in one write) is eaten when it appears. The `✓ N` is the mod's count of tasks finished this session (it does not shrink when old ones fall out of the list), and a reload shows it at once.

**Motion.** *Reduce motion* has no crumbs, no smoke and no carrying: an eaten item fades for a moment and the count goes up. An eat, a carry and a puff of smoke count as "something moves" for the pet's frame rate (about 30 frames a second while anything moves). While the pet dozes (nothing for two minutes, or the session is not running), the agents hold their food and stand still.

**Settings.** `show.tasks` (default on) and `food` (`character`, the default, or `ticket`) in `pet-settings.json`, or the pet's Settings window. `index.html?demo` shows a to-do list on the crab, and `?demo=tasks` plays every state with all five characters: to-do items going from pending to in progress to eaten, a subagent's ticket carried to its parent, a blocked task, a failed one and a deleted one.

**What the mod keeps.** The tasks live in the session's state (a list per source, at most 200 each, and a count per agent), end with the session and are cleared by `/crew reset`. The snapshot lists every open task up to 40, the last 10 closed ones and a deleted one for 5 s. A title is one line, credentials masked, cut to about 80 cells. The titles go into `data.js` and `sessions/<id>.js`, which stay on your machine (see [What it can reach](#what-it-can-reach)).

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

`/crew characters` lists the built-in and your characters with their traits, what is wrong with each file and how to fix it ([Pack problems](#pack-problems)), how the current option reads, what the pet's Settings say about characters, and what `auto` would pick for the agents of the latest snapshot. `/crew characters reload` rescans your folder; a running pet or browser view picks the change up within a few seconds. `?demo=lineup` shows every character in a row (`&verbs=think,edit,run` picks the rows).

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

  A pack can also bring the `food` its agent works on and eats (see [Tasks](#tasks)).

- **`*.glb`: a skinned model.** A glTF binary whose bones (nodes) are named like the rig. Case and `_` `.` space `-` do not matter: `Head`, `arm_L`, `Arm.R`, `mixamorig:Head`, `left arm` and `L_Leg` all match. The viewer turns the bones relative to the model's own rest pose (whatever their local axes), bobs, leans and squashes the model as a whole, scales it to the crab's footprint (about 7 wide and 6.5 tall) and stands it on the ground facing +z (a model whose eyes are at its back is turned around). Extra nodes named `eyeL_happy`, `eyeL_x`, `eyeL_squint`, `eyeL_sleepy`, `eyeL_dizzy` (and `eyeR_...`), placed beside the eye bones, are shown instead of the eye for that expression; without them the eyes just blink shut. Draco, Meshopt and KTX2 are not supported.
  - **How the bytes get to the page.** Files up to 4 MiB (the most the mod's `fs.read` can hand over) are embedded as base64 script parts in `characters-glb/`, which works everywhere, in a browser on `file://` and in the pet. A larger file is read from the folder by the page itself: the pet (Electron) can do that, a browser on `file://` usually refuses unless it runs with file access, and then the character falls back to a crab and the console says why.
  - `node tools/make-test-glb.mjs out.glb` (run it from a checkout of this repository; the installed plugin does not carry `tools/`) writes a small test model (a made-up "puff") with a rig-named skeleton, for trying the path.

### Food when the model has no task tools

Claude Code leaves `TodoWrite`, `TaskCreate`, `TaskGet`, `TaskUpdate` and `TaskList` out on newer models unless you ask for them ([tools reference](https://code.claude.com/docs/en/tools-reference#task-tool-availability), [environment variables](https://code.claude.com/docs/en/env-vars)), and the subagents of such a session get none either. Without them there are no to-do lists, so the mod makes food from proxies of real work instead. It reads the session's tool list at start (`TodoWrite` or `TaskCreate` present means native tools); nothing is registered, written or changed for this.

| Source | Is food when | The item |
| --- | --- | --- |
| To-dos and tasks | An agent writes them (native tools) | As above |
| Subagent tickets | Always | As above |
| **Prompt turns** | The session has no native task tools (`foodFrom` `auto`), or `foodFrom` is `todos+work` | Each prompt you send is one item owned by main, titled by the prompt (one line, credentials masked, about 60 cells). Pending while it waits behind a running turn, in progress while its turn runs, eaten (main's `✓ N`) when the turn answers, failed when it is aborted or ends in an error. A question typed into the pet is titled by your words, not by the frame. Turns the engine opens by itself (a hand-back, a task notification) and subagents' turns are not items. |
| Background jobs | Not tracked | A background `Bash` job or `Monitor` is not an item. When one ends, the mod sees it only as a notification prompt whose text format Claude Code does not type, so it cannot tell which job ended; the one typed link back to the call that started it (`task.toolUseId`) is on a transcript row (a render site), which cannot write state and needs a surface. A hook for it may become possible if Claude Code adds an event. |

The `foodFrom` option (`/config`): `auto` (default) uses the prompt turns only when the session is known to have no native task tools, `todos` never does, `todos+work` always does. An unreadable tool list counts as unknown, so `auto` leaves the turns out; a native task call seen later in the session settles it as present. The subagent tickets are food in every setting.

`/crew setup` only reports: whether the native tools are present, which sources are on, and how to get the native tools (set `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the environment before starting Claude Code, or under `env` in your `settings.json`; they cost some context on every request). It changes nothing and writes no file.

Characters you load are yours: the repository ships only the five original ones above.

### Pack problems

A file that is wrong, or misses something, is not silently ignored. Each pack gets a list of problems, `{ level, code, text, fix }`, worst first: an **error** means the character is not drawn as the pack meant (a crab stands in, nothing is drawn, or the food is not the one it names), a **warning** means it works but misses something.

| Code | Level | What it says |
| --- | --- | --- |
| `unreadable`, `bad-json`, `too-big`, `no-bones` | error | The file cannot be read, is not valid JSON, is over 512 KiB (or the manifest limit of 3 MiB), or has no `bones` object: it does not load at all |
| `nothing-drawn` | error | No box is left to draw (all dropped or none given): the character is invisible |
| `food-bad` | error | `food` is not a built-in food or a list of boxes: the pack eats the seed |
| `glb-failed`, `glb-too-big`, `glb-empty` | error | A model failed to load, is over 4 MiB where the page cannot read the folder, or has no geometry: a crab is drawn (found by the page) |
| `food-none` | warning | No `food`: it eats the seed |
| `no-hands`, `no-mouth` | warning | No `handL`/`handR`, no `mouth` (also checked for a model's node names): items are held at the arm, it eats at the head |
| `no-traits` | warning | No `traits`: `auto` never picks it by role (not checked for a `.glb`, which cannot declare any) |
| `bone-unknown`, `mirror-missing`, `box-color`, `box-limit` | warning | Dropped by validation: a bone that is not on the rig, a `mirror` of a bone that is not defined, boxes without a `#rrggbb` color (drawn light grey), more than 400 boxes |
| `glb-large`, `glb-unread`, `glb-no-rig` | warning | A model over 4 MiB (not embedded), one the mod could not read, one with no node named like a rig bone |

Where they show:

- **On the character.** A small round `!` chip at the head's upper right, red for an error and amber for warnings only (the pet setting `show.packWarnings`, on by default, hides the amber ones; a red one always shows). Hovering the character adds a *Pack problems* section to its card: the first three problems and `+N more · Settings…`; in `/crew web` they are in the tooltip and the side card (with the fixes). A character that stands in for a pack that failed (a crab for a model that did not load, or for a file that is not valid JSON that a rule or the Settings asked for) wears the red chip and its card names the pack that failed.
- **In the pet's Settings:** the *Character packs* section and the badges on the tiles (see above).
- **`/crew characters`** prints the same problems grouped by pack, errors first, each with its fix.

The mod writes them next to each pack in `characters-user.js` (`window.__crewUserPacks`, see the [data contract](DATA_CONTRACT.md#characters)); what only the page can know (a model that failed to load, its node names) it adds itself.

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
| `/crew setup` | Report whether the session has the native task tools, which food sources are on, and how to get the native tools. Changes nothing. See [Food when the model has no task tools](#food-when-the-model-has-no-task-tools). |
| `/crew characters [reload]` | List the built-in characters, yours (with traits) and the current assignment, the pet's own character settings and what `auto` gives the current agents; `reload` rescans `~/.claude/crew-graph/characters/`. |

Focus the pane with `ctrl+x tab`:
- `1`…`6` expand an agent card.
- `f` `s` `o` open the gate drill-downs.

## Configure

All of Flightdeck's options apply. Set them in `/config` or under `pluginConfigs["crew-graph"].options`:
- `architectPattern`, `architectLabel`, `gateLabel`, `panels`, `motion`, `moments`, `matchDescriptions`, `maxCards`, `layout`, `palette`, `openOnStart`, `statusLine`
- `webOnStart`, `petOnStart`, `characters`, `foodFrom`, `view3dFps`, `view3dRows`, `view3dColumns` and `view3dMode` (crew-graph only)
- `foodFrom`: `auto` (default), `todos` or `todos+work`: whether each prompt you send is food too. See [Food when the model has no task tools](#food-when-the-model-has-no-task-tools).
- `characters`: `who=character` pairs, e.g. `main=crab, Explore=bunny, *=auto` (a part without `=` means `*=`). Empty: every agent is a crab. The pet's Settings window sets characters too and wins over this. See [Characters](#characters).

The default `panels` value is `3d,main,crew,architect,gate,agents,loops,receipt,log`. The 3d panel shows only while `/crew 3d` runs.

## What it can reach

The mod mostly watches: every hook passes its event on unchanged, and a hook that throws passes the event on. The one thing it does for you is what you ask in the pet's **Ask Claude…** card and its **Ask Claude to stop it** entry: it then submits a prompt, framed as coming from the plugin, with your text (see [Ask Claude from the pet](#ask-claude-from-the-pet)). It never submits anything else, and never kills an agent itself. It does reach outside the session in three places:
- **Files:** it writes files only under `~/.claude/crew-graph/` (this includes the `characters/` folder with its `README.txt`, the `characters-user.js` manifest and `characters-glb/` parts, written from the files you put there), and only after `/crew web` or `/crew pet` or `/crew characters reload` (or `webOnStart`, `petOnStart`). The pet's own window state, its quit and close requests and its "show in Crew pane" requests live in `~/.claude/crew-graph/overlay/`.
- **Processes:** it starts the OS "open" command (`explorer`, `open` or `xdg-open`), or `orca tab create` inside Orca, when `/crew web` opens the page. With `/crew 3d` it also starts `node bin/crew-3d.mjs`, which starts a headless browser and listens on 127.0.0.1 (token-protected) for the pane's pointer input. With `/crew pet` it runs `npm install electron@44.4.5` (and Electron's own binary download) once, into `~/.claude/crew-graph/overlay-runtime/`, then `node overlay/launch.mjs`, which starts Electron detached, so the pet outlives the session. The pet opens a file (`orca file open`, or the OS) only when you click it, and only a file listed in that session's snapshot; it reads at most the first 64 KB of such a file, for the hover summary.
- **Network:** none from the mod or the viewer. three.js r158 is bundled in `web/three.min.js` (MIT). Installing Electron downloads it from npm and from Electron's release host, once.

What it keeps:
- **`overlay/pet-settings.json`:** the pet's settings (characters per type and per agent, what is shown, the tasks' food, motion, window, auto-dismiss). Written by the pet process only, with a temp file and a rename; `<session id>|<agent id>` keys are the only session ids in it.
- **Session state:** short summaries (tool name plus path or command, with credentials masked), and the agents' to-do items and tasks (titles one line, credentials masked, about 80 cells), and, when the prompt turns are food, each prompt you send as an item (one line, credentials masked, about 60 cells), which end with the session.
- **`data.js` and `sessions/<id>.js`:** the folder's basename, agent descriptions, the session's first prompt (shortened to about 32 characters, credentials masked), file paths relative to the session folder, short event texts, the titles of the agents' tasks (one line, credentials masked, about 80 cells) and, when the prompt turns are food (see [Food when the model has no task tools](#food-when-the-model-has-no-task-tools)), the prompts you send, clipped to about 60 cells with credentials masked. Each file also lists its absolute path (`abs`) and the session folder's full path (`cwdAbs`), so the pet can open and summarize files. Both files are local, under your home.

## Develop

```bash
claude plugin validate plugins/crew-graph
claude plugin test plugins/crew-graph
claude --plugin-dir plugins/crew-graph
```

`CREW_PET_RUNTIME=<folder>` (an environment variable, for tests) makes `/crew pet` install Electron into that folder instead of `~/.claude/crew-graph/overlay-runtime`.
