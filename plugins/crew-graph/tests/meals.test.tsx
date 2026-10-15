import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set a global (no `window` here, so globalThis).
import '../web/tasks.js'

import { MAIL_ORIGINS, USER_ORIGINS, isMailOrigin } from '../hooks/setup'
import {
  EMPTY_BOOK,
  MAIL_FROM_MAX,
  MAX_TITLE,
  QUEUED_STALE_MS,
  addresseeOf,
  applyAssign,
  applyAssignDone,
  applyMailEnd,
  applyMailIn,
  applyMailStart,
  assignTitle,
  isProtocolText,
  looksLikeUser,
  mailForTurn,
  mailFromOf,
  mailKey,
  mailParse,
  mailTitle,
  noteMailFrom,
  normalizeBook,
  tasksOf,
} from '../hooks/tasks'
import { normalizeCard } from '../hooks/deck/core'
import type { TaskBook, TaskItem } from '../types'

type Page = {
  cleanList(raw: unknown): { id: string; src: string; deliverTo: string | null }[]
  diff(prev: Map<string, string>, list: { id: string; status: string }[], first: boolean): { k: string }[]
  foodFor(charId: string, def: unknown, setting: string, src?: string): { key: string }
  cardLines(d: unknown, owner: string, blocked: boolean): [string, string][]
  biteScale(n: number): number
  biteGate(last: number | undefined, now: number): boolean
  callsStep(prev: number | undefined, calls: number, pend: number): { base: number; pend: number }
  countChip(n: number): string
  BITE: { gap: number; backlog: number; floor: number; step: number; crumbs: number }
  MAIL_FOOD: { boxes: unknown[] }
}
const page = (globalThis as unknown as { CrewTasks: Page }).CrewTasks

// ---------------------------------------------------------------- mail: what is a letter

test('the origin kinds that are letters to main are the report kinds; the user kinds are not', () => {
  for (const k of ['task-notification', 'peer', 'peer-send-message', 'coordinator', 'projects-relay', 'channel']) expect(isMailOrigin(k)).toBe(true)
  for (const k of USER_ORIGINS) expect(isMailOrigin(k)).toBe(false)
  for (const k of ['sdk', 'scheduled-trigger', 'auto-continuation', 'observer', 'observer-activity', 'unclassified', 'plugin', undefined, 3]) expect(isMailOrigin(k)).toBe(false)
  expect(MAIL_ORIGINS.filter(k => USER_ORIGINS.includes(k))).toEqual([])
})

test('a letter reads "from <sender>: <summary>": the mailbox tag first, the stamped sender over the text, the kind when nothing says', () => {
  const tagged = '<teammate-message teammate_id="scout" summary="parser is done">\nlong body here\n</teammate-message>'
  expect(mailParse(tagged, 'peer')).toEqual({ from: 'scout', summary: 'parser is done' })
  expect(mailParse(tagged, 'peer', 'real-sender').from).toBe('real-sender')
  const framed = 'Another Claude session sent a message: the build is green\nmore lines'
  expect(mailParse(framed, 'peer')).toEqual({ from: 'peer', summary: 'the build is green' })
  expect(mailParse('<task-notification><summary>job b1 finished</summary></task-notification>', 'task-notification')).toEqual({ from: 'task', summary: 'job b1 finished' })
  expect(mailParse('plain words', 'coordinator').from).toBe('lead')
  expect(mailTitle('scout', 'parser is done')).toBe('from scout: parser is done')
  expect(mailTitle('scout', '')).toBe('from scout')
})

test('a letter title is one line, masked, and cut like the other titles', () => {
  const long = mailTitle('scout', `deploy with sk-ant-abcdefghijklmnop ${'and then more words '.repeat(20)}`)
  expect(long.length).toBeLessThanOrEqual(MAX_TITLE)
  expect(long).not.toContain('abcdefghijklmnop')
  expect(long.startsWith('from scout: deploy with')).toBe(true)
})

test('"Another Claude session sent a message" is not the user\'s turn; a plain prompt is; a leading tag is not', () => {
  expect(looksLikeUser('Another Claude session sent a message: hello')).toBe(false)
  expect(looksLikeUser('  another claude session sent a message hello')).toBe(false)
  expect(looksLikeUser('<task-notification id="b1">done</task-notification>')).toBe(false)
  expect(looksLikeUser('fix the build')).toBe(true)
})

