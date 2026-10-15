import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ENV_KEY, USER_ORIGINS, foodFromOf, hasNativeTaskTools, proxyFoodOn, setupReport } from '../hooks/setup'
import { EMPTY_BOOK, MAX_TURN_TITLE, QUEUED_STALE_MS, applyTurnEnd, applyTurnQueued, applyTurnStart, normalizeBook, tasksOf, turnTitle } from '../hooks/tasks'
import type { TaskItem } from '../types'

// ---------------------------------------------------------------- the rules

test('the foodFrom option reads leniently; unknown words are auto', () => {
  expect(['auto', 'todos', 'todos+work', 'work', 'todos', 'x', undefined, 3].map(foodFromOf)).toEqual(['auto', 'todos', 'work', 'work', 'todos', 'auto', 'auto', 'auto'])
})

test('prompt turns are food when asked for, or on auto only when the session is known to have no native task tools', () => {
  expect(proxyFoodOn('auto', false)).toBe(true)
  expect(proxyFoodOn('auto', true)).toBe(false)
  expect(proxyFoodOn('auto', null)).toBe(false)
  expect(proxyFoodOn('work', true)).toBe(true)
  expect(proxyFoodOn('work', null)).toBe(true)
  expect(proxyFoodOn('todos', false)).toBe(false)
  expect(hasNativeTaskTools(['Read', 'TodoWrite'])).toBe(true)
  expect(hasNativeTaskTools(['TaskCreate'])).toBe(true)
  expect(hasNativeTaskTools(['Read', 'TaskStop', 'mcp__x__todo'])).toBe(false)
  expect(USER_ORIGINS).toContain('composer')
  expect(USER_ORIGINS).not.toContain('task-notification')
})

test('a turn title is the prompt on one line, masked, cut to about 60 cells, without the plugin\'s frame', () => {
  expect(turnTitle('  fix the\n build  ')).toBe('fix the build')
  expect(turnTitle('use sk-ant-abcdefghijkl to call')).not.toContain('abcdefghijkl')
  expect(turnTitle('x'.repeat(200))).toHaveLength(MAX_TURN_TITLE)
  expect(turnTitle('한'.repeat(60)).length).toBeLessThanOrEqual(MAX_TURN_TITLE / 2 + 1)
  expect(turnTitle('The crew-graph plugin sent a message: why is it slow?')).toBe('why is it slow?')
  expect(turnTitle('   ')).toBe('prompt')
})

const turns = (b: { turn: TaskItem[] }) => b.turn.map(i => [i.id, i.status, i.title])

test('a turn is in progress while it runs, eaten when it answers (counted once), failed when aborted or errored', () => {
  let b = applyTurnStart(EMPTY_BOOK, 'T1', 'fix the build', 100)
  expect(b.turn[0]).toMatchObject({ id: 'turn:T1', src: 'turn', owner: 'main', status: 'in_progress', title: 'fix the build', t: 100 })
  b = applyTurnEnd(b, 'T1', 'answer', 200)
  expect(b.turn[0]).toMatchObject({ status: 'completed', t: 200 })
  expect(b.eaten).toEqual({ main: 1 })
  expect(applyTurnEnd(b, 'T1', 'answer', 300).eaten).toEqual({ main: 1 })
  for (const reason of ['aborted', 'error', 'refusal']) {
    const f = applyTurnEnd(applyTurnStart(EMPTY_BOOK, 'T2', 'x', 1), 'T2', reason, 2)
    expect(f.turn[0]?.status).toBe('failed')
    expect(f.eaten).toEqual({})
  }
  // a turn the book never saw changes nothing
  expect(applyTurnEnd(EMPTY_BOOK, 'nope', 'answer', 1)).toBe(EMPTY_BOOK)
})

