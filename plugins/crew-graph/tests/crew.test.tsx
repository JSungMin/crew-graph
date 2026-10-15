import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bigFrame, miniFrame } from '../hooks/clawd'
import { toEvent } from '../hooks/input3d'
import { encodeCells, inkOf } from '../bin/cells.mjs'
import { absPath, clip, describeCall, kindOf, pushEvent, scrollbar, snapshotOf, titleOf, touchFile, withAbs } from '../hooks/crew'
import { DEFAULT_ARCHITECT, DEFAULT_GATE, DEFAULT_MAIN, DEFAULT_TURN, DEFAULT_USAGE, normalizeCard, parseConfig } from '../hooks/deck/core'
import { allowedFiles, isOpenable, makeActions, norm, parseDataJs } from '../overlay/actions.mjs'
import { summarize, summarizeFile } from '../overlay/summary.mjs'

// ---------------------------------------------------------------- pure behaviour

test('files are sorted into plans, docs and code', () => {
  expect(['plans/a.md', 'docs/x.ts', 'spec-v2.md', 'README.md', 'src/a.ts', 'journal/2026.d4a'].map(kindOf)).toEqual([
    'plan',
    'doc',
    'plan',
    'doc',
    'code',
    'doc',
  ])
})

test('a read then a write by one loop becomes rw, and the file moves to the front', () => {
  let list = touchFile([], 'plans/p.md', 'main', 'r', 1)
  list = touchFile(list, 'src/a.ts', 'a1', 'w', 2)
  list = touchFile(list, 'plans/p.md', 'main', 'w', 3)
  expect(list.map(n => n.path)).toEqual(['plans/p.md', 'src/a.ts'])
  expect(list[0]?.by).toEqual({ main: 'rw' })
})

test('tool calls read as crab verbs, and shell commands are masked', () => {
  expect(describeCall('Read', { file_path: '/w/plans/p.md' }, '/w')).toMatchObject({ verb: 'read', target: 'plans/p.md', op: 'r' })
  expect(describeCall('Grep', { pattern: 'register' }, '/w').verb).toBe('search')
  expect(describeCall('Bash', { command: 'curl -H "Authorization: Bearer abcdefgh12345" x' }, '/w').target).not.toContain('abcdefgh')
  expect(describeCall('Agent', { subagent_type: 'Explore', description: 'look' }, '/w')).toMatchObject({ verb: 'spawn' })
  expect(describeCall('ExitPlanMode', {}, '/w').verb).toBe('plan')
})

test('clipping counts Hangul as two cells', () => {
  expect(clip('업무일지자동화', 7)).toBe('업무일…')
  expect(clip('  indent kept', 40)).toBe('  indent kept')
})

test('every Clawd frame keeps its width, so the crab never jitters', () => {
  for (const v of ['think', 'read', 'edit', 'search', 'run', 'web', 'spawn', 'plan', 'done', 'failed', 'wait'] as const) {
    for (const f of [0, 1]) {
      expect(bigFrame(v, f).map(r => [...r].length)).toEqual([9, 9, 9])
      expect([...miniFrame(v, f)].length).toBe(5)
    }
  }
})

test('events get increasing ids and keep the last 200', () => {
  let ev = pushEvent([], { t: 0, kind: 'prompt', from: 'main', text: 'go' })
  for (let i = 0; i < 250; i += 1) ev = pushEvent(ev, { t: i, kind: 'tool', from: 'main', text: 'x' })
  expect(ev.length).toBe(200)
  expect(ev[ev.length - 1]?.id).toBe(251)
})

test('the web snapshot puts main at the root and children under their parent', () => {
  const card = (id: string) => ({ ...normalizeCard({}), id, type: 'Explore', description: id, spawnedAt: 5 })
  const snap = snapshotOf({
    now: 10,
    sessionId: 's',
    cwd: 'G:/work/my-proj',
    main: { ...DEFAULT_MAIN, model: 'claude-opus-5-5', isRunning: true },
    usage: { ...DEFAULT_USAGE, tokens: 1000, window: 200000 },
    architect: DEFAULT_ARCHITECT,
    gate: DEFAULT_GATE,
    cards: [card('a1'), card('a2')],
    architectIds: [],
    acts: { a2: { key: 'a2', verb: 'read', tool: 'Read', target: 'x.md', since: 7, calls: 1 } },
    files: [],
    events: [],
    parents: { a1: 'main', a2: 'a1' },
    turn: { ...DEFAULT_TURN, startedAt: 1 },
    receipt: null,
  })
  expect(snap.session.cwd).toBe('my-proj')
  expect(snap.agents.map(a => [a.id, a.parentId])).toEqual([
    ['main', null],
    ['a1', 'main'],
    ['a2', 'a1'],
  ])
  expect(snap.agents[2]?.verb).toBe('read')
  expect(snap.session.ctx).toEqual({ used: 1000, max: 200000 })
})

