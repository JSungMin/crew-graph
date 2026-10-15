// web-soak: loads the browser view (web/index.html) in a headless Chrome/Edge for a few minutes and samples it every few seconds over CDP:
// frames run (rAF), heap, DOM and script-element counts, three.js objects and renderer.info, timer lag, long tasks, poll counts, uncaught errors.
// A page that hangs shows up as "HANG" samples (Runtime.evaluate times out). Nothing is shown on screen and no input is sent.
//
//   node tools/web-soak.mjs --dir <folder with a copy of web/*> --query "demo&hooks" --secs 185 --out <dir for rows.json and shots>
//        [--writer 1 --flip 1]   rewrite <dir>/data.js every 450 ms from <dir>/data.base.js (and sessions/<id>.js), like the mod does;
//                                flip 1 alternates it with <dir>/data.base2.js, the way two sessions sharing data.js do
//        [--every 5] [--shots 0,60,120,180] [--chrome <exe>]   (or CREW_CHROME)
// Serve a COPY of web/ (the writer overwrites data.js there). ?hooks is needed for the three.js object counts.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d }
const dir = resolve(arg('dir')); const query = arg('query', ''); const secs = +arg('secs', 180); const every = +arg('every', 5)
const out = resolve(arg('out')); const writer = arg('writer', '0') === '1'; const shotAt = arg('shots', '0,60,120,180').split(',').map(Number)
mkdirSync(out, { recursive: true })
const exe = arg('chrome', process.env.CREW_CHROME) || [
  `${process.env.PROGRAMFILES ?? 'C:/Program Files'}/Google/Chrome/Application/chrome.exe`,
  `${process.env['PROGRAMFILES(X86)'] ?? 'C:/Program Files (x86)'}/Microsoft/Edge/Application/msedge.exe`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium',
].find(p => existsSync(p))
if (!exe) { console.log('no Chrome or Edge found; set CREW_CHROME'); process.exit(1) }
const profile = mkdtempSync(join(tmpdir(), 'wf-'))
const chrome = spawn(exe, ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--window-size=1100,720', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files', '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-extensions', 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: true })
let dead = false
chrome.on('exit', () => { dead = true })
const to = chrome.stdio[3], from = chrome.stdio[4]
let id = 0, buf = ''; const pend = new Map(); const evs = []
from.on('data', d => { buf += d.toString('utf8'); let i; while ((i = buf.indexOf('\0')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) } else evs.push(m) } })
const send = (method, params = {}, sessionId, tmo = 8000) => new Promise((res, rej) => { const i = ++id; const t = setTimeout(() => { pend.delete(i); rej(new Error('timeout ' + method)) }, tmo); pend.set(i, { res: r => { clearTimeout(t); res(r) }, rej: e => { clearTimeout(t); rej(e) } }); to.write(JSON.stringify({ id: i, method, params, sessionId }) + '\0') })
const cleanup = () => { try { chrome.kill() } catch {} ; setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }) } catch {} }, 500) }
process.on('exit', cleanup)