test('a prompt that waits is pending, keeps its place when its own turn starts, and the turn that lost its end is closed as failed', () => {
  let b = applyTurnStart(EMPTY_BOOK, 'T1', 'first', 10)
  b = applyTurnQueued(b, 'q1', 'second', 20)
  b = applyTurnQueued(b, 'q2', 'third', 30)
  expect(turns(b)).toEqual([['turn:T1', 'in_progress', 'first'], ['turn:q1', 'pending', 'second'], ['turn:q2', 'pending', 'third']])
  b = applyTurnEnd(b, 'T1', 'answer', 40)
  b = applyTurnStart(b, 'T2', 'second', 50, 'q1')
  expect(turns(b)).toEqual([['turn:T1', 'completed', 'first'], ['turn:T2', 'in_progress', 'second'], ['turn:q2', 'pending', 'third']])
  // T2 never reported its end, and T3 starts: T2 does not stay in hand
  b = applyTurnStart(b, 'T3', 'third', 60, 'q2')
  expect(turns(b)).toEqual([['turn:T1', 'completed', 'first'], ['turn:T2', 'failed', 'second'], ['turn:T3', 'in_progress', 'third']])
  // an empty turn text keeps the queued title
  const c = applyTurnStart(applyTurnQueued(EMPTY_BOOK, 'q9', 'kept words', 1), 'T9', '', 2, 'q9')
  expect(c.turn[0]?.title).toBe('kept words')
})

test('a prompt that waited longer than half an hour is not waiting any more', () => {
  const b = applyTurnQueued(EMPTY_BOOK, 'q1', 'old', 1000)
  expect(applyTurnQueued(b, 'q2', 'new', 1000 + QUEUED_STALE_MS + 1).turn.map(i => i.id)).toEqual(['turn:q2'])
  expect(applyTurnQueued(b, 'q2', 'new', 1000 + QUEUED_STALE_MS - 1).turn.map(i => i.id)).toEqual(['turn:q1', 'turn:q2'])
})

test('turn items ride the same snapshot list, the stored book keeps them, and an old stored book reads without them', () => {
  const b = applyTurnEnd(applyTurnStart(applyTurnQueued(EMPTY_BOOK, 'q1', 'later', 5), 'T1', 'now', 6), 'T1', 'answer', 7)
  const list = tasksOf(b, [], {}, 10)
  expect(list.map(i => [i.src, i.status])).toEqual([['turn', 'pending'], ['turn', 'completed']])
  expect(normalizeBook(JSON.parse(JSON.stringify(b)))).toEqual(b)
  expect(normalizeBook({ todo: [], task: [], eaten: {} }).turn).toEqual([])
  // the cap: 40 open and the last 10 closed, as for every source
  let many = EMPTY_BOOK
  for (let i = 0; i < 60; i += 1) many = applyTurnQueued(many, `q${i}`, `p${i}`, 1)
  expect(tasksOf(many, [], {}, 2)).toHaveLength(40)
})

test('/crew setup text: what is present, which sources are on, the env var and the docs, and that nothing is written', () => {
  const missing = setupReport({ native: false }, 'auto')
  for (const w of ['native task tools (TodoWrite, TaskCreate): missing', 'prompt turns: on', 'background jobs: not tracked', ENV_KEY, 'https://code.claude.com/docs/en/tools-reference', 'writes no file']) expect(missing).toContain(w)
  const present = setupReport({ native: true }, 'auto')
  expect(present).toContain('present')
  expect(present).toContain('prompt turns: off')
  expect(present).not.toContain(ENV_KEY)
  expect(setupReport({ native: null }, 'auto')).toContain('unknown')
  expect(setupReport({ native: true }, 'work')).toContain('prompt turns: on')
  expect(setupReport({ native: false }, 'todos')).toContain('prompt turns: off')
})

// ---------------------------------------------------------------- through the hooks

const USER = 'C:/Users/me/.claude/crew-graph'

type HostOptions = { tools?: string[] | 'fail' }

/** A session: the tool list, a clock, and every file the mod writes recorded; `snap` is the browser view's data. */
function host(on: On, opts: HostOptions = {}) {
  const clock = mock.clock(on)
  const written = new Map<string, string>()
  const submits: { text: string }[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('tool.list', () => {
    if (opts.tools === 'fail') throw new Error('not bound yet')
    return { value: (opts.tools ?? ['Read', 'Bash']).map(name => ({ name, description: '', mcp: false })) }
  })
  on('command.register', (_$, e) => ({ value: { command: (e as unknown as { name: string }).name } }))
  on('prompt.submit', (_$, e) => {
    submits.push({ text: e.text })
    return { text: e.text }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', (_$, e) => {
    written.set(e.path.replace(/\\/g, '/'), e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'sess-food' }))
  const snap = () => {
    const data = written.get(`${USER}/data.js`) ?? ''
    return JSON.parse(data.slice(data.indexOf('(', 30) + 1, data.lastIndexOf(')'))) as { tasks: TaskItem[]; eaten?: Record<string, number> }
  }
  return { clock, snap, written, submits }
}

const startSession = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as never).catch(() => undefined)
const crew = ($: Engine, args: string) => $.command.run({ command: 'crew', args } as never).then(r => r.text ?? '')
const complete = ($: Engine, turnId: string, reason: 'answer' | 'aborted' | 'error', agentId?: string) =>
  $.turn.complete({ turnId, answer: 'ok', reason, durationMs: 5, ...(agentId ? { agentId } : {}) } as never)
