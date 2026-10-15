import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// The viewer's list reader is a classic script; imported for its side effect it sets a global (no `window` here, so globalThis).
import '../web/tasks.js'

import { normalizeCard } from '../hooks/deck/core'
import {
  DELETED_MS,
  EMPTY_BOOK,
  MAX_CLOSED,
  MAX_OPEN,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  bumpEaten,
  createdId,
  normalizeBook,
  ownerOf,
  tasksOf,
  ticketOf,
} from '../hooks/tasks'
import type { TaskBook, TaskItem } from '../types'

type PageItem = { id: string; src: string; owner: string | null; status: string; blockedBy: string[]; deliverTo: string | null; active: string }
const page = (globalThis as unknown as {
  CrewTasks: {
    cleanList(raw: unknown): PageItem[]
    blockedIds(list: PageItem[]): Set<string>
    diff(prev: Map<string, string>, list: PageItem[], first: boolean): { k: string; d: PageItem }[]
  }
}).CrewTasks

const todo = (content: string, status: 'pending' | 'in_progress' | 'completed' = 'pending', activeForm = '') => ({ content, status, activeForm })
const byTitle = (list: TaskItem[], title: string) => list.find(i => i.title === title)
const card = (id: string, description: string, status: string, spawnedAt = 1, endedAt: number | null = null) =>
  normalizeCard({ id, type: 'Explore', description, status, spawnedAt, endedAt })

// ---------------------------------------------------------------- TodoWrite: an agent's whole list

test('a TodoWrite replaces that agent\'s own list and nobody else\'s', () => {
  let b: TaskBook = EMPTY_BOOK
  b = applyTodoWrite(b, 'main', { todos: [todo('write tests'), todo('ship it')] }, 100)
  b = applyTodoWrite(b, 'a1', { todos: [todo('read the docs', 'in_progress', 'Reading the docs')] }, 110)
  expect(b.todo.map(i => [i.owner, i.title])).toEqual([['main', 'write tests'], ['main', 'ship it'], ['a1', 'read the docs']])
  b = applyTodoWrite(b, 'main', { todos: [todo('write tests', 'in_progress', 'Writing tests'), todo('ship it')] }, 200)
  expect(b.todo.filter(i => i.owner === 'a1').length).toBe(1)
  const mine = b.todo.filter(i => i.owner === 'main')
  expect(mine.map(i => [i.title, i.status, i.t])).toEqual([['write tests', 'in_progress', 200], ['ship it', 'pending', 100]])
  expect(mine[0]?.active).toBe('Writing tests')
})

test('todo ids are stable, namespaced, and a repeated content is numbered', () => {
  const a = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [todo('same'), todo('same'), todo('other')] }, 1)
  const b = applyTodoWrite(a, 'main', { todos: [todo('other'), todo('same', 'completed'), todo('same')] }, 2)
  expect(new Set(a.todo.map(i => i.id)).size).toBe(3)
  expect(a.todo.every(i => i.id.startsWith('todo:main:'))).toBe(true)
  // the same content in the same order keeps its id, whatever else moved
  expect(b.todo.find(i => i.title === 'other')?.id).toBe(a.todo[2]?.id)
  expect(b.todo.filter(i => i.title === 'same').map(i => i.id).sort()).toEqual(a.todo.filter(i => i.title === 'same').map(i => i.id).sort())
  // another agent's identical text is a different item
  expect(applyTodoWrite(EMPTY_BOOK, 'a1', { todos: [todo('other')] }, 1).todo[0]?.id).not.toBe(a.todo[2]?.id)
})

test('an item that turns completed is counted once, and a rewrite of the same list adds nothing', () => {
  let b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [todo('a'), todo('b')] }, 1)
  b = applyTodoWrite(b, 'main', { todos: [todo('a', 'completed'), todo('b')] }, 2)
  expect(b.eaten).toEqual({ main: 1 })
  b = applyTodoWrite(b, 'main', { todos: [todo('a', 'completed'), todo('b')] }, 3)
  expect(b.eaten).toEqual({ main: 1 })
  expect(byTitle(b.todo, 'a')?.t).toBe(2)
  b = applyTodoWrite(b, 'main', { todos: [todo('a', 'completed'), todo('b', 'completed')] }, 4)
  expect(b.eaten).toEqual({ main: 2 })
})

