import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { ASK_MAX, aboutOf, autoDismissOf, autoDismissed, checkPetMsg, cleanAsk, composeAsk, composeStop, dismiss, hiddenIds, replyOf, withoutHidden } from '../hooks/pet-ask'
import { normalizeCard } from '../hooks/deck/core'
import type { AgentCard, FileNode } from '../types'

// ---------------------------------------------------------------- the pure parts

const card = (over: Partial<AgentCard>) => normalizeCard({ id: 'a1', type: 'Explore', description: 'find the hooks', ...over })

test('a request needs this session id and the token; asks must be 1-4000 characters once trimmed', () => {
  const msg = { kind: 'ask', sessionId: 's1', token: 'tok', mode: 'send', text: 'hi' }
  expect(checkPetMsg(msg, 's1', 'tok').ok).toBe(true)
  for (const bad of [{ ...msg, token: 'nope' }, { ...msg, sessionId: 's2' }, { ...msg, token: undefined }, { ...msg, kind: 'focus-file' }, null, 'x']) {
    expect(checkPetMsg(bad, 's1', 'tok').ok).toBe(false)
  }
  // the Settings window's Rescan is a request too: it needs the same session and token
  const rescan = { kind: 'rescan', sessionId: 's1', token: 'tok' }
  expect(checkPetMsg(rescan, 's1', 'tok').ok).toBe(true)
  for (const bad of [{ ...rescan, token: 'nope' }, { ...rescan, sessionId: 's2' }, { ...rescan, token: undefined }]) expect(checkPetMsg(bad, 's1', 'tok').ok).toBe(false)
  // a session without an id or a token accepts nothing, even a request that "matches"
  expect(checkPetMsg({ ...msg, sessionId: '', token: '' }, '', '').ok).toBe(false)
  // the reason never carries the token
  const why = checkPetMsg({ ...msg, token: 'secret-guess' }, 's1', 'tok')
  expect(JSON.stringify(why)).not.toContain('secret-guess')
  expect(cleanAsk('  hello \n')).toBe('hello')
  expect(cleanAsk('   ')).toBeNull()
  expect(cleanAsk('x'.repeat(ASK_MAX))).toHaveLength(ASK_MAX)
  expect(cleanAsk('x'.repeat(ASK_MAX + 1))).toBeNull()
  expect(cleanAsk(42)).toBeNull()
})

test('a question about an agent carries its type, id, status, task, last 5 events and files; a question about nothing carries none', () => {
  const events = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, t: i, kind: 'tool' as const, from: i % 2 ? 'a1' : 'main', text: `step ${i}` }))
  const files: FileNode[] = [
    { path: 'src/a.ts', kind: 'code', by: { a1: 'r' }, last: 1 },
    { path: 'src/b.ts', kind: 'code', by: { main: 'w' }, last: 1 },
  ]
  const about = aboutOf(card({ status: 'running' }), events, files)
  expect(about.recent).toEqual(['step 1', 'step 3', 'step 5', 'step 7'])
  expect(about.files).toEqual(['src/a.ts'])
  const text = composeAsk('why so slow?', about)
  expect(text).toContain('why so slow?')
  for (const w of ['Explore', 'a1', 'running', 'find the hooks', 'step 7', 'src/a.ts']) expect(text).toContain(w)
  expect(text).not.toContain('src/b.ts')
  expect(composeAsk('plain', null)).not.toContain('Context from crew-graph')
  // a description with a credential is masked before it goes into the prompt
  expect(composeAsk('q', aboutOf(card({ description: 'use sk-ant-abcdefghijkl to call' }), [], []))).not.toContain('abcdefghijkl')
  expect(composeStop(card({}))).toMatch(/stop the running Explore agent \(id a1/)
})

test('the reply is the first 200 cells of the answer, one line, credentials masked', () => {
  const r = replyOf(`token=abc123secret\n${'word '.repeat(80)}`, 'answer', 7)
  expect(r.at).toBe(7)
  expect(r.text).not.toContain('abc123secret')
  expect(r.text).not.toContain('\n')
  expect(r.text.length).toBeLessThanOrEqual(200)
  expect(r.text.endsWith('…')).toBe(true)
  expect(replyOf('   ', 'aborted', 1).text).toContain('aborted')
})