test('a turn is matched to the letter whose text it holds; with no text match only a turn that is not the user\'s takes the oldest', () => {
  const waits = [
    { mid: 'a', key: mailKey('Another Claude session sent a message: first one'), at: 1 },
    { mid: 'b', key: mailKey('second one'), at: 2 },
  ]
  expect(mailForTurn(waits, 'Another Claude session sent a message: second one, and more')?.mid).toBe('b')
  expect(mailForTurn(waits, 'typed by the user, nothing alike')).toBeUndefined()
  expect(mailForTurn(waits, '<task-notification id="b1">done</task-notification>')?.mid).toBe('a')
  expect(mailForTurn([], '<task-notification id="b1">done</task-notification>')).toBeUndefined()
})

test('who sent a message is remembered by its text, for a while, and bounded', () => {
  let log = noteMailFrom([], 'the report text of scout', 'scout', 1000)
  expect(mailFromOf(log, 'Another Claude session sent a message: the report text of scout and more', 2000)).toBe('scout')
  expect(mailFromOf(log, 'something else', 2000)).toBeUndefined()
  expect(mailFromOf(log, 'the report text of scout', 1000 + 11 * 60_000)).toBeUndefined()
  log = noteMailFrom(log, '', 'nobody', 3000)
  expect(log).toHaveLength(1)
  for (let i = 0; i < MAIL_FROM_MAX + 10; i += 1) log = noteMailFrom(log, `message number ${i}`, 'x', 4000)
  expect(log.length).toBeLessThanOrEqual(MAIL_FROM_MAX)
  expect(isProtocolText('{"type":"shutdown_request","reason":"done"}')).toBe(true)
  expect(isProtocolText('shutdown the build')).toBe(false)
  // wrapped in the mailbox tag or after the peer frame, or an idle notice: still a protocol object
  expect(isProtocolText('<teammate-message teammate_id="scout">{"type":"idle_notification","from":"scout"}</teammate-message>')).toBe(true)
  expect(isProtocolText('Another Claude session sent a message: {"type": "plan_approval_response", "approve": true}')).toBe(true)
  expect(isProtocolText('<teammate-message teammate_id="scout" summary="done">the {"type": 1} is odd</teammate-message>')).toBe(false)
  expect(looksLikeUser('{"type":"idle_notification"}')).toBe(false)
})

test('recipients: an id, a name, an address in the team, "name [ref]"; the lead and unknown names are no agent', () => {
  const known = [{ id: 'x1', name: 'scout', teammateId: 'scout@crew' }, { id: 'x2' }]
  expect(['x1', 'scout', 'Scout', 'scout@crew', 'scout [3fa9c1]', 'x2'].map(t => addresseeOf(t, known))).toEqual(['x1', 'x1', 'x1', 'x1', 'x1', 'x2'])
  expect(['main', 'team-lead', 'nobody', ''].map(t => addresseeOf(t, known))).toEqual([null, null, null, null])
})

// ---------------------------------------------------------------- mail in the book

const letters = (b: TaskBook) => b.mail.map(i => [i.id, i.status])

test('letters that arrive while a turn runs pile up pending; the turn that read them eats them all when it answers', () => {
  let b: TaskBook = EMPTY_BOOK
  b = applyMailIn(b, 'm1', 'from a: one', 10, 'T1')
  b = applyMailIn(b, 'm2', 'from b: two', 11, 'T1')
  b = applyMailIn(b, 'm3', 'from c: three', 12, 'T1')
  expect(letters(b)).toEqual([['mail:m1', 'pending'], ['mail:m2', 'pending'], ['mail:m3', 'pending']])
  expect(b.mail.every(i => i.owner === 'main' && i.src === 'mail')).toBe(true)
  b = applyMailEnd(b, 'T2', 'answer', 20) // another turn's end changes nothing
  expect(letters(b).every(l => l[1] === 'pending')).toBe(true)
  b = applyMailEnd(b, 'T1', 'answer', 30)
  expect(letters(b).every(l => l[1] === 'completed')).toBe(true)
  expect(b.eaten.main).toBe(3)
  expect(applyMailEnd(b, 'T1', 'answer', 31)).toBe(b) // no second eat
})