// ---------------------------------------------------------------- drawing

const engine = (on: On, opens = { n: 0 }) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => {
    opens.n += 1
    return { value: { isPlaced: true } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  return clock
}

const pane = (bodyColumns: number) => ({
  plugin: 'crew-graph',
  component: 'Pane' as const,
  requestId: 'crew-graph',
  props: {
    title: 'Crew',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
})

const spawn = (subagentType: string, description: string, tool_use_id: string) => ({
  prompt: description,
  description,
  subagentType,
  tool_use_id,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

test('the crew panel hangs a subagent under main and links the plan it read', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.tool.call({ tool: 'Read', file_path: 'plans/plan.md' })
  await $.agent.spawn(spawn('Explore', '훅 위치 찾기', 's1'))
  // A subagent's call is a tool.call carrying its loop's agentId, as a session raises it.
  const fromSubagent = { tool: 'Grep', pattern: 'register', agentId: 'x1' } as unknown as Parameters<typeof $.tool.call>[0]
  await $.tool.call(fromSubagent)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...pane(70), surface })
    expect(await ui.find({ text: /^crew$/ })).toBeDefined()
    expect(await ui.find({ text: /^└─$/ })).toBeDefined()
    expect(await ui.find({ text: / Explore$/ })).toBeDefined()
    expect(await ui.find({ text: /search register/ })).toBeDefined()
    expect(await ui.find({ text: /plans\/plan\.md/ })).toBeDefined()
    expect(await ui.find({ text: /main:r/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the pane opens by itself on the first subagent only', async ($, on) => {
  const opens = { n: 0 }
  engine(on, opens)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' }).catch(() => undefined)
  const before = opens.n
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'a', prompt: 'p' })
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: 'b', prompt: 'p' })
  expect(opens.n - before).toBe(1)
})

test('/crew web copies the viewer and writes data.js for the browser', async ($, on) => {
  engine(on)
  const written = new Map<string, string>()
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', (_$, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'sess-1' }))
  await $.turn.start({ text: 'go', turnId: 'W1' })
  const { text } = await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  expect(text).toContain('C:/Users/me/.claude/crew-graph/index.html')
  expect([...written.keys()].filter(k => k.endsWith('three.min.js')).length).toBe(1)
  // The host hands fs.write the path in the OS's own spelling.
  const data = [...written].find(([k]) => k.replace(/\\/g, '/') === 'C:/Users/me/.claude/crew-graph/data.js')?.[1] ?? ''
  expect(data.startsWith('window.__crewUpdate && window.__crewUpdate(')).toBe(true)
  const snap = JSON.parse(data.slice(data.indexOf('(', 30) + 1, data.lastIndexOf(')')))
  expect(snap.agents[0].id).toBe('main')
  expect(snap.events.some((x: { kind: string }) => x.kind === 'prompt')).toBe(true)
  // The session's first prompt names it; every session also gets its own file for the desktop pet windows.
  expect(snap.session.title).toBe('go')
  const own = [...written].find(([k]) => k.replace(/\\/g, '/') === 'C:/Users/me/.claude/crew-graph/sessions/sess-1.js')?.[1]
  expect(own).toBe(data)
})

const USER_DIR = 'C:/Users/me/.claude/crew-graph'

/** The mocks a character test needs: a home folder, a characters folder holding what `files` says, and every write recorded. */
function charactersHost(on: On, files: Record<string, string>) {
  const written = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => {
    const name = norm(e.path).split('/').pop() ?? ''
    if (norm(e.path).startsWith(`${USER_DIR}/characters/`)) return { value: e.as === 'bytes' ? { base64: btoa(files[name] ?? '') } : (files[name] ?? '') }
    return { value: `// ${e.path}` }
  })
  on('fs.write', (_$, e) => {
    written.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: written.has(norm(e.path)) }))
  on('fs.list', (_$, e) => ({
    value: norm(e.path) === `${USER_DIR}/characters` ? Object.keys(files).map(name => ({ name, kind: 'file' as const, size: files[name]?.length ?? 0, mtimeMs: 5000, isLink: false })) : [],
  }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'sess-c' }))
  return written
}

