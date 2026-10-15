// crew-graph = Flightdeck (ported, MIT, Stephen Casella; see third_party/flightdeck-LICENSE.txt)
// + the crew: Clawd crabs per loop, the agent tree, the plan/doc graph, and the browser view export.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentCard, Architect, Bucket, Check, CrewEvent, FileNode, Gate, Layout, LogLine, Loop, LoopAct, Main, Roster, Turn, Usage, Verb, View, View3d, Web } from '../types'
import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_ROSTER,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  DEFAULT_VIEW,
  EDIT_TOOLS,
  SCHEMA_VERSION,
  afterCall,
  applyStep,
  bucketOf,
  cardTitle,
  titleLines,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtClock,
  fmtDuration,
  fmtTimer,
  fmtUsd,
  plural,
  gateSummary,
  gauge,
  isAdvising,
  isLoopActive,
  kTokens,
  lanes,
  limitLabel,
  limitOf,
  fmtResetIn,
  fmtSpeed,
  listOf,
  logRows,
  momentOf,
  normalize,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  noteTool,
  PALETTES,
  SVG_COLORS,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  settleCheck,
  shorten,
  startConsult,
  stepSpeed,
  stepLoop,
} from './deck/core'
import type { Config, Panel } from './deck/core'
import { bigFrame, miniFrame, propFrame } from './clawd'
import { clip, dataJs, describeCall, pushEvent, shortPath, snapshotOf, touchFile, verbOfCard } from './crew'

const PANE = 'crew-graph'
const TITLE = 'Crew'
const PANE_COLUMNS = 70
const WEB_FILES = ['index.html', 'app.js', 'three.min.js', 'THREE_LICENSE.txt']
const WEB_THROTTLE_MS = 450


// ---------------------------------------------------------------- state

const meta = atom({ plugin: 'crew-graph', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const main = atom({ plugin: 'crew-graph', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'crew-graph', key: 'usage' } as const, DEFAULT_USAGE)
const architect = atom({ plugin: 'crew-graph', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gate = atom({ plugin: 'crew-graph', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'crew-graph', key: 'agents' } as const, [])
const loops = atom({ plugin: 'crew-graph', key: 'loops' } as const, [])
const log = atom({ plugin: 'crew-graph', key: 'log' } as const, [])
const turn = atom({ plugin: 'crew-graph', key: 'turn' } as const, DEFAULT_TURN)
const receipt = atom({ plugin: 'crew-graph', key: 'receipt' } as const, null)
const view = atom({ plugin: 'crew-graph', key: 'view' } as const, DEFAULT_VIEW)
const roster = atom({ plugin: 'crew-graph', key: 'roster' } as const, DEFAULT_ROSTER)
const acts = atom({ plugin: 'crew-graph', key: 'acts' } as const, {})
const files = atom({ plugin: 'crew-graph', key: 'files' } as const, [])
const events = atom({ plugin: 'crew-graph', key: 'events' } as const, [])
const parents = atom({ plugin: 'crew-graph', key: 'parents' } as const, {})
const autoOpened = atom({ plugin: 'crew-graph', key: 'autoOpened' } as const, false)
const web = atom({ plugin: 'crew-graph', key: 'web' } as const, { isOn: false, dir: '', lastWriteAt: 0 })
const view3d = atom({ plugin: 'crew-graph', key: 'view3d' } as const, { isOn: false, cols: 0, rows: 0, status: '' })

type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, main))
}
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, gate))
}
async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return listOf<unknown>(await read($, agents)).map(normalizeCard)
}
async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, loops))
}
async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, log))
}
async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, turn))
}
async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, view))
}
async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, roster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
async function migrate($: EngineInterface) {
  const m = await read($, meta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, log, list => normalizeLog(list))
  await update($, agents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, gate, g => normalizeGate(g))
  await update($, meta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, log, list => [...normalizeLog(list), line].slice(-60))
}

