'use strict'
// The pet page's only way out: window.crewPet. Every call is a fixed channel to overlay/main.js;
// nothing else of Electron or Node is exposed to the page.
const { contextBridge, ipcRenderer, webFrame } = require('electron')

const SEND = new Set(['pet:dragStart', 'pet:dragEnd', 'pet:resizeStart', 'pet:resizeEnd', 'pet:resizeBy', 'pet:setIgnore', 'pet:menu', 'pet:open', 'pet:reveal', 'pet:collapse'])
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

contextBridge.exposeInMainWorld('crewPet', {
  /** Start carrying the window; dx, dy: how far the pointer has moved since the press, so the window can catch up. */
  dragStart: (dx, dy) => send('pet:dragStart', num(dx), num(dy)),
  dragEnd: () => send('pet:dragEnd'),
  resizeStart: () => send('pet:resizeStart'),
  resizeEnd: () => send('pet:resizeEnd'),
  resizeBy: factor => send('pet:resizeBy', num(factor)),
  setIgnore: ignore => send('pet:setIgnore', !!ignore),
  /** The native context menu; `ctx` says what was clicked: {} | { kind: 'crab', id } | { kind: 'file', abs } | { kind: 'plate' }. */
  menu: ctx => send('pet:menu', { kind: ctx && (ctx.kind === 'crab' || ctx.kind === 'file' || ctx.kind === 'plate') ? ctx.kind : '', id: text(ctx && ctx.id), abs: text(ctx && ctx.abs) }),
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
  /** hop, reset, ticker, cursor: cb({ type, ... }). */
  onEvent: cb => {
    ipcRenderer.on('pet:event', (_e, ev) => cb(ev && typeof ev === 'object' ? ev : null))
  },
})