test('an open item missing from the new list is deleted for a moment; a closed one just leaves', () => {
  let b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [todo('open one'), todo('done one', 'completed'), todo('keep')] }, 1000)
  b = applyTodoWrite(b, 'main', { todos: [todo('keep')] }, 2000)
  expect(b.todo.map(i => [i.title, i.status])).toEqual([['keep', 'pending'], ['open one', 'deleted']])
  expect(tasksOf(b, [], {}, 2000 + DELETED_MS).some(i => i.status === 'deleted')).toBe(true)
  expect(tasksOf(b, [], {}, 2000 + DELETED_MS + 1).some(i => i.status === 'deleted')).toBe(false)
  // the next write sweeps it out of the stored book too
  expect(applyTodoWrite(b, 'main', { todos: [todo('keep')] }, 2000 + DELETED_MS + 1).todo.map(i => i.title)).toEqual(['keep'])
})

test('bad TodoWrite input changes nothing but the agent\'s own list', () => {
  const b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [todo('x')] }, 1)
  expect(applyTodoWrite(b, 'a1', 'nope', 2).todo.length).toBe(1)
  expect(applyTodoWrite(b, 'a1', { todos: [{ content: 5 }, null, { content: '  ' }] }, 2).todo.length).toBe(1)
  expect(applyTodoWrite(b, 'main', { todos: [] }, 2).todo.map(i => i.status)).toEqual(['deleted'])
})

// ---------------------------------------------------------------- TaskCreate / TaskUpdate

test('a TaskCreate result names the task: result.task.id, else the #n of its text', () => {
  expect(createdId({ task: { id: '7', subject: 's' } })).toBe('7')
  expect(createdId({ task: { id: 8 } })).toBe('8')
  expect(createdId('ok', 'Task #12 created successfully: x')).toBe('12')
  expect(createdId('ok', 'ok')).toBeNull()
  expect(createdId(undefined, undefined)).toBeNull()
})

test('a task goes pending, in progress, completed; its owner is who set it in progress', () => {
  const known = [{ id: 'main', type: 'main' }, { id: 'a1', type: 'Explore' }]
  let b = applyTaskCreate(EMPTY_BOOK, '1', { subject: 'Map the loader', description: 'd', activeForm: 'Mapping the loader' }, 10)
  expect(b.task[0]).toMatchObject({ id: 'task:1', src: 'task', status: 'pending', title: 'Map the loader', active: 'Mapping the loader', t: 10 })
  expect(b.task[0]?.owner).toBeUndefined()
  b = applyTaskUpdate(b, { taskId: '1', status: 'in_progress' }, 'a1', known, 20)
  expect(b.task[0]).toMatchObject({ status: 'in_progress', owner: 'a1', t: 20 })
  // another agent takes it over
  b = applyTaskUpdate(b, { taskId: '1', status: 'in_progress' }, 'main', known, 25)
  expect(b.task[0]?.owner).toBe('main')
  b = applyTaskUpdate(b, { taskId: '1', status: 'completed' }, 'main', known, 30)
  expect(b.task[0]).toMatchObject({ status: 'completed', owner: 'main', t: 30 })
  expect(b.eaten).toEqual({ main: 1 })
  // completing it again counts nothing
  expect(applyTaskUpdate(b, { taskId: '1', status: 'completed' }, 'main', known, 40).eaten).toEqual({ main: 1 })
})