async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const parts = [
    u.pct !== null ? `ctx ${Math.round(u.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string) {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via }))
  if (moment === 'before done') await update($, turn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const first = advice?.split('\n').find(l => l.trim()) ?? null
  const text = first ? shorten(first.replace(/^[#>*\s-]+/, ''), 160) : null
  await update($, architect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, turn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

async function noteAdvice($: EngineInterface, cfg: Config, advice: string) {
  await update($, architect, x => ({ ...normalize(DEFAULT_ARCHITECT, x), lastAdvice: advice }))
  await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

async function openPane($: EngineInterface) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: 8 })
}

async function resetAll($: EngineInterface) {
  await update($, main, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, architect, () => DEFAULT_ARCHITECT)
  await update($, gate, () => DEFAULT_GATE)
  await update($, agents, () => [])
  await update($, loops, () => [])
  await update($, log, () => [])
  await update($, turn, () => DEFAULT_TURN)
  await update($, receipt, () => null)
  await update($, view, () => DEFAULT_VIEW)
  await update($, acts, () => ({}))
  await update($, files, () => [])
  await update($, events, () => [])
  await update($, parents, () => ({}))
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, main, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}

// ---------------------------------------------------------------- crew

let cwd = ''
let webPending = false
const WEB_OFF: Web = { isOn: false, dir: '', lastWriteAt: 0 }

async function getActs($: EngineInterface): Promise<Record<string, LoopAct>> {
  const a = await read($, acts)
  return a && typeof a === 'object' ? a : {}
}
async function getFiles($: EngineInterface): Promise<FileNode[]> {
  return listOf<FileNode>(await read($, files))
}
async function getEvents($: EngineInterface): Promise<CrewEvent[]> {
  return listOf<CrewEvent>(await read($, events))
}
async function getParents($: EngineInterface): Promise<Record<string, string>> {
  const p = await read($, parents)
  return p && typeof p === 'object' ? p : {}
}
async function getWeb($: EngineInterface): Promise<Web> {
  return normalize(WEB_OFF, await read($, web))
}

async function act($: EngineInterface, key: string, verb: Verb, tool: string, target: string) {
  const now = await $.clock.now()
  await update($, acts, all => {
    const prev = all?.[key]
    return { ...all, [key]: { key, verb, tool, target, since: now, calls: (prev?.calls ?? 0) + (tool ? 1 : 0) } }
  })
}

async function emit($: EngineInterface, e: Omit<CrewEvent, 'id' | 't'>) {
  const t = await $.clock.now()
  await update($, events, list => pushEvent(listOf<CrewEvent>(list), { ...e, t }))
  await queueWeb($)
}

/** The browser view's data, written at most every WEB_THROTTLE_MS while the export is on. */
async function queueWeb($: EngineInterface) {
  const w = await getWeb($)
  if (!w.isOn || webPending) return
  const now = await $.clock.now()
  const wait = Math.max(0, WEB_THROTTLE_MS - (now - w.lastWriteAt))
  if (wait === 0) return writeWeb($)
  webPending = true
  $.clock.after(wait, () => void flushWeb($))
}

async function flushWeb($: EngineInterface) {
  webPending = false
  await writeWeb($)
}

async function writeWeb($: EngineInterface) {
  const w = await getWeb($)
  if (!w.isOn || !w.dir) return
  const [m, u, a, g, cards, t, r, ac, fl, ev, pa, now, sid] = await Promise.all([
    getMain($),
    getUsage($),
    getArchitect($),
    getGate($),
    getCards($),
    getTurn($),
    read($, receipt),
    getActs($),
    getFiles($),
    getEvents($),
    getParents($),
    $.clock.now(),
    $.session.id().catch(() => ''),
  ])
  const snap = snapshotOf({
    now,
    sessionId: String(sid),
    cwd,
    main: m,
    usage: u,
    architect: a,
    gate: g,
    cards,
    architectIds: a.ids,
    acts: ac,
    files: fl,
    events: ev,
    parents: pa,
    turn: t,
    receipt: r,
  })
  await $.fs.write(`${w.dir}/data.js`, dataJs(snap)).catch(() => undefined)
  await update($, web, x => ({ ...normalize(WEB_OFF, x), lastWriteAt: now }))
}

async function homeDir($: EngineInterface) {
  return ((await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '').replace(/\\/g, '/')
}

/** Copies the viewer next to its data and turns the export on; opens it in the browser when asked. */
async function startWeb($: EngineInterface, shouldOpen: boolean): Promise<string> {
  const home = await homeDir($)
  if (!home) return 'crew-graph: no home directory to write the browser view into.'
  const dir = `${home}/.claude/crew-graph`
  for (const f of WEB_FILES) {
    const text = await $.fs.read(`${$.plugin.root}/web/${f}`).catch(() => null)
    if (typeof text === 'string') await $.fs.write(`${dir}/${f}`, text)
  }
  await update($, web, () => ({ isOn: true, dir, lastWriteAt: 0 }))
  await writeWeb($)
  const page = `${dir}/index.html`
  const where = shouldOpen ? await openInBrowser($, page) : ''
  return `Crew web view: ${page}${where}`
}

/** Inside Orca, a browser tab beside the terminal (full pixels, real mouse); else the system browser. */
async function openInBrowser($: EngineInterface, page: string): Promise<string> {
  if ((await $.env.get('TERM_PROGRAM')) === 'Orca') {
    const url = `file://${page.startsWith('/') ? '' : '/'}${page}`
    const res = await $.process.run(['orca', 'tab', 'create', '--url', url, '--json'], { timeoutMs: 15_000 }).catch(() => null)
    if (res && res.exitCode === 0) return ' (opened in an Orca browser tab)'
  }
  const isWin = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWin ? ['explorer', page.replace(/\//g, '\\')] : [(await $.env.get('XDG_SESSION_TYPE')) ? 'xdg-open' : 'open', page]
  await $.process.run(argv, { timeoutMs: 10_000 }).catch(() => undefined)
  return ''
}

// ---------------------------------------------------------------- 3d view in the pane
// bin/crew-3d.mjs renders the web view in a headless Chrome/Edge and streams it as Raster
// cells (each cell the block glyph and two colours that best fit its 4x8 pixels, bin/cells.mjs)
// or, where the terminal draws pictures, as Image frames; each is blitted into the pane's `crew3d`.

const RASTER_KEY = 'crew3d'
const VIEW3D_OFF: View3d = { isOn: false, cols: 0, rows: 0, status: '' }
let view3dGen = 0
let last3d: { cols: number; rows: number; cells: string } | null = null
let lastImage: { path: string; width: number; height: number; gen: number } | null = null
let helper: { port: number; token: string } | null = null
let pointerIn3d = false
let pointerAt = { x: 0.5, y: 0.5 }
let mode3d: 'cells' | 'image' = 'cells'
let isRestarting3d = false

async function getView3d($: EngineInterface): Promise<View3d> {
  return normalize(VIEW3D_OFF, await read($, view3d))
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Standard padded base64, without relying on the host having toBase64 or btoa. */
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += B64.charAt((n >> 18) & 63) + B64.charAt((n >> 12) & 63)
    out += i + 1 < bytes.length ? B64.charAt((n >> 6) & 63) : '='
    out += i + 2 < bytes.length ? B64.charAt(n & 63) : '='
  }
  return out
}

let blankCache: { key: string; cells: string } | null = null

/** Blank cells for a raster not yet painted: spaces on the terminal's own colours. */
function blankCells(cols: number, rows: number): string {
  const key = `${cols}x${rows}`
  if (blankCache?.key === key) return blankCache.cells
  const words = new Uint32Array(cols * rows * 3)
  for (let i = 0; i < cols * rows; i += 1) {
    words[i * 3] = 0x20
    words[i * 3 + 1] = 0x01000000
    words[i * 3 + 2] = 0x01000000
  }
  blankCache = { key, cells: base64(new Uint8Array(words.buffer)) }
  return blankCache.cells
}

/** Pixels where the terminal draws them (kitty, Ghostty); colour cells everywhere else. */
async function pickMode($: EngineInterface, want: string): Promise<'cells' | 'image'> {
  if (want === 'cells' || want === 'image') return want
  const [term, prog, kitty, ghostty] = await Promise.all([
    $.env.get('TERM'),
    $.env.get('TERM_PROGRAM'),
    $.env.get('KITTY_WINDOW_ID'),
    $.env.get('GHOSTTY_RESOURCES_DIR'),
  ])
  const isPixel = /kitty/i.test(term ?? '') || /ghostty|kitty/i.test(prog ?? '') || Boolean(kitty) || Boolean(ghostty)
  return isPixel ? 'image' : 'cells'
}

async function start3d($: EngineInterface, cols: number, rows: number, fps: number, want = 'auto'): Promise<string> {
  const started = await startWeb($, false)
  const w = await getWeb($)
  if (!w.isOn || !w.dir) return started
  mode3d = await pickMode($, want)
  view3dGen += 1
  const gen = view3dGen
  last3d = null
  lastImage = null
  helper = null
  await update($, view3d, () => ({ isOn: true, cols, rows, status: 'starting the renderer…' }))
  void run3d($, gen, cols, rows, fps, w.dir)
  const inOrca = (await $.env.get('TERM_PROGRAM')) === 'Orca'
  const full = inOrca && mode3d === 'cells' ? ' Full size: /crew web opens it in an Orca browser tab.' : ''
  return `Crew 3D view: ${cols}x${rows} cells in the pane, ${mode3d === 'image' ? 'pixels' : 'block glyphs fitted to 4x8 pixels a cell'}, ${fps} fps. Drag to rotate, wheel to zoom, click a crab to pinch it, stroke it to pet it.${full}`
}

async function stop3d($: EngineInterface, status = '') {
  view3dGen += 1
  last3d = null
  lastImage = null
  helper = null
  pointerIn3d = false
  await update($, view3d, () => ({ ...VIEW3D_OFF, status }))
}

async function restart3d($: EngineInterface, cols: number, rows: number, fps: number, want: string) {
  isRestarting3d = false
  if ((await getView3d($)).isOn) await start3d($, cols, rows, fps, want)
}

/** The pane's pointer events, forwarded to the renderer's page. */
async function sendInput($: EngineInterface, events: unknown[]) {
  if (!helper || events.length === 0) return
  await $.http
    .fetch(`http://127.0.0.1:${helper.port}/input?t=${helper.token}`, { method: 'POST', body: JSON.stringify({ events }) })
    .catch(() => undefined)
}