test('a letter that opens a turn is that turn\'s work; an aborted turn fails it and eats nothing', () => {
  let b = applyMailIn(EMPTY_BOOK, 'm1', 'from a: report', 10)
  expect(b.mail[0]?.bound).toBeUndefined()
  b = applyMailStart(b, 'T1', 11, 'm1')
  expect(b.mail[0]).toMatchObject({ status: 'in_progress', bound: 'T1' })
  expect(applyMailEnd(b, 'T1', 'aborted', 12).mail[0]?.status).toBe('failed')
  expect(applyMailEnd(b, 'T1', 'aborted', 12).eaten.main).toBeUndefined()
})

test('a letter whose turn lost its end is closed when the next turn starts, so it cannot stay in hand', () => {
  let b = applyMailStart(applyMailIn(EMPTY_BOOK, 'm1', 'from a: one', 10), 'T1', 11, 'm1')
  b = applyMailStart(b, 'T2', 20) // a turn that no letter opened
  expect(b.mail[0]?.status).toBe('failed')
})

test('a letter nobody read in half an hour leaves the book; the snapshot carries no turn binding', () => {
  const b = applyMailIn(EMPTY_BOOK, 'old', 'from a: stale', 1)
  const later = applyMailIn(b, 'new', 'from a: fresh', 2 + QUEUED_STALE_MS)
  expect(later.mail.map(i => i.id)).toEqual(['mail:new'])
  const bound = applyMailIn(EMPTY_BOOK, 'm1', 'from a: one', 5, 'T9')
  const list = tasksOf(bound, [], {}, 6)
  expect(list).toHaveLength(1)
  expect('bound' in (list[0] as TaskItem)).toBe(false)
  expect(normalizeBook(bound).mail[0]?.bound).toBe('T9') // the stored book keeps it
})

// ---------------------------------------------------------------- assignments in the book

test('a teammate holds the oldest job; later ones wait in order; a report hands back one and takes the next', () => {
  let b: TaskBook = EMPTY_BOOK
  b = applyAssign(b, 'x1', 'map the loader', 'main', 100)
  b = applyAssign(b, 'x1', 'then the tests', 'main', 110)
  b = applyAssign(b, 'x1', 'and the docs', 'main', 120)
  expect(b.assign.map(i => [i.id, i.status])).toEqual([['assign:x1:1', 'in_progress'], ['assign:x1:2', 'pending'], ['assign:x1:3', 'pending']])
  expect(b.assign.every(i => i.owner === 'x1' && i.deliverTo === 'main' && i.src === 'assign')).toBe(true)
  b = applyAssignDone(b, 'x1', false, 200)
  expect(b.assign.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(b.eaten).toEqual({ main: 1 })
  b = applyAssignDone(b, 'x1', true, 300) // the teammate goes idle: nothing is left in its hands
  expect(b.assign.map(i => i.status)).toEqual(['completed', 'completed', 'completed'])
  expect(b.eaten).toEqual({ main: 3 })
  expect(applyAssignDone(b, 'x1', true, 301)).toBe(b)
})

test('jobs of two teammates do not mix; an aborted idle fails what was held and eats nothing', () => {
  let b = applyAssign(applyAssign(EMPTY_BOOK, 'x1', 'one', 'main', 1), 'x2', 'two', 'main', 2)
  expect(b.assign.map(i => i.status)).toEqual(['in_progress', 'in_progress'])
  b = applyAssignDone(b, 'x2', true, 5, 'aborted')
  expect(b.assign.map(i => i.status)).toEqual(['in_progress', 'failed'])
  expect(b.eaten.main).toBeUndefined()
})

test('a teammate\'s card is no ticket (it flips idle and completed with every message); a subagent\'s still is', () => {
  const mate = normalizeCard({ id: 'x1', type: 'scout', description: 'map', status: 'done', spawnedAt: 1, endedAt: 9, isTeammate: true })
  const sub = normalizeCard({ id: 'x2', type: 'Explore', description: 'read', status: 'done', spawnedAt: 1, endedAt: 9 })
  const b = applyAssign(EMPTY_BOOK, 'x1', 'map', 'main', 1)
  expect(tasksOf(b, [mate, sub], { x1: 'main', x2: 'main' }, 20).map(i => i.id).sort()).toEqual(['agent:x2', 'assign:x1:1'])
  expect(assignTitle('a label', 'long text')).toBe('a label')
  expect(assignTitle(undefined, '\n  first line\nsecond')).toBe('first line')
  expect(assignTitle(undefined, '')).toBe('assignment')
})

// ---------------------------------------------------------------- through the hooks

const USER = 'C:/Users/me/.claude/crew-graph'
type HostOptions = { tools?: string[]; drop?: boolean; agents?: { id: string; name?: string; teammateId?: string }[] }
type Snap = { tasks: TaskItem[]; eaten?: Record<string, number>; agents: { id: string; calls: number; status: string }[] }

function host(on: On, opts: HostOptions = {}) {
  const clock = mock.clock(on)
  const written = new Map<string, string>()
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('tool.list', () => ({ value: (opts.tools ?? ['Read', 'Bash']).map(name => ({ name, description: '', mcp: false })) }))
  on('command.register', (_$, e) => ({ value: { command: (e as unknown as { name: string }).name } }))
  on('prompt.submit', (_$, e) => (opts.drop ? { drop: 'refused' } : { text: e.text }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.receive', (_$, e) => ({ text: e.text }) as never)
  on('agent.list', () => ({ value: opts.agents ?? [] }) as never)
  let nextAgent = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: opts.agents?.[nextAgent++]?.id ?? `x${nextAgent}` }))
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? String.raw`C:\Users\me` : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => ({ value: `// ${e.path}` }))
  on('fs.write', (_$, e) => {
    written.set(e.path.replace(/\\/g, '/'), e.text)
    return { value: undefined }
  })
  on('fs.exists', () => ({ value: false }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: 'sess-meals' }))
  const snap = () => {
    const data = written.get(`${USER}/data.js`) ?? ''
    return JSON.parse(data.slice(data.indexOf('(', 30) + 1, data.lastIndexOf(')'))) as Snap
  }
  return { clock, snap }
}