test('the owner field names a known agent by id or type; an unknown name leaves the task unowned', () => {
  const known = [{ id: 'main', type: 'main' }, { id: 'a1', type: 'Explore' }, { id: 'a2', type: 'sonnet-coder' }, { id: 'a3', type: 'Explore' }]
  expect(ownerOf('a2', known)).toBe('a2')
  expect(ownerOf('sonnet-CODER', known)).toBe('a2')
  expect(ownerOf('Explore', known)).toBe('a3') // the latest of two with that type
  expect(ownerOf('nobody', known)).toBeNull()
  expect(ownerOf('', known)).toBeNull()
  let b = applyTaskCreate(EMPTY_BOOK, '1', { subject: 't' }, 1)
  b = applyTaskUpdate(b, { taskId: '1', owner: 'nobody' }, 'main', known, 2)
  expect(b.task[0]?.owner).toBeUndefined()
  b = applyTaskUpdate(b, { taskId: '1', owner: 'sonnet-coder' }, 'main', known, 3)
  expect(b.task[0]?.owner).toBe('a2')
  // in progress with an owner field: the owner field wins over the agent making the call
  b = applyTaskUpdate(b, { taskId: '1', owner: 'a1', status: 'in_progress' }, 'main', known, 4)
  expect(b.task[0]?.owner).toBe('a1')
})

test('blockedBy is namespaced like the ids, subject and activeForm can change, and a task the book never saw is made from the update', () => {
  const known = [{ id: 'main', type: 'main' }]
  let b = applyTaskCreate(EMPTY_BOOK, '2', { subject: 'second' }, 1)
  b = applyTaskUpdate(b, { taskId: '2', addBlockedBy: ['1', 1], subject: 'second, renamed', activeForm: 'Doing the second' }, 'main', known, 2)
  expect(b.task[0]).toMatchObject({ title: 'second, renamed', active: 'Doing the second', blockedBy: ['task:1'] })
  b = applyTaskUpdate(b, { taskId: '2', activeForm: '' }, 'main', known, 3)
  expect(b.task[0]?.active).toBeUndefined()
  b = applyTaskUpdate(b, { taskId: '9', status: 'in_progress', subject: 'late one' }, 'main', known, 4)
  expect(b.task.map(i => i.id)).toEqual(['task:2', 'task:9'])
  expect(b.task[1]).toMatchObject({ title: 'late one', status: 'in_progress', owner: 'main' })
  expect(applyTaskUpdate(b, { status: 'completed' }, 'main', known, 5)).toBe(b)
})

test('a deleted task stays for 5 s in the snapshot and is swept out of the book after that', () => {
  const known = [{ id: 'main', type: 'main' }]
  let b = applyTaskCreate(EMPTY_BOOK, '1', { subject: 'gone soon' }, 1000)
  b = applyTaskUpdate(b, { taskId: '1', status: 'deleted' }, 'main', known, 2000)
  expect(b.task[0]?.status).toBe('deleted')
  expect(tasksOf(b, [], {}, 2000 + DELETED_MS).map(i => i.status)).toEqual(['deleted'])
  expect(tasksOf(b, [], {}, 2000 + DELETED_MS + 1)).toEqual([])
  b = applyTaskCreate(b, '2', { subject: 'next' }, 2000 + DELETED_MS + 1)
  expect(b.task.map(i => i.id)).toEqual(['task:2'])
})

// ---------------------------------------------------------------- subagent tickets

test('every subagent card is a ticket owned by the child and delivered to its parent', () => {
  const parents = { a1: 'main', a2: 'a1' }
  expect(ticketOf(card('a1', 'map the loader', 'running'), parents)).toEqual({
    id: 'agent:a1', src: 'agent', owner: 'a1', title: 'map the loader', status: 'in_progress', deliverTo: 'main', t: 1,
  })
  expect(ticketOf(card('a2', 'sub work', 'done', 5, 90), parents)).toMatchObject({ status: 'completed', deliverTo: 'a1', t: 90 })
  expect(ticketOf(card('a3', 'bad', 'failed', 5, 70), parents)).toMatchObject({ status: 'failed', deliverTo: 'main' })
  expect(ticketOf(card('a4', 'stopped', 'stopped', 5, 60), parents).status).toBe('failed')
  expect(ticketOf(card('a5', '', 'running'), parents).title).toBe('Explore')
})

test('tickets come with no agent using any task tool', () => {
  const list = tasksOf(EMPTY_BOOK, [card('a1', 'one', 'running'), card('a2', 'two', 'done', 1, 50)], { a1: 'main', a2: 'main' }, 100)
  expect(list.map(i => [i.id, i.status])).toEqual([['agent:a1', 'in_progress'], ['agent:a2', 'completed']])
})

