'use strict'
// crew pet: the crew-graph view on the desktop, in transparent, frameless, always-on-top windows.
//
//   electron main.js --page <index.html> --state <dir> [--session <id>] [--token <token>] [--orca]
//   electron main.js ... --shot <png> [--demo [busy|lineup]] [--chars "main=crab, *=random"] [--at x,y]     one picture, then exit
//   electron main.js ... --shot-settings <png> [--demo]               a picture of the Settings window, then exit
//   electron main.js ... --pet-settings '<json>'                      (with --shot*) the pet settings to start from
//   electron main.js ... --selftest                                   exercises the resize path, prints bounds
//
// One process, one window per Claude session: a second start with another --session opens another window,
// with the same --session it only wakes that one. The page is the same three.js viewer as `/crew web`, in
// `?overlay&session=<id>` mode (web/app.js), reading sessions/<id>.js beside it. This process owns the
// windows: moving and resizing them, click-through, the tray, saved bounds, and the few things the page asks
// for over overlay/preload.js. It reads a session's file only to know which files its snapshot lists; it never
// opens or reads a path that is not listed there.
//   <state>/overlay-state.json   { alwaysOnTop, ticker, sessions: { <id>: bounds } }
//   <state>/pet-settings.json     the pet's settings (web/pet-settings-core.js): characters, what is shown, motion, window. This
//                                 process reads, validates and writes it (never ~/.claude/settings.json) and tells every window.
//   <state>/quit                  quit everything (launch.mjs --quit)
//   <state>/close-<id>            close that session's window (launch.mjs --close <id>)
//   <state>/pet-inbox-<id>.json   requests for that session's mod: "show this in the Crew pane", and (with the session id and the token the
//                                 mod gave this window) ask Claude, dismiss agents, ask Claude to stop one. One message at a time, at
//                                 least INBOX_GAP_MS apart, so the mod's poll sees each.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, ipcMain, shell, clipboard } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { pathToFileURL } = require('node:url')
const petCore = require('../web/pet-settings-core.js')

const parseArgs = argv => {
  const arg = (name, fallback = '') => {
    const i = argv.indexOf(`--${name}`)
    const v = i >= 0 ? argv[i + 1] : undefined
    return v !== undefined && !v.startsWith('--') ? v : fallback
  }
  return { arg, has: name => argv.includes(`--${name}`) }
}
const mine = parseArgs(process.argv)
const { arg, has } = mine

const shotOut = arg('shot')
const shotSettings = arg('shot-settings')
const selftest = has('selftest')
const isDemo = has('demo')
const demoMode = isDemo ? arg('demo') || '1' : ''
const stateDir = arg('state') || path.join(os.homedir(), '.claude', 'crew-graph', 'overlay')
const pageFile = arg('page') || path.join(stateDir, '..', 'index.html')
const stateFile = path.join(stateDir, 'overlay-state.json')
const settingsFile = path.join(stateDir, 'pet-settings.json')
const settingsPage = path.join(path.dirname(pageFile), 'settings.html')
const quitFile = path.join(stateDir, 'quit')
const isScratch = !!shotOut || !!shotSettings || selftest // no single-instance lock, no saved state
// Debug aid: CREW_PET_LOG=<file> logs what the page asks for.
const dbg = process.env.CREW_PET_LOG
  ? msg => {
      try {
        fs.appendFileSync(process.env.CREW_PET_LOG, `${new Date().toISOString()} [${process.pid}] ${msg}\n`)
      } catch {
        /* a log that cannot be written is not worth stopping for */
      }
    }
  : () => {}

const DEF_W = 360
const DEF_H = 300
const MIN_W = 160
const MIN_H = 140
const MIN_VISIBLE = 80
const CASCADE = 40
const MAX_SAVED = 50
const COLLAPSED_H = 34 // a window folded down to its title bar
const COLLAPSED_W = 340

// A 32x32 orange crab for the tray, generated once and embedded.
const TRAY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAjklEQVR4nGNgGAVQMM1G8j8yprv5A+YAmMCLAisUTC2HEDR/1AED7gB0hYQSI7niJOcCujuAkAZcQYkraEm2eNA4AN0hMIOlRQTAmJAD0NWRnZgHzAHEBjWpmOQ0MOqAAXMAtR1CtVxAd5+j88nFuMwdfA4gpIFYH5BtzoA5AJfBtHIAhviAO2AUjIIRDwCs1p5mhWMXTAAAAABJRU5ErkJggg=='

app.setName('crew-pet')
// Its own profile and lock: not shared with any other unpackaged Electron app on this machine.
app.setPath('userData', isScratch ? path.join(os.tmpdir(), 'crew-pet-scratch') : path.join(stateDir, 'userdata'))

/** A session id becomes part of file names: ids of the usual kind only. */
const okId = id => typeof id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(id)
/** The token the mod made for a window (letters and digits). Kept per window and written into every message for the mod; the page never sees it. */
const okToken = t => typeof t === 'string' && /^[A-Za-z0-9]{16,64}$/.test(t)
const ASK_MAX = 4000
const INBOX_GAP_MS = 1300

/** id -> window record: { id, win, token, ignoring, asking, gesture, orca, snap, cursor, cursorTimer, actions, inboxQ, inboxAt, inboxTimer } */
const wins = new Map()
const byContents = new Map()
let tray = null
let onTop = true
let ticker = true
let settings = petCore.sanitize(null) // the pet settings; onTop and ticker below follow them
let settingsWin = null // the one Settings window, shared by every session
let saved = {} // id -> bounds, as last saved (windows closed since stay here)
let legacy = null // bounds of the one window older versions saved
let lastBounds = null // where the newest window went: the next one cascades from it
let actionsMod = null // actions.mjs, loaded in start()
let summaryMod = null // summary.mjs
let menusMod = null // menus.mjs

