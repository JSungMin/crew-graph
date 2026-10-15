#!/usr/bin/env node
// crew-3d: renders the crew-graph three.js view in a headless Chrome/Edge and streams it as
// terminal Raster cells (half blocks: top pixel = foreground, bottom pixel = background).
//
//   node crew-3d.mjs --page <file:///…/index.html> --cols 70 --rows 22 [--fps 8] [--chrome <exe>]
//
// stdout, one line per frame:  C <cols> <rows> <base64 cells>   (RasterProps.cells encoding)
//                     errors:  E <message>
// Chrome is driven over --remote-debugging-pipe, so when this process dies (the mod ended
// the stream, the session closed) the pipe closes and Chrome exits with it. No network port.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const page = arg('page', '')
const cols = Math.max(8, Math.min(512, Number(arg('cols', 70)) | 0))
const rows = Math.max(4, Math.min(256, Number(arg('rows', 22)) | 0))
const fps = Math.max(1, Math.min(30, Number(arg('fps', 8))))
const SCALE = 8 // browser pixels per raster pixel, so the downsample stays smooth

const fail = msg => {
  process.stdout.write(`E ${String(msg).replace(/\s+/g, ' ')}\n`)
  process.exit(1)
}
if (!page) fail('no --page given')

function findBrowser() {
  const own = arg('chrome', process.env.CREW_CHROME)
  if (own) return own
  const pf = process.env.PROGRAMFILES ?? 'C:/Program Files'
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    `${pf}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Google/Chrome/Application/chrome.exe`,
    `${local}/Google/Chrome/Application/chrome.exe`,
    `${pf86}/Microsoft/Edge/Application/msedge.exe`,
    `${pf}/Microsoft/Edge/Application/msedge.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ]
  return candidates.find(p => existsSync(p)) ?? null
}

const exe = findBrowser()
if (!exe) fail('no Chrome, Edge or Chromium found; set CREW_CHROME to one')

const profile = mkdtempSync(join(tmpdir(), 'crew-3d-'))
const url = page + (page.includes('?') ? '&' : '?') + 'embed'
const chrome = spawn(
  exe,
  [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--window-size=${cols * SCALE},${rows * 2 * SCALE}`,
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--allow-file-access-from-files',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    url,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true },
)

const cleanup = () => {
  try {
    chrome.kill()
  } catch {}
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {}
  }, 300)
}
process.on('exit', cleanup)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0))
chrome.on('exit', code => {
  process.stdout.write(`E browser exited (${code})\n`)
  process.exit(1)
})
chrome.on('error', err => fail(`cannot start ${exe}: ${err.message}`))

// ---------------------------------------------------------------- CDP over the pipe
const toChrome = chrome.stdio[3]
const fromChrome = chrome.stdio[4]
let nextId = 1
const waiting = new Map()
let buf = ''
fromChrome.setEncoding('utf8')
fromChrome.on('data', chunk => {
  buf += chunk
  let at
  while ((at = buf.indexOf('\0')) >= 0) {
    const raw = buf.slice(0, at)
    buf = buf.slice(at + 1)
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      continue
    }
    const w = msg.id !== undefined ? waiting.get(msg.id) : undefined
    if (w) {
      waiting.delete(msg.id)
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result)
    }
  }
})
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    waiting.set(id, { resolve, reject })
    toChrome.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0')
  })

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function attach() {
  for (let i = 0; i < 100; i += 1) {
    const { targetInfos } = await send('Target.getTargets')
    const t = targetInfos.find(x => x.type === 'page' && x.url.includes('index.html'))
    if (t) {
      const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true })
      // The viewport, exactly: headless window sizes do not always reach the page whole.
      await send(
        'Emulation.setDeviceMetricsOverride',
        { width: cols * SCALE, height: rows * 2 * SCALE, deviceScaleFactor: 1, mobile: false },
        sessionId,
      )
      return sessionId
    }
    await sleep(100)
  }
  throw new Error('the view page never opened')
}

// ---------------------------------------------------------------- frames
const W = cols
const H = rows * 2
const cells = new Uint32Array(cols * rows * 3)
for (let i = 0; i < cols * rows; i += 1) cells[i * 3] = 0x2580 // ▀

function toCells(rgb) {
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const top = ((2 * y) * W + x) * 3
      const bot = ((2 * y + 1) * W + x) * 3
      const c = (y * cols + x) * 3
      cells[c + 1] = (rgb[top] << 16) | (rgb[top + 1] << 8) | rgb[top + 2]
      cells[c + 2] = (rgb[bot] << 16) | (rgb[bot + 1] << 8) | rgb[bot + 2]
    }
  }
  return Buffer.from(cells.buffer).toString('base64')
}

async function main() {
  const session = await attach()
  let last = ''
  for (;;) {
    const started = Date.now()
    try {
      const r = await send(
        'Runtime.evaluate',
        { expression: `window.__crewGrab ? window.__crewGrab(${W}, ${H}) : ''`, returnByValue: true },
        session,
      )
      const b64 = r?.result?.value
      if (typeof b64 === 'string' && b64.length > 0) {
        const rgb = Buffer.from(b64, 'base64')
        if (rgb.length === W * H * 3) {
          const out = toCells(rgb)
          if (out !== last) {
            process.stdout.write(`C ${cols} ${rows} ${out}\n`)
            last = out
          }
        }
      }
    } catch (err) {
      process.stderr.write(`grab: ${err.message}\n`)
    }
    await sleep(Math.max(5, 1000 / fps - (Date.now() - started)))
  }
}

main().catch(err => fail(err.message))
