import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { bigFrame, miniFrame } from '../hooks/clawd'
import { toEvent } from '../hooks/input3d'
import { encodeCells, inkOf } from '../bin/cells.mjs'
import { clip, describeCall, kindOf, pushEvent, scrollbar, snapshotOf, touchFile } from '../hooks/crew'
import { DEFAULT_ARCHITECT, DEFAULT_GATE, DEFAULT_MAIN, DEFAULT_TURN, DEFAULT_USAGE, normalizeCard } from '../hooks/deck/core'

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