const INSTR = `(() => {
  const P = window.__P = { rafCalls: 0, rafRuns: 0, lastRaf: 0, errs: [], errCount: 0, scriptLoad: 0, scriptErr: 0, upd: 0, lag: [], lt: [], con: 0 };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = cb => { P.rafCalls++; return raf(t => { P.rafRuns++; P.lastRaf = performance.now(); return cb(t); }); };
  addEventListener('error', e => { if (e.target && e.target.tagName === 'SCRIPT') { P.scriptErr++; return; } P.errCount++; if (P.errs.length < 6) P.errs.push((e.message || '') + ' @' + (e.filename || '').split('/').pop() + ':' + e.lineno); }, true);
  addEventListener('load', e => { if (e.target && e.target.tagName === 'SCRIPT') P.scriptLoad++; }, true);
  addEventListener('unhandledrejection', e => { P.errCount++; if (P.errs.length < 6) P.errs.push('rej ' + e.reason); });
  const ce = console.error.bind(console); console.error = (...a) => { P.con++; if (P.errs.length < 6) P.errs.push('console.error ' + a.map(String).join(' ').slice(0, 200)); ce(...a); };
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) P.lt.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch (e) {}
  let last = performance.now(); (function tick() { const n = performance.now(); P.lag.push(n - last - 100); last = n; setTimeout(tick, 100); })();
  let _T, _P; Object.defineProperty(window, 'THREE', { configurable: true, get() { return _P; }, set(v) { _T = v; _P = new Proxy(v, { get(t, k) { if (k === 'WebGLRenderer') { const O = t.WebGLRenderer; const W = function (...a) { const r = new O(...a); window.__r = r; return r; }; W.prototype = O.prototype; return W; } return t[k]; } }); } });
  setInterval(() => { if (window.__crewUpdate && !window.__crewUpdate.__w) { const u = window.__crewUpdate; const w = (s) => { P.upd++; return u(s); }; w.__w = 1; window.__crewUpdate = w; } }, 20);
})();`
const PROBE = `(() => {
  const P = window.__P; if (!P) return null;
  const lag = P.lag.splice(0), lt = P.lt.splice(0);
  const r = { t: performance.now() | 0, rafCalls: P.rafCalls, rafRuns: P.rafRuns, sinceRaf: P.lastRaf ? (performance.now() - P.lastRaf) | 0 : -1, errCount: P.errCount, errs: P.errs.slice(), con: P.con, scriptLoad: P.scriptLoad, scriptErr: P.scriptErr, upd: P.upd,
    dom: document.getElementsByTagName('*').length, scripts: document.getElementsByTagName('script').length, hidden: document.hidden, vis: document.visibilityState,
    lagMax: lag.length ? Math.round(Math.max(...lag)) : null, lagAvg: lag.length ? Math.round(lag.reduce((a, b) => a + b, 0) / lag.length) : null, lagN: lag.length,
    ltN: lt.length, ltSum: Math.round(lt.reduce((a, b) => a + b, 0)), ltMax: Math.round(Math.max(0, ...lt)) };
  const rr = window.__r; if (rr) { const i = rr.info; r.geo = i.memory.geometries; r.tex = i.memory.textures; r.prog = i.programs ? i.programs.length : null; r.calls = i.render.calls; r.tris = i.render.triangles; }
  const T = window.__crewTest; if (T && T.scene) { let n = 0; const g = new Set(), m = new Set(), tx = new Set(); T.scene.traverse(o => { n++; if (o.geometry) g.add(o.geometry); const mm = o.material; (Array.isArray(mm) ? mm : mm ? [mm] : []).forEach(x => { m.add(x); for (const k in x) if (x[k] && x[k].isTexture) tx.add(x[k]); }); }); r.objs = n; r.sg = g.size; r.sm = m.size; r.stx = tx.size; r.agents = T.agents.size; r.files = T.files.size;
    try { r.rfx = T.rfx.length } catch (e) {} }
  if (performance.memory) r.js = performance.memory.usedJSHeapSize;
  return r;
})()`

