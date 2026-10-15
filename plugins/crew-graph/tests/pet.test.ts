import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/characters-core.js'
import '../web/characters.js'
import '../web/pet-settings-core.js'

import { BUILTIN_CHARACTERS, agentsFromDataJs, autoPick, describeAgentPicks, describeCharacters, describePetSettings, roleOf, scanCharacters, traitsOf } from '../hooks/characters'
import type { AutoState, CharFs, RoleAgent } from '../hooks/characters'
import { AUTO_LABEL, FOLLOW_LABEL, RANDOM_LABEL, agentAction, characterItems, crabItems, currentValue, finishedIds, trayItems, windowItems } from '../overlay/menus.mjs'
import type { MenuItem } from '../overlay/menus.mjs'

type Agent = { id: string; type?: string; description?: string; verb?: string; isArchitect?: boolean; parentId?: string | null }
type Settings = {
  v: number
  default: string | null
  types: Record<string, string>
  agents: Record<string, string>
  show: { bubbles: boolean; ticker: boolean; papers: boolean; nameplate: boolean }
  reduceMotion: boolean
  alwaysOnTop: boolean
  opacity: number
  size: string
  autoDismiss: number
}
type Pick = { id: string; how: string; mode: string; why: string[] | null }
type Pet = {
  SIZES: Record<string, { width: number; height: number }>
  defaults(): Settings
  sanitize(raw: unknown): Settings
  merge(cur: unknown, patch: unknown): Settings
  agentKey(session: string, id: string): string
  resolve(s: Settings, rules: [string, string][], agent: Agent, ctx: { ids: string[]; auto?: (a: Agent) => { id: string; why: string[] } | null; session: string }): Pick | null
  explain(r: Pick | null): string
  load(fsx: Fsx, file: string): Settings | null
  save(fsx: Fsx, file: string, s: Settings): void
}
type Fsx = { readFileSync(p: string, enc: string): string; writeFileSync(p: string, t: string): void; renameSync(a: string, b: string): void; mkdirSync(p: string, o: unknown): void }
type Core = {
  parseRules(s: unknown): [string, string][]
  hash(s: string): number
  roleOf(a: Agent): Record<string, number>
  autoPick(chars: { id: string; traits: string[] }[], a: Agent, state: AutoState): { id: string; why: string[]; parent: string } | null
  normalizeDef(d: unknown): { def: null | { traits: string[] }; warnings: string[] }
}
const pet = (globalThis as unknown as { CrewPetCore: Pet }).CrewPetCore
const core = (globalThis as unknown as { CrewCharCore: Core }).CrewCharCore
const builtin = (globalThis as unknown as { __crewCharacters: { id: string; traits: string[] }[] }).__crewCharacters

// ---------------------------------------------------------------- what the settings file may hold

test('settings are checked: bad values dropped, missing ones the default, unsafe keys never kept', () => {
  expect(pet.sanitize(null)).toEqual(pet.defaults())
  expect(pet.sanitize('nope')).toEqual(pet.defaults())
  const s = pet.sanitize({
    default: 'auto',
    types: { Explore: 'cat', bad: 42, '': 'crab', 'with space': 'a b', main: 'crab', __proto__: 'crab', constructor: 'crab' },
    agents: { 'sess|a1': 'random', [`x`.repeat(201)]: 'crab' },
    show: { bubbles: false, ticker: 'no', nameplate: false },
    reduceMotion: true,
    alwaysOnTop: 'yes',
    opacity: 12,
    size: 'XL',
    extra: 1,
  })
  expect(s.default).toBe('auto')
  expect(s.types).toEqual({ Explore: 'cat', main: 'crab' })
  expect(Object.keys(s.types)).not.toContain('__proto__')
  expect(s.agents).toEqual({ 'sess|a1': 'random' })
  expect(s.show).toEqual({ bubbles: false, ticker: true, papers: true, nameplate: false })
  expect(s.reduceMotion).toBe(true)
  expect(s.alwaysOnTop).toBe(true)
  expect(s.opacity).toBe(60) // 60-100
  expect(s.size).toBe('')
  expect('extra' in s).toBe(false)
  expect(pet.sanitize({ opacity: 100.4 }).opacity).toBe(100)
  expect(pet.sanitize({ opacity: 250 }).opacity).toBe(100)
  expect(pet.sanitize({ default: 'not valid!' }).default).toBeNull()
  // a file written by JSON.parse can carry a real own "__proto__" key
  expect(Object.keys(pet.sanitize(JSON.parse('{"types":{"__proto__":"crab","Plan":"mochi"}}')).types)).toEqual(['Plan'])
})