// ---------------------------------------------------------------- saved state

function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function saveState() {
  if (isScratch) return
  for (const w of wins.values()) {
    if (!alive(w)) continue
    const b = w.win.getBounds()
    // Folded to the title bar, the record keeps the full size to open it up to again.
    saved[w.id] = w.collapsed ? { x: b.x, y: b.y, width: w.full.width, height: w.full.height, collapsed: true } : b
  }
  const ids = Object.keys(saved)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SAVED))) delete saved[id]
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(stateFile, JSON.stringify({ alwaysOnTop: onTop, ticker, sessions: saved }))
  } catch {
    /* the next move tries again */
  }
}

const isNum = v => typeof v === 'number' && Number.isFinite(v)
const validBounds = b => !!b && [b.x, b.y, b.width, b.height].every(isNum)

/** At least 80x80 of the window must lie on some display, or it could not be grabbed again. */
function isOnScreen(b) {
  return screen.getAllDisplays().some(d => {
    const r = d.bounds
    const w = Math.min(b.x + b.width, r.x + r.width) - Math.max(b.x, r.x)
    const h = Math.min(b.y + b.height, r.y + r.height) - Math.max(b.y, r.y)
    return w >= Math.min(MIN_VISIBLE, b.width) && h >= Math.min(MIN_VISIBLE, b.height)
  })
}

function defaultBounds() {
  const wa = screen.getPrimaryDisplay().workArea
  return { x: wa.x + wa.width - DEF_W - 16, y: wa.y + wa.height - DEF_H - 16, width: DEF_W, height: DEF_H }
}

const sane = b => ({ x: Math.round(b.x), y: Math.round(b.y), width: Math.max(MIN_W, Math.round(b.width)), height: Math.max(MIN_H, Math.round(b.height)) })