test('/crew web makes the characters folder with its README and writes the manifest the viewer loads', async ($, on) => {
  engine(on)
  const written = charactersHost(on, { 'mine.json': '{"id":"mine","bones":{"body":{"boxes":[]}}}', 'puff.glb': 'GLBDATA' })
  await $.turn.start({ text: 'go', turnId: 'C1' })
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  const readme = written.get(`${USER_DIR}/characters/README.txt`) ?? ''
  expect(readme).toContain('crew-graph characters')
  const manifest = written.get(`${USER_DIR}/characters-user.js`) ?? ''
  expect(manifest).toContain('window.__crewUserCharacters = [')
  expect(manifest).toContain('"id":"mine"')
  expect(manifest).toContain('"glb":{"file":"characters/puff.glb","parts":1,"bytes":7}')
  expect(written.get(`${USER_DIR}/characters-glb/puff.0.js`)).toContain(btoa('GLBDATA'))
  // the viewer's own files go along: loader, character code, built-ins
  for (const f of ['gltf-loader.classic.js', 'characters-core.js', 'characters.js']) expect(written.has(`${USER_DIR}/${f}`)).toBe(true)
})

test('/crew characters lists, /crew characters reload rescans and rewrites the manifest', async ($, on) => {
  engine(on)
  const written = charactersHost(on, { 'a.json': '{"id":"mybot","bones":{"body":{"boxes":[]}}}', 'broken.json': '{' })
  await $.turn.start({ text: 'go', turnId: 'C2' })
  const listed = await $.command.run({ command: 'crew', args: 'characters' } as never)
  expect(listed.text).toContain('Built-in: crab')
  expect(listed.text).toContain('mybot  voxel  a.json')
  expect(listed.text).toContain('broken.json  ERROR  (not loaded)')
  expect(listed.text).toContain('Not valid JSON')
  expect(listed.text).toContain('fix: ') // every problem comes with what to change
  expect(listed.text).toContain('every agent is a crab') // no option set
  expect(written.has(`${USER_DIR}/characters-user.js`)).toBe(false) // listing writes nothing
  const reloaded = await $.command.run({ command: 'crew', args: 'characters reload' } as never)
  expect(reloaded.text).toContain('Rescanned')
  expect(written.get(`${USER_DIR}/characters-user.js`)).toContain('"id":"mybot"')
  const manifest = written.get(`${USER_DIR}/characters-user.js`) ?? ''
  expect(manifest).toContain('window.__crewUserPacks = [') // every file, also the one that did not load
  expect(manifest).toContain('"file":"broken.json"')
  expect(manifest).toContain('"code":"bad-json"')
  expect(manifest).toMatch(/window\.__crewUserScanned = \d+;/)
})

test('a session title is its first prompt on one line, shortened, credentials masked', () => {
  expect(titleOf('  Refactor\nthe   loader\t please ')).toBe('Refactor the loader please')
  expect(titleOf('x'.repeat(80)).length).toBeLessThanOrEqual(32)
  expect(titleOf('use curl -H "Authorization: Bearer abcdefgh12345678" now')).not.toContain('abcdefgh')
  expect(titleOf('설정 로더를 고치고 문서도 같이 정리해서 올려줘 그리고 또')).toContain('…')
})

test('/crew 3d streams the renderer frames into the pane raster', async ($, on) => {
  const clock = engine(on)
  const blits: { key: string; columns?: number; rows?: number }[] = []
  let spawned: readonly string[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? '/home/me' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: 's3d' }))
  on('ui.blit', (_$, e) => {
    blits.push({ key: e.key, columns: e.columns, rows: e.rows })
    return { value: {} }
  })
  // 20x8 cells of '▀' on black/white, as bin/crew-3d.mjs prints them.
  const words = new Uint32Array(20 * 8 * 3)
  for (let i = 0; i < 160; i += 1) words.set([0x2580, 0x000000, 0xffffff], i * 3)
  let bin = ''
  for (const b of new Uint8Array(words.buffer)) bin += String.fromCharCode(b)
  const cells = btoa(bin)
  on('process.spawn', async function* (_$, e) {
    spawned = e.argv
    yield { stream: 'stdout' as const, text: `C 20 8 ${cells.slice(0, 100)}` }
    yield { stream: 'stdout' as const, text: `${cells.slice(100)}\nC 20 ` }
    yield { stream: 'stdout' as const, text: `8 ${cells}\n` }
    return { value: { code: 0, signal: null } }
  })
  const { text } = await $.command.run({ command: 'crew', args: '3d 20' } as never)
  expect(text).toContain('20x28')
  // Let the renderer loop drain its pieces.
  for (let i = 0; i < 20 && blits.length < 2; i += 1) await clock.advance(10)
  expect(spawned.some(a => a.endsWith('bin/crew-3d.mjs'))).toBe(true)
  expect(spawned.join(' ')).toContain('--cols 20')
  expect(blits.length).toBe(2)
  expect(blits[0]).toEqual({ key: 'crew3d', columns: 20, rows: 8 })
})

