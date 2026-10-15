// web-meals-replay: loads the desktop-pet page (web/index.html?overlay=1) in a headless Chrome/Edge at the pet's default size (360x300) and feeds it a
// scripted session over window.__crewUpdate, once a second like the pet's poll: main is working on the user's prompt, two teammates are given jobs and
// make tool calls, three reports reach main while it is busy and pile up, the teammates report back, main finishes and eats what is on its plate.
// Frames are captured every --every seconds; the page's own state (plates, count chips, bites, the eat order) is sampled every 250 ms.
// Nothing is shown on screen and no input is sent. All names in the script are made up.
//
//   node tools/web-meals-replay.mjs --out <dir for frames, strips and summary.json> [--secs 40] [--every 0.5] [--reduce 1] [--dsf 2] [--chrome <exe>]   (or CREW_CHROME)
// --dsf 2 draws at twice the pixel density (the same 360x300 layout, sharper frames to look at); the default is the pet's own 1.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let cleanup = () => {}
const die = (what, e) => { console.error(what, e && e.stack ? e.stack : e); try { cleanup() } catch {} ; process.exit(2) }
process.on('uncaughtException', e => die('uncaughtException', e))
process.on('unhandledRejection', e => die('unhandledRejection', e))

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const here = dirname(fileURLToPath(import.meta.url))
if (!arg('out')) { console.log('usage: node tools/web-meals-replay.mjs --out <dir> [--secs 40] [--every 0.5] [--reduce 1] [--dsf 2]'); process.exit(1) }
const out = resolve(arg('out')); const secs = +arg('secs', 40); const dsf = +arg('dsf', 1); const every = +arg('every', 0.5); const reduce = arg('reduce', '0') === '1'
const frames = join(out, 'frames'); mkdirSync(frames, { recursive: true })
const exe = arg('chrome', process.env.CREW_CHROME) || [
  `${process.env.PROGRAMFILES ?? 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
  `${process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'}/Microsoft/Edge/Application/msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => existsSync(p))
if (!exe) { console.log('no Chrome or Edge found; set CREW_CHROME'); process.exit(1) }

const profile = mkdtempSync(join(tmpdir(), 'wm-'))
const chrome = spawn(exe, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--window-size=360,300', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
chrome.on('error', e => die('chrome', e))
const to = chrome.stdio[3], from = chrome.stdio[4]
let id = 0, buf = ''; const pend = new Map()
from.on('data', d => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } } })
const send = (method, params = {}, sessionId, tmo = 15000) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error('timeout ' + method)) }, tmo); pend.set(i, { res: r => { clearTimeout(t); res(r) }, rej: e => { clearTimeout(t); rej(e) } }); to.write(JSON.stringify({ id: i, method, params, sessionId }) + '\0') })
cleanup = () => { try { chrome.kill() } catch {} ; setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }) } catch {} }, 500) }
process.on('exit', cleanup)
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- the scripted session (made-up names)
const T0 = Date.now()
const AG = { main: { id: 'main', type: 'main', description: 'main loop' }, t1: { id: 't1', type: 'scout', description: 'map the loader' }, t2: { id: 't2', type: 'builder', description: 'port the tests' } }
const calls = { main: 10, t1: 3, t2: 2 }
const run = { main: true, t1: false, t2: false }
const tasks = new Map()
let eaten = {}
let ev = 0
const put = (t) => tasks.set(t.id, { t: Date.now(), ...t })
const set = (id, status) => { const x = tasks.get(id); if (x) { x.status = status; x.t = Date.now() } }
const eat = (who, n = 1) => { eaten = { ...eaten, [who]: (eaten[who] || 0) + n } }
// [second, action]
const STEPS = [
  [0, () => put({ id: 'turn:T1', src: 'turn', owner: 'main', title: 'fix the build', status: 'in_progress' })],
  [2, () => {
    run.t1 = true; run.t2 = true
    put({ id: 'assign:t1:1', src: 'assign', owner: 't1', title: 'map the loader', status: 'in_progress', deliverTo: 'main' })
    put({ id: 'assign:t2:1', src: 'assign', owner: 't2', title: 'port the tests', status: 'in_progress', deliverTo: 'main' })
    put({ id: 'assign:t1:2', src: 'assign', owner: 't1', title: 'then update the docs', status: 'pending', deliverTo: 'main' })
  }],
  [6, () => put({ id: 'mail:m1', src: 'mail', owner: 'main', title: 'from scout: parser mapped', status: 'pending' })],
  [8, () => put({ id: 'mail:m2', src: 'mail', owner: 'main', title: 'from builder: tests ported', status: 'pending' })],
  [10, () => put({ id: 'mail:m3', src: 'mail', owner: 'main', title: 'from scout: loader notes ready', status: 'pending' })],
  [12, () => { set('assign:t2:1', 'completed'); eat('main'); run.t2 = false }],
  [15, () => { set('assign:t1:1', 'completed'); set('assign:t1:2', 'in_progress'); eat('main') }],
  [18, () => { set('turn:T1', 'completed'); for (const m of ['mail:m1', 'mail:m2', 'mail:m3']) set(m, 'completed'); eat('main', 4); run.main = false }],
  [22, () => { set('assign:t1:2', 'completed'); eat('main'); run.t1 = false }],
  [24, () => { run.main = true; put({ id: 'mail:m4', src: 'mail', owner: 'main', title: 'from builder: one more thing', status: 'in_progress' }) }],
  [28, () => { set('mail:m4', 'completed'); eat('main'); run.main = false }],
]
// tool calls: [agent, from second, to second, every seconds]
const CALLS = [['main', 0, 18, 1.0], ['main', 24, 28, 0.8], ['t1', 3, 21, 0.45], ['t2', 3, 12, 0.7]]
const callAt = []
for (const [a, f, t, e] of CALLS) for (let s = f; s < t; s += e) callAt.push([s, a])
callAt.sort((x, y) => x[0] - y[0])
let stepI = 0, callI = 0
function advance(sec) {
  while (stepI < STEPS.length && STEPS[stepI][0] <= sec) STEPS[stepI++][1]()
  while (callI < callAt.length && callAt[callI][0] <= sec) calls[callAt[callI++][1]] += 1
}
const VERBS = ['read', 'search', 'edit', 'run']
function snapshot(sec) {
  const now = Date.now()
  const agents = Object.values(AG).map(a => {
    const running = run[a.id]
    return { ...a, parentId: a.id === 'main' ? null : 'main', status: running ? 'running' : a.id === 'main' ? 'idle' : 'completed', verb: running ? VERBS[Math.floor(sec * 2) % 4] : a.id === 'main' ? 'wait' : 'done', target: running ? 'src/loader.ts' : '', since: now - 500, steps: 4, calls: calls[a.id], startedAt: T0, ...(a.id === 'main' || running ? {} : { endedAt: now - 1000 }) }
  })
  ev += 1
  return { v: 1, now, session: { id: 'meals-replay', cwd: 'demo', model: 'claude-opus-5-5', requests: 3, compactions: 0, turn: { running: run.main, startedAt: T0, edits: 0, errors: 0, agents: 2 } }, agents, files: [], events: [{ id: ev, t: now, kind: 'tool', from: 'main', text: 'Read x' }], gate: { allowed: 1, asked: 0, denied: 0, pending: 0 }, tasks: [...tasks.values()], eaten }
}