/** Where a session's window opens: where it was, else 40 px down and right of the newest one, else the corner. */
function boundsFor(id) {
  const own = validBounds(saved[id]) ? sane(saved[id]) : id === '' && validBounds(legacy) ? sane(legacy) : null
  if (own && isOnScreen(own)) return own
  if (lastBounds) {
    const c = { ...sane(lastBounds), x: Math.round(lastBounds.x + CASCADE), y: Math.round(lastBounds.y + CASCADE) }
    if (isOnScreen(c)) return c
  }
  return defaultBounds()
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** The most a window may grow to: 90% of the work area of the display it is on. */
function maxSize(w) {
  const wa = screen.getDisplayMatching(w.win.getBounds()).workAreaSize
  return { width: Math.max(MIN_W, Math.floor(wa.width * 0.9)), height: Math.max(MIN_H, Math.floor(wa.height * 0.9)) }
}

// ---------------------------------------------------------------- a session's snapshot, for the paths its page may ask about

const dataFileOf = id => (id ? path.join(path.dirname(pageFile), 'sessions', `${id}.js`) : path.join(path.dirname(pageFile), 'data.js'))
const inboxFileOf = id => path.join(stateDir, id ? `pet-inbox-${id}.json` : 'pet-inbox.json')

function snapshot(w) {
  try {
    const file = dataFileOf(w.id)
    const st = fs.statSync(file)
    if (st.mtimeMs !== w.snap.mtime) {
      const snap = actionsMod.parseDataJs(fs.readFileSync(file, 'utf8'))
      w.snap = { mtime: st.mtimeMs, snap, files: actionsMod.allowedFiles(snap) }
    }
  } catch {
    w.snap = { mtime: -1, snap: null, files: new Map() }
  }
  return w.snap
}

const demoRoot = () => path.resolve(__dirname, '..', '..', '..')

// --demo: a few of the demo files point into this repository, so the card and the click can be tried.
function demoFiles() {
  const out = new Map()
  for (const rel of ['docs/DATA_CONTRACT.md', 'plugins/crew-graph/hooks/crew.ts', 'README.md']) {
    const abs = path.join(demoRoot(), rel)
    out.set(actionsMod.norm(abs), abs)
  }
  return out
}

const isFile = p => {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- windows

const alive = w => !!w && !w.win.isDestroyed()

function setIgnore(w, v) {
  w.ignoring = v
  if (!alive(w)) return
  // Never click-through while a drag or a resize runs.
  const effective = v && !w.gesture
  w.win.setIgnoreMouseEvents(effective, effective ? { forward: true } : undefined)
  dbg(`ignore ${effective}${w.gesture ? ' (gesture)' : ''}`)
}

const sendTo = (w, ev) => {
  if (alive(w)) w.win.webContents.send('pet:event', ev)
}

function showWin(w) {
  if (!alive(w)) return
  w.win.showInactive()
  if (!isOnScreen(w.win.getBounds())) w.win.setBounds(boundsFor(w.id))
  raise(w)
}

// Measured on Windows 11 with the Photos app as the viewer of a png: a few seconds after shell.openPath the viewer's window
// is above the pet's in the z-order although the pet is flagged topmost (isAlwaysOnTop() stays true). showInactive() and a
// repeated setAlwaysOnTop(true, 'floating') leave it there; moveTop() puts the pet back and takes no focus. Why the OS
// ranks the viewer above a topmost window is not known.
const RAISE_EVERY_MS = 400
const RAISE_FOR_MS = 15000

/** Put the window back on top of the others, without activating it. */
function raise(w) {
  if (!alive(w) || !w.win.isVisible()) return
  try {
    w.win.moveTop()
  } catch {
    /* a window that is going away */
  }
}

/** A viewer takes a second or two to come up: keep the pet on top for a while after something was handed to the OS. */
function raiseFor(w, ms = RAISE_FOR_MS) {
  if (!alive(w)) return
  clearInterval(w.raiseTimer)
  const until = Date.now() + ms
  if (onTop) raise(w)
  w.raiseTimer = setInterval(() => {
    if (!alive(w) || Date.now() > until) return clearInterval(w.raiseTimer)
    if (onTop) raise(w)
  }, RAISE_EVERY_MS)
}

/**
 * Hand something to the OS (open a file, show it in the folder): the press that started it may never get its release
 * once another app is in front, so any gesture is ended and the page forgets its pointer state; and the pet stays on top.
 */
function runAction(w, run) {
  stopGesture(w)
  sendTo(w, { type: 'reset-input' })
  if (onTop) raiseFor(w)
  return run().then(r => {
    dbg(`action ${r}`)
    sendTo(w, { type: 'reset-input' })
    return r
  })
}

const setOnTop = v => void applyPatch({ alwaysOnTop: !!v })
const setTicker = v => void applyPatch({ show: { ticker: !!v } })

// ---------------------------------------------------------------- pet settings

/** Everything that listens: every pet window, and the Settings window. */
function broadcastSettings() {
  for (const w of wins.values()) if (alive(w)) w.win.webContents.send('pet:settings', settings)
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('pet:settings', settings)
}

/** Grow or shrink every window to a size preset, around its centre. */
function applySize(preset) {
  const sz = petCore.SIZES[preset]
  if (!sz) return
  for (const w of wins.values()) {
    if (!alive(w)) continue
    if (w.collapsed) {
      w.full = { ...w.full, width: sz.width, height: sz.height }
      continue
    }
    const b = w.win.getBounds()
    const nb = { x: Math.round(b.x + (b.width - sz.width) / 2), y: Math.round(b.y + (b.height - sz.height) / 2), width: sz.width, height: sz.height }
    w.win.setBounds(isOnScreen(nb) ? nb : { ...nb, x: b.x, y: b.y })
  }
}

/** Takes new settings (checked again here), makes the windows match, writes the file, tells everyone. Returns what is now in force. */
function changeSettings(next, size) {
  const prev = settings
  settings = petCore.sanitize(next)
  onTop = settings.alwaysOnTop
  ticker = settings.show.ticker
  if (!isScratch) {
    try {
      petCore.save(fs, settingsFile, settings)
    } catch (e) {
      dbg(`settings not saved ${e && e.message}`)
    }
  }
  if (prev.alwaysOnTop !== settings.alwaysOnTop) for (const w of wins.values()) if (alive(w)) w.win.setAlwaysOnTop(onTop, onTop ? 'floating' : 'normal')
  if (prev.opacity !== settings.opacity) for (const w of wins.values()) if (alive(w)) w.win.setOpacity(settings.opacity / 100)
  if (size) applySize(size)
  saveState()
  broadcastSettings()
  refreshTray()
  dbg(`settings ${JSON.stringify(settings)}`)
  return settings
}

/** A change from a page or a menu: merged into the settings, every key checked. A size preset in it also resizes the windows. */
function applyPatch(patch) {
  const size = patch && typeof patch === 'object' && typeof patch.size === 'string' && petCore.SIZES[patch.size] ? patch.size : ''
  return changeSettings(petCore.merge(settings, patch), size)
}

/** The one Settings window: a second request only brings it forward. */
async function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show()
    settingsWin.focus()
    return settingsWin
  }
  const wa = screen.getPrimaryDisplay().workArea
  const width = 580
  const height = Math.min(720, wa.height - 40)
  const win = new BrowserWindow({
    width,
    height,
    x: wa.x + Math.round((wa.width - width) / 2),
    y: wa.y + Math.round((wa.height - height) / 2),
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    show: false,
    title: 'Crew pet settings',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  settingsWin = win
  win.removeMenu()
  win.on('closed', () => {
    if (settingsWin === win) settingsWin = null
  })
  if (process.env.CREW_PET_LOG) win.webContents.on('console-message', (e, ...rest) => dbg(`settings page ${e && e.message !== undefined ? e.message : rest[1]}`))
  await win.loadFile(settingsPage, { query: { preview: '1' } })
  win.show()
  win.focus()
  dbg('settings window open')
  return win
}

const clipText = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
/** What the Settings window may list: every window's session and the agents its page says it shows (id, type, task). */
function settingsContext() {
  return {
    windows: [...wins.values()]
      .filter(alive)
      .map(w => ({ session: w.id, name: nameOf(w), agents: w.seen || [] })),
  }
}

/** Fold the window down to its title bar (the pill), or open it up to the size it had. */
function setCollapsed(w, v) {
  if (!alive(w) || !!w.collapsed === !!v) return
  const b = w.win.getBounds()
  stopGesture(w)
  if (v) {
    w.full = b
    w.collapsed = true
    w.win.setBounds({ x: b.x, y: b.y, width: Math.min(b.width, COLLAPSED_W), height: COLLAPSED_H })
  } else {
    const f = w.full || { width: DEF_W, height: DEF_H }
    w.collapsed = false
    const open = { x: b.x, y: b.y, width: f.width, height: f.height }
    w.win.setBounds(isOnScreen(open) ? open : boundsFor(w.id))
  }
  dbg(`collapse ${v}: ${JSON.stringify(w.win.getBounds())}`)
  sendTo(w, { type: 'collapse', on: !!v })
  saveState()
  refreshTray()
}

function resetBounds(w) {
  if (!alive(w)) return
  w.collapsed = false
  sendTo(w, { type: 'collapse', on: false })
  w.win.setBounds(defaultBounds())
  sendTo(w, { type: 'reset' })
  saveState()
}

function closeWindow(id) {
  const w = wins.get(id)
  if (!w) return
  saveState()
  wins.delete(id)
  stopGesture(w, true)
  clearInterval(w.cursorTimer)
  clearInterval(w.raiseTimer)
  clearTimeout(w.inboxTimer)
  if (alive(w)) {
    byContents.delete(w.win.webContents.id)
    w.win.destroy()
  }
  dbg(`closed window ${id || '(none)'}`)
  if (wins.size === 0) app.exit(0)
  else refreshTray()
}

function quit() {
  saveState()
  app.exit(0)
}

/** What a session's window is called in menus: "<cwd> · <title>", from its own snapshot. */
function nameOf(w) {
  const s = snapshot(w).snap && snapshot(w).snap.session
  const name = [s && s.cwd, s && s.title].filter(Boolean).join(' · ')
  return name || (w.id ? w.id.slice(0, 8) : 'crew')
}

const canAsk = w => !!(w && w.id && w.token)
const agentsOf = w => {
  const snap = snapshot(w).snap
  return snap && Array.isArray(snap.agents) ? snap.agents : []
}

function windowItems(w, askHere) {
  return menusMod.windowItems(
    { collapsed: !!(w && w.collapsed), onTop, ticker, hasId: !!(w && w.id), canAsk: canAsk(w), askHere: !!askHere, finished: canAsk(w) ? menusMod.finishedIds(agentsOf(w)).length : 0 },
    {
      ask: () => askOpen(w, ''),
      dismissAll: () => dismissAgents(w, menusMod.finishedIds(agentsOf(w))),
      show: () => showWin(w),
      settings: () => void openSettings(),
      collapse: () => setCollapsed(w, !(w && w.collapsed)),
      onTop: setOnTop,
      ticker: setTicker,
      reset: () => resetBounds(w),
      close: () => closeWindow(w.id),
      quit,
    },
  )
}

function trayItems() {
  const byId = id => [...wins.values()].find(w => w.id === id)
  return menusMod.trayItems(
    { sessions: [...wins.values()].map(w => ({ id: w.id, name: nameOf(w), collapsed: !!w.collapsed, canAsk: canAsk(w) })), onTop, ticker },
    {
      showOne: id => showWin(byId(id)),
      askOne: id => askOpen(byId(id), ''),
      collapseOne: id => {
        const w = byId(id)
        setCollapsed(w, !(w && w.collapsed))
      },
      closeOne: id => closeWindow(id),
      showAll: () => wins.forEach(showWin),
      settings: () => void openSettings(),
      onTop: setOnTop,
      ticker: setTicker,
      reset: () => wins.forEach(resetBounds),
      quit,
    },
  )
}

function refreshTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayItems()))
}

