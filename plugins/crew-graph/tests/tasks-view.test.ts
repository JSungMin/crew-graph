import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/characters-core.js'
import '../web/characters.js'
import '../web/tasks.js'

type Item = {
  id: string
  src: string
  owner: string | null
  title: string
  active: string
  status: string
  blockedBy: string[]
  deliverTo: string | null
  t: number
}
type Ev = { k: string; d: Item; isNew?: boolean }
type View = {
  cleanList(raw: unknown): Item[]
  blockedIds(list: Item[]): Set<string>
  diff(prev: Map<string, string>, list: Item[], first: boolean): Ev[]
  agentFor(id: string | null, has: (k: string) => boolean, mainId: string): string | null
  eaterId(d: { deliverTo: string | null; owner: string | null }): string
  stackSlot(i: number, id: string): { x: number; y: number; z: number; ry: number }
  tableSlot(i: number): { x: number; z: number }
  cardLines(d: Item, owner: string, blocked: boolean): [string, string][]
  foodFor(charId: string, def: unknown, setting: string): { key: string; boxes: { color: string }[]; crumb: string }
  FOODS: Record<string, { crumb: string; boxes: { size: number[]; at: number[]; color: string }[] }>
  BUILTIN_FOOD: Record<string, string>
  MOTION_OF: Record<string, string>
  EAT: { grab: number; chomp: number; chomps: number; total: number; gap: number; pop: number; last: number; minPx: number }
  eatSlot(free: number | undefined, now: number, dur: number): { at: number; free: number }
  boostFor(hm: number, base: number, pxw: number, minPx: number): number
  foodHeight(boxes: { size: number[]; at: number[] }[]): number
  eatSize(t: number): number
}
type Core = { normalizeDef(d: unknown): { def: null | { food?: { id?: string; boxes?: unknown[] } }; warnings: string[] }; FOOD_IDS: string[]; DEFAULT_FOOD: string }
const view = (globalThis as unknown as { CrewTasks: View }).CrewTasks
const core = (globalThis as unknown as { CrewCharCore: Core }).CrewCharCore
const builtin = (globalThis as unknown as { __crewCharacters: { id: string }[] }).__crewCharacters

const item = (id: string, status: string, extra: Partial<Item> = {}): Item => ({ id, src: 'todo', owner: 'main', title: id, active: '', status, blockedBy: [], deliverTo: null, t: 0, ...extra })
const seen = (list: Item[]) => new Map(list.map(d => [d.id, d.status]))
const kinds = (ev: Ev[]) => ev.map(e => `${e.k}:${e.d.id}`)

// ---------------------------------------------------------------- the snapshot's list

test('the list is cleaned: wrong shapes dropped, texts bounded, a title missing is empty', () => {
  const list = view.cleanList([
    { id: 'a', status: 'pending', title: 'x'.repeat(500), owner: 5, blockedBy: ['b', 7], t: 'x' },
    { id: 'b', status: 'weird' },
    { status: 'pending' },
    null,
    { id: 'c', status: 'completed', src: 'agent', owner: 'a1', deliverTo: 'main', active: 'Doing it', t: 9 },
  ])
  expect(list.map(d => d.id)).toEqual(['a', 'c'])
  expect(list[0]).toMatchObject({ src: 'todo', owner: null, blockedBy: ['b'], t: 0 })
  expect(list[0]?.title.length).toBe(200)
  expect(list[1]).toMatchObject({ src: 'agent', owner: 'a1', deliverTo: 'main', active: 'Doing it', t: 9 })
  expect(view.cleanList(undefined)).toEqual([])
  expect(view.cleanList(Array.from({ length: 200 }, (_, i) => ({ id: `t${i}`, status: 'pending' }))).length).toBe(80)
})

test('a task is blocked while one it waits for is open', () => {
  const list = [item('a', 'in_progress'), item('b', 'pending', { blockedBy: ['a'] }), item('c', 'pending', { blockedBy: ['gone'] }), item('d', 'completed', { blockedBy: ['a'] })]
  expect([...view.blockedIds(list)]).toEqual(['b'])
  expect([...view.blockedIds([item('a', 'completed'), item('b', 'pending', { blockedBy: ['a'] })])]).toEqual([])
})

// ---------------------------------------------------------------- only what is seen live is played