// ---------------------------------------------------------------- the page
const rows = []
let pageT0 = 0
const shots = []
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId: sess } = await send('Target.attachToTarget', { targetId, flatten: true })
  const S = (m, p, tmo) => send(m, p, sess, tmo)
  await S('Page.enable'); await S('Runtime.enable')
  await S('Emulation.setDeviceMetricsOverride', { width: 360, height: 300, deviceScaleFactor: dsf, mobile: false })
  await S('Emulation.setDefaultBackgroundColorOverride', { color: { r: 44, g: 48, b: 60, a: 1 } })
  await S('Page.addScriptToEvaluateOnNewDocument', { source: "window.addEventListener('error', e => { (window.__errs = window.__errs || []).push(String(e.message)) }); window.addEventListener('unhandledrejection', e => { (window.__errs = window.__errs || []).push('rej ' + e.reason) })" })
  const web = resolve(here, '..', 'plugins', 'crew-graph', 'web', 'index.html')
  const chars = encodeURIComponent('main=crab,scout=bunny,builder=cat')
  const url = pathToFileURL(web).href + `?overlay=1&session=meals-replay&hooks=1&ticker=0&chars=${chars}`
  console.log('load', url)
  await S('Page.navigate', { url })
  await sleep(2500)
  if (reduce) await S('Runtime.evaluate', { expression: 'window.__crewTest.settings().reduceMotion = true' })
  const ready = await S('Runtime.evaluate', { expression: '!!(window.__crewTest && window.__crewTest.tasks && window.__crewUpdate)', returnByValue: true })
  if (!ready.result.value) throw new Error('page not ready: no __crewTest.tasks')
  // the baseline snapshot, then the timeline
  advance(0)
  await S('Runtime.evaluate', { expression: `window.__crewUpdate(${JSON.stringify(snapshot(0))})` })
  await sleep(1500)
  const start = Date.now()
  pageT0 = (await S('Runtime.evaluate', { expression: 'performance.now() / 1000', returnByValue: true })).result.value // the page's clock (its nowS) at second 0 of the script
  let nextSnap = 1, nextShot = 0
  for (;;) {
    const sec = (Date.now() - start) / 1000
    if (sec > secs) break
    if (sec >= nextSnap) {
      advance(sec); nextSnap += 1
      await S('Runtime.evaluate', { expression: `window.__crewUpdate(${JSON.stringify(snapshot(sec))})` })
    }
    const r = await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__crewTest.tasks.counts())', returnByValue: true })
    rows.push({ s: +sec.toFixed(2), c: JSON.parse(r.result.value) })
    if (sec >= nextShot) {
      const p = await S('Page.captureScreenshot', { format: 'png' }, 20000)
      const name = `f-${String(Math.round(nextShot * 100)).padStart(5, '0')}.png`
      writeFileSync(join(frames, name), Buffer.from(p.data, 'base64')); shots.push({ s: +sec.toFixed(2), name, data: p.data })
      nextShot += every
    }
    await sleep(120)
  }
  const errs = await S('Runtime.evaluate', { expression: 'JSON.stringify(window.__errs || [])', returnByValue: true })
  console.log('page errors:', errs.result.value)

  // ---- strips: 8 frames a sheet (4 x 2; 4 as 2 x 2 at --dsf 2), labelled with the second
  const cols = dsf > 1 ? 2 : 4, per = cols * 2
  for (let k = 0; k * per < shots.length; k += 1) {
    const part = shots.slice(k * per, k * per + per)
    const html = `<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${360 * dsf}px);gap:4px">${part.map(x => `<div style="position:relative;width:${360 * dsf}px;height:${300 * dsf}px"><img src="data:image/png;base64,${x.data}" style="display:block;width:${360 * dsf}px"><b style="position:absolute;left:4px;top:2px;font:12px monospace;color:#ffd166">${x.s.toFixed(1)}s</b></div>`).join('')}</body>`
    const { targetId: t2 } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId: s2 } = await send('Target.attachToTarget', { targetId: t2, flatten: true })
    await send('Page.enable', {}, s2)
    await send('Emulation.setDeviceMetricsOverride', { width: cols * 360 * dsf + (cols - 1) * 4, height: 2 * 300 * dsf + 4, deviceScaleFactor: 1, mobile: false }, s2)
    await send('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') }, s2)
    await sleep(500)
    const p = await send('Page.captureScreenshot', { format: 'png' }, s2, 20000)
    writeFileSync(join(out, `strip-${String(k).padStart(2, '0')}.png`), Buffer.from(p.data, 'base64'))
    await send('Target.closeTarget', { targetId: t2 })
  }
} catch (e) { die('FATAL', e) }