test('dismissing hides finished agents only, and an agent that works again comes back', () => {
  const cards = [card({ id: 'a1', status: 'done', endedAt: 5, steps: 2 }), card({ id: 'a2', status: 'running' }), card({ id: 'a3', status: 'failed', endedAt: 9 })]
  const { set, taken } = dismiss({}, ['a1', 'a2', 'ghost', 'a3'], cards, {})
  expect(taken).toEqual(['a1', 'a3'])
  expect([...hiddenIds(cards, set, {})].sort()).toEqual(['a1', 'a3'])
  // a step, a tool call or a new end changes the agent: it is shown again
  expect(hiddenIds([{ ...cards[0]!, steps: 3 }, cards[1]!, cards[2]!], set, {}).has('a1')).toBe(false)
  expect(hiddenIds(cards, set, { a1: { key: 'a1', verb: 'search', tool: 'Grep', target: '', since: 1, calls: 1 } }).has('a1')).toBe(false)
  expect(hiddenIds([{ ...cards[0]!, endedAt: 50 }, cards[1]!, cards[2]!], set, {}).has('a1')).toBe(false)
  // an entry for an agent that left the card list is dropped
  expect(Object.keys(dismiss(set, [], [cards[1]!], {}).set)).toEqual([])
})

test('hiding takes the agent out of the events, the files it alone touched, and re-hangs its children', () => {
  const cards = [card({ id: 'a1' }), card({ id: 'a2' })]
  const all = {
    cards,
    files: [
      { path: 'only-a1.md', kind: 'doc', by: { a1: 'r' }, last: 1 },
      { path: 'both.ts', kind: 'code', by: { a1: 'r', main: 'w' }, last: 2 },
    ] as FileNode[],
    acts: { a1: { key: 'a1', verb: 'read' as const, tool: 'Read', target: '', since: 1, calls: 1 }, main: { key: 'main', verb: 'think' as const, tool: '', target: '', since: 1, calls: 0 } },
    events: [
      { id: 1, t: 1, kind: 'read' as const, from: 'a1', to: 'only-a1.md', text: '' },
      { id: 2, t: 2, kind: 'spawn' as const, from: 'a1', to: 'a2', text: '' },
      { id: 3, t: 3, kind: 'tool' as const, from: 'main', text: 'kept' },
    ],
    parents: { a1: 'main', a2: 'a1' },
  }
  const out = withoutHidden(all, new Set(['a1']))
  expect(out.cards.map(c => c.id)).toEqual(['a2'])
  expect(out.files.map(f => f.path)).toEqual(['both.ts'])
  expect(out.files[0]?.by).toEqual({ main: 'w' })
  expect(out.events.map(e => e.id)).toEqual([3])
  expect(Object.keys(out.acts)).toEqual(['main'])
  expect(out.parents).toEqual({ a2: 'main' })
  expect(withoutHidden(all, new Set())).toBe(all)
})

test('auto-dismiss: 5, 10 or 30 minutes after an agent finished; the setting is read tolerantly', () => {
  expect(autoDismissOf('{"autoDismiss":10}')).toBe(10)
  expect(autoDismissOf('\uFEFF{"autoDismiss":30}')).toBe(30)
  for (const bad of ['{"autoDismiss":7}', '{"autoDismiss":"5"}', '{', '', null, undefined, '[]', 'null', '{"autoDismiss":0}']) expect(autoDismissOf(bad)).toBe(0)
  const cards = [card({ id: 'a1', status: 'done', endedAt: 1000 }), card({ id: 'a2', status: 'running' }), card({ id: 'a3', status: 'done', endedAt: 1000 + 4 * 60_000 })]
  const now = 1000 + 6 * 60_000
  const next = autoDismissed(cards, {}, {}, now, 5)
  expect(Object.keys(next ?? {})).toEqual(['a1'])
  expect(autoDismissed(cards, next ?? {}, {}, now, 5)).toBeNull()
  expect(autoDismissed(cards, {}, {}, now, 0)).toBeNull()
  expect(autoDismissed(cards, {}, {}, now, 7)).toBeNull()
})

// ---------------------------------------------------------------- through the mod