test('a patch changes only what it names; null or "" removes a rule; the window presets are S, M, L', () => {
  let s = pet.defaults()
  s = pet.merge(s, { default: 'random', types: { Explore: 'cat', '*': 'auto' }, show: { ticker: false }, opacity: 80, size: 'L' })
  expect(s.default).toBe('random')
  expect(s.types).toEqual({ Explore: 'cat', '*': 'auto' })
  expect(s.show).toEqual({ bubbles: true, ticker: false, papers: true, nameplate: true })
  expect([s.opacity, s.size]).toEqual([80, 'L'])
  s = pet.merge(s, { types: { Explore: null, Plan: 'mochi' }, default: null, agents: { 's|a': 'robot' } })
  expect(s.types).toEqual({ '*': 'auto', Plan: 'mochi' })
  expect(s.default).toBeNull()
  s = pet.merge(s, { agents: { 's|a': '' }, show: { papers: false, bubbles: 'x' }, size: 'huge', nothing: 1 })
  expect(s.agents).toEqual({})
  expect(s.show.papers).toBe(false)
  expect(s.show.bubbles).toBe(true)
  expect(s.size).toBe('L') // an invalid size is dropped; it does not even clear the old one
  // the file is merged, never trusted: a patch of the wrong type changes nothing
  expect(pet.merge(s, 'x')).toEqual(s)
  expect(pet.merge(s, { types: [1, 2], show: 5 })).toEqual(s)
  expect(Object.keys(pet.SIZES)).toEqual(['S', 'M', 'L'])
  expect(pet.SIZES.S?.width).toBeLessThan(pet.SIZES.M?.width ?? 0)
  expect(pet.SIZES.M?.width).toBeLessThan(pet.SIZES.L?.width ?? 0)
})

test('the maps keep the newest entries when they are full', () => {
  let s = pet.defaults()
  for (let i = 0; i < 70; i += 1) s = pet.merge(s, { types: { [`t${i}`]: 'crab' } })
  expect(Object.keys(s.types).length).toBe(64)
  expect(s.types.t69).toBe('crab')
  expect(s.types.t0).toBeUndefined()
  for (let i = 0; i < 210; i += 1) s = pet.merge(s, { agents: { [`s|a${i}`]: 'cat' } })
  expect(Object.keys(s.agents).length).toBe(200)
  expect(s.agents['s|a209']).toBe('cat')
  expect(s.agents['s|a0']).toBeUndefined()
})

test('the settings file is written to a temp file and renamed; a missing or broken file reads as null', () => {
  const files = new Map<string, string>()
  const ops: string[] = []
  const fsx: Fsx = {
    readFileSync: p => {
      const v = files.get(p)
      if (v === undefined) throw new Error('ENOENT')
      return v
    },
    writeFileSync: (p, t) => {
      ops.push(`write ${p}`)
      files.set(p, t)
    },
    renameSync: (a, b) => {
      ops.push(`rename ${a} ${b}`)
      files.set(b, files.get(a) ?? '')
      files.delete(a)
    },
    mkdirSync: p => void ops.push(`mkdir ${String(p)}`),
  }
  expect(pet.load(fsx, 'C:/u/overlay/pet-settings.json')).toBeNull()
  pet.save(fsx, 'C:/u/overlay/pet-settings.json', pet.merge(pet.defaults(), { default: 'auto' }))
  expect(ops).toEqual(['mkdir C:/u/overlay', 'write C:/u/overlay/pet-settings.json.tmp', 'rename C:/u/overlay/pet-settings.json.tmp C:/u/overlay/pet-settings.json'])
  expect(pet.load(fsx, 'C:/u/overlay/pet-settings.json')?.default).toBe('auto')
  expect(files.has('C:/u/overlay/pet-settings.json.tmp')).toBe(false)
  files.set('C:/u/overlay/pet-settings.json', '\uFEFF{"default":"random"}')
  expect(pet.load(fsx, 'C:/u/overlay/pet-settings.json')?.default).toBe('random')
  files.set('C:/u/overlay/pet-settings.json', '{ nope')
  expect(pet.load(fsx, 'C:/u/overlay/pet-settings.json')).toBeNull()
})

// ---------------------------------------------------------------- which character an agent gets

