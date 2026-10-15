#!/usr/bin/env node
// crew-3d: renders the crew-graph three.js view in a headless Chrome/Edge and streams it into
// the terminal pane, and feeds the pane's mouse input back to the page.
//
//   node crew-3d.mjs --page <file:///…/index.html> --cols 100 --rows 28 [--fps 10]
//                    [--mode cells|image] [--out <dir for image frames>] [--cellw 8 --cellh 16]
//
// stdout, one line each:
//   P <port> <token>                    input endpoint: POST http://127.0.0.1:<port>/input?t=<token>
//   C <cols> <rows> <base64 cells>      a Raster frame (RasterProps.cells): quadrant blocks, 2x2
//                                       pixels a cell, each cell's best two colours
//   I <path> <width> <height> <gen>     an Image frame: raw RGB file written for the terminal
//   E <message>                         an error
// Chrome is driven over --remote-debugging-pipe: when this process dies the pipe closes and the
// browser exits with it. The input endpoint listens on 127.0.0.1 only and needs the token.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}
const page = arg('page', '')
const cols = Math.max(8, Math.min(512, Number(arg('cols', 100)) | 0))
const rows = Math.max(4, Math.min(255, Number(arg('rows', 28)) | 0))
const fps = Math.max(1, Math.min(30, Number(arg('fps', 10))))
// Idle (no input for a while) the view still breathes, at a few frames a second: the browser
// renders on the CPU (SwiftShader), so every frame not drawn is CPU given back.
const idleFps = Math.max(1, Math.min(fps, Number(arg('idle-fps', 4))))
const ACTIVE_MS = 3000
let lastInputAt = 0
const mode = arg('mode', 'cells') === 'image' ? 'image' : 'cells'
const cellW = Math.max(4, Number(arg('cellw', 8)) | 0)
const cellH = Math.max(8, Number(arg('cellh', 16)) | 0)
const outDir = arg('out', '')

// The page's own size in CSS pixels, and the size of each grabbed frame.
//   cells: 2x2 pixels a cell, grabbed at 2x again and box-filtered (supersampling)
//   image: the cell box's real pixels (capped so a frame stays small)
const SS = 2
// cells: 4x8 CSS pixels a cell keeps the cell's shape and still supersamples its 2x2 pixels.
const pageW = mode === 'image' ? Math.min(1600, cols * cellW) : cols * 4
const pageH = mode === 'image' ? Math.min(1000, rows * cellH) : rows * 8
const grabW = mode === 'image' ? pageW : cols * 2 * SS
const grabH = mode === 'image' ? pageH : rows * 2 * SS

const say = line => process.stdout.write(`${line}\n`)
const fail = msg => {
  say(`E ${String(msg).replace(/\s+/g, ' ')}`)
  process.exit(1)
}
if (!page) fail('no --page given')
if (mode === 'image' && !outDir) fail('--mode image needs --out')