test('pane pointer events become view fractions for the renderer', () => {
  expect(toEvent({ type: 'down', x: 9, y: 4, button: 'left' }, 20, 10)).toEqual({
    kind: 'down',
    button: 'left',
    x: 0.475,
    y: 0.45,
    shift: undefined,
    alt: undefined,
    ctrl: undefined,
  })
  // Fine positions win where the terminal reports pixels; the edges clamp.
  expect(toEvent({ type: 'move', x: 0, y: 0, fine: { x: 5, y: 2.5 } }, 20, 10)).toMatchObject({ kind: 'move', x: 0.25, y: 0.25 })
  expect(toEvent({ type: 'enter', x: 40, y: 0 }, 20, 10)).toMatchObject({ kind: 'move', x: 1 })
  expect(toEvent({ type: 'leave', x: 3, y: 3, shift: true }, 20, 10)).toMatchObject({ kind: 'leave', shift: true })
})

test('the 3D cells follow an edge to an eighth of the cell and stay within the colour pairs', () => {
  // One cell, 4x8 pixels: dark above, orange from the fourth row down (the lower 5/8).
  const rgb = new Uint8Array(4 * 8 * 3)
  for (let y = 3; y < 8; y += 1) for (let x = 0; x < 4; x += 1) rgb.set([255, 128, 0], (y * 4 + x) * 3)
  const one = encodeCells(rgb, 1, 1)
  expect(Array.from(one.cells)).toEqual([0x2585, 0xff8000, 0x000000])
  expect(inkOf(0x2585)?.length).toBe(20)
  // The quadrant set can only split it in halves.
  expect([0x2580, 0x2584]).toContain(encodeCells(rgb, 1, 1, { glyphs: 'quad' }).cells[0])
  // 64 cells of distinct colours, at most 60 pairs: bits are dropped until it fits.
  const many = new Uint8Array(64 * 32 * 3)
  for (let c = 0; c < 64; c += 1) {
    for (let k = 0; k < 32; k += 1) {
      const i = ((Math.floor(k / 4) * 64 * 4) + c * 4 + (k % 4)) * 3
      many.set([c * 4, 255 - c * 4, (c * 37) % 256], i)
    }
  }
  const capped = encodeCells(many, 64, 1, { maxPairs: 60 })
  expect(encodeCells(many, 64, 1).pairs).toBe(64)
  expect(capped.pairs).toBeLessThanOrEqual(60)
  expect(capped.bits).toBeLessThan(8)
})

test('/crew web inside Orca opens an Orca browser tab', async ($, on) => {
  engine(on)
  const runs: (readonly string[])[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'TERM_PROGRAM' ? 'Orca' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: '{"ok":true}', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.id', () => ({ value: 'sess-o' }))
  const { text } = await $.command.run({ command: 'crew', args: 'web' } as never)
  expect(text).toContain('Orca browser tab')
  expect(runs).toEqual([['orca', 'tab', 'create', '--url', 'file:///C:/Users/me/.claude/crew-graph/index.html', '--json']])
})

test('the pane scrollbar: a thumb sized to the window, at its place, none when the tree fits', () => {
  expect(scrollbar(0, 10, 10)).toBeNull()
  expect(scrollbar(0, 10, 40)).toEqual({ top: 0, thumbTop: 0, thumbLen: 3 })
  expect(scrollbar(30, 10, 40)).toEqual({ top: 30, thumbTop: 7, thumbLen: 3 })
  // An offset past the end clamps, so the bar never makes the tree taller.
  expect(scrollbar(99, 10, 40)?.top).toBe(30)
})

test('a docked pane taller than its window draws a scrollbar once the tree is measured', async ($, on) => {
  engine(on)
  on('ui.scroll', () => ({}))
  await $.turn.start({ text: 'go', turnId: 'S1' })
  const short = { ...pane(70), props: { ...pane(70).props, scroll: { offset: 0, bodyRows: 12 } } }
  const before = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await before.find({ text: /┃/ })).toBeUndefined()
  await before.unmount()
  await $.ui.scroll({ component: 'Pane', requestId: 'crew-graph', offset: 0, by: 1, bodyRows: 12, contentRows: 48, origin: { kind: 'person' } } as never)
  const after = await $.ui.mount({ ...short, surface: 'terminal' })
  expect(await after.find({ text: /┃/ })).toBeDefined()
  await after.unmount()
})

// ---------------------------------------------------------------- desktop pet