test('the first snapshot is a baseline: nothing is eaten again after a reload', () => {
  const list = [item('done', 'completed'), item('open', 'pending'), item('hold', 'in_progress'), item('bad', 'failed'), item('gone', 'deleted')]
  const ev = view.diff(new Map(), list, true)
  expect(kinds(ev)).toEqual(['rest:open', 'rest:hold', 'rest:bad'])
})

test('a status change after that is played: take, put back, eat, fail, poof', () => {
  const a = [item('x', 'pending'), item('y', 'pending'), item('z', 'pending'), item('w', 'pending')]
  const b = [item('x', 'in_progress'), item('y', 'pending'), item('z', 'pending'), item('w', 'pending')]
  expect(kinds(view.diff(seen(a), b, false))).toEqual(['start:x'])
  expect(kinds(view.diff(seen(b), a, false))).toEqual(['back:x'])
  const c = [item('x', 'completed'), item('y', 'failed'), item('z', 'deleted'), item('w', 'pending')]
  expect(kinds(view.diff(seen(b), c, false))).toEqual(['eat:x', 'fail:y', 'poof:z'])
  // an unchanged list plays nothing, however often it is read again
  expect(view.diff(seen(c), c, false)).toEqual([])
})

test('a new id is shown, taken at once when it is in progress, and a throttled write that skipped a state still plays its end', () => {
  const prev = seen([item('old', 'pending')])
  const ev = view.diff(prev, [item('old', 'pending'), item('n1', 'pending'), item('n2', 'in_progress'), item('n3', 'completed'), item('n4', 'failed')], false)
  expect(kinds(ev)).toEqual(['show:n1', 'show:n2', 'start:n2', 'eat:n3', 'fail:n4'])
  expect(ev.filter(e => e.isNew).length).toBe(5)
})

test('an id that was seen once and left is not new again: no replay when it comes back completed', () => {
  const prev = new Map([['x', 'completed']])
  expect(view.diff(prev, [item('x', 'completed')], false)).toEqual([])
})

test('an agent ticket is eaten by its parent, a task by its owner, an unowned one by main', () => {
  expect(view.eaterId({ deliverTo: 'main', owner: 'a1' })).toBe('main')
  expect(view.eaterId({ deliverTo: null, owner: 'a1' })).toBe('a1')
  expect(view.eaterId({ deliverTo: null, owner: null })).toBe('main')
  const has = (k: string) => ['main', 'a1'].includes(k)
  expect(view.agentFor('a1', has, 'main')).toBe('a1')
  expect(view.agentFor('ghost', has, 'main')).toBe('main') // an owner nobody draws: main has it
  expect(view.agentFor(null, has, 'main')).toBe('main')
  expect(view.agentFor('a1', k => k === 'a1', 'main')).toBe('a1')
  expect(view.agentFor(null, () => false, 'main')).toBeNull()
})

// ---------------------------------------------------------------- where things sit

test('stack slots rise by a fixed step and are the same every time; the table takes six in two rows', () => {
  expect(view.stackSlot(2, 'id')).toEqual(view.stackSlot(2, 'id'))
  expect([0, 1, 2, 3, 4].map(i => Math.round(view.stackSlot(i, 'q').y * 10) / 10)).toEqual([0, 0.6, 1.2, 1.8, 2.4])
  const slots = [0, 1, 2, 3, 4, 5].map(view.tableSlot)
  expect(new Set(slots.map(s => `${s.x},${s.z}`)).size).toBe(6)
  expect(new Set(slots.map(s => s.z)).size).toBe(2)
})

test('the hover card says the title, the state, who has it and what it is doing now', () => {
  const lines = view.cardLines(item('x', 'in_progress', { title: 'Fix the loader', owner: 'main', active: 'Fixing the loader' }), 'main', false)
  expect(lines.map(l => l[0])).toEqual(['Fix the loader', 'in progress · to-do', 'owner: main', 'now: Fixing the loader'])
  expect(lines[0]?.[1]).toBe('b')
  expect(view.cardLines(item('x', 'pending', { owner: null, src: 'task' }), '', true).map(l => l[0])).toEqual(['x', 'waiting · blocked · task', 'nobody has taken it'])
  const ticket = view.cardLines(item('x', 'completed', { src: 'agent', owner: 'a1', deliverTo: 'main', active: 'ignored' }), 'Explore', false).map(l => l[0])
  expect(ticket).toEqual(['x', 'done · subagent', 'agent: Explore', 'hands it to main'])
})

// ---------------------------------------------------------------- the food