function findBrowser() {
  const own = arg('chrome', process.env.CREW_CHROME)
  if (own) return own
  const pf = process.env.PROGRAMFILES ?? 'C:/Program Files'
  const pf86 = process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'
  const local = process.env.LOCALAPPDATA ?? ''
  return (
    [
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
    ].find(p => existsSync(p)) ?? null
  )
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
    `--window-size=${pageW},${pageH}`,
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

let server = null
const cleanup = () => {
  try {
    server?.close()
  } catch {}
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
// A parent that died without killing us: our stdout pipe breaks on the next write.
process.stdout.on('error', () => process.exit(0))
chrome.on('exit', code => {
  say(`E browser exited (${code})`)
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
      await send('Emulation.setDeviceMetricsOverride', { width: pageW, height: pageH, deviceScaleFactor: 1, mobile: false }, sessionId)
      await send('Runtime.evaluate', { expression: INPUT_SHIM }, sessionId)
      return sessionId
    }
    await sleep(100)
  }
  throw new Error('the view page never opened')
}

// ---------------------------------------------------------------- input from the pane
// Events carry x, y as fractions of the view (0..1). They are replayed in the page as DOM
// pointer and wheel events on the canvas: CDP's Input domain refuses them in this headless mode.
let session = null
const INPUT_SHIM = `(() => {
  if (window.__crewInput) return
  let buttons = 0
  const BTN = { left: 1, right: 2, middle: 4 }
  const CODE = { left: 0, middle: 1, right: 2 }
  window.__crewInput = (events) => {
    const el = document.querySelector('#stage canvas') || document.body
    for (const ev of events) {
      const x = Math.max(0, Math.min(innerWidth - 1, ev.x * innerWidth))
      const y = Math.max(0, Math.min(innerHeight - 1, ev.y * innerHeight))
      const base = { clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
        shiftKey: !!ev.shift, altKey: !!ev.alt, ctrlKey: !!ev.ctrl }
      const b = ev.button in CODE ? ev.button : 'left'
      if (ev.kind === 'wheel') { el.dispatchEvent(new WheelEvent('wheel', { ...base, deltaY: ev.dy * 100, deltaMode: 0 })); continue }
      if (ev.kind === 'leave') { buttons = 0; el.dispatchEvent(new PointerEvent('pointerleave', { ...base, pointerId: 1, pointerType: 'mouse' })); continue }
      if (ev.kind === 'down') buttons |= BTN[b]
      if (ev.kind === 'up') buttons &= ~BTN[b]
      const type = ev.kind === 'down' ? 'pointerdown' : ev.kind === 'up' ? 'pointerup' : 'pointermove'
      const button = ev.kind === 'move' ? -1 : CODE[b]
      el.dispatchEvent(new PointerEvent(type, { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, button, buttons }))
      const mtype = type.replace('pointer', 'mouse')
      el.dispatchEvent(new MouseEvent(mtype, { ...base, button: Math.max(0, button), buttons }))
      if (ev.kind === 'up' && b === 'left') el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, buttons }))
    }
    return true
  }
})()`

let inputChain = Promise.resolve()
function dispatch(events) {
  // One evaluate per batch, in order; a slow page never reorders a press and its release.
  inputChain = inputChain
    .then(() =>
      session
        ? send('Runtime.evaluate', { expression: `window.__crewInput && window.__crewInput(${JSON.stringify(events)})` }, session)
        : null,
    )
    .catch(err => process.stderr.write(`input: ${err.message}
`))
  return inputChain
}

const token = randomBytes(12).toString('hex')
server = createServer((req, res) => {
  const ok = req.method === 'POST' && req.url === `/input?t=${token}`
  if (!ok) {
    res.writeHead(404).end()
    return
  }
  let body = ''
  req.setEncoding('utf8')
  req.on('data', c => {
    body += c
    if (body.length > 1_000_000) req.destroy()
  })
  req.on('end', async () => {
    try {
      const { events } = JSON.parse(body)
      const clean = (Array.isArray(events) ? events.slice(0, 200) : []).map(ev => ({
        kind: ['down', 'up', 'move', 'wheel', 'leave'].includes(ev?.kind) ? ev.kind : 'move',
        button: ['left', 'right', 'middle'].includes(ev?.button) ? ev.button : 'left',
        x: Math.max(0, Math.min(1, Number(ev?.x) || 0)),
        y: Math.max(0, Math.min(1, Number(ev?.y) || 0)),
        dy: Math.max(-20, Math.min(20, Number(ev?.dy) || 0)),
        shift: ev?.shift === true,
        alt: ev?.alt === true,
        ctrl: ev?.ctrl === true,
      }))
      if (clean.length) {
        lastInputAt = Date.now()
        await dispatch(clean)
      }
      res.writeHead(204).end()
    } catch (err) {
      res.writeHead(400).end(String(err))
    }
  })
})
server.listen(0, '127.0.0.1', () => say(`P ${server.address().port} ${token}`))

// ---------------------------------------------------------------- frames
// Quadrant blocks by the four pixels they cover: bit 1 top-left, 2 top-right, 4 bottom-left,
// 8 bottom-right; the set bits take the foreground colour.
const QUAD = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]
const cells = new Uint32Array(cols * rows * 3)
const sub = new Float32Array(cols * 2 * rows * 2 * 3)

/** Box-filters the supersampled grab to 2x2 subpixels a cell. */
function downsample(rgb) {
  const sw = cols * 2
  const sh = rows * 2
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < SS; dy += 1) {
        for (let dx = 0; dx < SS; dx += 1) {
          const i = ((y * SS + dy) * grabW + (x * SS + dx)) * 3
          r += rgb[i]
          g += rgb[i + 1]
          b += rgb[i + 2]
        }
      }
      const o = (y * sw + x) * 3
      const n = SS * SS
      sub[o] = r / n
      sub[o + 1] = g / n
      sub[o + 2] = b / n
    }
  }
}