async function createWindow(id, orca, token) {
  const bounds = boundsFor(id)
  const startCollapsed = !!(saved[id] && saved[id].collapsed)
  const shown = startCollapsed ? { x: bounds.x, y: bounds.y, width: Math.min(bounds.width, COLLAPSED_W), height: COLLAPSED_H } : bounds
  const win = new BrowserWindow({
    ...shown,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  })
  const w = { id, win, token: okToken(token) ? token : '', ignoring: true, asking: false, gesture: null, collapsed: false, full: bounds, orca, snap: { mtime: -1, snap: null, files: new Map() }, cursor: '', cursorTimer: null, actions: null, inboxQ: [], inboxAt: 0, inboxTimer: null }
  w.actions = actionsMod.makeActions({
    shell,
    execFile,
    files: () => {
      const m = new Map(snapshot(w).files)
      if (isDemo) for (const [k, v] of demoFiles()) m.set(k, v)
      return m
    },
    platform: process.platform,
    orca,
    isFile,
  })
  w.collapsed = startCollapsed
  wins.set(id, w)
  byContents.set(win.webContents.id, w)
  lastBounds = bounds
  // Across displays with different scaling the constructor can land a few pixels off: say it again.
  win.setBounds(shown)
  win.setAlwaysOnTop(onTop, onTop ? 'floating' : 'normal')
  win.setOpacity(settings.opacity / 100)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.removeMenu()
  // With CREW_PET_LOG set, what the page writes to its console lands in the log too.
  if (process.env.CREW_PET_LOG) win.webContents.on('console-message', (e, ...rest) => dbg(`page ${e && e.message !== undefined ? e.message : rest[1]}`))

  const query = { overlay: '1' }
  if (id) query.session = id
  if (!ticker) query.ticker = '0'
  if (startCollapsed) query.collapsed = '1'
  if (isDemo) Object.assign(query, { demo: demoMode, skip: '14', demoRoot: demoRoot().replace(/\\/g, '/') })
  // Development flags: --chars "main=crab, *=random" picks the demo's characters; --hooks lets a driver script reach into the page (?hooks).
  if (arg('chars')) query.chars = arg('chars')
  if (has('hooks')) query.hooks = '1'
  await win.loadFile(pageFile, { query })
  win.showInactive()
  win.on('moved', saveState)
  win.on('resized', saveState)
  win.on('show', () => sendTo(w, { type: 'reset-input' }))
  win.on('restore', () => {
    sendTo(w, { type: 'reset-input' })
    raise(w)
  })
  // The page asks for forwarded mouse moves while it lets clicks through. This is a second source for the
  // cursor, a few times a second and only while click-through is on, in case those do not arrive.
  if (!isScratch) {
    w.cursorTimer = setInterval(() => {
      if (!alive(w) || w.gesture || !w.win.isVisible()) return
      const c = screen.getCursorScreenPoint()
      const b = w.win.getBounds()
      const x = c.x - b.x
      const y = c.y - b.y
      const inside = x >= 0 && y >= 0 && x < b.width && y < b.height
      const key = inside ? `${x},${y}` : 'out'
      if (key === w.cursor) return
      w.cursor = key
      // While the window takes clicks the page sees its own moves; only the cursor leaving needs telling (a window that was
      // covered gets no leave event of its own, and would keep taking clicks over its whole rectangle).
      if (!w.ignoring && inside) return
      sendTo(w, { type: 'cursor', x: inside ? x : -1, y: inside ? y : -1 })
    }, 125)
  }
  dbg(`started window ${id || '(none)'} bounds ${JSON.stringify(win.getBounds())}`)
  refreshTray()
  return w
}