const IDS = ['crab', 'bunny', 'cat', 'mochi', 'robot', 'mine']
const ctxOf = (session = 's1', auto?: (a: Agent) => { id: string; why: string[] } | null) => ({ ids: IDS, session, ...(auto ? { auto } : {}) })
const cfg = (patch: unknown) => pet.merge(pet.defaults(), patch)

test('precedence: the agent, then its type in the pet, then the characters option, then the pet default', () => {
  const rules = core.parseRules('Explore=bunny, main=crab')
  const ex: Agent = { id: 'a1', type: 'Explore' }
  const all = cfg({ default: 'robot', types: { Explore: 'cat' }, agents: { [pet.agentKey('s1', 'a1')]: 'mochi' } })
  expect(pet.resolve(all, rules, ex, ctxOf())).toMatchObject({ id: 'mochi', how: 'agent' })
  // another session's entry for "a1" is not this one's
  expect(pet.resolve(all, rules, ex, ctxOf('s2'))).toMatchObject({ id: 'cat', how: 'type:Explore' })
  expect(pet.resolve(cfg({ default: 'robot', types: { Explore: 'cat' } }), rules, ex, ctxOf())).toMatchObject({ id: 'cat' })
  expect(pet.resolve(cfg({ default: 'robot' }), rules, ex, ctxOf())).toMatchObject({ id: 'bunny', how: 'option' })
  expect(pet.resolve(cfg({ default: 'robot' }), rules, { id: 'z', type: 'Other' }, ctxOf())).toMatchObject({ id: 'robot', how: 'default' })
  // nothing set anywhere: no rules, the crab; rules that do not match, a stable pick (what the option alone always did)
  expect(pet.resolve(pet.defaults(), [], { id: 'z', type: 'x' }, ctxOf())).toMatchObject({ id: 'crab', how: 'legacy' })
  const legacy = pet.resolve(pet.defaults(), rules, { id: 'z', type: 'Other' }, ctxOf())
  expect(legacy?.id).toBe(IDS[core.hash('z') % IDS.length])
  // the first matching rule is the one: "*" in the pet comes last among the pet's own type rules, but still above the option
  const star = cfg({ types: { '*': 'cat', main: 'crab' } })
  expect(pet.resolve(star, rules, { id: 'main', type: 'main' }, ctxOf())).toMatchObject({ id: 'crab', how: 'type:main' })
  expect(pet.resolve(star, rules, ex, ctxOf())).toMatchObject({ id: 'cat', how: 'type:*' })
  // a character that is not loaded (a pack that went away) does not decide: the next tier does; an option naming one is a crab, as before
  expect(pet.resolve(cfg({ types: { Explore: 'gone' }, default: 'robot' }), [], ex, ctxOf())).toMatchObject({ id: 'robot', how: 'default' })
  expect(pet.resolve(pet.defaults(), core.parseRules('Explore=gone'), ex, ctxOf())).toMatchObject({ id: 'crab', how: 'option' })
  // ids compare without case; random and auto are values of any tier
  expect(pet.resolve(cfg({ default: 'CAT' }), [], ex, ctxOf())?.id).toBe('cat')
  expect(pet.resolve(cfg({ types: { Explore: 'random' } }), [], ex, ctxOf())).toMatchObject({ id: IDS[core.hash('a1') % IDS.length], mode: 'random' })
})

test('a rule change in the pet reaches two session windows: both redraw by the new rule', () => {
  // each window resolves with its own session id from the same settings object main broadcasts
  const rules = core.parseRules('')
  const windows = ['sess-A', 'sess-B']
  const agentsOf = (n: number): Agent[] => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, type: i % 2 ? 'Explore' : 'sonnet-coder' }))
  const count = (s: Settings, id: string) => windows.reduce((n, w) => n + agentsOf(6).filter(a => pet.resolve(s, rules, a, ctxOf(w))?.id === id).length, 0)
  const before = pet.defaults()
  expect(count(before, 'cat')).toBe(0)
  const after = pet.merge(before, { types: { Explore: 'cat' } })
  expect(count(after, 'cat')).toBe(6) // 3 Explore agents in each of the two windows
  expect(count(after, 'crab')).toBe(6) // the others keep the default
  expect(count(pet.merge(after, { types: { Explore: null } }), 'cat')).toBe(0)
})