// ---------------------------------------------------------------- the numbers
const name = id => (id === 't1' ? 'scout' : id === 't2' ? 'builder' : id)
const plates = []
let last = ''
for (const r of rows) {
  const key = JSON.stringify([r.c.plates, r.c.chips])
  if (key !== last) { last = key; plates.push({ s: r.s, plates: Object.fromEntries(r.c.plates.map(([i, n]) => [name(i), n])), chips: Object.fromEntries(r.c.chips.map(([i, t]) => [name(i), t])) }) }
}
const fin = rows.at(-1)?.c ?? {}
const summary = { reduce, secs, samples: rows.length, frames: shots.length, plateTimeline: plates, bitesByAgent: Object.fromEntries(Object.entries(fin.bites ?? {}).map(([i, n]) => [name(i), n])), maxNoms: Math.max(0, ...rows.map(r => r.c.noms ?? 0)), maxCrumbs: Math.max(0, ...rows.map(r => r.c.crumbs ?? 0)), minBiteGapSec: Object.fromEntries(['main', 't1', 't2'].map(i => { const t = (fin.biteLog ?? []).filter(b => b[0] === i).map(b => b[1]); let g = Infinity; for (let k = 1; k < t.length; k += 1) g = Math.min(g, t[k] - t[k - 1]); return [name(i), g === Infinity ? null : +g.toFixed(3)] })), callsMade: { main: calls.main - 10, scout: calls.t1 - 3, builder: calls.t2 - 2 }, eatOrder: (fin.eats ?? []).map(e => `${(e.t - pageT0).toFixed(1)}s ${e.id} by ${name(e.by)}`), sizes: fin.sizes }
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1))
writeFileSync(join(out, 'rows.json'), JSON.stringify(rows))
console.log(JSON.stringify(summary, null, 1))
cleanup(); setTimeout(() => process.exit(0), 700)