/** A start with a session: its window opens, or, if it is already there, it only hops. */
async function openSession(id, orca, token) {
  const w = wins.get(id)
  if (alive(w)) {
    w.orca = w.orca || orca
    // The mod made a new token (it was started again, or reloaded): the window repeats that one from now on.
    if (okToken(token) && w.token !== token) {
      w.token = token
      refreshTray()
    }
    showWin(w)
    sendTo(w, { type: 'hop' })
    return w
  }
  return createWindow(id, orca, token)
}

// ---------------------------------------------------------------- the mod's inbox

let inboxSeq = 0
/**
 * A message for the session's mod. The inbox is one file the mod looks at about once a second, so messages go out one at a time,
 * INBOX_GAP_MS apart (a question followed at once by a dismissal would otherwise lose the question). Every message carries the
 * session id and this window's token; the mod ignores one without both.
 */
function writeInbox(w, msg) {
  w.inboxQ.push(msg)
  pumpInbox(w)
}

function pumpInbox(w) {
  if (w.inboxTimer || w.inboxQ.length === 0) return
  const wait = Math.max(0, w.inboxAt + INBOX_GAP_MS - Date.now())
  w.inboxTimer = setTimeout(() => {
    w.inboxTimer = null
    const msg = w.inboxQ.shift()
    if (msg) putInbox(w, msg)
    pumpInbox(w)
  }, wait)
}

function putInbox(w, msg) {
  inboxSeq = Math.max(Date.now(), inboxSeq + 1)
  w.inboxAt = Date.now()
  const body = JSON.stringify({ seq: inboxSeq, at: Date.now(), ...msg, sessionId: w.id, token: w.token })
  try {
    fs.mkdirSync(stateDir, { recursive: true })
    const file = inboxFileOf(w.id)
    fs.writeFileSync(`${file}.tmp`, body)
    fs.renameSync(`${file}.tmp`, file)
    dbg(`inbox ${msg.kind}`)
  } catch (e) {
    dbg(`inbox failed ${e && e.message}`)
  }
}

// ---------------------------------------------------------------- asking Claude, dismissing agents

/**
 * The window takes keyboard focus only while its ask card is open: focusable is switched on and the window focused, and off again
 * (with click-through put back the way the page last wanted it) when the card closes.
 */
function setAsking(w, on) {
  if (!alive(w)) return
  on = !!on
  if (!!w.asking === on) return
  w.asking = on
  w.win.setFocusable(on)
  if (on) {
    w.win.focus()
    // A window that was never activated may need to be shown first.
    if (!w.win.isFocused()) {
      w.win.show()
      w.win.focus()
    }
  } else setIgnore(w, w.ignoring)
  dbg(`asking ${on} focusable=${w.win.isFocusable()} focused=${w.win.isFocused()}`)
}

/** Open the ask card in the window (about one agent, or none): a collapsed window opens up first. */
function askOpen(w, agentId) {
  if (!canAsk(w)) return
  const wasCollapsed = !!w.collapsed
  if (wasCollapsed) setCollapsed(w, false)
  showWin(w)
  setTimeout(() => sendTo(w, { type: 'ask', id: String(agentId || '').slice(0, 200) }), wasCollapsed ? 150 : 0)
}

/** Dismiss finished agents: only ids the window's own snapshot lists as finished are sent; the page plays the goodbye. */
function dismissAgents(w, ids) {
  if (!canAsk(w)) return
  const ok = new Set(menusMod.finishedIds(agentsOf(w)))
  const list = [...new Set(ids)].filter(id => typeof id === 'string' && ok.has(id)).slice(0, 100)
  if (list.length === 0) return
  writeInbox(w, { kind: 'dismiss', ids: list })
  sendTo(w, { type: 'dismiss', ids: list })
}

/** Ask Claude (through the mod) to stop a running agent; the mod cannot stop one itself. */
function stopAgent(w, id) {
  if (!canAsk(w)) return
  const agent = agentsOf(w).find(a => a && a.id === id)
  if (menusMod.agentAction(agent) !== 'stop') return
  writeInbox(w, { kind: 'stop', id: String(id).slice(0, 200) })
  sendTo(w, { type: 'sent' })
}

const summaryCache = new Map()
function summaryOf(file) {
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return { error: 'missing' }
  }
  const key = `${file}|${st.mtimeMs}`
  let s = summaryCache.get(key)
  if (!s) {
    if (summaryCache.size > 300) summaryCache.clear()
    s = summaryMod.summarizeFile(file, fs)
    summaryCache.set(key, s)
  }
  return s
}

function focusFile(w, abs) {
  const file = w.actions.resolve(abs)
  if (!file) return dbg(`focus refused ${String(abs).slice(0, 80)}`)
  const want = actionsMod.norm(file)
  const entry = ((snapshot(w).snap && snapshot(w).snap.files) || []).find(f => f && actionsMod.norm(f.abs) === want)
  writeInbox(w, { kind: 'focus-file', abs: file, path: entry ? entry.path : path.basename(file), summary: summaryOf(file) })
}