test('"in words" for the hover card', () => {
  const r = (x: Partial<Pick>): Pick => ({ id: 'robot', how: 'type:Explore', mode: 'set', why: null, ...x })
  expect(pet.explain(r({ mode: 'auto', why: ['code', 'test'] }))).toBe('matched: code, test')
  expect(pet.explain(r({ mode: 'auto', why: [] }))).toContain('no trait fits')
  expect(pet.explain(r({ mode: 'random' }))).toBe('random pick')
  expect(pet.explain(r({ how: 'agent' }))).toBe('set for this agent')
  expect(pet.explain(r({}))).toBe('set for Explore')
  expect(pet.explain(r({ how: 'type:*' }))).toBe('set for all types')
  expect(pet.explain(r({ how: 'option' }))).toBe('from the characters option')
  expect(pet.explain(r({ how: 'default' }))).toBe('pet default')
  expect(pet.explain(null)).toBe('')
})

// ---------------------------------------------------------------- auto: roles and traits

const state = (): AutoState => ({ locks: new Map() })
const poolOf = () => builtin.map(c => ({ id: c.id, traits: c.traits }))
const packs = [...poolOf(), { id: 'zip', traits: ['code', 'build', 'run', 'test', 'energetic'] }]

test('auto fits the role: a coder gets the robot, Explore the cat, a doc writer the bunny, Plan and the architect the mochi', () => {
  const st = state()
  const pick = (a: RoleAgent) => autoPick(poolOf(), a, st)
  expect(pick({ id: 'main', type: 'main', parentId: null })?.id).toBe('crab')
  expect(pick({ id: 'a1', type: 'sonnet-coder', description: 'implement the loader change', verb: 'edit', parentId: 'main' })).toMatchObject({ id: 'robot' })
  expect(pick({ id: 'a2', type: 'Explore', description: 'map settings usage', parentId: 'main' })?.id).toBe('cat')
  expect(pick({ id: 'a3', type: 'doc-writer', description: 'write the migration docs', parentId: 'main' })?.id).toBe('bunny')
  expect(pick({ id: 'a4', type: 'Plan', description: 'plan the rollout', parentId: 'main' })?.id).toBe('mochi')
  expect(pick({ id: 'a5', type: 'general-purpose', isArchitect: true, description: 'review loader design', parentId: 'main' })?.id).toBe('mochi')
  expect(pick({ id: 'a6', type: 'code-reviewer', parentId: 'main' })?.id).toBe('cat')
  // the task text counts when the type says nothing, and Korean words do too
  expect(autoPick(poolOf(), { id: 'b1', type: 'worker', description: 'fix the failing test', parentId: 'main' }, state())?.id).toBe('robot')
  expect(autoPick(poolOf(), { id: 'b2', type: 'worker', description: '마이그레이션 문서 작성', parentId: 'main' }, state())?.id).toBe('bunny')
  // the reason names the traits that matched, the strongest first
  expect(pick({ id: 'a7', type: 'tester', description: 'run the tests', verb: 'run', parentId: 'main' })).toMatchObject({ id: 'robot', why: expect.arrayContaining(['test']) })
  expect(roleOf({ id: 'x', type: 'Explore' }).explore).toBeGreaterThan(0)
  expect(roleOf({ id: 'x', type: 'zzz' })).toEqual({})
})

test('with the user pack that declares traits, a coder gets whichever fits best, and a pack with no traits never matches', () => {
  const st = state()
  const coder: RoleAgent = { id: 'a1', type: 'sonnet-coder', description: 'implement x', verb: 'edit', parentId: 'main' }
  expect(['robot', 'zip']).toContain(autoPick(packs, coder, st)?.id)
  // a pack that fits exactly the same as a built-in shares the work: siblings spread over equally good characters
  const twins = [...poolOf().filter(c => c.id !== 'robot'), { id: 'robot', traits: ['code', 'build', 'fix', 'test', 'implement'] }, { id: 'robot2', traits: ['code', 'build', 'fix', 'test', 'implement'] }]
  const st2 = state()
  const got = Array.from({ length: 6 }, (_, i) => autoPick(twins, { id: `c${i}`, type: 'sonnet-coder', parentId: 'main' }, st2)?.id)
  expect(new Set(got.slice(0, 2)).size).toBe(2)
  expect(new Set(got)).toEqual(new Set(['robot', 'robot2']))
  // an agent nobody fits (no trait matches anything) gets a stable pick, and four siblings do not all get the same one
  const odd = (id: string): RoleAgent => ({ id, type: 'zzz', description: 'qqq', parentId: 'main' })
  const st3 = state()
  const ids = Array.from({ length: 5 }, (_, i) => autoPick(poolOf(), odd(`z${i}`), st3)?.id)
  expect(new Set(ids).size).toBeGreaterThan(1)
  expect(autoPick(poolOf(), odd('z0'), state())?.id).toBe(ids[0])
  expect(autoPick([], coder, state())).toBeNull()
  expect(autoPick([{ id: 'plain', traits: [] }], coder, state())?.id).toBe('plain')
})