type H = ReturnType<typeof host>
const start = async ($: Engine) => {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as never).catch(() => undefined)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
}
const done = ($: Engine, turnId: string, reason: 'answer' | 'aborted' | 'error' = 'answer', agentId?: string) =>
  $.turn.complete({ turnId, answer: 'ok', reason, durationMs: 5, ...(agentId ? { agentId } : {}) } as never)
const submit = ($: Engine, text: string, kind: string, turnId?: string) => $.prompt.submit({ text, wait: false, origin: { kind }, ...(turnId ? { turnId } : {}) } as never)
const of = async (h: H, src: string) => {
  await h.clock.advance(600)
  // the snapshot lists the open items first and the closed after: compare in the order they were made
  return h.snap().tasks.filter(i => i.src === src).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
}
const spawnMate = ($: Engine, name: string, description: string) =>
  $.agent.spawn({ prompt: 'do it', description, subagentType: 'teammate', name, isTeammate: true, tool_use_id: `s-${name}`, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false } as never)

test('reports that arrive while main is busy pile up on its plate, and are eaten when that turn answers', async ($, on) => {
  const h = host(on)
  await start($)
  await $.turn.start({ text: 'fix the build', turnId: 'T1' })
  for (const [who, what] of [['alpha', 'parser done'], ['beta', 'tests green'], ['gamma', 'docs drafted']]) {
    await submit($, `<teammate-message teammate_id="${who}" summary="${what}">body of ${who}</teammate-message>`, 'peer', 'T1')
  }
  const mail = await of(h, 'mail')
  expect(mail.map(i => [i.status, i.title, i.owner])).toEqual([
    ['pending', 'from alpha: parser done', 'main'],
    ['pending', 'from beta: tests green', 'main'],
    ['pending', 'from gamma: docs drafted', 'main'],
  ])
  expect((await of(h, 'turn')).map(i => i.status)).toEqual(['in_progress'])
  await done($, 'T1')
  expect((await of(h, 'mail')).map(i => i.status)).toEqual(['completed', 'completed', 'completed'])
  expect(h.snap().eaten).toEqual({ main: 4 }) // the user's prompt and the three letters
})

test('a teammate report that opens a turn of its own is a letter, not a user turn', async ($, on) => {
  const h = host(on)
  await start($)
  const text = 'Another Claude session sent a message: the loader is mapped'
  await submit($, text, 'peer') // idle: no turnId; the turn it opens starts inside this call
  await $.turn.start({ text, turnId: 'T1' })
  expect((await of(h, 'turn')).length).toBe(0)
  expect((await of(h, 'mail')).map(i => [i.status, i.title])).toEqual([['in_progress', 'from peer: the loader is mapped']])
  await done($, 'T1')
  expect((await of(h, 'mail')).map(i => i.status)).toEqual(['completed'])
  expect(h.snap().eaten).toEqual({ main: 1 })
})