// ---------------------------------------------------------------- the cap and the masking

test('the snapshot lists every open task up to 40 and the last 10 closed ones', () => {
  const many = Array.from({ length: 55 }, (_, i) => todo(`open ${i}`))
  const closed = Array.from({ length: 15 }, (_, i) => todo(`done ${i}`, 'completed'))
  let b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [...closed, ...many] }, 1)
  b = { ...b, todo: b.todo.map((i, n) => (i.status === 'completed' ? { ...i, t: 100 + n } : i)) }
  const list = tasksOf(b, [], {}, 1000)
  expect(list.filter(i => i.status === 'pending').length).toBe(MAX_OPEN)
  const done = list.filter(i => i.status === 'completed')
  expect(done.length).toBe(MAX_CLOSED)
  expect(done.map(i => i.title)).toEqual(Array.from({ length: 10 }, (_, i) => `done ${i + 5}`))
})

test('a long to-do list does not push a ticket out of the cap', () => {
  const b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: Array.from({ length: 55 }, (_, i) => todo(`open ${i}`)) }, 1)
  const list = tasksOf(b, [card('a1', 'one', 'running'), card('a2', 'two', 'running')], { a1: 'main', a2: 'main' }, 100)
  expect(list.length).toBe(MAX_OPEN)
  expect(list.filter(i => i.src === 'agent').map(i => i.id)).toEqual(['agent:a1', 'agent:a2'])
  expect(list.filter(i => i.src === 'todo').length).toBe(MAX_OPEN - 2)
})

test('a dismissed agent takes its tasks with it (cards of dismissed agents are not passed, and their book items are hidden)', () => {
  let b = applyTodoWrite(EMPTY_BOOK, 'main', { todos: [todo('mine')] }, 1)
  b = applyTodoWrite(b, 'a1', { todos: [todo('theirs')] }, 2)
  b = applyTaskCreate(b, '1', { subject: 'shared' }, 3)
  b = applyTaskUpdate(b, { taskId: '1', status: 'in_progress', owner: 'a1' }, 'main', [{ id: 'a1', type: 'Explore' }], 4)
  const list = tasksOf(b, [], {}, 10, new Set(['a1']))
  expect(list.map(i => i.title)).toEqual(['mine'])
})

test('the stored book is capped too, and open items outlast closed ones', () => {
  let b = EMPTY_BOOK
  for (let i = 0; i < 260; i += 1) b = applyTaskCreate(b, String(i), { subject: `t${i}` }, i)
  for (let i = 0; i < 260; i += 2) b = applyTaskUpdate(b, { taskId: String(i), status: 'completed' }, 'main', [], 1000 + i)
  expect(b.task.length).toBeLessThanOrEqual(200)
  expect(b.task.filter(i => i.status === 'pending').length).toBe(130)
})