const pack = (r, g, b) => ((Math.round(r) & 255) << 16) | ((Math.round(g) & 255) << 8) | (Math.round(b) & 255)

/** Each cell: the split of its four pixels into two colours with the least error. */
function toCells(rgb) {
  downsample(rgb)
  const sw = cols * 2
  const p = new Float32Array(12)
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      const idx = [(2 * cy) * sw + 2 * cx, (2 * cy) * sw + 2 * cx + 1, (2 * cy + 1) * sw + 2 * cx, (2 * cy + 1) * sw + 2 * cx + 1]
      for (let k = 0; k < 4; k += 1) {
        p[k * 3] = sub[idx[k] * 3]
        p[k * 3 + 1] = sub[idx[k] * 3 + 1]
        p[k * 3 + 2] = sub[idx[k] * 3 + 2]
      }
      let best = 0
      let bestErr = Infinity
      let fg = [0, 0, 0]
      let bg = [0, 0, 0]
      // Masks 1..7 cover every two-way split once (8..14 are their complements); 0 is uniform.
      for (let mask = 0; mask < 8; mask += 1) {
        const a = [0, 0, 0]
        const b = [0, 0, 0]
        let na = 0
        let nb = 0
        for (let k = 0; k < 4; k += 1) {
          const t = mask & (1 << k) ? a : b
          t[0] += p[k * 3]
          t[1] += p[k * 3 + 1]
          t[2] += p[k * 3 + 2]
          if (mask & (1 << k)) na += 1
          else nb += 1
        }
        if (na) for (let j = 0; j < 3; j += 1) a[j] /= na
        if (nb) for (let j = 0; j < 3; j += 1) b[j] /= nb
        let err = 0
        for (let k = 0; k < 4; k += 1) {
          const t = mask & (1 << k) ? a : b
          const dr = p[k * 3] - t[0]
          const dg = p[k * 3 + 1] - t[1]
          const db = p[k * 3 + 2] - t[2]
          err += dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11
        }
        if (err < bestErr - 1e-6) {
          bestErr = err
          best = mask
          fg = a
          bg = b
        }
      }
      const c = (cy * cols + cx) * 3
      if (best === 0) {
        cells[c] = 0x20
        cells[c + 1] = pack(bg[0], bg[1], bg[2])
        cells[c + 2] = pack(bg[0], bg[1], bg[2])
      } else {
        cells[c] = QUAD[best]
        cells[c + 1] = pack(fg[0], fg[1], fg[2])
        cells[c + 2] = pack(bg[0], bg[1], bg[2])
      }
    }
  }
  return Buffer.from(cells.buffer).toString('base64')
}

let gen = 0
function writeImage(rgb) {
  gen += 1
  const path = join(outDir, `frame-${gen % 2}.rgb`)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, rgb)
  renameSync(tmp, path)
  say(`I ${path.replace(/\\/g, '/')} ${grabW} ${grabH} ${gen}`)
}

async function main() {
  if (mode === 'image') mkdirSync(outDir, { recursive: true })
  session = await attach()
  let last = ''
  for (;;) {
    const started = Date.now()
    try {
      const r = await send(
        'Runtime.evaluate',
        { expression: `(${INPUT_SHIM}, window.__crewGrab ? window.__crewGrab(${grabW}, ${grabH}) : '')`, returnByValue: true },
        session,
      )
      const b64 = r?.result?.value
      if (typeof b64 === 'string' && b64.length > 0) {
        const rgb = Buffer.from(b64, 'base64')
        if (rgb.length === grabW * grabH * 3) {
          if (mode === 'image') writeImage(rgb)
          else {
            const out = toCells(rgb)
            if (out !== last) {
              say(`C ${cols} ${rows} ${out}`)
              last = out
            }
          }
        }
      }
    } catch (err) {
      process.stderr.write(`grab: ${err.message}\n`)
    }
    const rate = Date.now() - lastInputAt < ACTIVE_MS ? fps : idleFps
    await sleep(Math.max(5, 1000 / rate - (Date.now() - started)))
  }
}

main().catch(err => fail(err.message))