// ---------------------------------------------------------------- menus

function menuFor(w, ctx) {
  const items = []
  if (ctx.kind === 'file') {
    items.push(
      { label: 'Open', click: () => void runAction(w, () => w.actions.open(ctx.abs)) },
      { label: 'Show in folder', click: () => void runAction(w, () => w.actions.reveal(ctx.abs)) },
      { label: 'Show in Crew pane', click: () => focusFile(w, ctx.abs) },
      {
        label: 'Copy path',
        click: () => {
          const f = w.actions.resolve(ctx.abs)
          if (f) clipboard.writeText(f)
        },
      },
      { type: 'separator' },
    )
  } else if (ctx.kind === 'crab' && ctx.id) {
    // Dismiss or stop is offered by what the window's own snapshot says the agent is doing, not by what the page says.
    const agent = agentsOf(w).find(a => a && a.id === ctx.id)
    items.push(
      ...menusMod.crabItems({
        ctx,
        settings,
        session: w.id,
        act: {
          set: patch => void applyPatch(patch),
          focus: () => writeInbox(w, { kind: 'focus-agent', id: String(ctx.id).slice(0, 200) }),
          ask: () => askOpen(w, ctx.id),
          dismiss: () => dismissAgents(w, [ctx.id]),
          stop: () => stopAgent(w, ctx.id),
        },
        agentKeyOf: petCore.agentKey,
        canAsk: canAsk(w),
        action: menusMod.agentAction(agent),
      }),
    )
  }
  return Menu.buildFromTemplate([...items, ...windowItems(w, ctx.kind === 'crab' && !!ctx.id && canAsk(w))])
}

// ---------------------------------------------------------------- drag and resize, polled

const TICK_MS = 16

function stopGesture(w, silent) {
  if (!w.gesture) return
  clearInterval(w.gesture.timer)
  const kind = w.gesture.kind
  w.gesture = null
  if (alive(w)) {
    w.win.webContents.send('pet:move', { vx: 0, vy: 0 })
    if (!silent) setIgnore(w, w.ignoring) // back to what the page last wanted
    dbg(`gesture ${kind} ended, bounds ${JSON.stringify(w.win.getBounds())}`)
  }
  if (!silent) saveState()
}

function startGesture(w, kind, pullX = 0, pullY = 0) {
  if (!alive(w) || (w.collapsed && kind === 'resize')) return
  stopGesture(w)
  const here = screen.getCursorScreenPoint()
  // For a drag the pointer has already moved since the press: the window follows from where the press was.
  const cur = kind === 'drag' ? { x: here.x - pullX, y: here.y - pullY } : here
  const b = w.win.getBounds()
  const g = { kind, cur, b, last: { x: b.x, y: b.y }, at: Date.now(), started: Date.now(), vx: 0, vy: 0, timer: null, ticks: 0 }
  w.gesture = g
  w.win.setIgnoreMouseEvents(false)
  const max = maxSize(w)
  g.timer = setInterval(() => {
    if (!alive(w)) return stopGesture(w)
    // A gesture the page never ended (a lost mouse-up) must not hold the window forever.
    if (Date.now() - g.started > 60000) return stopGesture(w)
    const c = screen.getCursorScreenPoint()
    g.ticks += 1
    if (kind === 'drag') {
      // Keep the saved size: across displays with different scaling the size would otherwise drift.
      const x = c.x - (g.cur.x - g.b.x)
      const y = c.y - (g.cur.y - g.b.y)
      w.win.setBounds({ x, y, width: g.b.width, height: g.b.height })
      const now = Date.now()
      const dt = Math.max(1, now - g.at) / 1000
      g.vx = g.vx * 0.5 + ((x - g.last.x) / dt) * 0.5
      g.vy = g.vy * 0.5 + ((y - g.last.y) / dt) * 0.5
      g.last = { x, y }
      g.at = now
      w.win.webContents.send('pet:move', { vx: g.vx, vy: g.vy })
    } else {
      const width = clamp(g.b.width + (c.x - g.cur.x), MIN_W, max.width)
      const height = clamp(g.b.height + (c.y - g.cur.y), MIN_H, max.height)
      w.win.setBounds({ x: g.b.x, y: g.b.y, width, height })
      if (g.ticks === 1 || g.ticks % 30 === 0) dbg(`resize tick ${g.ticks} want ${width}x${height} got ${JSON.stringify(w.win.getBounds())}`)
    }
  }, TICK_MS)
  dbg(`gesture ${kind} started at ${JSON.stringify(cur)}, bounds ${JSON.stringify(b)}`)
}

/** Grows or shrinks by a factor around the centre; returns [before, after] so a test can see what happened. */
function resizeBy(w, f) {
  if (!alive(w) || w.collapsed || !isNum(f) || f <= 0) return null
  const b = w.win.getBounds()
  const max = maxSize(w)
  const width = clamp(Math.round(b.width * f), MIN_W, max.width)
  const height = clamp(Math.round(b.height * f), MIN_H, max.height)
  // Around the centre, so the crabs stay put under the cursor.
  const nb = { x: Math.round(b.x + (b.width - width) / 2), y: Math.round(b.y + (b.height - height) / 2), width, height }
  const target = isOnScreen(nb) ? nb : { ...nb, x: b.x, y: b.y }
  w.win.setBounds(target)
  const after = w.win.getBounds()
  dbg(`resizeBy ${f}: ${JSON.stringify(b)} -> asked ${JSON.stringify(target)} -> got ${JSON.stringify(after)}`)
  clearTimeout(resizeBy.t)
  resizeBy.t = setTimeout(saveState, 400)
  return [b, after]
}