const ok = { exitCode: 0, stdout: 'ok 4242', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
// The host spells paths its own way (backslashes on Windows).
const isElectron = (p: string) => p.replace(/\\/g, '/').endsWith('node_modules/electron/dist/electron.exe')

test('/crew pet starts the overlay through launch.mjs and says how to use it', async ($, on) => {
  engine(on)
  const runs: { argv: readonly string[]; cwd?: string }[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'OS' ? 'Windows_NT' : e.name === 'TERM_PROGRAM' ? 'Orca' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: isElectron(e.path) }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd })
    return { value: ok }
  })
  on('session.id', () => ({ value: 'sess-p1' }))
  const { text } = await $.command.run({ command: 'crew', args: 'pet' } as never)
  const launch = runs.find(r => /overlay[/\\]launch\.mjs$/.test(r.argv[1] ?? ''))
  expect(launch?.argv[0]).toBe('node')
  const a = launch?.argv ?? []
  const main = a[a.indexOf('--main') + 1] ?? ''
  expect(a.slice(2)).toEqual([
    '--electron',
    'C:/Users/me/.claude/crew-graph/overlay-runtime/node_modules/electron/dist/electron.exe',
    '--main',
    main,
    '--page',
    'C:/Users/me/.claude/crew-graph/index.html',
    '--state',
    'C:/Users/me/.claude/crew-graph/overlay',
    '--session',
    'sess-p1',
    '--token',
    expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
    '--orca',
  ])
  expect(main).toMatch(/overlay[/\\]main\.js$/)
  // Electron was there: no npm.
  expect(runs.some(r => r.argv.includes('npm'))).toBe(false)
  for (const w of ['carry', 'pinch', 'pet', 'rotate', 'zoom', 'resize', 'menu', '/crew pet off']) expect(text).toContain(w)
})