test('fallback: the same frame with no origin seen is still not a user turn', async ($, on) => {
  const h = host(on)
  await start($)
  await $.turn.start({ text: 'Another Claude session sent a message: hello there', turnId: 'T1' })
  await done($, 'T1')
  expect((await of(h, 'turn')).length).toBe(0)
  expect((await of(h, 'mail')).length).toBe(0)
})

test('letters are food on every food setting: the native task tools do not switch them off', async ($, on) => {
  const h = host(on, { tools: ['Read', 'TodoWrite'] })
  await start($)
  await $.turn.start({ text: 'plain', turnId: 'T1' })
  await submit($, 'a task finished', 'task-notification', 'T1')
  expect((await of(h, 'mail')).map(i => [i.status, i.title])).toEqual([['pending', 'from task: a task finished']])
  expect((await of(h, 'turn')).length).toBe(0) // the prompt turns are not food here
})

test('a prompt another hook dropped leaves no letter', async ($, on) => {
  const h = host(on, { drop: true })
  await start($)
  await $.turn.start({ text: 'busy', turnId: 'T1' })
  await submit($, 'will be dropped', 'peer', 'T1')
  expect((await of(h, 'mail')).length).toBe(0)
})

test('a slash command and the user\'s own prompt are never letters', async ($, on) => {
  const h = host(on)
  await start($)
  await $.turn.start({ text: 'busy', turnId: 'T1' })
  await submit($, 'user words', 'composer', 'T1')
  await $.prompt.submit({ text: '/review', wait: false, origin: { kind: 'peer' }, turnId: 'T1', command: { name: 'review', args: '' } } as never)
  expect((await of(h, 'mail')).length).toBe(0)
})

test('an aborted turn fails the letters it was reading', async ($, on) => {
  const h = host(on)
  await start($)
  await $.turn.start({ text: 'work', turnId: 'T1' })
  await submit($, 'one', 'peer-send-message', 'T1')
  await done($, 'T1', 'aborted')
  expect((await of(h, 'mail')).map(i => i.status)).toEqual(['failed'])
  expect(h.snap().eaten).toBeUndefined()
})