const rows = []
let hangDiag = false
async function diagnose(S, row) {
  console.log('--- HANG at', row.s, 's: diagnosing')
  try {
    const p1 = await send('SystemInfo.getProcessInfo', {}, undefined, 6000); await new Promise(r => setTimeout(r, 3000)); const p2 = await send('SystemInfo.getProcessInfo', {}, undefined, 6000)
    const m1 = new Map(p1.processInfo.map(p => [p.id, p])); row.procs = p2.processInfo.map(p => ({ type: p.type, id: p.id, cpuDeltaSecIn3s: +(p.cpuTime - (m1.get(p.id)?.cpuTime ?? p.cpuTime)).toFixed(2) }))
    console.log('procs', JSON.stringify(row.procs))
  } catch (e) { console.log('procinfo fail', e.message) }
  try {
    await S('Debugger.enable', {}, 6000)
    const pausedP = new Promise(res => { const t0 = Date.now(); const iv = setInterval(() => { const i = evs.findIndex(m => m.method === 'Debugger.paused'); if (i >= 0) { clearInterval(iv); res(evs[i]) } else if (Date.now() - t0 > 8000) { clearInterval(iv); res(null) } }, 50) })
    send('Debugger.pause', {}, sess, 8000).catch(() => {})
    const pm = await pausedP
    if (pm) { row.stack = pm.params.callFrames.slice(0, 12).map(f => `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.location.lineNumber + 1}:${f.location.columnNumber}`); console.log('PAUSED stack:'); row.stack.forEach(x => console.log('  ' + x)) }
    else console.log('Debugger.pause did not fire in 8s (not stuck in JS?)')
  } catch (e) { console.log('debugger fail', e.message) }
}
let sess
try {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }); sess = sessionId
  const S = (m, p, tmo) => send(m, p, sess, tmo)
  await S('Page.enable'); await S('Runtime.enable'); await S('Performance.enable'); await S('Emulation.setDeviceMetricsOverride', { width: 1100, height: 720, deviceScaleFactor: 1, mobile: false })
  await S('Page.addScriptToEvaluateOnNewDocument', { source: INSTR })
  const url = pathToFileURL(join(dir, 'index.html')).href + (query ? '?' + query : '')
  console.log('load', url)
  await S('Page.navigate', { url })
  // writer: rewrite data.js every 450 ms with small changes, like the mod
  let wtimer = null, wn = 0
  if (writer) {
    const load = f => { const src = readFileSync(join(dir, f), 'utf8'); const j = JSON.parse(src.slice(src.indexOf('(') + 1, src.lastIndexOf(')'))); j.__eid = Math.max(0, ...j.events.map(e => e.id)); return j }
    const J = [load('data.base.js')]; if (arg('flip', '0') === '1') J.push(load('data.base2.js'))
    wtimer = setInterval(() => {
      wn++; const j = J[wn % J.length]
      j.now = Date.now(); j.session.requests = (j.session.requests || 0) + (wn % 7 === 0 ? 1 : 0)
      j.events.push({ kind: wn % 3 ? 'tool' : 'read', from: 'main', tool: 'Bash', text: 'step ' + wn, t: Date.now(), id: ++j.__eid }); if (j.events.length > 200) j.events.shift()
      j.agents.forEach(a => { if (a.status === 'running') { a.steps = (a.steps || 0) + 1; a.calls = (a.calls || 0) + (wn % 2) } })
      if (j.session.ctx) j.session.ctx.used += 37
      const body = 'window.__crewUpdate && window.__crewUpdate(' + JSON.stringify(j) + ');\n'
      try { writeFileSync(join(dir, 'data.tmp'), body); renameSync(join(dir, 'data.tmp'), join(dir, 'data.js')) } catch (e) { try { writeFileSync(join(dir, 'data.js'), body) } catch (e2) {} }
      try { mkdirSync(join(dir, 'sessions'), { recursive: true }); writeFileSync(join(dir, 'sessions', j.session.id + '.js'), body) } catch (e) {}
    }, 450)
  }
  const t1 = Date.now()
  const shotsDone = new Set()
  for (let s = 0; s <= secs; s += every) {
    const target = t1 + s * 1000; const wait = target - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait))
    if (dead) { rows.push({ s, dead: true }); break }
    const row = { s }
    try {
      const v = await S('Runtime.evaluate', { expression: PROBE, returnByValue: true }, 6000)
      Object.assign(row, v.result.value || { noProbe: true })
      const hu = await S('Runtime.getHeapUsage', {}, 6000); row.heapUsed = hu.usedSize; row.heapTotal = hu.totalSize
      const pm = await S('Performance.getMetrics', {}, 6000); const m = Object.fromEntries(pm.metrics.map(x => [x.name, x.value])); row.nodes = m.Nodes; row.listeners = m.JSEventListeners; row.taskDur = +(m.TaskDuration).toFixed(2); row.scriptDur = +(m.ScriptDuration).toFixed(2); row.layoutCount = m.LayoutCount
    } catch (e) { row.hang = String(e.message); if (!hangDiag) { hangDiag = true; await diagnose(S, row) } }
    for (const sh of shotAt) if (s >= sh && !shotsDone.has(sh)) { shotsDone.add(sh); try { const r = await S('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, 10000); writeFileSync(join(out, `shot-${sh}.jpg`), Buffer.from(r.data, 'base64')) } catch (e) { row.shotErr = e.message } }
    rows.push(row)
    const f = x => (x == null ? '-' : x)
    console.log(`${String(s).padStart(4)}s raf=${f(row.rafRuns)} since=${f(row.sinceRaf)} heap=${row.heapUsed ? (row.heapUsed / 1048576).toFixed(1) : '-'}M dom=${f(row.dom)} scr=${f(row.scripts)} objs=${f(row.objs)} geo=${f(row.geo)} tex=${f(row.tex)} prog=${f(row.prog)} upd=${f(row.upd)} sErr=${f(row.scriptErr)} lagMax=${f(row.lagMax)} lt=${f(row.ltN)}/${f(row.ltMax)} err=${f(row.errCount)} ${row.hang ? 'HANG ' + row.hang : ''}${row.errs && row.errs.length ? ' ERRS=' + JSON.stringify(row.errs) : ''}`)
  }
  if (wtimer) clearInterval(wtimer)
  try { await S('HeapProfiler.collectGarbage', {}, 15000); const hu = await S('Runtime.getHeapUsage', {}, 6000); rows.push({ s: 'afterGC', heapUsed: hu.usedSize }); console.log('after GC heap', (hu.usedSize / 1048576).toFixed(1) + 'M') } catch (e) { console.log('gc fail', e.message) }
} catch (e) { console.log('FATAL', e.message) }
writeFileSync(join(out, 'rows.json'), JSON.stringify(rows, null, 1))
cleanup(); setTimeout(() => process.exit(0), 700)