/** A runtime folder as the mod sees it: Electron appears when install.js has run; install.lock keeps what the mod wrote (or what "another session" put there). */
const petHost = (on: On, opts: { lock?: string; session?: string; npmFails?: string } = {}) => {
  const runs: { argv: readonly string[]; cwd?: string; timeoutMs?: number }[] = []
  const written: { path: string; text: string }[] = []
  const toasts: string[] = []
  const state = { installed: false, lock: opts.lock ?? '' }
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: /install\.lock$/.test(e.path) ? state.lock : `// ${e.path}` }))
  on('fs.write', (_$, e) => {
    written.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    if (/install\.lock$/.test(e.path)) state.lock = e.text
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: state.installed && isElectron(e.path) }))
  on('process.run', (_$, e) => {
    runs.push({ argv: e.argv, cwd: e.init?.cwd, timeoutMs: e.init?.timeoutMs })
    if (opts.npmFails && e.argv.includes('npm')) return { value: { ...ok, exitCode: 1, stdout: '', stderr: opts.npmFails } }
    if (e.argv[1] === 'node_modules/electron/install.js') state.installed = true
    return { value: ok }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  on('session.id', () => ({ value: opts.session ?? 'sess-p2' }))
  return { runs, written, toasts, state }
}
const launched = (runs: { argv: readonly string[] }[]) => runs.filter(r => r.argv[1]?.endsWith('launch.mjs'))

test('/crew pet without Electron installs it into the runtime folder first, then starts', async ($, on) => {
  const clock = engine(on)
  const { runs, written, toasts, state } = petHost(on)
  const { text } = await $.command.run({ command: 'crew', args: 'pet' } as never)
  expect(text).toContain('44.4.5')
  for (let i = 0; i < 40 && launched(runs).length === 0; i += 1) await clock.advance(10)
  await clock.advance(10)
  expect(written.some(w => w.path === 'C:/Users/me/.claude/crew-graph/overlay-runtime/README.txt')).toBe(true)
  const npm = runs[0]
  // process.run has no shell: npm is reached through cmd on Windows.
  expect(npm?.argv).toEqual(['cmd', '/c', 'npm', 'install', '--no-audit', '--no-fund', '--prefix', '.', 'electron@44.4.5'])
  expect(npm?.cwd).toBe('C:/Users/me/.claude/crew-graph/overlay-runtime')
  expect(npm?.timeoutMs).toBe(600_000)
  expect(runs[1]?.argv).toEqual(['node', 'node_modules/electron/install.js'])
  // the same chain opens the pet: launch.mjs with this session's id, once
  expect(launched(runs).length).toBe(1)
  const launch = launched(runs)[0]?.argv ?? []
  expect(launch.slice(launch.indexOf('--session'), launch.indexOf('--session') + 2)).toEqual(['--session', 'sess-p2'])
  expect(launch).toContain('--electron')
  // toasts: installing at the start, ready at the end; the lock was taken for the install and let go after it
  expect(toasts.some(x => x.includes('installing Electron (~100 MB)'))).toBe(true)
  expect(toasts.at(-1)).toContain('ready')
  expect(written.filter(w => w.path.endsWith('install.lock')).map(w => w.text.split(':')[0])).toEqual(['held', 'free'])
  expect(state.lock.startsWith('free:')).toBe(true)
})

test('a failed install ends with the error and its tail, takes the lock off, and opens nothing', async ($, on) => {
  const clock = engine(on)
  const { runs, toasts, state } = petHost(on, { npmFails: 'npm ERR! network offline\nnpm ERR! last line' })
  await $.command.run({ command: 'crew', args: 'pet' } as never)
  for (let i = 0; i < 40; i += 1) await clock.advance(10)
  expect(launched(runs).length).toBe(0)
  expect(toasts.some(x => x.includes('npm install electron@44.4.5 failed') && x.includes('npm ERR! last line'))).toBe(true)
  expect(state.lock.startsWith('free:')).toBe(true)
})

test('a second session that starts while another installs waits for it, then opens its own window; it never runs npm', async ($, on) => {
  const clock = engine(on)
  // "another session" took the lock a moment ago (the engine's clock starts at 0, so a held lock at 0 is fresh)
  const { runs, toasts, state } = petHost(on, { lock: 'held:other-session-1:0', session: 'sess-second' })
  const { text } = await $.command.run({ command: 'crew', args: 'pet' } as never)
  expect(text).toContain('44.4.5')
  await clock.advance(5000)
  expect(runs.some(r => r.argv.includes('npm'))).toBe(false)
  expect(launched(runs).length).toBe(0)
  expect(toasts.some(x => x.includes('another session is installing Electron'))).toBe(true)
  // the other session finishes: Electron is there and the lock is free
  state.installed = true
  state.lock = 'free:4000'
  for (let i = 0; i < 20 && launched(runs).length === 0; i += 1) await clock.advance(2000)
  expect(runs.some(r => r.argv.includes('npm'))).toBe(false)
  const launch = launched(runs)[0]?.argv ?? []
  expect(launch.slice(launch.indexOf('--session'), launch.indexOf('--session') + 2)).toEqual(['--session', 'sess-second'])
  expect(toasts.at(-1)).toContain('ready')
})

test('a lock older than 15 minutes is a crashed install: the next session takes it over and installs', async ($, on) => {
  const clock = engine(on)
  const { runs, state } = petHost(on, { lock: 'held:crashed-1:0' })
  await clock.advance(16 * 60_000)
  await $.command.run({ command: 'crew', args: 'pet' } as never)
  for (let i = 0; i < 40 && launched(runs).length === 0; i += 1) await clock.advance(10)
  expect(runs.some(r => r.argv.includes('npm'))).toBe(true)
  expect(launched(runs).length).toBe(1)
  expect(state.lock.startsWith('free:')).toBe(true)
})

test('/crew pet twice in one session starts one install', async ($, on) => {
  const clock = engine(on)
  const { runs } = petHost(on)
  const [a, b] = await Promise.all([$.command.run({ command: 'crew', args: 'pet' } as never), $.command.run({ command: 'crew', args: 'pet' } as never)])
  const texts = [a, b].map(r => r?.text ?? '')
  expect(texts.filter(x => x.includes('Installing Electron')).length).toBe(1)
  expect(texts.filter(x => x.includes('still downloading')).length).toBe(1)
  for (let i = 0; i < 40 && launched(runs).length === 0; i += 1) await clock.advance(10)
  expect(runs.filter(r => r.argv.includes('npm')).length).toBe(1)
  expect(launched(runs).length).toBe(1)
})

test('/crew pet off closes the window of this session, /crew pet off all quits the pet', async ($, on) => {
  engine(on)
  const runs: (readonly string[])[] = []
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? '/home/me' : undefined }))
  on('session.id', () => ({ value: 'sess-p4' }))
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: ok }
  })
  const one = await $.command.run({ command: 'crew', args: 'pet off' } as never)
  expect(one.text).toContain('window closed')
  expect(runs.length).toBe(1)
  expect(runs[0]?.[0]).toBe('node')
  expect(runs[0]?.[1]).toMatch(/overlay[/\\]launch\.mjs$/)
  expect(runs[0]?.slice(2)).toEqual(['--state', '/home/me/.claude/crew-graph/overlay', '--close', 'sess-p4'])
  const all = await $.command.run({ command: 'crew', args: 'pet off all' } as never)
  expect(all.text).toContain('every window')
  expect(runs[1]?.slice(2)).toEqual(['--state', '/home/me/.claude/crew-graph/overlay', '--quit'])
})

