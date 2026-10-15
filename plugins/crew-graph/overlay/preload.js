'use strict'
// The pet page's only way out: window.crewPet. Every call is a fixed channel to overlay/main.js;
// nothing else of Electron or Node is exposed to the page.
const { contextBridge, ipcRenderer, webFrame } = require('electron')

const SEND = new Set(['pet:dragStart', 'pet:dragEnd', 'pet:resizeStart', 'pet:resizeEnd', 'pet:resizeBy', 'pet:setIgnore', 'pet:menu', 'pet:open', 'pet:reveal', 'pet:collapse', 'pet:seen', 'pet:resetSettings', 'pet:closeSettings', 'pet:ask', 'pet:askFocus'])
const send = (channel, ...args) => {
  if (SEND.has(channel)) ipcRenderer.send(channel, ...args)
}

// The page draws its own scale: no browser zoom from Ctrl+wheel or a pinch.
try {
  webFrame.setVisualZoomLevelLimits(1, 1)
} catch {
  /* an older Electron: nothing to do */
}

const num = v => (Number.isFinite(Number(v)) ? Number(v) : 0)
const text = v => (typeof v === 'string' ? v.slice(0, 4096) : '')
const short = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '')
/** A plain copy of a settings patch: only the keys the settings have, nothing that is not JSON data (main checks every value again). */
const patchOf = p => {
  const out = {}
  if (!p || typeof p !== 'object') return out
  const str = v => (v === null ? null : short(v, 80))
  if ('default' in p) out.default = str(p.default)
  for (const f of ['types', 'agents']) {
    if (!p[f] || typeof p[f] !== 'object') continue
    out[f] = {}
    for (const k of Object.keys(p[f]).slice(0, 80)) out[f][short(k, 200)] = str(p[f][k])
  }
  if (p.show && typeof p.show === 'object') {
    out.show = {}
    for (const k of ['bubbles', 'ticker', 'papers', 'nameplate']) if (typeof p.show[k] === 'boolean') out.show[k] = p.show[k]
  }
  for (const k of ['reduceMotion', 'alwaysOnTop']) if (typeof p[k] === 'boolean') out[k] = p[k]
  if (typeof p.opacity === 'number') out.opacity = p.opacity
  if (typeof p.size === 'string') out.size = short(p.size, 4)
  if (typeof p.autoDismiss === 'number') out.autoDismiss = p.autoDismiss
  return out
}
const charsOf = list =>
  (Array.isArray(list) ? list : []).slice(0, 100).map(c => ({ id: short(c && c.id, 40), name: short(c && c.name, 60) }))

contextBridge.exposeInMainWorld('crewPet', {
  /** Start carrying the window; dx, dy: how far the pointer has moved since the press, so the window can catch up. */
  dragStart: (dx, dy) => send('pet:dragStart', num(dx), num(dy)),
  dragEnd: () => send('pet:dragEnd'),
  resizeStart: () => send('pet:resizeStart'),
  resizeEnd: () => send('pet:resizeEnd'),
  resizeBy: factor => send('pet:resizeBy', num(factor)),
  setIgnore: ignore => send('pet:setIgnore', !!ignore),
  /**
   * The native context menu; `ctx` says what was clicked: {} | { kind: 'crab', id, type, cur, chars: [{ id, name }] } | { kind: 'file', abs } | { kind: 'plate' }.
   * For a character: its id and type, the character it has now and the characters to choose from.
   */
  menu: ctx =>
    send('pet:menu', {
      kind: ctx && (ctx.kind === 'crab' || ctx.kind === 'file' || ctx.kind === 'plate') ? ctx.kind : '',
      id: text(ctx && ctx.id),
      abs: text(ctx && ctx.abs),
      type: short(ctx && ctx.type, 80),
      cur: short(ctx && ctx.cur, 40),
      chars: charsOf(ctx && ctx.chars),
    }),
  /**
   * The ask card. askFocus(true) while it is open: the window takes keyboard focus (it has none otherwise); askFocus(false) gives it back.
   * ask({ mode: 'send' | 'draft', text, agentId? }) hands the question to the main process, which writes it to the mod's inbox with the
   * window's token (the page never has the token).
   */
  askFocus: on => send('pet:askFocus', !!on),
  ask: req =>
    send('pet:ask', {
      mode: req && req.mode === 'draft' ? 'draft' : 'send',
      text: short(req && req.text, 4001),
      agentId: short(req && req.agentId, 200),
    }),
  /** Fold the window down to its title bar, or open it again. */
  collapse: on => send('pet:collapse', !!on),
  /** Open or reveal a file the snapshot lists (main refuses any other path). */
  openFile: abs => send('pet:open', text(abs)),
  revealFile: abs => send('pet:reveal', text(abs)),
  /** A summary of a file the snapshot lists: { kind, title, lead, heads, decls } or { error }. */
  summary: abs => ipcRenderer.invoke('pet:summary', text(abs)),
  /** The window's velocity in px/s while it is carried: cb({ vx, vy }). */
  onMove: cb => {
    ipcRenderer.on('pet:move', (_e, v) => cb({ vx: num(v && v.vx), vy: num(v && v.vy) }))
  },
  /** hop, reset, reset-input, ticker, cursor: cb({ type, ... }). */
  onEvent: cb => {
    ipcRenderer.on('pet:event', (_e, ev) => cb(ev && typeof ev === 'object' ? ev : null))
  },
  /** The pet settings in force (web/pet-settings-core.js): a promise of the settings object. */
  getSettings: () => ipcRenderer.invoke('pet:getSettings'),
  /** Change some of them: a patch such as { default: 'auto' } or { types: { Explore: 'cat' }, show: { ticker: false } }. Resolves to the new settings. */
  setSettings: patch => ipcRenderer.invoke('pet:setSettings', patchOf(patch)),
  /** Called with the full settings whenever they change, whoever changed them. */
  onSettings: cb => {
    ipcRenderer.on('pet:settings', (_e, s) => cb(s && typeof s === 'object' ? s : null))
  },
  /** The agents this window shows, so the Settings window can list their types: [{ id, type, description }]. */
  seen: list =>
    send(
      'pet:seen',
      (Array.isArray(list) ? list : []).slice(0, 80).map(a => ({ id: short(a && a.id, 200), type: short(a && a.type, 80), description: short(a && a.description, 80) })),
    ),
  /** Settings window only (main refuses anyone else): the sessions and agents to list, back to defaults, close. */
  settingsContext: () => ipcRenderer.invoke('pet:settingsContext'),
  resetSettings: () => send('pet:resetSettings'),
  closeSettings: () => send('pet:closeSettings'),
})