const submit = ($: Engine, text: string, turnId?: string, kind = 'composer') =>
  $.prompt.submit({ text, wait: false, origin: { kind }, ...(turnId ? { turnId } : {}) } as never)
const turnItems = (h: ReturnType<typeof host>) => h.snap().tasks.filter(i => i.src === 'turn')
const shown = async (h: ReturnType<typeof host>) => {
  await h.clock.advance(600)
  return turnItems(h).map(i => [i.id, i.status, i.title, i.owner])
}

test('no native task tools: a prompt is an item in progress while the turn runs and is eaten when it answers', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'fix the build', turnId: 'T1' })
  expect(await shown(h)).toEqual([['turn:T1', 'in_progress', 'fix the build', 'main']])
  await complete($, 'T1', 'answer')
  expect(await shown(h)).toEqual([['turn:T1', 'completed', 'fix the build', 'main']])
  expect(h.snap().eaten).toEqual({ main: 1 })
  // the next prompt is a new item; the old one stays among the closed ones
  await $.turn.start({ text: 'and the tests', turnId: 'T2' })
  expect(await shown(h)).toEqual([['turn:T2', 'in_progress', 'and the tests', 'main'], ['turn:T1', 'completed', 'fix the build', 'main']])
})

test('an aborted or errored turn fails its item and eats nothing', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'one', turnId: 'T1' })
  await complete($, 'T1', 'aborted')
  await $.turn.start({ text: 'two', turnId: 'T2' })
  await complete($, 'T2', 'error')
  expect((await shown(h)).map(r => [r[0], r[1]])).toEqual([['turn:T1', 'failed'], ['turn:T2', 'failed']])
  expect(h.snap().eaten).toBeUndefined()
})

test('a prompt typed over a running turn is pending on the plate, then its own turn takes it over', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'first', turnId: 'T1' })
  await submit($, 'second one', 'T1')
  await submit($, 'third one', 'T1')
  expect(await shown(h)).toEqual([['turn:T1', 'in_progress', 'first', 'main'], ['turn:q1', 'pending', 'second one', 'main'], ['turn:q2', 'pending', 'third one', 'main']])
  await complete($, 'T1', 'answer')
  await $.turn.start({ text: 'second one', turnId: 'T2' })
  // open ones first, then the closed
  expect((await shown(h)).map(r => r.slice(0, 3))).toEqual([['turn:T2', 'in_progress', 'second one'], ['turn:q2', 'pending', 'third one'], ['turn:T1', 'completed', 'first']])
  await complete($, 'T2', 'answer')
  await $.turn.start({ text: 'third one', turnId: 'T3' })
  await complete($, 'T3', 'answer')
  expect((await shown(h)).map(r => r[1])).toEqual(['completed', 'completed', 'completed'])
  expect(h.snap().eaten).toEqual({ main: 3 })
})

test('only a prompt of the user typed over a running turn waits: not one typed while idle, a slash command, a notification or the plugin itself', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await submit($, 'typed while idle')
  await $.prompt.submit({ text: '/review the diff', wait: false, origin: { kind: 'composer' }, turnId: 'T0', command: { name: 'review', args: 'the diff' } } as never)
  await submit($, 'a notification', 'T0', 'task-notification')
  await $.prompt.submit({ text: 'from the plugin' } as never)
  await h.clock.advance(600)
  expect(turnItems(h)).toEqual([])
  await submit($, 'really waiting', 'T0')
  await h.clock.advance(600)
  expect(turnItems(h).map(i => [i.status, i.title])).toEqual([['pending', 'really waiting']])
})