// ---------------------------------------------------------------- ipc

function wireIpc() {
  // Only a pet page of ours may ask, and what it asks is about its own window.
  const of = e => {
    const w = byContents.get(e.sender.id)
    return alive(w) ? w : null
  }
  const on = (channel, fn) =>
    ipcMain.on(channel, (e, ...args) => {
      const w = of(e)
      if (w) fn(w, ...args)
    })
  on('pet:dragStart', (w, dx, dy) => startGesture(w, 'drag', isNum(dx) ? clamp(dx, -200, 200) : 0, isNum(dy) ? clamp(dy, -200, 200) : 0))
  on('pet:dragEnd', w => stopGesture(w))
  on('pet:resizeStart', w => startGesture(w, 'resize'))
  on('pet:resizeEnd', w => stopGesture(w))
  on('pet:resizeBy', (w, f) => {
    dbg(`resizeBy requested ${f}`)
    resizeBy(w, Number(f))
  })
  on('pet:setIgnore', (w, v) => setIgnore(w, !!v))
  on('pet:collapse', (w, v) => setCollapsed(w, !!v))
  // The ask card: the page opens it on a menu's request and says when it takes and gives up the keyboard; Send / Put in prompt box arrive here.
  on('pet:askFocus', (w, v) => setAsking(w, !!v))
  on('pet:ask', (w, req) => {
    if (!canAsk(w) || !req || typeof req !== 'object') return
    const text = typeof req.text === 'string' ? req.text.trim() : ''
    const mode = req.mode === 'send' || req.mode === 'draft' ? req.mode : ''
    if (!mode || !text || text.length > ASK_MAX) return dbg('ask refused')
    const agentId = clipText(req.agentId, 200)
    writeInbox(w, { kind: 'ask', mode, text, ...(agentId ? { agentId } : {}) })
  })
  on('pet:menu', (w, ctx) => {
    if (!ctx || typeof ctx !== 'object') return
    const kind = ctx.kind === 'crab' || ctx.kind === 'file' || ctx.kind === 'plate' ? ctx.kind : ''
    dbg(`menu ${kind || 'window'}`)
    // A file entry is offered only for a path the snapshot lists.
    if (kind === 'file' && !w.actions.resolve(ctx.abs)) return menuFor(w, {}).popup({ window: w.win })
    // The character list is the page's (it knows the user's packs); only ids of the usual form and clipped names are taken.
    const chars = (Array.isArray(ctx.chars) ? ctx.chars : [])
      .filter(c => c && typeof c.id === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(c.id))
      .slice(0, 100)
      .map(c => ({ id: c.id, name: clipText(c.name, 60) || c.id }))
    menuFor(w, { kind, id: clipText(ctx.id, 200), abs: ctx.abs, type: clipText(ctx.type, 80), cur: typeof ctx.cur === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(ctx.cur) ? ctx.cur : '', chars }).popup({ window: w.win })
  })
  // The agents a window shows, for the Settings window's lists.
  on('pet:seen', (w, list) => {
    w.seen = (Array.isArray(list) ? list : [])
      .slice(0, 80)
      .filter(a => a && typeof a.id === 'string')
      .map(a => ({ id: clipText(a.id, 200), type: clipText(a.type, 80), description: clipText(a.description, 80) }))
  })
  // Settings: a pet page or the Settings window may read and change them; what arrives is checked again in changeSettings.
  const fromSettings = e => !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents
  const fromPage = e => byContents.has(e.sender.id) || fromSettings(e)
  ipcMain.handle('pet:getSettings', e => (fromPage(e) ? settings : null))
  ipcMain.handle('pet:setSettings', (e, patch) => (fromPage(e) ? applyPatch(patch) : null))
  ipcMain.handle('pet:settingsContext', e => (fromSettings(e) ? settingsContext() : null))
  ipcMain.on('pet:resetSettings', e => {
    if (fromSettings(e)) changeSettings(petCore.defaults(), 'M')
  })
  ipcMain.on('pet:closeSettings', e => {
    if (fromSettings(e)) settingsWin.close()
  })
  on('pet:open', (w, abs) => void runAction(w, () => w.actions.open(abs)))
  on('pet:reveal', (w, abs) => void runAction(w, () => w.actions.reveal(abs)))
  ipcMain.handle('pet:summary', (e, abs) => {
    const w = of(e)
    if (!w) return { error: 'sender' }
    const file = w.actions.resolve(abs)
    return file ? summaryOf(file) : { error: 'not listed' }
  })
}

// ---------------------------------------------------------------- start

const sessionOf = args => {
  const id = args.arg('session')
  return okId(id) ? id : ''
}