test('titles are cut to about 80 cells (Hangul takes two) and credentials are masked', () => {
  const b = applyTodoWrite(EMPTY_BOOK, 'main', {
    todos: [
      todo('가'.repeat(60), 'pending', 'Using token=sk-abcdefghijklmnop123'),
      todo('curl -H "Authorization: Bearer abcdefgh12345678" https://x'),
      todo('line one\nline two\ttabbed'),
    ],
  }, 1)
  const [wide, secret, lines] = b.todo
  expect([...(wide?.title ?? '')].reduce((n, c) => n + ((c.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1), 0)).toBeLessThanOrEqual(80)
  expect(wide?.title.endsWith('…')).toBe(true)
  expect(wide?.active).not.toContain('abcdefghijklmnop')
  expect(secret?.title).not.toContain('abcdefgh1234')
  expect(lines?.title).toBe('line one line two tabbed')
  const t = ticketOf(card('a1', 'deploy with --token hunter2hunter2 now', 'running'), {})
  expect(t.title).not.toContain('hunter2')
})

test('a stored book that is missing, old or damaged still reads', () => {
  expect(normalizeBook(undefined)).toEqual(EMPTY_BOOK)
  expect(normalizeBook({ todo: 'x', task: [null, { id: 'task:1', title: 't', status: 'weird', t: 'x' }], eaten: { main: 2, a: -1, b: 'x' } })).toEqual({
    todo: [],
    task: [{ id: 'task:1', src: 'todo', title: 't', status: 'pending', t: 0 }],
    turn: [],
    eaten: { main: 2 },
  })
  expect(bumpEaten(EMPTY_BOOK, 'a1').eaten).toEqual({ a1: 1 })
})

// ---------------------------------------------------------------- through the hooks, into the snapshot

const USER = 'C:/Users/me/.claude/crew-graph'

function host(on: On, fails = false) {
  const clock = mock.clock(on)
  const written = new Map<string, string>()
  let created = 6
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', (_$, e) => {
    if (fails) return { result: 'boom', text: 'boom', isError: true } as never
    if (e.tool === 'TaskCreate') return { result: { task: { id: String((created += 1)), subject: 'x' } }, text: 'Task created' } as never
    return { result: 'ok', text: 'ok' }
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
  on('session.id', () => ({ value: 'sess-t' }))
  const snap = () => {
    const data = written.get(`${USER}/data.js`) ?? ''
    return JSON.parse(data.slice(data.indexOf('(', 30) + 1, data.lastIndexOf(')'))) as { tasks: TaskItem[]; eaten?: Record<string, number> }
  }
  return { clock, snap, written }
}

const asCall = (x: Record<string, unknown>) => x as never

test('TodoWrite from main and from a subagent reach the snapshot, each under its own agent id', async ($, on) => {
  const { clock, snap } = host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.agent.spawn({ prompt: 'p', description: 'read the docs', subagentType: 'Explore', tool_use_id: 's1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('plan', 'in_progress', 'Planning'), todo('build')] }))
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('look around', 'in_progress', 'Looking around')], agentId: 'x1' }))
  await clock.advance(600)
  const list = snap().tasks
  expect(list.filter(i => i.src === 'todo').map(i => [i.owner, i.title, i.status, i.active])).toEqual([
    ['main', 'plan', 'in_progress', 'Planning'],
    ['main', 'build', 'pending', undefined],
    ['x1', 'look around', 'in_progress', 'Looking around'],
  ])
  // the subagent's card is a ticket as well
  expect(list.find(i => i.src === 'agent')).toMatchObject({ id: 'agent:x1', owner: 'x1', title: 'read the docs', status: 'in_progress', deliverTo: 'main' })
})

test('TaskCreate takes its id from the result and TaskUpdate gives the task an owner and finally a count', async ($, on) => {
  const { clock, snap } = host(on)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.tool.call(asCall({ tool: 'TaskCreate', subject: 'Map the loader', description: 'd', activeForm: 'Mapping' }))
  await clock.advance(600)
  const created = snap().tasks.find(i => i.src === 'task')
  expect(created).toMatchObject({ title: 'Map the loader', status: 'pending', active: 'Mapping' })
  expect(created?.owner).toBeUndefined()
  const taskId = (created?.id ?? '').replace('task:', '')
  await $.tool.call(asCall({ tool: 'TaskUpdate', taskId, status: 'in_progress' }))
  await clock.advance(600)
  expect(snap().tasks.find(i => i.src === 'task')).toMatchObject({ status: 'in_progress', owner: 'main' })
  await $.tool.call(asCall({ tool: 'TaskUpdate', taskId, status: 'completed' }))
  await clock.advance(600)
  expect(snap().tasks.find(i => i.src === 'task')?.status).toBe('completed')
  expect(snap().eaten).toEqual({ main: 1 })
})

test('/crew web copies tasks.js beside the viewer, so the pet and the browser can load it', async ($, on) => {
  const { written } = host(on)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  expect([...written.keys()].filter(k => k === `${USER}/tasks.js`).length).toBe(1)
})

test('a denied or failed task call changes nothing', async ($, on) => {
  const { clock, snap } = host(on, true)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('x')] }))
  await clock.advance(600)
  expect(snap().tasks).toEqual([])
})