async function run3d($: EngineInterface, gen: number, cols: number, rows: number, fps: number, dir: string) {
  const page = `file:///${dir.replace(/^\/+/, '')}/index.html`
  const argv = ['node', `${$.plugin.root}/bin/crew-3d.mjs`, '--page', page, '--cols', String(cols), '--rows', String(rows), '--fps', String(fps), '--mode', mode3d]
  if (mode3d === 'image') argv.push('--out', `${dir}/frames`)
  const child = $.process.spawn({ argv })
  let buf = ''
  let denies = 0
  let isDone = false
  try {
    for await (const piece of child) {
      if (gen !== view3dGen) break
      if (piece.stream !== 'stdout') continue
      buf += piece.text
      let at = buf.indexOf('\n')
      while (at >= 0 && !isDone) {
        const line = buf.slice(0, at)
        buf = buf.slice(at + 1)
        at = buf.indexOf('\n')
        if (line.startsWith('P ')) {
          const [, port = '0', token = ''] = line.split(' ')
          helper = { port: Number(port), token }
          continue
        }
        if (line.startsWith('C ') || line.startsWith('I ')) {
          let res: { deny?: string }
          if (line.startsWith('C ')) {
            const [, c = '0', r = '0', cells = ''] = line.split(' ')
            last3d = { cols: Number(c), rows: Number(r), cells }
            res = await $.ui.blit({ requestId: PANE, key: RASTER_KEY, cells, columns: Number(c), rows: Number(r) }).catch(() => ({ deny: 'blit failed' }))
          } else {
            const [, path = '', wd = '0', ht = '0', g = '0'] = line.split(' ')
            lastImage = { path, width: Number(wd), height: Number(ht), gen: Number(g) }
            res = await $.ui
              .blit({ requestId: PANE, key: RASTER_KEY, source: { file: path, format: 'rgb', width: lastImage.width, height: lastImage.height, generation: lastImage.gen } })
              .catch(() => ({ deny: 'blit failed' }))
          }
          if ('deny' in res && res.deny !== undefined) {
            // A terminal the engine draws no pictures in: say why, and go on in cells.
            if (mode3d === 'image' && /draws its alt|cannot read files/.test(res.deny)) {
              await $.ui.toast(`crew 3d: no pixels in this terminal (${res.deny}); using block glyphs`)
              // start3d moves view3dGen on, so this run ends without stopping the new one.
              await start3d($, cols, rows, fps, 'cells')
              return
            }
            denies += 1
            // The pane is closed or the panel hidden for ~5 s: stop the browser.
            if (denies > 40) isDone = true
          } else {
            if (denies > 0 || (await getView3d($)).status) await update($, view3d, v => ({ ...normalize(VIEW3D_OFF, v), status: '' }))
            denies = 0
          }
        } else if (line.startsWith('E ')) {
          await update($, view3d, v => ({ ...normalize(VIEW3D_OFF, v), status: line.slice(2) }))
        }
      }
      if (isDone) break
    }
  } catch (err) {
    if (gen === view3dGen) await update($, view3d, v => ({ ...normalize(VIEW3D_OFF, v), status: `renderer: ${String(err)}` }))
  }
  if (gen === view3dGen) await stop3d($, isDone ? 'stopped: the pane was closed' : (await getView3d($)).status || 'renderer ended')
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const C = PALETTES[cfg.palette]
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const callLoop = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'crew',
      description: 'Crew: the live agent dashboard with Clawd crabs; open, close, reset, layout, or the 3D web view',
      argumentHint: '[open|close|reset|layout auto|compact|wide|mini|web [off|noopen]|3d [off]]',
    })
    await migrate($)
    cwd = String((e as { cwd?: string }).cwd ?? '')
    if (cfg.webOnStart) await startWeb($, false).catch(() => undefined)
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    if (u) {
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        costUsd: u.cost?.usd ?? null,
        limits: u.rateLimits.map(limitOf),
      }))
    }
    if (cfg.openOnStart) void openPane($).catch(() => undefined)
    await refreshStatus($, cfg)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await resetAll($)
      await refreshStatus($, cfg)
    }
    return next(e)
  })

  on('command.run', { command: 'crew' }, async ($, e) => {
    const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === '3d') {
      if (arg === 'off') {
        await stop3d($)
        return { text: 'Crew 3D view stopped.' }
      }
      await $.ui.open({ id: PANE, title: TITLE, columns: cfg.view3dColumns, rows: 8 }).catch(() => undefined)
      const cols = Math.max(20, Math.min(240, Number(arg) || cfg.view3dColumns - 2))
      return { text: await start3d($, cols, cfg.view3dRows, cfg.view3dFps, cfg.view3dMode) }
    }
    if (verb === 'web') {
      if (arg === 'off') {
        await update($, web, x => ({ ...normalize(WEB_OFF, x), isOn: false }))
        return { text: 'Crew web view export stopped.' }
      }
      return { text: await startWeb($, arg !== 'noopen') }
    }
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'Crew closed.' }
    }
    if (verb === 'reset') {
      await resetAll($)
      await refreshStatus($, cfg)
      return { text: 'Crew reset.' }
    }
    if (verb === 'layout') {
      const layout: Layout | null = arg === 'compact' || arg === 'wide' || arg === 'auto' || arg === 'mini' ? arg : null
      if (!layout) return { text: 'Usage: /crew layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      const opened = await openPane($)
      return { text: opened.isPlaced ? `Crew layout: ${layout}.` : `Layout set to ${layout}; the pane is not shown yet: ${opened.reason}` }
    }
    const opened = await openPane($)
    if (!opened.isPlaced) return { text: `Crew is not shown yet: ${opened.reason}` }
    return { text: 'Crew opened. Focus it with ctrl+x tab; 1-6 expand cards, f/s/o open the gate rows. /crew web opens the 3D view.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent) || (cfg.matchDescriptions && cfg.architect.test(e.description))) {
      await update($, roster, r => {
        const x = normalize(DEFAULT_ROSTER, r)
        return x.architectTypes.includes(e.agent) ? x : { architectTypes: [...listOf<string>(x.architectTypes), e.agent].slice(-20) }
      })
    }
    return offered
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    const [now, cost] = await Promise.all([$.clock.now(), costNow($)])
    await update($, turn, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
    await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
    await act($, 'main', 'think', '', '')
    if (e.text) await emit($, { kind: 'prompt', from: 'main', text: shorten(promptLine(e.text).text, 60) })
    // A background architect's report reaches the main loop as the text opening this turn. The
    // SubagentHandback tool call (in tool.call) normally carries it first; this is the fallback.
    const back = e.text ? handbackOf(e.text) : null
    const a = back ? await getArchitect($) : null
    if (back && a && a.ids.includes(back.from)) {
      const advice = adviceLine(back.body)
      if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
    } else if (e.text) {
      const p = promptLine(e.text)
      await say($, p.who, p.text)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The main loop's model is known when its request starts; a long first request shouldn't read "—".
    if (!e.agentId) {
      await update($, main, m => {
        const x = normalize(DEFAULT_MAIN, m)
        return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1 }
      })
      // Time the response as it passes: the first piece that is not the engine's envelope, then the
      // stop chunk. Two clock reads in the stream and nothing stored until it has ended.
      const sentAt = await $.clock.now()
      let firstAt: number | null = null
      let stopAt: number | null = null
      const s = next(e)
      for await (const c of s) {
        if (c.kind === 'stop') stopAt = await $.clock.now()
        else if (firstAt === null && c.kind !== 'engine') firstAt = await $.clock.now()
        yield c
      }
      const result = await s.result
      const speed = result.usage && stopAt !== null ? stepSpeed(sentAt, firstAt, stopAt, result.usage.output_tokens) : null
      if (speed) await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), speed }))
      return result
    }
    const result = yield* next(e)
    const id = e.agentId
    const [cards, a] = await Promise.all([getCards($), getArchitect($)])
    if (cards.some(c => c.id === id)) {
      const step = { model: e.model, usage: result.usage, stopReason: result.stopReason }
      await update($, agents, list => listOf<unknown>(list).map(normalizeCard).map(c => (c.id === id ? applyStep(c, step) : c)))
      if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
    } else if (!a.ids.includes(id)) {
      const now = await $.clock.now()
      await update($, loops, l => stepLoop(listOf<Loop>(l), id, now))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, x => ({
      ...normalize(DEFAULT_USAGE, x),
      pct: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
      limits: e.rateLimits.map(limitOf),
    }))
    if (e.changed.includes('context')) await refreshStatus($, cfg)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1, lastCompactAt: now }
      })
      await say($, 'main', `context compacted (${e.trigger})`)
      await emit($, { kind: 'compact', from: 'main', text: `compacted (${e.trigger})` })
    }
    return done
  }).catch(($, e, next) => next(e))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        id: e.tool_use_id,
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
        inSubagent: Boolean(callLoop.get(e.tool_use_id)),
        detail: shorten(describeInput(e.tool, e.input), 90),
        at: await $.clock.now(),
      }
      await update($, gate, g => recordCheck(normalizeGate(g), check))
      if (check.verdict === 'ask') await emit($, { kind: 'check', from: callLoop.get(e.tool_use_id) ?? 'main', tool: e.tool, text: check.detail })
      // The status line updates when the call settles; only a refusal ends here.
      if (verdict.decision === 'deny') {
        await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
        await emit($, { kind: 'deny', from: callLoop.get(e.tool_use_id) ?? 'main', tool: e.tool, text: check.detail })
        await refreshStatus($, cfg)
      }
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    const key = e.agentId ?? 'main'
    const touch = describeCall(String(e.tool), e as unknown as Record<string, unknown>, cwd)
    if (String(e.tool) !== 'SubagentHandback') {
      await act($, key, touch.verb, String(e.tool), touch.target)
      if (touch.file && touch.op) {
        const path = shortPath(touch.file, cwd)
        const op = touch.op
        const now = await $.clock.now()
        await update($, files, list => touchFile(listOf<FileNode>(list), path, key, op, now))
        await emit($, { kind: op === 'r' ? 'read' : 'write', from: key, to: path, tool: String(e.tool), text: path })
      } else if (e.tool !== 'Agent') {
        await emit($, { kind: 'tool', from: key, tool: String(e.tool), text: `${e.tool} ${touch.target}`.trim() })
      }
    }
    if (e.tool === 'Agent' && !(await read($, autoOpened))) {
      // Open on the session's first subagent only; after a close it stays closed (/crew reopens).
      await update($, autoOpened, () => true)
      void openPane($).catch(() => undefined)
    }
    const ran = await next(e).finally(() => callLoop.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    // Settle this call's pending ask, if it had one; skip the write (and the redraw) otherwise.
    const g0 = await getGate($)
    const isSettled = settleCheck(g0, e.tool_use_id, didRun) !== g0
    if (isSettled) await update($, gate, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === 'SubagentHandback') {
      const message = (e as unknown as { message?: unknown }).message
      const a = e.agentId ? await getArchitect($) : null
      if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
        const advice = adviceLine(message)
        if (advice && advice !== a.lastAdvice) await noteAdvice($, cfg, advice)
      }
      return ran
    }
    if (e.tool === 'Agent') {
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    const hasFailed = didRun && ran.isError === true
    if (hasFailed || !didRun) {
      await act($, key, 'failed', String(e.tool), touch.target)
      await emit($, { kind: didRun ? 'fail' : 'deny', from: key, tool: String(e.tool), text: `${e.tool} ${touch.target}`.trim() })
    }
    const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(e.tool)
    const t0 = await getTurn($)
    if (isEdit || hasFailed || (!e.agentId && t0.errorStreak > 0)) {
      await update($, turn, t => afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit }))
    }
    const text = shorten(describeInput(e.tool, e), 64)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? noteTool(c, { tool: e.tool, text, isError: hasFailed || ran.deny !== undefined }) : c)),
      )
    }
    // The log keeps what is worth a glance: refusals, errors and edits; the rest is on the cards.
    if (ran.deny !== undefined) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
    else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
    else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    if (isSettled || !didRun) await refreshStatus($, cfg)
    return ran
  }).catch(($, e, next) => next(e))

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant') {
      const a = await getArchitect($)
      // Consults this row opened: their result may be in the same row, after the stale read above.
      const opened = new Set<string>()
      for (const block of e.message.content as unknown as readonly ServerBlock[]) {
        if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
          if (a.seen.includes(block.id)) continue
          const id = block.id
          await update($, architect, x => {
            const y = normalize(DEFAULT_ARCHITECT, x)
            return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
          })
          opened.add(id)
          await consultStarted($, cfg, id, `${block.name} tool`)
        } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const id = block.tool_use_id
          const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
          if (isOpen) await consultEnded($, cfg, null, id)
        }
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!e.parentAgentId) await noteMode($, e.permissionMode)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    const parent = e.parentAgentId ?? 'main'
    await update($, parents, p => ({ ...p, [id]: parent }))
    await act($, id, 'think', '', '')
    await emit($, { kind: 'spawn', from: parent, to: id, text: shorten(`${e.subagentType}: ${e.description}`, 60) })
    if (await isArchitectType($, cfg, e.subagentType)) {
      await update($, architect, a => {
        const x = normalize(DEFAULT_ARCHITECT, a)
        return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
      })
      await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
      await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent')
      await emit($, { kind: 'consult', from: parent, to: id, text: e.subagentType })
      return started
    }
    const card: AgentCard = {
      ...normalizeCard({}),
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description,
      spawnedAt: await $.clock.now(),
    }
    await update($, agents, list => [...listOf<unknown>(list).map(normalizeCard), card].slice(-24))
    await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
    await say($, shorten(cardTitle(card), 12), `spawned · ${card.type}`, 'info', id)
    await refreshStatus($, cfg)
    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const [t, cards, cost] = await Promise.all([getTurn($), getCards($), costNow($)])
      const r = receiptOf(t, {
        durationMs: e.durationMs,
        agentsSince: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        costNow: cost,
        reason: e.reason,
      })
      await update($, receipt, () => r)
      await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false }))
      await act($, 'main', e.reason === 'answer' ? 'done' : 'failed', '', '')
      await refreshStatus($, cfg)
      await queueWeb($)
      return done
    }
    if ((await getArchitect($)).ids.includes(id)) {
      await consultEnded($, cfg, e.answer, id)
      await emit($, { kind: 'answer', from: id, to: (await getParents($))[id] ?? 'main', text: shorten(e.answer, 60) })
      return done
    }
    const cards = await getCards($)
    if (cards.some(c => c.id === id)) {
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? { ...c, status, endedAt: now, answer: shorten(e.answer, 400) } : c)),
      )
      const card = cards.find(c => c.id === id)
      const took = card ? fmtDuration(now - card.spawnedAt) : ''
      await say($, await whoIs($, id), status === 'done' ? `done · ${took}` : status, status === 'done' ? 'done' : 'error', id)
      await act($, id, status === 'done' ? 'done' : 'failed', '', '')
      await emit($, { kind: status === 'done' ? 'answer' : 'fail', from: id, to: (await getParents($))[id] ?? 'main', text: status === 'done' ? shorten(e.answer, 60) : status })
    } else {
      await update($, loops, l => listOf<Loop>(l).map(x => (x.id === id ? { ...x, isDone: true, lastAt: now } : x)))
    }
    await refreshStatus($, cfg)
    return done
  })

  // The 3D view's input layer posts here; the pointer goes on to the renderer's page.
  on('ui.message', async ($, e, next) => {
    if (e.requestId !== PANE || e.element !== 'input3d') return next(e)
    const data = e.data as { type?: string; inside?: boolean; x?: number; y?: number; events?: unknown[] }
    if (data?.type === 'hover') pointerIn3d = data.inside === true
    else if (data?.type === 'at' && typeof data.x === 'number' && typeof data.y === 'number') pointerAt = { x: data.x, y: data.y }
    else if (data?.type === 'input' && Array.isArray(data.events)) await sendInput($, data.events.slice(0, 200))
    return {}
  }).catch(($, e, next) => next(e))

  // The wheel over the 3D view zooms it instead of scrolling the pane.
  on('ui.scroll', { requestId: PANE }, async ($, e, next) => {
    if (!pointerIn3d || !helper || e.by === 0 || e.origin.kind !== 'person') return next(e)
    await sendInput($, [{ kind: 'wheel', x: pointerAt.x, y: pointerAt.y, dy: Math.max(-10, Math.min(10, e.by)) }])
    return {}
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    const [m, u, a, g, cards, lp, lines, t, r, v, now] = await Promise.all([
      getMain($),
      getUsage($),
      getArchitect($),
      getGate($),
      getCards($),
      getLoops($),
      getLog($),
      getTurn($),
      read($, receipt),
      getView($),
      $.clock.now(),
    ])
    const [ac, fl, pa, v3] = await Promise.all([getActs($), getFiles($), getParents($), getView3d($)])
    const W = Math.max(40, e.props.bodyColumns)
    const layout = v.layout ?? cfg.layout
    const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const modelName = prettyModel(m.model)
    const viewed = e.props.view?.agentId ?? null
    const advising = isAdvising(a)
    const running = cards.filter(c => c.status === 'running')
    const showArchitect = a.consults.length > 0 || a.ids.length > 0
    const motion = cfg.motion && hasClient
    // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
    const isEmpty: Record<Panel, boolean> = {
      main: false,
      architect: !showArchitect,
      gate: g.recent.length === 0 && gateSummary(g).total === 0,
      agents: cards.length === 0,
      loops: lp.length === 0,
      receipt: !m.isRunning && !r,
      crew: false,
      '3d': !v3.isOn && !v3.status,
      log: false,
    }
    const panels = cfg.panels.filter(p => !isEmpty[p])
    const decider = m.mode === 'auto' ? 'classifier' : 'you'

    // A connector between panels: animated while its flow is live, a dim line otherwise.
    const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
      motion ? (
        <els.Client
          key={key}
          module="./rail.tsx"
          width={width}
          height={1}
          props={{ active, width, color, dim: C.faint, marks, isMerge }}
        />
      ) : (
        <Text color={C.faint}>{'─'.repeat(Math.max(1, width))}</Text>
      )

    // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
    const clock = (key: string, since: number, endAt: number | null, color: string) =>
      since <= 0 ? (
        <Text color={color}>—</Text>
      ) : hasClient ? (
        <els.Client key={key} module="./elapsed.tsx" props={{ since, now, endAt, color }} />
      ) : (
        <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
      )

    // ---- main
    const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
    const ctxGauge = u.pct !== null ? gauge(u.pct, 10) : null
    const mainPanel = (w: number) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.main} paddingX={1} width={w}>
        <Box justifyContent="space-between">
          <Text color={C.main} bold>
            {modelName} · main
          </Text>
          <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? '● working' : '○ idle'}</Text>
        </Box>
        <Text wrap="truncate">
          <Text dimColor>effort </Text>
          <Text color={C.main}>{'▮'.repeat(effortN) + '▯'.repeat(4 - effortN)} </Text>
          <Text color={C.main} bold>
            {m.effort || '—'}
          </Text>
          {m.mode ? <Text dimColor>{`   mode ${m.mode}`}</Text> : null}
          <Text dimColor>{`   ${m.steps} req`}</Text>
        </Text>
        {ctxGauge ? (
          <Text wrap="truncate">
            <Text dimColor>ctx </Text>
            <Text color={u.pct !== null && u.pct >= 80 ? C.warn : C.main}>{ctxGauge.on}</Text>
            <Text color={C.faint}>{ctxGauge.off}</Text>
            <Text bold>{` ${Math.round(u.pct ?? 0)}%`}</Text>
            {u.tokens !== null ? <Text dimColor>{` ${kTokens(u.tokens)}/${kTokens(u.window)}`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{`  ⟲${u.compactions}`}</Text> : null}
          </Text>
        ) : null}
        {u.costUsd !== null || u.limits.length > 0 ? (
          <Text wrap="truncate">
            {u.costUsd !== null ? <Text color={C.text}>{`${fmtUsd(u.costUsd)}   `}</Text> : null}
            {u.limits.slice(0, 2).map(l => {
              const lg = gauge(l.pct, 5)
              // The time to each reset where the line has room for it: both windows fit from 56 columns,
              // so a wide pane's half column (59 at 120) has them and a 40-column pane keeps its gauges.
              const resetIn = w >= 56 ? fmtResetIn(l.resetsAt, now) : ''
              return (
                <Text wrap="truncate">
                  <Text dimColor>{`${limitLabel(l.kind)} `}</Text>
                  <Text color={l.pct >= 80 ? C.warn : C.main}>{lg.on}</Text>
                  <Text color={C.faint}>{lg.off}</Text>
                  <Text dimColor>{` ${Math.round(l.pct)}%${resetIn ? ` ↻${resetIn}` : ''}  `}</Text>
                </Text>
              )
            })}
          </Text>
        ) : null}
        {m.speed ? <Text dimColor wrap="truncate">{`last req  ${fmtSpeed(m.speed)}`}</Text> : null}
      </Box>
    )

    // ---- architect
    const lastConsult = a.consults[a.consults.length - 1]
    const architectPanel = (w: number) => {
      const tl = consultTimeline(a, now, Math.max(8, w - 4))
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.arch} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.arch} bold>
              {cfg.architectLabel} · {advising ? 'advising' : 'on call'}
            </Text>
            <Text>
              <Text dimColor>consults </Text>
              <Text color={C.arch} bold>
                {a.consults.length}
              </Text>
            </Text>
          </Box>
          <Text color={C.arch}>{tl}</Text>
          {lastConsult ? (
            <Text dimColor wrap="truncate">
              {advising
                ? `consulting since ${fmtClock(lastConsult.at)}`
                : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
            </Text>
          ) : (
            <Text dimColor>not consulted yet</Text>
          )}
          {cfg.moments ? (
            <Box flexWrap="wrap" columnGap={2}>
              {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
                const isOn = lastConsult?.moment === mo
                return (
                  <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                    {isOn ? '◆' : '◇'} {mo}
                  </Text>
                )
              })}
              <Text color={C.faint}>(inferred)</Text>
            </Box>
          ) : null}
          {a.lastAdvice ? (
            <Text color={C.arch} wrap="truncate">
              » {a.lastAdvice}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- gate
    const s = gateSummary(g)
    const verdictColor = (c: Check) =>
      c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
    const gatePanel = (w: number) => {
      const strip = g.recent.slice(-Math.max(8, w - 4))
      const open = v.gateOpen
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.gate} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.gate} bold>
              {cfg.gateLabel} · permissions
            </Text>
            <Text dimColor>{`${s.total} checks`}</Text>
          </Box>
          <Box>
            {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null}
            {strip.map(c => (
              <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                {c.verdict === 'deny' ? '✗' : '■'}
              </Text>
            ))}
          </Box>
          <Text wrap="truncate">
            <Text color={C.gate}>■</Text>
            <Text dimColor>{` ${s.rule} allowed  `}</Text>
            <Text color={C.cleared}>■</Text>
            <Text dimColor>{` ${s.cleared} ${decider}  `}</Text>
            {s.ask > 0 ? <Text color={C.amber}>{`■ ${s.ask} pending  `}</Text> : null}
            <Text color={s.deny > 0 ? C.warn : C.dim}>{`✗ ${s.deny} denied`}</Text>
            {w >= 80 && g.recent.some(c => c.inSubagent) ? <Text color={C.faint}>{'  dim: in subagents'}</Text> : null}
          </Text>
          <Box columnGap={2}>
            {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
              const tl = g.totals[b]
              const n = tl.rule + tl.ask + tl.cleared + tl.deny
              return (
                <Button
                  key={`gate-${b}`}
                  plain
                  hotkey={b[0]}
                  label={`${b} ${n}${open === b ? ' ▾' : ''}`}
                  dimColor={n === 0}
                  onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
                />
              )
            })}
          </Box>
          {open
            ? g.recent
                .filter(c => c.bucket === open)
                .slice(-5)
                .map(c => (
                  <Text wrap="truncate">
                    <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                    <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
                    <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, w - 18))}</Text>
                  </Text>
                ))
            : null}
        </Box>
      )
    }

    // ---- agents: cards up to the limit, swimlanes beyond it
    const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
    const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
    const expandOnPress = (id: string) => () =>
      update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

    const agentsPanel = (w: number) => {
      // Cards need 20 columns each; when the pane can't hold the limit, lanes take over.
      const fit = Math.max(1, Math.min(cfg.maxCards, Math.floor((w + 1) / 21)))
      const useLanes = cards.length > fit
      const header = (
        <Box justifyContent="space-between" width={w}>
          <Text bold>{`agents · ${running.length} running · ${cards.length} total`}</Text>
          {cards.length > 0 ? <Text color={C.faint}>1-{Math.min(cards.length, useLanes ? 6 : fit)} expand</Text> : null}
        </Box>
      )
      if (cards.length === 0) {
        return (
          <Box flexDirection="column" width={w}>
            {header}
            <Text color={C.faint}>no subagents yet</Text>
          </Box>
        )
      }
      if (useLanes) {
        const shown = cards.slice(-6)
        const barW = Math.max(8, w - 28)
        const geo = lanes(shown, now, barW)
        return (
          <Box flexDirection="column" width={w}>
            {header}
            {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
            {shown.map((c, i) => {
              const gm = geo[i]
              const isViewed = viewed === c.id
              return (
                <Box>
                  <Text color={statusColor(c)} bold={isViewed}>{`${isViewed ? '▶' : glyph(c)} `}</Text>
                  <Box width={17}>
                    <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), 14)} onPress={expandOnPress(c.id)} />
                  </Box>
                  <Text color={C.faint}>{' ' + '·'.repeat(gm?.before ?? 0)}</Text>
                  <Text color={statusColor(c)}>{'━'.repeat(gm?.bar ?? 1)}</Text>
                  <Text color={C.faint}>{'·'.repeat(gm?.after ?? 0) + ' '}</Text>
                  {clock(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
                </Box>
              )
            })}
          </Box>
        )
      }
      const shown = cards.slice(-fit)
      const cardW = Math.max(20, Math.floor((w - (shown.length - 1)) / shown.length))
      const centers = shown.map((_, i) => i * (cardW + 1) + Math.floor(cardW / 2))
      return (
        <Box flexDirection="column" width={w}>
          {header}
          {rail('fan-out', running.length > 0, C.agent, w, centers)}
          <Box columnGap={1}>
            {shown.map((c, i) => {
              const isViewed = viewed === c.id
              const sameModel = !c.model || prettyModel(c.model) === modelName
              return (
                <Box
                  flexDirection="column"
                  borderStyle={isViewed ? 'double' : 'round'}
                  borderColor={c.lastStop === 'max_tokens' ? C.warn : C.agent}
                  borderDimColor={c.status !== 'running' && !isViewed}
                  width={cardW}
                  paddingX={1}
                >
                  <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={titleLines(cardTitle(c), cardW - 7, cardW - 4)[0]} onPress={expandOnPress(c.id)} />
                  <Text bold wrap="truncate">
                    {titleLines(cardTitle(c), cardW - 7, cardW - 4)[1]}
                  </Text>
                  <Text color={C.dim} wrap="truncate">
                    {sameModel ? c.type : `${c.type} · ${prettyModel(c.model)}`}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {c.steps > 0 ? `ctx ${kTokens(c.ctx)} · out ${kTokens(c.out)} · ${c.steps} st` : 'starting…'}
                  </Text>
                  <Box>
                    <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)}>
                      {cardW >= 26 ? `${glyph(c)} ${c.lastStop === 'max_tokens' ? 'max_tokens' : c.status} ` : `${glyph(c)} `}
                    </Text>
                    <Box flexShrink={0}>{clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
          {rail('merge', running.length > 0, C.agent, w, centers, true)}
        </Box>
      )
    }

    const expandedCard = cards.find(c => c.id === v.expanded)
    const expandedPanel = (w: number) =>
      expandedCard ? (
        <Box flexDirection="column" borderStyle="single" borderColor={C.agent} paddingX={1} width={w}>
          <Text bold wrap="wrap">
            {expandedCard.description || expandedCard.type}
          </Text>
          <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
          {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
          {expandedCard.tools.map(n => (
            <Text color={n.isError ? C.warn : C.text} wrap="truncate">
              {`${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          ))}
          {expandedCard.answer ? (
            <Text dimColor wrap="wrap">
              {`» ${shorten(expandedCard.answer, 240)}`}
            </Text>
          ) : null}
        </Box>
      ) : null

    // ---- other loops (workflow agents, forks): ids that match no card
    const loopsPanel = (w: number) => {
      if (lp.length === 0) return null
      const active = lp.filter(l => isLoopActive(l, now)).length
      const dots = lp.slice(-Math.max(4, w - 38))
      return (
        <Box width={w}>
          <Text bold>other loops </Text>
          <Text dimColor>{`${lp.length} seen · ${active} active  `}</Text>
          {dots.map(l => (
            <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
          ))}
        </Box>
      )
    }

    // ---- receipt: the turn now, or the last one
    const receiptPanel = (w: number) => {
      const isReview = t.isReviewing
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.main} borderDimColor={!m.isRunning && !isReview} paddingX={1} width={w}>
          {m.isRunning ? (
            <Box>
              <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn `}</Text>
              <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
              {w >= 60 ? <Text dimColor wrap="truncate">{` · ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
            </Box>
          ) : r ? (
            <Text wrap="truncate">
              <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
              <Text>{`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}</Text>
              {r.costDelta !== null ? <Text color={C.main}>{` · +${fmtUsd(r.costDelta)}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.faint}>no turn finished yet</Text>
          )}
          {isReview ? <Text color={C.arch}>{`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}</Text> : null}
        </Box>
      )
    }

    // ---- crew: Clawd crabs per loop, the agent tree, and the plan/doc graph
    const crab = (key: string, verb: Verb, size: 'big' | 'mini', color: string) =>
      hasClient ? (
        <els.Client key={`clawd-${size}-${key}`} module="./clawd-anim.tsx" props={{ verb, size, color, propColor: C.text }} />
      ) : size === 'mini' ? (
        <Text>
          <Text color={color}>{miniFrame(verb, 0)}</Text>
          <Text color={C.text}>{propFrame(verb, 0)}</Text>
        </Text>
      ) : (
        <Box flexDirection="column">
          {bigFrame(verb, 0).map((row, i) => (
            <Text>
              <Text color={color}>{row}</Text>
              <Text color={C.text}>{i === 0 ? propFrame(verb, 0) : '  '}</Text>
            </Text>
          ))}
        </Box>
      )
    const loopName = (key: string) => (key === 'main' ? 'main' : (cards.find(c => c.id === key)?.type ?? key.slice(0, 6)))
    const mainVerb: Verb = m.isRunning ? (ac.main?.verb ?? 'think') : ac.main?.verb === 'failed' ? 'failed' : r ? 'done' : 'wait'
    const crewPanel = (w: number) => {
      const plans = fl.filter(n => n.kind !== 'code')
      const code = fl.filter(n => n.kind === 'code')
      const rows: { prefix: string; card: AgentCard }[] = []
      const walk = (parent: string, depth: number) => {
        const kids = cards.filter(c => (pa[c.id] ?? 'main') === parent)
        kids.forEach((k, i) => {
          rows.push({ prefix: `${'  '.repeat(depth)}${i === kids.length - 1 ? '└─' : '├─'}`, card: k })
          walk(k.id, depth + 1)
        })
      }
      walk('main', 0)
      const edgeText = (by: Record<string, string>) =>
        Object.entries(by)
          .map(([k, op]) => `${loopName(k)}:${op}`)
          .join(' ')
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={C.main} paddingX={1} width={w}>
          <Box justifyContent="space-between">
            <Text color={C.main} bold>
              crew
            </Text>
            <Text dimColor>{`${running.length} running · ${fl.length} files`}</Text>
          </Box>
          <Box columnGap={1}>
            {crab('main', mainVerb, 'big', C.main)}
            <Box flexDirection="column">
              <Text color={C.main} bold wrap="truncate">{`${modelName} · ${mainVerb}`}</Text>
              <Text wrap="truncate">{clip(ac.main?.target ?? '', Math.max(8, w - 18))}</Text>
              <Text dimColor wrap="truncate">{`${ac.main?.calls ?? 0} calls · ${m.steps} req`}</Text>
            </Box>
          </Box>
          {rows.slice(-8).map(({ prefix, card }) => {
            const verb = verbOfCard(card, ac[card.id])
            const tint = card.status === 'failed' || card.status === 'stopped' ? C.warn : card.status === 'done' ? C.gate : C.agent
            const what = card.status === 'running' ? `${verb} ${ac[card.id]?.target ?? ''}` : card.status
            return (
              <Box>
                <Text color={C.faint}>{prefix}</Text>
                {crab(card.id, verb, 'mini', tint)}
                <Text wrap="truncate">
                  <Text color={tint} bold>{` ${card.type}`}</Text>
                  <Text dimColor>{` ${clip(card.description, 18)}  `}</Text>
                  <Text>{clip(what, Math.max(6, w - prefix.length - 34))}</Text>
                </Text>
              </Box>
            )
          })}
          {rows.length > 8 ? <Text color={C.faint}>{`+${rows.length - 8} earlier agents`}</Text> : null}
          {plans.length > 0 ? <Text dimColor>plans & docs</Text> : null}
          {plans.slice(0, 6).map(n => (
            <Text wrap="truncate">
              <Text color={n.kind === 'plan' ? C.arch : C.amber}>{n.kind === 'plan' ? ' ■ plan ' : ' □ doc  '}</Text>
              <Text>{clip(n.path, Math.max(10, Math.floor(w / 2)))}</Text>
              <Text color={C.faint}>{' ◄─ '}</Text>
              <Text dimColor>{edgeText(n.by)}</Text>
            </Text>
          ))}
          {code.length > 0 ? (
            <Text dimColor wrap="truncate">
              {` · code ${code.length}: ${code
                .slice(0, 3)
                .map(n => `${n.path.split('/').pop() ?? n.path} ◄─ ${edgeText(n.by)}`)
                .join('  ')}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- 3d: the web view, streamed into a Raster by bin/crew-3d.mjs
    const view3dPanel = (w: number) => {
      const Raster = 'Raster' in els ? els.Raster : null
      if (!v3.isOn || !Raster) {
        return (
          <Box flexDirection="column" width={w}>
            <Text color={C.main} bold>3d view</Text>
            <Text dimColor wrap="truncate">
              {Raster ? v3.status || 'off · /crew 3d' : 'the terminal draws the 3D view; here, /crew web opens it in a browser'}
            </Text>
          </Box>
        )
      }
      // A pane that changed width since the renderer started: restart it at the new size.
      const want = Math.max(20, Math.min(240, w))
      if (want !== v3.cols && !isRestarting3d) {
        isRestarting3d = true
        $.clock.after(400, () => void restart3d($, want, v3.rows, cfg.view3dFps, cfg.view3dMode))
      }
      const Image = 'Image' in els ? els.Image : null
      const picture =
        mode3d === 'image' && Image && lastImage ? (
          <Image
            key={RASTER_KEY}
            source={{ file: lastImage.path, format: 'rgb', width: lastImage.width, height: lastImage.height, generation: lastImage.gen }}
            columns={v3.cols}
            rows={v3.rows}
            alt="crew 3d view"
          />
        ) : (
          <Raster
            key={RASTER_KEY}
            columns={v3.cols}
            rows={v3.rows}
            cells={last3d && last3d.cols === v3.cols && last3d.rows === v3.rows ? last3d.cells : blankCells(v3.cols, v3.rows)}
          />
        )
      return (
        <Box flexDirection="column" width={w}>
          <Box justifyContent="space-between">
            <Text color={C.main} bold>3d view</Text>
            <Text dimColor wrap="truncate">{v3.status || 'drag rotate · wheel zoom · click pinch · stroke pet'}</Text>
          </Box>
          <Box width={v3.cols} height={v3.rows}>
            {picture}
            {hasClient ? (
              <Box position="absolute" top={0} left={0} width={v3.cols} height={v3.rows}>
                <els.Client key="input3d" module="./input3d.tsx" width={v3.cols} height={v3.rows} props={{ cols: v3.cols, rows: v3.rows }} />
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }

    // ---- log: whatever rows the other panels leave, 4 to 8
    // The main box's speed line and the gap above the log are a row each.
    const used = 2 + 5 + (m.speed ? 1 : 0) + 1 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length > cfg.maxCards ? 3 + Math.min(6, cards.length) : 8) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + 3
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const nLog = logRows(bodyRows, used)
    const shownLines = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-nLog)
    const colorOf = (l: LogLine) =>
      l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
    const logPanel = (w: number) => (
      <Box flexDirection="column" borderStyle="round" borderColor={C.faint} paddingX={1} marginTop={1} width={w}>
        <Text dimColor>{viewed ? 'session log · this agent' : 'session log'}</Text>
        {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
        {shownLines.map(l => (
          <Box>
            <Box width={9} flexShrink={0}>
              <Text color={C.faint}>{fmtClock(l.at)}</Text>
            </Box>
            <Box width={13} flexShrink={0}>
              <Text color={colorOf(l)} bold wrap="truncate">
                {l.who}
              </Text>
            </Box>
            <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
              {l.text}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const draw = (p: Panel, w: number) =>
      p === '3d'
        ? view3dPanel(w)
        : p === 'crew'
        ? crewPanel(w)
        : p === 'main'
        ? mainPanel(w)
        : p === 'architect'
          ? architectPanel(w)
          : p === 'gate'
            ? gatePanel(w)
            : p === 'agents'
              ? agentsPanel(w)
              : p === 'loops'
                ? loopsPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : logPanel(w)

    // Panels with the flow between them; the agents panel draws its own rails.
    const column = (ps: Panel[], w: number) => (
      <Box flexDirection="column" width={w}>
        {ps.map((p, i) => {
          const prev = ps[i - 1]
          const link =
            i === 0 || p === 'agents' || prev === 'agents' || p === 'log' || p === 'loops' || prev === 'loops' || p === 'crew' || prev === 'crew' || p === '3d' || prev === '3d'
              ? null
              : rail(`link-${p}`, p === 'architect' ? advising : m.isRunning, p === 'architect' ? C.arch : C.main, w)
          return (
            <Box flexDirection="column">
              {link}
              {draw(p, w)}
              {p === 'agents' ? expandedPanel(w) : null}
            </Box>
          )
        })}
      </Box>
    )

    // Desktop draws the agents' time axis as SVG under the panels.
    const svgLanes =
      e.surface !== 'terminal' && cards.length > 0
        ? (() => {
            const { Svg } = $.ui.resolve(e)
            const rowH = 18
            const pxW = 520
            const geo = lanes(cards.slice(-10), now, 100)
            const rects = cards
              .slice(-10)
              .map((c, i) => {
                const gm = geo[i]
                const x = 150 + ((gm?.before ?? 0) / 100) * (pxW - 160)
                const wpx = Math.max(3, ((gm?.bar ?? 1) / 100) * (pxW - 160))
                const fill = c.status === 'running' ? SVG_COLORS.running : c.status === 'done' ? SVG_COLORS.done : c.status === 'failed' ? SVG_COLORS.failed : SVG_COLORS.other
                const label = shorten(cardTitle(c), 22).replace(/[<&>]/g, '')
                return `<text x="4" y="${i * rowH + 13}" font-size="11" fill="${SVG_COLORS.label}">${label}</text><rect x="${x}" y="${i * rowH + 4}" width="${wpx}" height="10" rx="3" fill="${fill}"/>`
              })
              .join('')
            const svgH = Math.min(10, cards.length) * rowH + 4
            return (
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${svgH}" viewBox="0 0 ${pxW} ${svgH}">${rects}</svg>`}
                alt={`${cards.length} agents on a time axis`}
                width={pxW}
                height={svgH}
              />
            )
          })()
        : null

    // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
    const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
    if (isMini) {
      const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
      const counts = ` ${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
      const strip = g.recent.slice(-Math.max(4, W - cfg.gateLabel.length - 1 - counts.length))
      const mg = u.pct !== null ? gauge(u.pct, 6) : null
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text color={C.main}>{`${miniFrame(mainVerb, 0)}${propFrame(mainVerb, 0)} `}</Text>
            <Text color={C.main} bold>
              {modelName}
            </Text>
            <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? ' ● working' : ' ○ idle'}</Text>
            {mg ? <Text dimColor> · ctx </Text> : null}
            {mg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : C.main}>{mg.on}</Text> : null}
            {mg ? <Text color={C.faint}>{mg.off}</Text> : null}
            {mg ? <Text>{` ${Math.round(u.pct ?? 0)}%`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
            {u.costUsd !== null ? <Text dimColor>{` · ${fmtUsd(u.costUsd)}`}</Text> : null}
            {showArchitect ? <Text color={C.arch}>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`}</Text> : null}
          </Text>
          {strip.length > 0 ? (
            <Box>
              <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
              {strip.map(c => (
                <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                  {c.verdict === 'deny' ? '✗' : '■'}
                </Text>
              ))}
              <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
                {counts}
              </Text>
            </Box>
          ) : null}
          {live.map(c => (
            <Box>
              <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
              <Box width={Math.max(10, W - 30)}>
                <Text wrap="truncate">{cardTitle(c)}</Text>
              </Box>
              <Text dimColor>{c.steps > 0 ? ` ctx ${kTokens(c.ctx)} ` : ' '}</Text>
              {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          ))}
          {cards.length > live.length ? (
            <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /crew layout compact for all`}</Text>
          ) : null}
          {lp.length > 0 ? <Text dimColor>{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
          {!m.isRunning && r ? (
            <Text dimColor wrap="truncate">
              {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    const legend = fitLegend(
      [
        { label: 'main', color: C.main },
        { label: 'agents', color: C.agent },
        { label: cfg.gateLabel.toLowerCase(), color: C.gate },
        ...(showArchitect ? [{ label: cfg.architectLabel.toLowerCase(), color: C.arch }] : []),
      ],
      W,
    )

    const body = isWide ? (
      <Box flexDirection="column">
        {panels.includes('3d') ? view3dPanel(W) : null}
        <Box columnGap={2}>
          {column(panels.filter(p => p === 'main' || p === 'architect' || p === 'gate'), colW)}
          {column(panels.filter(p => p === 'crew' || p === 'agents' || p === 'loops' || p === 'receipt'), colW)}
        </Box>
        {panels.includes('log') ? logPanel(W) : null}
      </Box>
    ) : (
      column(panels, W)
    )

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="center">
          <Text bold wrap="truncate">
            <Text>CREW</Text>
            <Text color={C.dim}> · </Text>
            <Text color={C.main}>{modelName.toUpperCase()}</Text>
            <Text>{m.isRunning ? ' WORKS' : ' IDLE'}</Text>
            {showArchitect ? <Text color={C.dim}> · </Text> : null}
            {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
            {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
          </Text>
        </Box>
        <Box justifyContent="center" columnGap={2}>
          {legend.map(l => (
            <Text>
              <Text color={l.color}>■</Text>
              <Text dimColor>{` ${l.label}`}</Text>
            </Text>
          ))}
        </Box>
        {body}
        {svgLanes}
      </Box>
    )
  })
}