async function start() {
  actionsMod = await import(pathToFileURL(path.join(__dirname, 'actions.mjs')).href)
  summaryMod = await import(pathToFileURL(path.join(__dirname, 'summary.mjs')).href)
  menusMod = await import(pathToFileURL(path.join(__dirname, 'menus.mjs')).href)
  await app.whenReady()
  const st = isScratch ? {} : loadState()
  // The settings file wins; without one, the two settings older versions kept in overlay-state.json carry over.
  let fromFile = null
  if (isScratch) {
    try {
      fromFile = petCore.sanitize(JSON.parse(arg('pet-settings') || '{}'))
    } catch {
      fromFile = petCore.sanitize(null)
    }
  } else fromFile = petCore.load(fs, settingsFile)
  settings = fromFile || petCore.sanitize({ alwaysOnTop: st.alwaysOnTop !== false, show: { ticker: st.ticker !== false } })
  onTop = settings.alwaysOnTop
  ticker = settings.show.ticker
  saved = st.sessions && typeof st.sessions === 'object' ? st.sessions : {}
  legacy = validBounds(st) ? st : null
  wireIpc()

  const first = await createWindow(sessionOf(mine), has('orca'), arg('token'))
  const at = arg('at').split(',').map(Number)
  const size = arg('size').split(',').map(Number)
  const [sw, sh] = size.length === 2 && size.every(isNum) ? size : [DEF_W, DEF_H]
  if (isScratch && at.length === 2 && at.every(isNum)) first.win.setBounds({ x: at[0], y: at[1], width: sw, height: sh })
  if (shotOut) return void shot(first)
  if (shotSettings) return void settingsShot()
  if (selftest) return void runSelftest(first)

  try {
    tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_PNG, 'base64')))
    tray.setToolTip('Crew pet')
    tray.on('click', () => wins.forEach(showWin))
    refreshTray()
  } catch (e) {
    dbg(`no tray ${e && e.message}`)
  }

  // A stale request would close the pet the moment it starts.
  fs.rmSync(quitFile, { force: true })
  for (const f of fs.readdirSync(stateDir)) if (/^close-/.test(f)) fs.rmSync(path.join(stateDir, f), { force: true })
  // Snapshots of sessions that ended a week ago are not worth keeping.
  try {
    const dir = path.join(path.dirname(pageFile), 'sessions')
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f)
      if (Date.now() - fs.statSync(file).mtimeMs > 7 * 24 * 3600e3) fs.rmSync(file, { force: true })
    }
  } catch {
    /* no sessions folder yet */
  }
  setInterval(() => {
    let names = []
    try {
      names = fs.readdirSync(stateDir)
    } catch {
      return
    }
    if (names.includes('quit')) {
      fs.rmSync(quitFile, { force: true })
      return quit()
    }
    for (const f of names) {
      const m = /^close-(.+)$/.exec(f)
      if (!m) continue
      fs.rmSync(path.join(stateDir, f), { force: true })
      if (okId(m[1])) closeWindow(m[1])
    }
  }, 1000)
}

function out(line) {
  try {
    fs.writeSync(1, `${line}\n`)
  } catch {
    /* no stdout to write to */
  }
}

async function shot(w) {
  await new Promise(r => setTimeout(r, 2500))
  const img = await w.win.webContents.capturePage()
  const size = img.getSize()
  const bmp = img.toBitmap() // BGRA
  let content = 0
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 8) content += 1
  fs.writeFileSync(shotOut, img.toPNG())
  const line = `corner-alpha=${bmp[(2 * size.width + 2) * 4 + 3]} content-pixels=${content} size=${size.width}x${size.height}`
  out(line)
  fs.writeFileSync(`${shotOut}.txt`, `${line}\n`)
  app.exit(0)
}

/** --shot-settings: the Settings window, once its previews have run for a moment. */
async function settingsShot() {
  const win = await openSettings()
  await new Promise(r => setTimeout(r, 3500))
  const img = await win.webContents.capturePage()
  const size = img.getSize()
  const bmp = img.toBitmap()
  let content = 0
  for (let i = 3; i < bmp.length; i += 4) if (bmp[i] > 8) content += 1
  fs.writeFileSync(shotSettings, img.toPNG())
  const line = `content-pixels=${content} size=${size.width}x${size.height}`
  out(line)
  fs.writeFileSync(`${shotSettings}.txt`, `${line}\n`)
  app.exit(0)
}

// --selftest: the resize path without a mouse. Prints the bounds before and after each step.
async function runSelftest(w) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const show = (label, r) => out(`${label}: ${r ? `${r[0].width}x${r[0].height} -> ${r[1].width}x${r[1].height} (at ${r[1].x},${r[1].y})` : 'refused'}`)
  await sleep(500)
  out(`resizable=${w.win.isResizable()} bounds=${JSON.stringify(w.win.getBounds())}`)
  show('resizeBy 1.25', resizeBy(w, 1.25))
  await sleep(200)
  show('resizeBy 0.8', resizeBy(w, 0.8))
  await sleep(200)
  // The grip's path: a polled gesture, with the cursor stood in for.
  const real = screen.getCursorScreenPoint
  let cur = { x: 100, y: 100 }
  screen.getCursorScreenPoint = () => cur
  const b0 = w.win.getBounds()
  startGesture(w, 'resize')
  cur = { x: 160, y: 140 }
  await sleep(120)
  const b1 = w.win.getBounds()
  stopGesture(w)
  screen.getCursorScreenPoint = real
  out(`grip +60,+40: ${b0.width}x${b0.height} -> ${b1.width}x${b1.height} (top-left kept: ${b0.x === b1.x && b0.y === b1.y})`)
  app.exit(0)
}

// A second start tells this process what it wanted through the lock's own channel: Chromium reorders and splits a
// second process's command line, so its argv cannot be parsed for --session.
app.on('second-instance', (_e, _argv, _cwd, data) => {
  const id = data && okId(data.session) ? data.session : ''
  dbg(`second start for session ${id || '(none)'}`)
  void openSession(id, !!(data && data.orca), data && data.token).catch(e => dbg(`second start failed ${e && e.stack}`))
})
app.on('window-all-closed', () => {
  if (wins.size === 0) app.quit()
})

if (!isScratch && !app.requestSingleInstanceLock({ session: sessionOf(mine), orca: has('orca'), token: arg('token') })) app.exit(0)
else
  void start().catch(e => {
    dbg(`start failed ${e && e.stack}`)
    app.exit(1)
  })