test('teammate jobs: the spawn is the first, main\'s messages stack on its plate, a report hands one back, idle flips eat nothing extra', async ($, on) => {
  const h = host(on, { agents: [{ id: 'x1', name: 'scout', teammateId: 'scout@crew' }, { id: 'x9', name: 'other' }] })
  await start($)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await spawnMate($, 'scout', 'map the loader')
  let jobs = await of(h, 'assign')
  expect(jobs.map(i => [i.owner, i.status, i.title, i.deliverTo])).toEqual([['x1', 'in_progress', 'map the loader', 'main']])
  expect((await of(h, 'agent')).length).toBe(0) // the card is no ticket for a teammate
  // two more messages from main wait behind it
  await $.session.send({ to: 'scout', text: 'then the tests\nplease', origin: { kind: 'model' } } as never)
  await $.session.send({ to: 'scout@crew', text: 'and the docs', origin: { kind: 'model' } } as never)
  jobs = await of(h, 'assign')
  expect(jobs.map(i => [i.status, i.title])).toEqual([['in_progress', 'map the loader'], ['pending', 'then the tests'], ['pending', 'and the docs']])
  // its card flips with every idle: nothing is eaten by that alone
  await done($, 'IDLE0', 'answer', 'nobody-known')
  await h.clock.advance(600)
  expect(h.snap().eaten).toBeUndefined()
  // it reports to the lead: the oldest job is handed back and eaten by main, the next is taken in hand
  await $.session.send({ to: 'team-lead', text: 'mapped it', origin: { kind: 'model' }, agentId: 'x1' } as never)
  jobs = await of(h, 'assign')
  expect(jobs.map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  expect(h.snap().eaten).toEqual({ main: 1 })
  // a message to another teammate is not a report
  await $.session.send({ to: 'other', text: 'psst', origin: { kind: 'model' }, agentId: 'x1' } as never)
  expect((await of(h, 'assign')).map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  // it goes idle: nothing is left in its hands
  await done($, 'A1', 'answer', 'x1')
  expect((await of(h, 'assign')).map(i => i.status)).toEqual(['completed', 'completed', 'completed'])
  expect(h.snap().eaten).toEqual({ main: 3 })
  // idle again with nothing given: still nothing new is eaten
  await done($, 'A2', 'answer', 'x1')
  await h.clock.advance(600)
  expect(h.snap().eaten).toEqual({ main: 3 })
})

test('a teammate whose card was made before this version is found by the agent list: no ticket, no eat on idle, a job on a send from main', async ($, on) => {
  const h = host(on, { agents: [{ id: 'x1', name: 'scout', teammateId: 'scout@crew' }] })
  await start($)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  // spawned without the flag, as the stored cards of an older session are
  await $.agent.spawn({ prompt: 'p', description: 'old teammate', subagentType: 'teammate', name: 'scout', tool_use_id: 's1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false } as never)
  await h.clock.advance(600)
  expect(h.snap().tasks.filter(i => i.src === 'agent')).toEqual([])
  await done($, 'A1', 'answer', 'x1') // an idle flip with nothing given: nothing is eaten
  await h.clock.advance(600)
  expect(h.snap().eaten).toBeUndefined()
  await $.session.send({ to: 'scout', text: 'map the loader', origin: { kind: 'model' } } as never)
  expect((await of(h, 'assign')).map(i => [i.status, i.title])).toEqual([['in_progress', 'map the loader']])
  await done($, 'A2', 'answer', 'x1')
  expect((await of(h, 'assign')).map(i => i.status)).toEqual(['completed'])
  expect(h.snap().eaten).toEqual({ main: 1 })
})

test('a protocol message that reaches main is no letter and no user turn', async ($, on) => {
  const h = host(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await submit($, '<teammate-message teammate_id="scout">{"type":"idle_notification","from":"scout"}</teammate-message>', 'peer', 'T1')
  expect((await of(h, 'mail')).length).toBe(0)
  await done($, 'T1')
  await submit($, 'Another Claude session sent a message: {"type":"idle_notification"}', 'peer')
  await $.turn.start({ text: 'Another Claude session sent a message: {"type":"idle_notification"}', turnId: 'T2' })
  expect((await of(h, 'turn')).map(i => i.id)).toEqual(['turn:T1'])
  expect((await of(h, 'mail')).length).toBe(0)
})

test('a message from main to anything that is not a teammate gives no job; neither does a protocol message', async ($, on) => {
  const h = host(on, { agents: [{ id: 'x1', name: 'scout' }] })
  await start($)
  await spawnMate($, 'scout', 'map')
  await $.session.send({ to: 'team-lead', text: 'hello', origin: { kind: 'model' } } as never)
  await $.session.send({ to: 'scout', text: '{"type":"shutdown_request","reason":"done"}', origin: { kind: 'model' } } as never)
  expect((await of(h, 'assign')).map(i => i.title)).toEqual(['map'])
})

test('the sender of a report is named from the session.send that carried it', async ($, on) => {
  const h = host(on, { agents: [{ id: 'x1', name: 'scout' }] })
  await start($)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await spawnMate($, 'scout', 'map')
  await $.session.send({ to: 'team-lead', text: 'the loader is mapped', origin: { kind: 'model' }, agentId: 'x1' } as never)
  await submit($, 'Another Claude session sent a message: the loader is mapped', 'peer', 'T1')
  expect((await of(h, 'mail')).map(i => i.title)).toEqual(['from scout: the loader is mapped'])
})

test('/crew reset clears the letters and jobs', async ($, on) => {
  const h = host(on, { agents: [{ id: 'x1', name: 'scout' }] })
  await start($)
  await $.turn.start({ text: 'go', turnId: 'T1' })
  await submit($, 'a report', 'peer', 'T1')
  await spawnMate($, 'scout', 'map')
  expect((await of(h, 'mail')).length + (await of(h, 'assign')).length).toBe(2)
  await $.command.run({ command: 'crew', args: 'reset' } as never)
  await $.turn.start({ text: 'again', turnId: 'T2' })
  expect((await of(h, 'mail')).length + (await of(h, 'assign')).length).toBe(0)
})

// ---------------------------------------------------------------- the page's side

test('the page reads the new sources, hands a teammate job to the parent, and gives a letter an envelope', () => {
  const list = page.cleanList([
    { id: 'mail:m1', src: 'mail', status: 'pending', title: 'from a: x', owner: 'main', t: 1 },
    { id: 'assign:x1:1', src: 'assign', status: 'in_progress', title: 'map', owner: 'x1', deliverTo: 'main', t: 1 },
    { id: 'z', src: 'nonsense', status: 'pending', title: 'q', t: 1 },
  ])
  expect(list.map(i => i.src)).toEqual(['mail', 'assign', 'todo'])
  expect(list[1]?.deliverTo).toBe('main')
  expect(page.foodFor('crab', null, 'character', 'mail').key).toBe('envelope')
  expect(page.foodFor('crab', null, 'ticket', 'mail').key).toBe('ticket') // the paper-ticket setting still wins
  expect(page.foodFor('crab', null, 'character', 'assign').key).toBe(page.foodFor('crab', null, 'character', 'todo').key) // the teammate's own food
  expect(page.foodFor('crab', null, 'character', 'turn').key).toBe('riceball')
  expect(page.cardLines({ title: 'from a: x', status: 'pending', src: 'mail', active: '', deliverTo: null }, 'main', false)[1]?.[0]).toContain('letter')
  expect(page.cardLines({ title: 'map', status: 'pending', src: 'assign', active: '', deliverTo: 'main' }, 'scout', false).map(l => l[0])).toContain('hands it to main')
  // a pending job turning in progress is taken in hand; completed, eaten
  const prev = new Map([['assign:x1:2', 'pending']])
  expect(page.diff(prev, [{ id: 'assign:x1:2', status: 'in_progress' }], false).map(e => e.k)).toEqual(['start'])
  expect(page.diff(prev, [{ id: 'assign:x1:2', status: 'completed' }], false).map(e => e.k)).toEqual(['eat'])
})

test('a bite shrinks the item one step, never below the floor', () => {
  const seq = [0, 1, 2, 3, 4, 5, 6, 20].map(n => page.biteScale(n))
  expect(seq[0]).toBe(1)
  for (let i = 1; i < seq.length; i += 1) expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!)
  expect(Math.abs((seq[1] ?? 0) - (1 - page.BITE.step))).toBeLessThan(1e-9)
  expect(seq.at(-1)).toBe(page.BITE.floor)
  expect(Math.abs(page.BITE.floor - 0.45)).toBeLessThan(0.05)
  expect(page.biteScale(-3)).toBe(1)
})

test('bites are limited to one in about 0.6 s per agent, whatever the call rate', () => {
  // an agent makes 10 calls a second for 6 s; the page asks for a bite every frame (60 fps) and takes one whenever the gate lets it
  let last: number | undefined
  let pend = 0
  let calls = 0
  let prev: number | undefined
  const took: number[] = []
  for (let f = 0; f <= 360; f += 1) {
    const now = f / 60
    if (f % 6 === 0) calls += 1 // 10 a second
    if (f % 60 === 0) { // the page gets a snapshot once a second
      const s = page.callsStep(prev, calls, pend)
      prev = s.base
      pend = s.pend
    }
    if (pend > 0 && page.biteGate(last, now)) {
      pend -= 1
      last = now
      took.push(now)
    }
  }
  expect(took.length).toBeGreaterThanOrEqual(8)
  expect(took.length).toBeLessThanOrEqual(11) // 6 s / 0.6 s = 10, plus the first
  for (let i = 1; i < took.length; i += 1) expect(took[i]! - took[i - 1]!).toBeGreaterThanOrEqual(page.BITE.gap - 1e-6)
})

test('the calls counter: the first sight is a baseline, a reset rebases, a poll that saw many calls queues at most the backlog', () => {
  expect(page.callsStep(undefined, 40, 0)).toEqual({ base: 40, pend: 0 })
  expect(page.callsStep(40, 41, 0)).toEqual({ base: 41, pend: 1 })
  expect(page.callsStep(41, 41, 1)).toEqual({ base: 41, pend: 1 })
  expect(page.callsStep(41, 3, 2)).toEqual({ base: 3, pend: 0 })
  expect(page.callsStep(3, 300, 0).pend).toBe(page.BITE.backlog)
})

test('the count chip says how many wait on a plate, only when more than one does', () => {
  expect([0, 1, 2, 3, 12].map(page.countChip)).toEqual(['', '', '2', '3', '12'])
})