const ok = { exitCode: 0, stdout: 'ok 4242', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const SID = 'sess-ask'
const STATE = 'C:/Users/me/.claude/crew-graph'

type Host = Awaited<ReturnType<typeof askHost>>
async function askHost($: Engine, on: On, opts: { settings?: string; pet?: boolean } = {}) {
  const opened = { n: 0 }
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => {
    opened.n += 1
    return { value: { isPlaced: true } }
  })
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('command.register', () => ({ value: { command: 'crew' } }))
  const state = { spawned: 0, inbox: '', seq: 90_000, settings: opts.settings ?? '', box: { text: '', cursor: 0 }, folder: [] as { name: string; kind: 'file'; size: number; mtimeMs: number; isLink: boolean }[] }
  const submits: { text: string; origin: unknown }[] = []
  const fills: { text: string; mode?: string }[] = []
  const runs: (readonly string[])[] = []
  const written = new Map<string, string>()
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('env.get', (_$, e) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/me' : e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('fs.read', (_$, e) => {
    const p = norm(e.path)
    return { value: p.endsWith(`pet-inbox-${SID}.json`) ? state.inbox : p.endsWith('pet-settings.json') ? state.settings : `// ${p}` }
  })
  on('fs.write', (_$, e) => {
    written.set(norm(e.path), e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: /electron\.exe$/.test(e.path) }))
  on('fs.list', (_$, e) => ({ value: norm(e.path).endsWith('/characters') ? state.folder : [] })) // the user's characters folder
  on('process.run', (_$, e) => {
    runs.push(e.argv)
    return { value: ok }
  })
  on('session.id', () => ({ value: SID }))
  on('prompt.submit', (_$, e) => {
    submits.push({ text: e.text, origin: e.origin })
    return { text: e.text }
  })
  on('prompt.fill', (_$, e) => {
    fills.push({ text: e.text, mode: e.mode })
    return { isFilled: true }
  })
  on('prompt.read', () => ({ value: state.box }))
  on('agent.spawn', () => {
    state.spawned += 1
    return { model: 'claude-sonnet-5-5', agentId: `x${state.spawned}` }
  })
  if (opts.pet !== false) await $.command.run({ command: 'crew', args: 'pet' } as never)
  await $.command.run({ command: 'crew', args: 'web noopen' } as never)
  const launch = runs.find(r => /launch\.mjs$/.test(r[1] ?? '')) ?? []
  const token = launch[launch.indexOf('--token') + 1] ?? ''
  const send = async (msg: Record<string, unknown>, over: Record<string, unknown> = {}) => {
    state.seq += 1
    state.inbox = JSON.stringify({ seq: state.seq, at: Number.MAX_SAFE_INTEGER, sessionId: SID, token, ...msg, ...over })
    await clock.advance(1100)
  }
  const snap = () => {
    const data = written.get(`${STATE}/data.js`) ?? ''
    return JSON.parse(data.slice(data.indexOf('(', 30) + 1, data.lastIndexOf(')'))) as {
      agents: { id: string }[]
      files: { path: string; by: Record<string, string> }[]
      lastReply?: { at: number; text: string }
      tasks?: { id: string; src: string; status: string; title: string }[]
      petAck?: number
    }
  }
  const spawnArgs = (subagentType: string, description: string, id: string) => ({
    prompt: description,
    description,
    subagentType,
    tool_use_id: id,
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  return { clock, state, submits, fills, runs, written, launch, token, send, snap, spawnArgs, opened }
}

/** One finished Explore (x1, which read plans/plan.md) and one running Plan (x2). */
async function crew($: Engine, h: Host) {
  await $.turn.start({ text: 'go', turnId: 'T0' })
  await $.agent.spawn(h.spawnArgs('Explore', 'find the hooks', 's1'))
  await $.agent.spawn(h.spawnArgs('Plan', 'draft the plan', 's2'))
  await $.tool.call({ tool: 'Read', file_path: 'C:/w/plans/plan.md', agentId: 'x1' } as never)
  await $.tool.call({ tool: 'Read', file_path: 'C:/w/docs/main-only.md' })
  await $.turn.complete({ turnId: 'T0x1', agentId: 'x1', answer: 'done', reason: 'answer', durationMs: 5 } as never)
}

test('the pet is launched with a random token for its session', async ($, on) => {
  const h = await askHost($, on)
  expect(h.token).toMatch(/^[0-9a-f]{32}$/)
  expect(h.launch.slice(h.launch.indexOf('--session'), h.launch.indexOf('--session') + 4)).toEqual(['--session', SID, '--token', h.token])
  await $.command.run({ command: 'crew', args: 'pet' } as never)
  const second = h.runs.filter(r => /launch\.mjs$/.test(r[1] ?? '')).pop() ?? []
  expect(second[second.indexOf('--token') + 1]).not.toBe(h.token)
})

test('an ask with the token is submitted framed, with the agent it is about; the wrong token or session does nothing', async ($, on) => {
  const h = await askHost($, on)
  await crew($, h)
  await h.send({ kind: 'ask', mode: 'send', text: 'why is it slow?', agentId: 'x1' })
  expect(h.submits).toHaveLength(1)
  const sent = h.submits[0]!
  for (const w of ['why is it slow?', 'Explore', 'x1', 'find the hooks', 'plans/plan.md', 'done']) expect(sent.text).toContain(w)
  // framed: it comes from this plugin, never "as the user"
  expect(sent.origin).toMatchObject({ kind: 'plugin' })
  expect((sent.origin as { asUser?: true }).asUser).toBeUndefined()
  // no agent: just the words
  await h.send({ kind: 'ask', mode: 'send', text: 'and in general?' })
  expect(h.submits[1]?.text).toContain('and in general?')
  expect(h.submits[1]?.text).not.toContain('Context from crew-graph')
  // everything else is ignored
  await h.send({ kind: 'ask', mode: 'send', text: 'x' }, { token: 'deadbeef' })
  await h.send({ kind: 'ask', mode: 'send', text: 'x' }, { token: undefined })
  await h.send({ kind: 'ask', mode: 'send', text: 'x' }, { sessionId: 'another-session' })
  await h.send({ kind: 'ask', mode: 'send', text: 'x'.repeat(ASK_MAX + 1) })
  await h.send({ kind: 'ask', mode: 'send', text: '   ' })
  await h.send({ kind: 'ask', mode: 'shout', text: 'x' })
  expect(h.submits).toHaveLength(2)
  expect(h.fills).toHaveLength(0)
  // a request from before the pet started is not ours either
  await h.send({ kind: 'ask', mode: 'send', text: 'old' }, { at: -1 })
  expect(h.submits).toHaveLength(2)
})

test('a draft goes into the prompt box: over an empty one, after what the person has typed', async ($, on) => {
  const h = await askHost($, on)
  await h.send({ kind: 'ask', mode: 'draft', text: 'draft me' })
  expect(h.fills).toEqual([{ text: expect.stringContaining('draft me') as unknown as string, mode: 'replace' }])
  expect(h.submits).toHaveLength(0)
  h.state.box = { text: 'half a sentence', cursor: 3 }
  await h.send({ kind: 'ask', mode: 'draft', text: 'second' })
  expect(h.fills[1]?.mode).toBe('append')
  expect(h.fills[1]?.text.startsWith('\n\n')).toBe(true)
  await h.send({ kind: 'ask', mode: 'draft', text: 'bad' }, { token: 'nope' })
  expect(h.fills).toHaveLength(2)
})

test('only the turn that came from a pet question gives lastReply', async ($, on) => {
  const h = await askHost($, on)
  // a turn is running when the question arrives
  await $.turn.start({ text: 'refactor it', turnId: 'U0' })
  await h.send({ kind: 'ask', mode: 'send', text: 'status please?' })
  expect(h.submits).toHaveLength(1)
  // the running turn ends first: its answer is not the pet's
  await $.turn.complete({ turnId: 'U0', answer: 'refactored', reason: 'answer', durationMs: 5 } as never)
  await h.clock.advance(600)
  expect(h.snap().lastReply).toBeUndefined()
  // then the question's own turn starts (the engine may frame the text) and ends
  await $.turn.start({ text: `The crew-graph plugin sent a message: ${h.submits[0]?.text}`, turnId: 'Q1' })
  await $.turn.complete({ turnId: 'Q1', answer: `All good. password=hunter2hunter2\n${'more '.repeat(80)}`, reason: 'answer', durationMs: 5 } as never)
  await h.clock.advance(600)
  const reply = h.snap().lastReply
  expect(reply?.text.startsWith('All good.')).toBe(true)
  expect(reply?.text).not.toContain('hunter2')
  expect(reply?.text.length).toBeLessThanOrEqual(200)
  // a later turn of the person's is not an answer to the pet
  await $.turn.start({ text: 'something else', turnId: 'U1' })
  await $.turn.complete({ turnId: 'U1', answer: 'other answer', reason: 'answer', durationMs: 5 } as never)
  await h.clock.advance(600)
  expect(h.snap().lastReply).toEqual(reply)
})

test('dismiss hides a finished agent, its events and the files only it touched, from the snapshot and the pane; a running one is refused; activity brings it back', async ($, on) => {
  const h = await askHost($, on)
  await crew($, h)
  await h.clock.advance(600)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x1', 'x2'])
  expect(h.snap().files.map(f => f.path).sort()).toEqual(['C:/w/docs/main-only.md', 'C:/w/plans/plan.md'])
  await h.send({ kind: 'dismiss', ids: ['x1', 'x2', 'ghost'] })
  await h.clock.advance(600)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x2'])
  expect(h.snap().files.map(f => f.path)).toEqual(['C:/w/docs/main-only.md'])
  const pane = {
    plugin: 'crew-graph',
    component: 'Pane' as const,
    requestId: 'crew-graph',
    props: { title: 'Crew', isFocused: true, bodyColumns: 70, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
  }
  const ui = await $.ui.mount({ ...pane, surface: 'terminal' })
  expect(await ui.find({ text: / Explore$/ })).toBeUndefined()
  expect(await ui.find({ text: /plans\/plan\.md/ })).toBeUndefined()
  expect(await ui.find({ text: / Plan$/ })).toBeDefined()
  await ui.unmount()
  // a wrong token dismisses nothing
  await h.send({ kind: 'dismiss', ids: ['x2'] }, { token: 'nope' })
  // the dismissed agent works again: back
  await $.tool.call({ tool: 'Grep', pattern: 'hooks', agentId: 'x1' } as never)
  await h.clock.advance(600)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x1', 'x2'])
})

test('"Ask Claude to stop it" submits a framed request for a running agent; a finished or unknown one gets none', async ($, on) => {
  const h = await askHost($, on)
  await crew($, h)
  await h.send({ kind: 'stop', id: 'x2' })
  expect(h.submits).toHaveLength(1)
  expect(h.submits[0]?.text).toMatch(/stop the running Plan agent \(id x2/)
  expect(h.submits[0]?.origin).toMatchObject({ kind: 'plugin' })
  expect((h.submits[0]?.origin as { asUser?: true }).asUser).toBeUndefined()
  await h.send({ kind: 'stop', id: 'x1' })
  await h.send({ kind: 'stop', id: 'nobody' })
  await h.send({ kind: 'stop', id: 'x2' }, { token: 'nope' })
  await h.send({ kind: 'stop', id: 'x2' }, { sessionId: 'other' })
  expect(h.submits).toHaveLength(1)
})

test('with auto-dismiss on, a finished agent leaves after the set time and the running one stays', async ($, on) => {
  const h = await askHost($, on, { settings: '{"autoDismiss":5}' })
  await crew($, h)
  await h.clock.advance(2000)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x1', 'x2'])
  await h.clock.advance(5 * 60_000 + 12_000)
  await h.clock.advance(600)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x2'])
})

test('/clear forgets what was dismissed and the pending question', async ($, on) => {
  const h = await askHost($, on)
  await crew($, h)
  await h.send({ kind: 'dismiss', ids: ['x1'] })
  await $.session.end({ reason: 'clear', sessionId: SID } as never)
  // the next agent happens to get the id x1 again: it is shown, the old dismissal is gone
  h.state.spawned = 0
  await $.turn.start({ text: 'again', turnId: 'T9' })
  await $.agent.spawn(h.spawnArgs('Explore', 'new one', 's9'))
  await $.turn.complete({ turnId: 'T9x', agentId: 'x1', answer: 'done', reason: 'answer', durationMs: 5 } as never)
  await h.clock.advance(600)
  expect(h.snap().agents.map(a => a.id)).toEqual(['main', 'x1'])
})

// ---------------------------------------------------------------- the pet survives a reload

const launches = (h: Host) => h.runs.filter(r => /launch\.mjs$/.test(r[1] ?? '') && r.includes('--electron'))
const tokenOf = (r: readonly string[] | undefined) => (r ?? [])[(r ?? []).indexOf('--token') + 1] ?? ''
// nothing beneath the plugin answers session.start: its hook has done its work by then
const startSession = ($: Engine) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/w' } as never).catch(() => undefined)

test('session.start starts the pet again when it was on, with a new token; requests under the new token are taken, the old one not', async ($, on) => {
  const h = await askHost($, on)
  expect(launches(h)).toHaveLength(1)
  const first = h.token
  await startSession($)
  await h.clock.advance(200)
  expect(launches(h)).toHaveLength(2)
  const second = tokenOf(launches(h)[1])
  expect(second).toMatch(/^[0-9a-f]{32}$/)
  expect(second).not.toBe(first)
  // the inbox poll runs under the new token
  await h.send({ kind: 'ask', mode: 'send', text: 'old window token' }, { token: first })
  expect(h.submits).toHaveLength(0)
  await h.send({ kind: 'ask', mode: 'send', text: 'new token' }, { token: second })
  expect(h.submits).toHaveLength(1)
})

test('a session where the pet was never on starts nothing on session.start', async ($, on) => {
  const never = await askHost($, on, { pet: false })
  await startSession($)
  await never.clock.advance(200)
  expect(launches(never)).toHaveLength(0)
})

test('after /crew pet off, a new session.start does not start the pet', async ($, on) => {
  const h = await askHost($, on)
  await $.command.run({ command: 'crew', args: 'pet off' } as never)
  await startSession($)
  await h.clock.advance(200)
  expect(launches(h)).toHaveLength(1)
})

test('after /crew pet off all, a new session.start does not start the pet', async ($, on) => {
  const h = await askHost($, on)
  await $.command.run({ command: 'crew', args: 'pet off all' } as never)
  await startSession($)
  await h.clock.advance(200)
  expect(launches(h)).toHaveLength(1)
})

test('the Settings window\'s Rescan rescans the characters folder like /crew characters reload; without the token nothing happens', async ($, on) => {
  const h = await askHost($, on)
  // the folder: one file the host reads back as text that is not JSON, so the rescan has something to report
  h.state.folder = [{ name: 'puff.json', kind: 'file', size: 40, mtimeMs: 1, isLink: false }]
  const manifest = () => h.written.get(`${STATE}/characters-user.js`) ?? ''
  const before = manifest()
  await h.send({ kind: 'rescan' }, { token: 'nope' })
  await h.send({ kind: 'rescan' }, { sessionId: 'another-session' })
  expect(manifest()).toBe(before)
  await h.send({ kind: 'rescan' })
  expect(manifest()).toContain('"file":"puff.json"')
  expect(manifest()).toContain('"code":"bad-json"')
  expect(manifest()).toMatch(/window\.__crewUserScanned = \d+;/)
  expect(manifest()).not.toBe(before)
  await h.clock.advance(600)
  expect(h.snap().petAck).toBe(h.state.seq) // acknowledged like the other requests
  expect(h.submits).toHaveLength(0) // it asks Claude nothing
  expect(h.fills).toHaveLength(0)
})

test('an accepted request is acknowledged in the snapshot (petAck = its seq); a refused one is not', async ($, on) => {
  const h = await askHost($, on)
  await h.send({ kind: 'ask', mode: 'send', text: 'refused' }, { token: 'wrong' })
  await h.clock.advance(600)
  expect(h.snap().petAck).toBeUndefined()
  await h.send({ kind: 'ask', mode: 'draft', text: 'taken' })
  await h.clock.advance(600)
  expect(h.snap().petAck).toBe(h.state.seq)
  // an accepted dismissal that finds nothing to dismiss is still delivered
  await h.send({ kind: 'dismiss', ids: ['ghost'] })
  await h.clock.advance(600)
  expect(h.snap().petAck).toBe(h.state.seq)
})

test('a question typed into the pet is a prompt turn titled by the words typed, not by the frame', { options: { foodFrom: 'todos+work' } }, async ($, on) => {
  const h = await askHost($, on)
  await h.send({ kind: 'ask', mode: 'send', text: 'why is it slow?', agentId: undefined })
  expect(h.submits).toHaveLength(1)
  // the engine frames the text when it opens the turn
  await $.turn.start({ text: `The crew-graph plugin sent a message: ${h.submits[0]?.text}`, turnId: 'Q1' })
  await h.clock.advance(600)
  expect(h.snap().tasks?.filter(i => i.src === 'turn').map(i => [i.status, i.title])).toEqual([['in_progress', 'why is it slow?']])
  await $.turn.complete({ turnId: 'Q1', answer: 'because', reason: 'answer', durationMs: 5 } as never)
  await h.clock.advance(600)
  expect(h.snap().tasks?.filter(i => i.src === 'turn').map(i => [i.status, i.title])).toEqual([['completed', 'why is it slow?']])
})