test('an agent keeps the character it was first given, whatever its verb does later', () => {
  const st = state()
  const a: RoleAgent = { id: 'a1', type: 'worker', description: 'look around', verb: 'read', parentId: 'main' }
  const first = autoPick(poolOf(), a, st)
  expect(first?.id).toBe('cat')
  for (const verb of ['edit', 'run', 'edit', 'plan', 'think']) expect(autoPick(poolOf(), { ...a, verb }, st)?.id).toBe(first?.id)
  // another run of the same agent id with a fresh state decides again, from the verb at that moment
  expect(autoPick(poolOf(), { ...a, verb: 'edit', description: '' }, state())?.id).toBe('robot')
  // the lock gives way when the character is gone (a pack removed)
  const withPack = [...poolOf(), { id: 'pk', traits: ['explore', 'search', 'investigate', 'review', 'locate', 'extra'] }]
  const st2 = state()
  const had = autoPick(withPack, a, st2)?.id
  expect(had).toBeDefined()
  expect(autoPick(poolOf().filter(c => c.id !== had), a, st2)?.id).not.toBe(had)
})

test('the viewer and the mod pick the same characters for the same agents (twin tables)', () => {
  const agents: RoleAgent[] = [
    { id: 'main', type: 'main', parentId: null },
    { id: 'a1', type: 'sonnet-coder', description: 'implement loader', verb: 'edit', parentId: 'main' },
    { id: 'a2', type: 'Explore', description: 'map settings usage', parentId: 'main' },
    { id: 'a3', type: 'doc-writer', description: '마이그레이션 문서 작성', parentId: 'main' },
    { id: 'a4', type: 'Plan', parentId: 'main' },
    { id: 'a5', type: 'x', isArchitect: true, parentId: 'main' },
    { id: 'a6', type: 'code-reviewer', parentId: 'main' },
    { id: 'a7', type: 'sonnet-coder', description: 'fix tests', verb: 'run', parentId: 'main' },
    { id: 'a8', type: 'sonnet-coder', description: 'fix tests', parentId: 'main' },
    { id: 'a9', type: 'fetcher', description: 'fetch https://x.test and summarize', parentId: 'a8' },
    { id: 'a10', type: 'zzz', description: 'qqq', parentId: 'a8' },
    { id: 'a11', type: 'zzz', description: 'qqq', parentId: 'a8' },
  ]
  const a = state()
  const b = state()
  for (const ag of agents) {
    expect(core.roleOf(ag)).toEqual(roleOf(ag))
    const x = core.autoPick(packs, ag, b)
    const y = autoPick(packs, ag, a)
    expect([ag.id, y?.id, y?.why]).toEqual([ag.id, x?.id, x?.why])
  }
})

test('traits in a pack are read and cleaned, in the viewer and in the mod', async () => {
  expect(traitsOf(['Code', ' test ', 'cheerful', 'bad word', '', 7, 'code', 'x'.repeat(30)])).toEqual(['code', 'test', 'cheerful'])
  expect(traitsOf('nope')).toEqual([])
  expect(traitsOf(Array.from({ length: 40 }, (_, i) => `t${i}`)).length).toBe(16)
  const def = { id: 'tp', traits: ['Explore', 'zzz yy', 'Search'], bones: { body: { boxes: [{ size: [1, 1, 1], at: [0, 0, 0], color: '#123456' }] } } }
  expect(core.normalizeDef(def).def?.traits).toEqual(['explore', 'search'])
  expect(core.normalizeDef({ ...def, traits: undefined }).def?.traits).toEqual([])
  const fs: CharFs = {
    list: async () => [{ name: 'tp.json', kind: 'file', size: 100, mtimeMs: 1 }],
    read: async () => JSON.stringify(def),
    readBytes: async () => '',
    write: async () => undefined,
    exists: async () => false,
  }
  const scan = await scanCharacters(fs, 'C:/u/characters', false)
  expect(scan.chars[0]).toMatchObject({ id: 'tp', traits: ['explore', 'search'] })
  const text = describeCharacters(scan, 'auto', 'C:/u/characters', [], false)
  expect(text).toContain('tp  voxel  tp.json  traits: explore, search')
  expect(BUILTIN_CHARACTERS.find(c => c.id === 'robot')?.traits).toEqual(['code', 'build', 'fix', 'test', 'implement'])
})