test('turns the engine opened with a tagged message, and the turns of subagents, are not items', async ($, on) => {
  const h = host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: '<task-notification id="b1">job done</task-notification>', turnId: 'N1' })
  await complete($, 'N1', 'answer')
  await $.turn.start({ text: 'look around', turnId: 'A1', agentId: 'x1' } as never)
  await complete($, 'A1', 'answer', 'x1')
  await $.turn.start({ text: '', turnId: 'C1' })
  await complete($, 'C1', 'answer')
  expect(await shown(h)).toEqual([])
})

test('a long prompt is cut to about 60 cells and masked before it reaches data.js', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: `deploy with sk-ant-abcdefghijklmnop ${'and then more words '.repeat(20)}`, turnId: 'T1' })
  await h.clock.advance(600)
  const title = turnItems(h)[0]?.title ?? ''
  expect(title.length).toBeLessThanOrEqual(MAX_TURN_TITLE)
  expect(title.startsWith('deploy with')).toBe(true)
  expect(title).not.toContain('abcdefghijklmnop')
  // nowhere in the data the pet and the browser read, the prompt's credential is in the clear
  expect(h.written.get(`${USER}/data.js`) ?? '').not.toContain('abcdefghijklmnop')
  expect(h.written.get(`${USER}/sessions/sess-food.js`) ?? '').not.toContain('abcdefghijklmnop')
  expect(title).not.toContain('and then more words and then more words and then more words')
})

test('with the native tools the prompts are not food on auto; "todos+work" makes them food anyway', async ($, on) => {
  const h = host(on, { tools: ['Read', 'TodoWrite'] })
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  await complete($, 'T1', 'answer')
  expect(await shown(h)).toEqual([])
  // to-dos still are
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'plan', status: 'in_progress', activeForm: 'Planning' }] } as never)
  await h.clock.advance(600)
  expect(h.snap().tasks.filter(i => i.src === 'todo')).toHaveLength(1)
})

test('"todos+work" makes the prompts food even where the native tools exist', { options: { foodFrom: 'todos+work' } }, async ($, on) => {
  const h = host(on, { tools: ['Read', 'TodoWrite'] })
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  expect(await shown(h)).toEqual([['turn:T1', 'in_progress', 'plain', 'main']])
})

test('"todos" never makes the prompts food; the subagent tickets stay', { options: { foodFrom: 'todos' } }, async ($, on) => {
  const h = host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await startSession($)
  await crew($, 'web noopen')
  await $.agent.spawn({ prompt: 'p', description: 'read the docs', subagentType: 'Explore', tool_use_id: 's1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  await h.clock.advance(600)
  expect(turnItems(h)).toEqual([])
  expect(h.snap().tasks.filter(i => i.src === 'agent')).toHaveLength(1)
})

test('a tool list that cannot be read keeps the prompts out on auto', async ($, on) => {
  const h = host(on, { tools: 'fail' })
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  expect(await shown(h)).toEqual([])
  expect(await crew($, 'setup')).toContain('unknown')
})

test('a native call seen mid-session settles it as present: the prompts stop being food and their items are hidden', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  expect((await shown(h)).length).toBe(1)
  // a native call shows up: the session has them after all
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'a', status: 'pending', activeForm: '' }] } as never)
  await h.clock.advance(600)
  expect(turnItems(h)).toEqual([])
})

test('/crew reset clears the turn items and the line', async ($, on) => {
  const h = host(on)
  await startSession($)
  await crew($, 'web noopen')
  await $.turn.start({ text: 'one', turnId: 'T1' })
  await submit($, 'two', 'T1')
  expect((await shown(h)).length).toBe(2)
  await crew($, 'reset')
  // any event after the reset writes the view again
  await $.turn.start({ text: '<task-notification id="n">x</task-notification>', turnId: 'N1' })
  expect(await shown(h)).toEqual([])
  await complete($, 'T1', 'answer')
  expect(await shown(h)).toEqual([])
})

test('/crew setup is informational: it names the sources, the env var and the docs, and writes nothing', async ($, on) => {
  const h = host(on)
  await startSession($)
  const before = h.written.size
  const text = await crew($, 'setup')
  for (const w of ['missing', 'prompt turns: on', 'subagent tickets: always', ENV_KEY, 'https://code.claude.com/docs/en/env-vars']) expect(text).toContain(w)
  expect(h.written.size).toBe(before)
})