test('a "show in Crew pane" request from the pet opens a focus panel for a file the crew touched', async ($, on) => {
  const clock = engine(on)
  let inbox = ''
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('pet-inbox-sess-p3.json') ? inbox : `// ${e.path}` }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.exists', (_$, e) => ({ value: /electron\.exe$/.test(e.path) }))
  on('process.run', () => ({ value: ok }))
  on('session.id', () => ({ value: 'sess-p3' }))
  await $.turn.start({ text: 'go', turnId: 'F1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:/w/src/focus-me.ts' })
  await $.command.run({ command: 'crew', args: 'pet' } as never)
  const summary = { title: 'Focus title', lead: 'what this file is for', heads: [], decls: ['alpha', 'beta'] }
  const at = Number.MAX_SAFE_INTEGER
  // A file the crew never touched is ignored.
  inbox = JSON.stringify({ seq: 90001, at, kind: 'focus-file', abs: 'C:/elsewhere/secret.txt', path: 'secret.txt', summary })
  await clock.advance(1100)
  const none = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await none.find({ text: /secret\.txt/ })).toBeUndefined()
  await none.unmount()
  inbox = JSON.stringify({ seq: 90002, at, kind: 'focus-file', abs: 'C:/w/src/focus-me.ts', path: 'focus-me.ts', summary })
  await clock.advance(1100)
  const shown = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await shown.find({ text: /focus .*focus-me\.ts/ })).toBeDefined()
  expect(await shown.find({ text: /Focus title/ })).toBeDefined()
  expect(await shown.find({ text: /alpha . beta/ })).toBeDefined()
  await shown.unmount()
  await $.command.run({ command: 'crew', args: 'pet off' } as never)
})

test('FileNode carries the absolute path, relative ones taken from the working directory', () => {
  expect(absPath('C:\\w\\a.ts', '')).toBe('C:/w/a.ts')
  expect(absPath('src/a.ts', 'C:\\w\\proj\\')).toBe('C:/w/proj/src/a.ts')
  expect(absPath('/home/me/a.ts', '/x')).toBe('/home/me/a.ts')
  expect(absPath('a.ts', '')).toBeUndefined()
  const list = touchFile([], 'src/a.ts', 'main', 'r', 1, 'C:/w/src/a.ts')
  expect(list[0]?.abs).toBe('C:/w/src/a.ts')
  // Touching it again without a path keeps the one it had; older state without one stays valid.
  expect(touchFile(list, 'src/a.ts', 'main', 'w', 2)[0]?.abs).toBe('C:/w/src/a.ts')
  expect(touchFile([], 'b.ts', 'main', 'r', 1)[0]).not.toHaveProperty('abs')
})

test('petOnStart is off unless the config turns it on', () => {
  expect(parseConfig({}).petOnStart).toBe(false)
  expect(parseConfig({ petOnStart: true }).petOnStart).toBe(true)
  expect(parseConfig({ petOnStart: 'yes' }).petOnStart).toBe(false)
})

test('a markdown file is summarized by its title, first paragraph and headings', () => {
  const md = ['---', 'tag: x', '---', '# The **Crew** guide', '', 'First line of the', 'intro paragraph, with a [link](http://x).', '', '## Install', 'text', '```', '# not a heading', '```', '## Use', '### Deep', '#### d4', '##### d5', '###### d6', '## Last'].join('\n')
  const s = summarize(md, 'docs/guide.md')
  expect(s.kind).toBe('doc')
  expect(s.title).toBe('The Crew guide')
  expect(s.lead).toBe('First line of the intro paragraph, with a link.')
  expect(s.heads).toEqual(['Install', 'Use', 'Deep', 'd4', 'd5', 'd6'])
  // No heading: the first line is the title.
  expect(summarize('plain notes\n\nmore', 'a.txt').title).toBe('plain notes')
  // A long paragraph is cut near 200 characters.
  expect(summarize('# T\n\n' + 'word '.repeat(100), 'a.md').lead.length).toBeLessThanOrEqual(200)
})

test('a source file is summarized by its leading comment and its top-level declarations', () => {
  const ts = ['// Pure helpers for the crew.', '// Nothing here touches the engine.', 'import x from "y"', 'export function kindOf(p: string) {', '  function inner() {}', '}', 'export const MAX = 3', 'export class Box {}', 'interface Shape {}', 'type Id = string'].join('\n')
  const s = summarize(ts, 'hooks/crew.ts')
  expect(s.kind).toBe('code')
  expect(s.lead).toBe('Pure helpers for the crew. Nothing here touches the engine.')
  expect(s.decls).toEqual(['kindOf', 'MAX', 'Box', 'Shape', 'Id'])
  const py = ['#!/usr/bin/env python', '"""Tools for the thing."""', 'def run(): pass', 'class Job: pass'].join('\n')
  expect(summarize(py, 'x.py')).toMatchObject({ lead: 'Tools for the thing.', decls: ['run', 'Job'] })
  const many = Array.from({ length: 20 }, (_, i) => `function f${i}() {}`).join('\n')
  expect(summarize(many, 'a.js').decls.length).toBe(8)
})