test('a finished subagent is eaten by its parent: the ticket is completed and the parent\'s count goes up', async ($, on) => {
  const { clock, snap } = host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.agent.spawn({ prompt: 'p', description: 'read the docs', subagentType: 'Explore', tool_use_id: 's1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  await $.turn.complete({ agentId: 'x1', reason: 'answer', answer: 'found it', durationMs: 5 } as never)
  await clock.advance(600)
  expect(snap().tasks.find(i => i.src === 'agent')).toMatchObject({ status: 'completed', deliverTo: 'main' })
  expect(snap().eaten).toEqual({ main: 1 })
})

test('/crew reset clears the tasks', async ($, on) => {
  const { clock, snap } = host(on)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('x')] }))
  await clock.advance(600)
  expect(snap().tasks.length).toBe(1)
  await $.command.run({ command: 'crew', args: 'reset' } as never)
  await $.turn.start({ text: 'again', turnId: 'T2' })
  await clock.advance(600)
  expect(snap().tasks).toEqual([])
})

test('what the mod writes is what the page reads: ids, owners, blockers and tickets survive, and the next write plays the right things', async ($, on) => {
  const { clock, snap } = host(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'x1' }))
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await $.agent.spawn({ prompt: 'p', description: 'read the docs', subagentType: 'Explore', tool_use_id: 's1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false })
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('plan', 'in_progress', 'Planning'), todo('build')] }))
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('look around', 'in_progress', 'Looking around')], agentId: 'x1' }))
  await $.tool.call(asCall({ tool: 'TaskCreate', subject: 'first task', description: 'd' }))
  await $.tool.call(asCall({ tool: 'TaskCreate', subject: 'second task', description: 'd' }))
  await clock.advance(600)
  const ids = snap().tasks.filter(i => i.src === 'task').map(i => i.id)
  expect(ids.length).toBe(2)
  await $.tool.call(asCall({ tool: 'TaskUpdate', taskId: ids[1]?.replace('task:', ''), addBlockedBy: [ids[0]?.replace('task:', '')] }))
  await $.tool.call(asCall({ tool: 'TaskUpdate', taskId: ids[0]?.replace('task:', ''), status: 'in_progress', owner: 'x1' }))
  await clock.advance(600)
  const first = page.cleanList(snap().tasks)
  expect(first.length).toBe(snap().tasks.length) // the page drops nothing the mod wrote
  const by = (id: string) => first.find(i => i.id === id)
  expect(by(ids[0] ?? '')).toMatchObject({ owner: 'x1', status: 'in_progress' })
  expect(by(ids[1] ?? '')?.blockedBy).toEqual([ids[0]])
  expect([...page.blockedIds(first)]).toEqual([ids[1]]) // the namespaced blocker finds the open task it names
  expect(by('agent:x1')).toMatchObject({ src: 'agent', owner: 'x1', deliverTo: 'main', status: 'in_progress' })
  expect(first.filter(i => i.src === 'todo').map(i => i.owner).sort()).toEqual(['main', 'main', 'x1'])
  // the first snapshot is a baseline: everything open is just there
  expect(page.diff(new Map(), first, true).every(e => e.k === 'rest')).toBe(true)
  // then main finishes planning and starts building, the first task is done, the subagent answers
  const seen = new Map(first.map(i => [i.id, i.status]))
  await $.tool.call(asCall({ tool: 'TodoWrite', todos: [todo('plan', 'completed'), todo('build', 'in_progress', 'Building')] }))
  await $.tool.call(asCall({ tool: 'TaskUpdate', taskId: ids[0]?.replace('task:', ''), status: 'completed' }))
  await $.turn.complete({ agentId: 'x1', reason: 'answer', answer: 'found it', durationMs: 5 } as never)
  await clock.advance(600)
  const next = page.cleanList(snap().tasks)
  const played = page.diff(seen, next, false).map(e => `${e.k}:${e.d.id}`.replace(/todo:main:[a-z0-9]+/, 'todo:main'))
  expect(played.sort()).toEqual([`eat:${ids[0]}`, 'eat:agent:x1', 'eat:todo:main', 'start:todo:main'].sort())
  expect(snap().eaten).toEqual({ main: 2, x1: 1 }) // the plan, and the ticket for main; the first task was owned by x1
})