// ---------------------------------------------------------------- /crew characters: the pet's settings and the agents' picks

test('the pet settings are described tolerantly: missing, broken, set', () => {
  expect(describePetSettings(null)[0]).toContain('Settings window')
  expect(describePetSettings('{ nope')[0]).toContain('not valid JSON')
  expect(describePetSettings('42').join('\n')).toContain('none (the option, else a crab)')
  const lines = describePetSettings(JSON.stringify({ default: 'auto', types: { Explore: 'cat', '*': 'random', bad: 5 }, agents: { 's|a': 'robot', 's|b': 'cat' } }))
  const text = lines.join('\n')
  expect(text).toContain('default: auto (match the role)')
  expect(text).toContain('Explore -> cat')
  expect(text).toContain('any other type (*) -> random')
  expect(text).not.toContain('bad')
  expect(text).toContain('2 agents with a character of their own')
  expect(describePetSettings('\uFEFF{"default":"bunny"}').join('\n')).toContain('default: bunny')
})

test('the latest snapshot gives the agents and what auto would pick for them, with the reason', () => {
  const data = `window.__crewUpdate && window.__crewUpdate(${JSON.stringify({
    v: 1,
    agents: [
      { id: 'main', type: 'main', description: 'main loop', parentId: null, verb: 'think' },
      { id: 'a1', type: 'sonnet-coder', description: 'implement loader', parentId: 'main', verb: 'edit' },
      { id: 'a2', type: 'Explore', description: 'map usage', parentId: 'main' },
      { nope: 1 },
    ],
  })});\n`
  const agents = agentsFromDataJs(data)
  expect(agents.map(a => a.id)).toEqual(['main', 'a1', 'a2'])
  expect(agentsFromDataJs('garbage')).toEqual([])
  expect(agentsFromDataJs(null)).toEqual([])
  expect(agentsFromDataJs('window.__crewUpdate && window.__crewUpdate({ broken')).toEqual([])
  const text = describeAgentPicks(agents, BUILTIN_CHARACTERS).join('\n')
  expect(text).toContain('main -> crab (matched: lead, main, generalist)')
  expect(text).toContain('sonnet-coder (implement loader) -> robot (matched:')
  expect(text).toContain('Explore (map usage) -> cat (matched:')
  expect(describeAgentPicks([], BUILTIN_CHARACTERS)).toEqual([])
  const full = describeCharacters({ chars: [], notes: [], rev: '0' }, '', 'C:/u/characters', [], false, ['an extra line'])
  expect(full).toContain('an extra line')
})

// ---------------------------------------------------------------- the right-click menu and the tray

const labelsOf = (items: MenuItem[]) => items.map(i => i.label ?? '-')
const CHARS = [
  { id: 'crab', name: 'Clawd crab' },
  { id: 'bunny', name: 'Mochi bunny' },
  { id: 'zip', name: 'Zippy' },
]