test('summarizeFile reads at most 64 KB and refuses what is not a regular file', () => {
  let asked = 0
  const fs = {
    openSync: () => 7,
    fstatSync: () => ({ isFile: () => true, size: 500_000, mtimeMs: 5 }),
    readSync: (_fd: number, buf: Uint8Array, _o: number, len: number) => {
      asked = len
      buf.fill(97)
      return len
    },
    closeSync: () => undefined,
  }
  const s = summarizeFile('big.md', fs)
  expect(asked).toBe(64 * 1024)
  expect(s).toMatchObject({ kind: 'doc', truncated: true })
  const dir = { ...fs, fstatSync: () => ({ isFile: () => false, size: 0, mtimeMs: 0 }) }
  expect(summarizeFile('somewhere', dir)).toEqual({ error: 'not a regular file' })
})

test('the pet opens or reveals only paths the snapshot lists, and only safe types are opened', async () => {
  const snap = { files: [{ path: 'a.md', abs: 'C:/Work/Notes/a.md' }, { path: 'run.bat', abs: 'C:/Work/run.bat' }, { path: 'no.txt' }] }
  const text = `window.__crewUpdate && window.__crewUpdate(${JSON.stringify(snap)});\n`
  expect(parseDataJs(text)).toEqual(snap)
  expect(parseDataJs('garbage')).toBeNull()
  const files = allowedFiles(parseDataJs(text), 'win32')
  expect([...files.keys()]).toEqual(['c:/work/notes/a.md', 'c:/work/run.bat'])
  expect(norm('relative/a.md', 'win32')).toBeNull()
  expect(norm('C:\\Work\\Notes\\..\\Notes\\A.MD', 'win32')).toBe('c:/work/notes/a.md')
  const calls: string[] = []
  const make = (orca: boolean, orcaWorks = true) =>
    makeActions({
      shell: {
        openPath: (p: string) => {
          calls.push(`open ${p}`)
          return ''
        },
        showItemInFolder: (p: string) => void calls.push(`reveal ${p}`),
      },
      execFile: (file, args, _opts, cb) => {
        calls.push(`${file} ${args.join(' ')}`)
        cb(orcaWorks ? null : new Error('no orca'))
      },
      files: () => files,
      platform: 'win32',
      orca,
      isFile: () => true,
    })
  // Listed: Orca first, with --focus, an absolute path and no shell.
  expect(await make(true).open('c:\\work\\notes\\a.md')).toBe('orca')
  expect(calls).toEqual(['orca file open C:/Work/Notes/a.md --focus'])
  // Orca missing or failing: the OS opens it.
  calls.length = 0
  expect(await make(true, false).open('C:/Work/Notes/a.md')).toBe('shell')
  expect(calls).toEqual(['orca file open C:/Work/Notes/a.md --focus', 'open C:/Work/Notes/a.md'])
  // Not launched from Orca: straight to the OS.
  calls.length = 0
  expect(await make(false).open('C:/Work/Notes/a.md')).toBe('shell')
  // A program is never run: it is shown in the folder.
  calls.length = 0
  expect(await make(false).open('C:/Work/run.bat')).toBe('reveal')
  expect(calls).toEqual(['reveal C:/Work/run.bat'])
  expect(isOpenable('x.md') && isOpenable('y.TS') && !isOpenable('z.exe') && !isOpenable('noext')).toBe(true)
  // Anything the snapshot does not list is refused outright, whatever the spelling.
  calls.length = 0
  expect(await make(true).open('C:/Windows/system32/cmd.exe')).toBe('denied')
  expect(await make(true).reveal('C:/Work/Notes/../../Windows/notepad.exe')).toBe('denied')
  expect(await make(true).open('../a.md')).toBe('denied')
  expect(calls).toEqual([])
  expect(await make(true).reveal('C:/Work/Notes/a.md')).toBe('reveal')
})

test('files recorded before absolute paths were kept get one from the working directory', () => {
  const old = { path: 'web/app.js', kind: 'code' as const, by: { main: 'w' as const }, last: 1 }
  expect(withAbs(old, String.raw`G:\work\proj`).abs).toBe('G:/work/proj/web/app.js')
  // A clipped short path cannot be rebuilt; one that has its path keeps it.
  expect(withAbs({ ...old, path: '…ng/web/app.js' }, 'G:/work').abs).toBeUndefined()
  expect(withAbs({ ...old, abs: 'D:/x/app.js' }, 'G:/work').abs).toBe('D:/x/app.js')
})