test('each built-in has its own food, a user pack the sunflower seed, and the setting can ask for tickets', () => {
  expect(view.BUILTIN_FOOD).toEqual({ crab: 'fish', bunny: 'carrot', cat: 'treat', mochi: 'seed', robot: 'battery' })
  for (const c of builtin) if (c.id in view.BUILTIN_FOOD) expect(view.foodFor(c.id, undefined, 'character').key).toBe(view.BUILTIN_FOOD[c.id])
  expect(builtin.map(c => c.id).filter(id => !(id in view.BUILTIN_FOOD))).toEqual([]) // a new built-in needs a food
  // a user's pack (JSON without a food, or a GLB, which has no def at all) eats the seed, as the hamster does; nobody holding it is a ticket
  expect(view.foodFor('someone', undefined, 'character').key).toBe('seed')
  expect(view.foodFor('someone', undefined, 'character').boxes).toBe(view.FOODS.seed?.boxes)
  expect(view.foodFor('', undefined, 'character').key).toBe('ticket')
  expect(view.foodFor('someone', undefined, 'ticket').key).toBe('ticket') // the setting still wins for everyone
  expect(view.foodFor('crab', undefined, 'ticket').key).toBe('ticket')
  expect(Object.keys(view.MOTION_OF).sort()).toEqual(Object.keys(view.BUILTIN_FOOD).sort())
  for (const f of Object.values(view.FOODS)) for (const b of f.boxes) expect(b.color).toMatch(/^#[0-9a-f]{6}$/i)
})

test('a user pack without a valid food eats the seed: no food, a bad food, a GLB; built-ins keep theirs; the ticket setting wins', () => {
  const base = { id: 'puff', bones: { body: { boxes: [{ size: [4, 2, 3], at: [0, 1, 0], color: '#aabbcc' }] } } }
  const none = core.normalizeDef(base)
  expect(view.foodFor('puff', none.def, 'character').key).toBe('seed')
  expect(view.foodFor('puff', none.def, 'character').crumb).toBe(view.FOODS.seed?.crumb)
  for (const food of ['steak!', 7, true, { boxes: [] }, [], 'banana']) {
    const r = core.normalizeDef({ ...base, food })
    expect(r.def?.food).toBeUndefined()
    expect(view.foodFor('puff', r.def, 'character').key).toBe('seed')
  }
  expect(view.foodFor('puff', undefined, 'character').key).toBe('seed') // a GLB has no def
  expect(view.foodFor('puff', none.def, 'ticket').key).toBe('ticket')
  expect(view.foodFor('robot', undefined, 'character').key).toBe('battery')
  expect(view.foodFor('crab', undefined, 'character').key).toBe('fish')
  // the foods a pack may name are the foods there are
  expect([...core.FOOD_IDS].sort()).toEqual(Object.keys(view.FOODS).sort())
  expect(core.DEFAULT_FOOD).toBe('seed')
})

test('a pack may name a built-in food or bring boxes; a bad food is ignored', () => {
  const base = { id: 'mine', bones: { body: { boxes: [{ size: [4, 2, 3], at: [0, 1, 0], color: '#aabbcc' }] } } }
  const byId = core.normalizeDef({ ...base, food: 'Carrot' })
  expect(byId.def?.food).toEqual({ id: 'carrot' })
  expect(view.foodFor('mine', byId.def, 'character').key).toBe('carrot')
  const bone = { boxes: [{ size: [2.4, 0.5, 0.5], at: [0, 0, 0], color: '#e8e0d0' }, { size: [0.6, 0.9, 0.9], at: [1.2, 0, 0], color: '#e8e0d0' }] }
  const own = core.normalizeDef({ ...base, food: bone })
  expect(own.def?.food?.boxes?.length).toBe(2)
  expect(view.foodFor('mine', own.def, 'character').key).toBe('own:mine')
  expect(view.foodFor('mine', own.def, 'ticket').key).toBe('ticket')
  expect(core.normalizeDef({ ...base, food: bone.boxes }).def?.food?.boxes?.length).toBe(2) // a bare list works too
  const bad = core.normalizeDef({ ...base, food: 'no good!' })
  expect(bad.def?.food).toBeUndefined()
  expect(bad.warnings.some(w => w.includes('food'))).toBe(true)
  expect(core.normalizeDef({ ...base, food: { boxes: [] } }).def?.food).toBeUndefined()
  // an id that is not a built-in food is dropped with a warning, and the pack eats the seed
  const unknown = core.normalizeDef({ ...base, food: 'nothing-like-it' })
  expect(unknown.def?.food).toBeUndefined()
  expect(unknown.warnings.some(w => w.includes('food'))).toBe(true)
  expect(view.foodFor('mine', unknown.def, 'character').key).toBe('seed')
  const many = core.normalizeDef({ ...base, food: Array.from({ length: 90 }, () => bone.boxes[0]) })
  expect(many.def?.food?.boxes?.length).toBe(40)
})

// ---------------------------------------------------------------- the eat

test('an eat takes about 2.3 s: grab and lift, three chomps, a swallow', () => {
  const E = view.EAT
  expect(E.total).toBeGreaterThanOrEqual(2)
  expect(E.total).toBeLessThanOrEqual(2.5)
  expect(E.grab + E.chomps * E.chomp).toBeLessThan(E.total) // some time is left for the swallow
  expect(E.total - E.grab - E.chomps * E.chomp).toBeGreaterThan(0.3)
})

test('eats of one eater go one after another; another eater is not held up; a late request starts at once', () => {
  const E = view.EAT, one = E.total + E.gap
  let free: number | undefined
  const starts: number[] = []
  for (let i = 0; i < 4; i++) {
    const s = view.eatSlot(free, 10, E.total) // four tasks finished in the same snapshot
    starts.push(s.at)
    free = s.free
  }
  expect(starts[0]).toBe(10)
  starts.forEach((t, i) => expect(Math.abs((t) - (10 + i * one)) < 1e-6).toBe(true))
  expect(starts[1]! - starts[0]!).toBeGreaterThan(E.total) // never two at the same time
  expect(view.eatSlot(undefined, 10, E.total).at).toBe(10) // nobody else: at once
  expect(view.eatSlot(free, 10 + 99, E.total).at).toBe(10 + 99) // the queue was empty long ago
})

test('the item grows to 1.5x on its way to the mouth, shrinks with each chomp but stays readable, and is gone after the swallow', () => {
  const E = view.EAT
  expect(view.eatSize(0)).toBe(1)
  expect(Math.abs((view.eatSize(E.grab)) - (E.pop)) < 1e-6).toBe(true)
  expect(Math.abs((E.pop) - (1.5)) < 1e-6).toBe(true)
  let prev = 0
  for (let t = 0; t <= E.grab; t += 0.01) { const v = view.eatSize(t); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v } // only grows while it is lifted
  prev = 9
  for (let t = E.grab; t <= E.total; t += 0.01) { const v = view.eatSize(t); expect(v).toBeLessThanOrEqual(prev + 1e-9); prev = v } // only shrinks while it is eaten
  expect(Math.abs(view.eatSize(E.grab + E.chomp * E.chomps) - E.pop * E.last) < 1e-3).toBe(true) // after the third chomp: still a bit left
  expect(view.eatSize(E.total)).toBeLessThan(0.01)
  expect(view.eatSize(E.total + 5)).toBeLessThan(0.01)
})

test('a held or eaten item is boosted to at least minPx tall on screen, never made smaller, and capped', () => {
  const px = view.EAT.minPx
  expect(px).toBeGreaterThanOrEqual(14)
  expect(view.boostFor(1.2, 0.3, 10, px)).toBeGreaterThan(1) // 1.2 voxels * 0.3 * 10 px = 3.6 px: too small
  expect(Math.abs((1.2 * 0.3 * 10 * view.boostFor(1.2, 0.3, 10, px)) - (px)) < 1e-6).toBe(true)
  expect(view.boostFor(1.2, 0.3, 100, px)).toBe(1) // already 36 px: left alone
  expect(view.boostFor(1.2, 0.3, 0.001, px)).toBe(4) // far away: the cap
  expect(view.boostFor(0, 0.3, 10, px)).toBe(1)
  expect(view.boostFor(NaN, 0.3, 10, px)).toBe(1)
  // the height of a food: the tall box, or a long thing lying down counts for its length
  expect(view.foodHeight([{ size: [1, 3, 1], at: [0, 0, 0] }])).toBe(3)
  expect(Math.abs((view.foodHeight([{ size: [2.5, 0.5, 0.5], at: [0, 0, 0] }])) - (0.55 * 2.5)) < 1e-6).toBe(true)
  expect(view.foodHeight([])).toBe(1)
  for (const f of Object.values(view.FOODS)) expect(view.foodHeight(f.boxes)).toBeGreaterThan(0.5)
})