test('a character is offered Character > (radio items for every character and Random), then Only this agent, near the top', () => {
  const sent: unknown[] = []
  const act = { set: (p: unknown) => void sent.push(p), focus: () => void sent.push('focus') }
  const s = cfg({ types: { Explore: 'bunny' } })
  const items = crabItems({ ctx: { id: 'a1', type: 'Explore', cur: 'bunny', chars: CHARS }, settings: s, session: 'sess', act, agentKeyOf: pet.agentKey })
  expect(labelsOf(items).slice(0, 3)).toEqual(['Character', 'Only this agent', '-'])
  const sub = items[0]?.submenu ?? []
  expect(labelsOf(sub)).toEqual([FOLLOW_LABEL, AUTO_LABEL, RANDOM_LABEL, '-', 'Clawd crab (crab)', 'Mochi bunny (bunny)', 'Zippy (zip)'])
  expect(sub.filter(i => i.type === 'radio').length).toBe(6)
  // the radio that is on is the type's rule
  expect(sub.filter(i => i.checked).map(i => i.label)).toEqual(['Mochi bunny (bunny)'])
  // picking applies to the agent's type
  sub.find(i => i.label === 'Zippy (zip)')?.click?.({ checked: true })
  sub.find(i => i.label === RANDOM_LABEL)?.click?.({ checked: true })
  sub.find(i => i.label === FOLLOW_LABEL)?.click?.({ checked: true })
  expect(sent).toEqual([{ types: { Explore: 'zip' } }, { types: { Explore: 'random' } }, { types: { Explore: null } }])
  // "Only this agent": ticking makes an entry for it, from the character it has now; unticking removes it
  sent.length = 0
  const only = items[1]
  expect(only?.type).toBe('checkbox')
  expect(only?.checked).toBe(false)
  only?.click?.({ checked: true })
  only?.click?.({ checked: false })
  expect(sent).toEqual([{ agents: { 'sess|a1': 'bunny' } }, { agents: { 'sess|a1': null } }])
  // with an entry of its own, the menu stands on it and a pick changes that entry
  sent.length = 0
  const own = crabItems({ ctx: { id: 'a1', type: 'Explore', cur: 'zip', chars: CHARS }, settings: cfg({ types: { Explore: 'bunny' }, agents: { 'sess|a1': 'zip' } }), session: 'sess', act, agentKeyOf: pet.agentKey })
  expect(own[1]?.checked).toBe(true)
  expect(own[0]?.submenu?.filter(i => i.checked).map(i => i.label)).toEqual(['Zippy (zip)'])
  own[0]?.submenu?.find(i => i.label === 'Clawd crab (crab)')?.click?.({ checked: true })
  expect(sent).toEqual([{ agents: { 'sess|a1': 'crab' } }])
  expect(labelsOf(items)).toContain('Show in Crew pane')
  items.find(i => i.label === 'Show in Crew pane')?.click?.({ checked: false })
  expect(sent.at(-1)).toBe('focus')
  // with nothing set, "follow the rules" is the one that is on
  const none = characterItems({ chars: CHARS, value: '', pick: () => undefined })
  expect(none.filter(i => i.checked).map(i => i.label)).toEqual([FOLLOW_LABEL])
  expect(currentValue(s, 'x|y', 'Explore')).toEqual({ value: 'bunny', own: false })
})

test('both the right-click menu and the tray have "Settings…"', () => {
  let opened = 0
  const noop = () => undefined
  const act = { show: noop, settings: () => void (opened += 1), collapse: noop, onTop: noop, ticker: noop, reset: noop, close: noop, quit: noop }
  const w = windowItems({ collapsed: false, onTop: true, ticker: true, hasId: true }, act)
  expect(labelsOf(w)).toContain('Settings…')
  w.find(i => i.label === 'Settings…')?.click?.({ checked: false })
  const tray = trayItems(
    { sessions: [{ id: 's1', name: 'proj · fix', collapsed: false }], onTop: true, ticker: false },
    { showOne: noop, collapseOne: noop, closeOne: noop, showAll: noop, settings: act.settings, onTop: noop, ticker: noop, reset: noop, quit: noop },
  )
  expect(labelsOf(tray)).toContain('Settings…')
  tray.find(i => i.label === 'Settings…')?.click?.({ checked: false })
  expect(opened).toBe(2)
  expect(tray.find(i => i.label === 'Activity ticker')?.checked).toBe(false)
  expect(labelsOf(tray)).toContain('proj · fix')
  expect(labelsOf(windowItems({ collapsed: true, onTop: false, ticker: true, hasId: false }, act))).toEqual(['Show', 'Settings…', 'Expand', 'Always on top', 'Activity ticker', 'Reset position & size', '-', 'Quit'])
})

// ---------------------------------------------------------------- ask Claude, dismiss, stop

test('the menu offers Dismiss for a finished agent and "Ask Claude to stop it" for a running one, from the snapshot status; main gets neither', () => {
  for (const st of ['completed', 'failed', 'killed', 'idle', 'waiting']) expect(agentAction({ id: 'a1', status: st })).toBe('dismiss')
  for (const st of ['running', 'pending']) expect(agentAction({ id: 'a1', status: st })).toBe('stop')
  expect(agentAction({ id: 'main', status: 'idle' })).toBe('')
  expect(agentAction({ id: 'a1', status: 'who knows' })).toBe('')
  expect(agentAction(null)).toBe('')
  const sent: string[] = []
  const act = { set: () => undefined, focus: () => void sent.push('focus'), ask: () => void sent.push('ask'), dismiss: () => void sent.push('dismiss'), stop: () => void sent.push('stop') }
  const base = { ctx: { id: 'a1', type: 'Explore', cur: 'crab', chars: CHARS }, settings: cfg({}), session: 'sess', act, agentKeyOf: pet.agentKey }
  const done = crabItems({ ...base, canAsk: true, action: 'dismiss' })
  expect(labelsOf(done)).toEqual(['Character', 'Only this agent', '-', 'Ask Claude…', 'Show in Crew pane', 'Dismiss', '-'])
  const running = crabItems({ ...base, canAsk: true, action: 'stop' })
  expect(labelsOf(running)).toEqual(['Character', 'Only this agent', '-', 'Ask Claude…', 'Show in Crew pane', 'Ask Claude to stop it', '-'])
  for (const l of ['Ask Claude…', 'Dismiss']) done.find(i => i.label === l)?.click?.({ checked: false })
  running.find(i => i.label === 'Ask Claude to stop it')?.click?.({ checked: false })
  expect(sent).toEqual(['ask', 'dismiss', 'stop'])
  // a window the mod gave no token to cannot ask, dismiss or stop
  expect(labelsOf(crabItems({ ...base, canAsk: false, action: 'dismiss' }))).toEqual(['Character', 'Only this agent', '-', 'Show in Crew pane', '-'])
  expect(finishedIds([{ id: 'main', status: 'idle' }, { id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }, { id: 'a3', status: 'failed' }])).toEqual(['a1', 'a3'])
})

