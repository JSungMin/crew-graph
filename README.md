# crew-graph

A Claude Code **mod** that shows your agent crew at work, in a side pane:

- **Agent tree:** the main loop and every subagent under it, with grandchildren and their status.
- **Cute activity critters:** each agent gets a little two-frame ASCII critter that acts out what it is doing right now (reading, editing, searching, running, browsing, spawning, planning, thinking).
- **Plan / doc relationship graph:** every plan, doc and code file a loop touched, with which agent read (`r`) or wrote (`w`) it.

```
Crew · 1 running · 3 files
● (>.<)/~ main  edit docs/guide.md 2s
└─(O_O)!   Explore "find the hooks"  search register 4s

Plans & docs (2)
  ■ plan plans/plan.md ◄─ main:r Explore:r
  □ doc  docs/guide.md ◄─ main:w

Code (1)
  · hooks/register.tsx ◄─ Explore:r
```

| Verb | Critter |
| --- | --- |
| read | `(o.o)[=]` ↔ `(-.o)[=]` |
| edit | `(>.<)/~` ↔ `(>.<)-~` |
| search | `(o_o)?` ↔ `(O_O)!` |
| run | `\(^o^)/` ↔ `/(^o^)\` |
| web | `(o.o)@` ↔ `(o.o) @` |
| spawn | `(^.^)>` ↔ `(^.^)>>>` |
| plan | `(._.)..` ↔ `(._.)...` |
| think | `(-.-)zZ` ↔ `(-.-)Zz` |
| done / failed | `(^_^)v` / `(x_x)` |

## Install

Requires **Claude Code 2.1.287+** (mods). In Claude Code:

```text
/plugin marketplace add JSungMin/crew-graph
/plugin install crew-graph@crew-graph
/reload-plugins
```

Or from a shell:

```bash
claude plugin marketplace add JSungMin/crew-graph
claude plugin install crew-graph@crew-graph
```

## Use

- `/crew` opens the pane.
- The pane also opens by itself **once per session**, on the first subagent spawn. If you close it, it stays closed until you run `/crew` again.
- In the terminal, the pane needs the fullscreen layout. An unrequested pane waits until the terminal is wide enough (about 110–144 columns).

## How it works

| Hook | What it does |
| --- | --- |
| `tool.call` | Records the verb and target per loop (`agentId`, or `main`), and the files read or written. |
| `turn.start` / `turn.complete` | Marks the main loop as thinking or done. |
| `ui.render` (`Pane`) | Draws the tree, the critters and the graph. |
| `$.clock.every` | Ticks the animation every 450 ms, and only while work is running. |
| `$.agent.list()` | Polls the agent list every 2 s while the timer runs; the tree comes from each agent's `parentId`. |

File classification:
- **plan:** paths under `plan/`, `plans/`, `spec/`, `specs/` or `.omc/plans/`, and files named `plan*`, `intent*`, `spec*`, `prd*` or `roadmap*` with `.md` or `.d4a`.
- **doc:** `.md`, `.d4a`, `.txt`, `.rst`, `.adoc`, or anything under `doc/` or `docs/`.
- **code:** everything else.

Line widths are counted in terminal cells, so CJK paths (two cells per character) do not wrap the pane.

Reach: it reads only what Claude Code's events hand it. It does not touch the network, write files or run processes.

## Develop

```bash
claude plugin validate plugins/crew-graph
claude plugin test plugins/crew-graph
claude --plugin-dir plugins/crew-graph     # try it in a session
```

## License

MIT