test('every other menu asks Claude about nothing in particular and can dismiss all finished; the tray asks per session', () => {
  const sent: string[] = []
  const noop = () => undefined
  const act = { ask: () => void sent.push('ask'), dismissAll: () => void sent.push('all'), show: noop, settings: noop, collapse: noop, onTop: noop, ticker: noop, reset: noop, close: noop, quit: noop }
  const w = windowItems({ collapsed: false, onTop: true, ticker: true, hasId: true, canAsk: true, askHere: false, finished: 2 }, act)
  expect(labelsOf(w).slice(0, 3)).toEqual(['Ask Claude…', 'Dismiss all finished (2)', 'Show'])
  w.find(i => i.label === 'Ask Claude…')?.click?.({ checked: false })
  w.find(i => i.label?.startsWith('Dismiss all'))?.click?.({ checked: false })
  expect(sent).toEqual(['ask', 'all'])
  // nothing to dismiss: the entry is there, greyed out
  const none = windowItems({ collapsed: false, onTop: true, ticker: true, hasId: true, canAsk: true, finished: 0 }, act)
  expect(none.find(i => i.label === 'Dismiss all finished')?.enabled).toBe(false)
  // on a character's menu "Ask Claude…" is already there, about that agent
  expect(labelsOf(windowItems({ collapsed: false, onTop: true, ticker: true, hasId: true, canAsk: true, askHere: true, finished: 0 }, act)).filter(l => l === 'Ask Claude…')).toEqual([])
  // no token: no ask, no dismiss
  expect(labelsOf(windowItems({ collapsed: false, onTop: true, ticker: true, hasId: true }, act))).not.toContain('Ask Claude…')
  const asked: string[] = []
  const tray = trayItems(
    { sessions: [{ id: 's1', name: 'proj', collapsed: false, canAsk: true }, { id: 's2', name: 'other', collapsed: false }], onTop: true, ticker: true },
    { showOne: noop, askOne: id => void asked.push(id), collapseOne: noop, closeOne: noop, showAll: noop, settings: noop, onTop: noop, ticker: noop, reset: noop, quit: noop },
  )
  const subs = tray.filter(i => i.submenu).map(i => labelsOf(i.submenu ?? []))
  expect(subs[0]).toContain('Ask Claude…')
  expect(subs[1]).not.toContain('Ask Claude…')
  tray.find(i => i.label === 'proj')?.submenu?.find(i => i.label === 'Ask Claude…')?.click?.({ checked: false })
  expect(asked).toEqual(['s1'])
})

test('autoDismiss is 0, 5, 10 or 30 minutes: anything else reads as off', () => {
  expect(pet.defaults().autoDismiss).toBe(0)
  expect(pet.sanitize({ autoDismiss: 10 }).autoDismiss).toBe(10)
  for (const bad of [7, '5', -5, null, 60]) expect(pet.sanitize({ autoDismiss: bad }).autoDismiss).toBe(0)
  expect(pet.merge({ autoDismiss: 30 }, { opacity: 80 }).autoDismiss).toBe(30)
  expect(pet.merge({ autoDismiss: 30 }, { autoDismiss: 5 }).autoDismiss).toBe(5)
  expect(pet.merge({ autoDismiss: 30 }, { autoDismiss: 0 }).autoDismiss).toBe(0)
  expect(pet.merge({ autoDismiss: 30 }, { autoDismiss: 12 }).autoDismiss).toBe(30)
})
