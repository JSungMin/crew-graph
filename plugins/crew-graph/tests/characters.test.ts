import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/characters-core.js'
import '../web/characters.js'

import { BUILTIN_CHARACTERS, CHAR_README, FOOD_IDS, HOST_FILE_MAX, PACK_CODES, RIG_BONES, describeCharacters, lintVoxel, manifestOf, problem, safeCharId, scanCharacters, statusOf, writeCharacters } from '../hooks/characters'
import type { CharFs } from '../hooks/characters'
import { snapshotOf } from '../hooks/crew'
import { DEFAULT_ARCHITECT, DEFAULT_GATE, DEFAULT_MAIN, DEFAULT_TURN, DEFAULT_USAGE, parseCharacterRules, parseConfig } from '../hooks/deck/core'

type Box = { size: number[]; at: number[]; color: string; rot?: number[] }
type Bone = { parent: string | null; at: number[]; boxes: Box[]; gait?: number }
type Core = {
  RIG: string[]
  EYE_VARIANTS: string[]
  hash(s: string): number
  rigOf(n: string): string | null
  matchRig(names: string[]): { bones: Record<string, string>; variants: Record<string, Record<string, string>> }
  parseRules(s: unknown): [string, string][]
  chooseCharacter(rules: [string, string][], agent: { id: string; type?: string; isArchitect?: boolean }, ids: string[], auto?: (a: unknown) => { id: string } | null): string | null
  roleOf(agent: unknown): Record<string, number>
  autoPick(chars: { id: string; traits: string[] }[], agent: unknown, state: { locks: Map<string, { id: string; why: string[]; parent: string }> }): { id: string; why: string[]; parent: string } | null
  traitsOf(list: unknown): string[]
  normalizeDef(d: unknown): { def: null | { id: string; bones: Record<string, Bone>; eyes: Record<string, unknown[]>; scale: number }; warnings: string[] }
}
const core = (globalThis as unknown as { CrewCharCore: Core }).CrewCharCore
const builtin = (globalThis as unknown as { __crewCharacters: { id: string; name: string }[] }).__crewCharacters

// ---------------------------------------------------------------- the assignment option

test('the characters option reads who=character pairs, leniently', () => {
  expect(parseCharacterRules('main=crab, Explore=bunny; sonnet-coder=robot\n*=random')).toEqual([
    ['main', 'crab'],
    ['Explore', 'bunny'],
    ['sonnet-coder', 'robot'],
    ['*', 'random'],
  ])
  // a part without "=" is `*=<it>`; `=x` and `y=` are still dropped; `auto` is its own thing, not `random`
  expect(parseCharacterRules('  a = b ,junk, =x, y=, z=AUTO ')).toEqual([
    ['a', 'b'],
    ['*', 'junk'],
    ['z', 'auto'],
  ])
  expect(parseCharacterRules('')).toEqual([])
  expect(parseCharacterRules(42)).toEqual([])
  expect(parseCharacterRules(Array.from({ length: 200 }, (_, i) => `a${i}=crab`).join(',')).length).toBe(64)
})

test('a part without "=" means "*=": random, bunny, auto and "main=crab, random" all work', () => {
  expect(parseCharacterRules('random')).toEqual([['*', 'random']])
  expect(parseCharacterRules('bunny')).toEqual([['*', 'bunny']])
  expect(parseCharacterRules('main=crab, random')).toEqual([
    ['main', 'crab'],
    ['*', 'random'],
  ])
  expect(parseCharacterRules('auto')).toEqual([['*', 'auto']])
  expect(parseCharacterRules('Explore=cat; auto\nmain=crab')).toEqual([
    ['Explore', 'cat'],
    ['*', 'auto'],
    ['main', 'crab'],
  ])
  expect(parseCharacterRules(' , ;; ')).toEqual([])
  // and the first rule that matches wins: `main=crab, random` keeps the crab for main, the rest are a stable pick
  const ids = ['crab', 'bunny', 'cat']
  expect(core.chooseCharacter(core.parseRules('main=crab, random'), { id: 'main', type: 'main' }, ids)).toBe('crab')
  expect(core.chooseCharacter(core.parseRules('random'), { id: 'a7', type: 't' }, ids)).toBe(ids[core.hash('a7') % ids.length])
  expect(core.chooseCharacter(core.parseRules('bunny'), { id: 'a7', type: 't' }, ids)).toBe('bunny')
})

test('parseConfig carries the option as text and as rules; empty means all crabs', () => {
  expect(parseConfig({}).characters).toBe('')
  expect(parseConfig({}).characterRules).toEqual([])
  const c = parseConfig({ characters: 'main=crab, *=random' })
  expect(c.characters).toBe('main=crab, *=random')
  expect(c.characterRules).toEqual([
    ['main', 'crab'],
    ['*', 'random'],
  ])
  expect(parseConfig({ characters: 7 }).characters).toBe('')
})

test('the viewer reads the option exactly as the mod does', () => {
  for (const s of ['main=crab, Explore=bunny; *=random', ' a = b ,junk, =x, y=, z=AUTO ', '', 'x==y', 'a=b,\n\nc=d', 'random', 'bunny', 'main=crab, random', 'auto', 'Explore=AUTO; x', ' , ;; ', 'a=b,auto,c=d,RANDOM'])
    expect(core.parseRules(s)).toEqual(parseCharacterRules(s))
})

test('the snapshot carries the parsed rules only when there are some', () => {
  const base = {
    now: 1,
    sessionId: 's',
    cwd: '/w',
    main: DEFAULT_MAIN,
    usage: DEFAULT_USAGE,
    architect: DEFAULT_ARCHITECT,
    gate: DEFAULT_GATE,
    cards: [],
    architectIds: [],
    acts: {},
    files: [],
    events: [],
    parents: {},
    turn: DEFAULT_TURN,
    receipt: null,
  }
  expect('chars' in snapshotOf(base)).toBe(false)
  expect('chars' in snapshotOf({ ...base, chars: [] })).toBe(false)
  expect((snapshotOf({ ...base, chars: [['main', 'crab']] }) as { chars?: unknown }).chars).toEqual([['main', 'crab']])
})

// ---------------------------------------------------------------- choosing a character

const IDS = ['crab', 'bunny', 'cat', 'mochi', 'robot', 'mine']

test('with no rules everyone is a crab; named rules win; unmatched agents get a stable pick', () => {
  const a = { id: 'a1', type: 'Explore' }
  expect(core.chooseCharacter([], a, IDS)).toBe('crab')
  expect(core.chooseCharacter([['explore', 'Bunny']], a, IDS)).toBe('bunny')
  expect(
    core.chooseCharacter(
      [
        ['main', 'cat'],
        ['Explore', 'robot'],
      ],
      { id: 'main', type: 'main' },
      IDS,
    ),
  ).toBe('cat')
  expect(core.chooseCharacter([['architect', 'mochi']], { id: 'a9', type: 'x', isArchitect: true }, IDS)).toBe('mochi')
  expect(core.chooseCharacter([['sonnet-*', 'robot']], { id: 'a2', type: 'sonnet-coder' }, IDS)).toBe('robot')
  // a name nobody has (a pack that is not there): the crab
  expect(core.chooseCharacter([['Explore', 'ghost']], a, IDS)).toBe('crab')
  // no match, or `random`: a pick by hash of the id, the same every time, spread over the list
  const pick = (id: string) => core.chooseCharacter([['main', 'crab']], { id, type: 't' }, IDS)
  expect(pick('a7')).toBe(pick('a7'))
  expect(core.chooseCharacter([['*', 'random']], { id: 'a7', type: 't' }, IDS)).toBe(pick('a7'))
  const seen = new Set(Array.from({ length: 60 }, (_, i) => pick(`agent-${i}`)))
  expect(seen.size).toBe(IDS.length)
  expect(pick('x')).toBe(IDS[core.hash('x') % IDS.length])
})

// ---------------------------------------------------------------- bone names of a GLB

test('GLB node names are matched to the rig, case and separators ignored', () => {
  const m = (n: string) => core.rigOf(n)
  expect([m('Head'), m('arm_L'), m('Arm.R'), m('arm L'), m('mixamorig:Head'), m('legL2'), m('leg_R3'), m('TAIL'), m('handR')]).toEqual(['head', 'armL', 'armR', 'armL', 'head', 'legL2', 'legR3', 'tail', 'handR'])
  expect([m('left arm'), m('L_Leg'), m('right hand'), m('ear_left'), m('eye.R.001'), m('leg2.L')]).toEqual(['armL', 'legL1', 'handR', 'earL', 'eyeR', 'legL2'])
  expect([m('Armature'), m('Hips'), m('Spine'), m('Puff'), m('')]).toEqual([null, null, null, null, null])
  const r = core.matchRig(['Armature', 'root', 'Body', 'Head', 'ear_L', 'eyeL', 'eyeL_happy', 'eye_R', 'Eye_R_x', 'tail', 'Head'])
  expect(r.bones).toEqual({ root: 'root', body: 'Body', head: 'Head', earL: 'ear_L', eyeL: 'eyeL', eyeR: 'eye_R', tail: 'tail' })
  expect(r.variants).toEqual({ eyeL: { happy: 'eyeL_happy' }, eyeR: { x: 'Eye_R_x' } })
  // every rig name finds itself
  expect(core.RIG.map(n => core.rigOf(n))).toEqual(core.RIG)
})

// ---------------------------------------------------------------- voxel characters

test('the built-in characters are the ones the mod lists, all valid, all on the rig', () => {
  expect(builtin.map(c => c.id)).toEqual(BUILTIN_CHARACTERS.map(c => c.id))
  expect(builtin.map(c => c.name)).toEqual(BUILTIN_CHARACTERS.map(c => c.name))
  expect(builtin.map(c => (c as unknown as { traits: string[] }).traits)).toEqual(BUILTIN_CHARACTERS.map(c => [...c.traits]))
  expect(builtin.length).toBeGreaterThanOrEqual(4)
  for (const raw of builtin) {
    const r = core.normalizeDef(raw)
    expect(r.warnings).toEqual([])
    expect(r.def).not.toBeNull()
    for (const [name, b] of Object.entries(r.def?.bones ?? {})) {
      expect(core.RIG).toContain(name)
      expect(b.boxes.every(x => /^#[0-9a-f]{6}$/i.test(x.color) || x.color === '@base')).toBe(true)
    }
    expect(Object.keys(r.def?.bones ?? {})).toContain('body')
  }
  // the crab is the original: 4 legs in a row with their gaits, two arms, eyes with the three old expressions
  const crab = core.normalizeDef(builtin[0])
  expect(builtin[0]?.id).toBe('crab')
  expect(Object.keys(crab.def?.bones ?? {}).sort()).toEqual(['armL', 'armR', 'body', 'eyeL', 'eyeR', 'legL1', 'legL2', 'legR1', 'legR2'])
  expect(['legL1', 'legL2', 'legR2', 'legR1'].map(n => crab.def?.bones[n]?.gait)).toEqual([0, 1, 2, 3])
  expect(Object.keys(crab.def?.eyes ?? {}).sort()).toEqual(['happy', 'squint', 'x'])
  // a bunny has ears and no middle legs, a crab no ears
  const bunny = core.normalizeDef(builtin.find(c => c.id === 'bunny'))
  expect(Object.keys(bunny.def?.bones ?? {})).toContain('earL')
  expect(Object.keys(bunny.def?.bones ?? {})).not.toContain('legL2')
  expect(Object.keys(crab.def?.bones ?? {})).not.toContain('earL')
})

test('mirror copies a bone with x flipped; its parent and gait follow', () => {
  const r = core.normalizeDef({
    id: 'm',
    bones: {
      head: { at: [0, 3, 0], boxes: [] },
      earL: { parent: 'head', at: [-1, 2, 0], rot: [0, 0, 0.2], boxes: [{ size: [1, 2, 1], at: [-0.5, 1, 0], color: '#112233', rot: [0, 0.1, 0.3] }] },
      earR: { mirror: 'earL' },
      legL1: { at: [-1, 0.5, 0], gait: 0, boxes: [{ size: [1, 1, 1], at: [0, 0, 0], color: '#445566' }] },
      legR1: { mirror: 'legL1', gait: 2 },
    },
  })
  const b = r.def?.bones
  expect(b?.earR?.at).toEqual([1, 2, 0])
  expect(b?.earR?.parent).toBe('head')
  expect(b?.earR?.boxes[0]?.at).toEqual([0.5, 1, 0])
  expect(b?.earR?.boxes[0]?.rot).toEqual([0, -0.1, -0.3])
  expect(b?.legR1?.gait).toBe(2)
  expect(b?.legL1?.gait).toBe(0)
  expect(r.def?.bones.body).toBeDefined()
})

test('a malformed voxel character is refused or cleaned, never trusted', () => {
  expect(core.normalizeDef(null).def).toBeNull()
  expect(core.normalizeDef({ id: 'x' }).def).toBeNull()
  expect(core.normalizeDef({ id: 'bad id!', bones: {} }).def).toBeNull()
  const r = core.normalizeDef({
    id: 'ok',
    scale: 99,
    bones: {
      body: {
        boxes: [{ size: [1e9, -2, NaN], at: [1e9, 'x'], color: 'red' }, { size: [1, 1, 1], at: [0, 0, 0], color: '#abcdef' }, 'nope'],
      },
      wing: { boxes: [] },
    },
  })
  expect(r.def?.scale).toBe(4)
  const bx = r.def?.bones.body?.boxes ?? []
  expect(bx.length).toBe(2)
  expect(bx[0]?.size.every(n => Number.isFinite(n) && n > 0 && n <= 80)).toBe(true)
  expect(bx[0]?.at.every(n => Number.isFinite(n) && Math.abs(n) <= 80)).toBe(true)
  expect(bx[0]?.color).toBe('#cccccc')
  expect(r.warnings.some(w => w.includes('wing'))).toBe(true)
  const many = core.normalizeDef({ id: 'many', bones: { body: { boxes: Array.from({ length: 900 }, () => ({ size: [1, 1, 1], at: [0, 0, 0], color: '#000000' })) } } })
  expect(many.def?.bones.body?.boxes.length).toBe(400)
})

// ---------------------------------------------------------------- the user's folder

const memFs = (files: Record<string, string | Uint8Array>, sizes: Record<string, number> = {}) => {
  const written = new Map<string, string>()
  const lenOf = (name: string) => (files[name] as string | Uint8Array).length
  const fs: CharFs = {
    list: async () => Object.keys(files).map(name => ({ name, kind: 'file', size: sizes[name] ?? lenOf(name), mtimeMs: 1000 + name.length })),
    read: async p => String(files[p.split('/').pop() ?? ''] ?? ''),
    readBytes: async p => {
      const b = files[p.split('/').pop() ?? ''] as Uint8Array
      let s = ''
      for (let i = 0; i < b.length; i += 30000) s += String.fromCharCode(...b.subarray(i, i + 30000))
      return btoa(s)
    },
    write: async (p, t) => void written.set(p, t),
    exists: async p => written.has(p),
  }
  return { fs, written }
}
const pack = (id: unknown) => JSON.stringify({ id, name: 'Mine', bones: { body: { boxes: [{ size: [1, 1, 1], at: [0, 0, 0], color: '#123456' }] } } })

test('the user folder is scanned: JSON packs inlined, bad files noted, ids kept unique', async () => {
  const { fs, written } = memFs({
    'a.json': pack('mine'),
    'b.json': pack('mine'), // same id: suffixed
    'c.json': pack('crab'), // a built-in's id: suffixed
    'd.json': pack(undefined), // no id: the file name
    'bad.json': '{ nope',
    'nobones.json': '{"id":"z"}',
    'note.txt': 'x',
    'Fluffy Boy.glb': new Uint8Array([103, 108, 84, 70, 2, 0, 0, 0]),
  })
  const scan = await scanCharacters(fs, 'C:/u/characters', true)
  // files are taken in name order (capitals first)
  expect(scan.chars.map(c => c.id)).toEqual(['Fluffy-Boy', 'mine', 'mine-2', 'crab-2', 'd'])
  // a file that does not load is a pack with an error, not a note; the folder-level notes stay empty
  expect(scan.notes).toEqual([])
  expect(scan.packs.find(p => p.file === 'bad.json')?.problems.map(p => p.code)).toEqual(['bad-json'])
  expect(scan.packs.find(p => p.file === 'nobones.json')?.problems.map(p => p.code)).toEqual(['no-bones'])
  const glb = scan.chars[0]
  expect(glb?.kind === 'glb' && glb.parts?.length).toBe(1)
  await writeCharacters(fs, 'C:/u', scan)
  const manifest = written.get('C:/u/characters-user.js') ?? ''
  expect(manifest.startsWith('window.__crewUserCharacters = [')).toBe(true)
  expect(manifest).toContain('"id":"mine-2"')
  expect(manifest).toContain('"glb":{"file":"characters/Fluffy Boy.glb","parts":1,"bytes":8}')
  expect(manifest).toContain(`window.__crewUserRev = "${scan.rev}"`)
  const part = written.get('C:/u/characters-glb/Fluffy-Boy.0.js') ?? ''
  expect(part).toContain('window.__crewGlbPart("Fluffy-Boy", 0, "')
  expect(atob(/"([A-Za-z0-9+/=]+)"\);/.exec(part)?.[1] ?? '')).toBe('glTF\u0002\u0000\u0000\u0000')
  // listing without data reads no GLB bytes; a different folder content is a different revision
  const light = await scanCharacters(fs, 'C:/u/characters', false)
  expect(light.chars.every(c => c.kind !== 'glb' || c.parts === null)).toBe(true)
  expect(light.rev).toBe(scan.rev)
  expect((await scanCharacters(memFs({ 'a.json': pack('other') }).fs, 'C:/u/characters', true)).rev).not.toBe(scan.rev)
})

test('a GLB over what the host can read is listed, not embedded; a big one is cut into parts', async () => {
  const big = memFs({ 'huge.glb': new Uint8Array(8) }, { 'huge.glb': HOST_FILE_MAX + 1 })
  const scan = await scanCharacters(big.fs, 'C:/u/characters', true)
  const c = scan.chars[0]
  expect(c?.kind === 'glb' && c.parts).toBeNull()
  expect(scan.packs[0]?.problems.map(p => p.code)).toEqual(['glb-large'])
  expect(manifestOf(scan)).toContain('"parts":0')
  // 3 MB of bytes = 4 million base64 characters = two parts, each well under what a write may hold
  const two = memFs({ 'mid.glb': new Uint8Array(3_000_000).fill(7) })
  const s2 = await scanCharacters(two.fs, 'C:/u/characters', true)
  const m = s2.chars[0]
  expect(m?.kind === 'glb' && m.parts?.length).toBe(2)
  expect(m?.kind === 'glb' && (m.parts ?? []).every(p => p.length <= 3_000_000)).toBe(true)
  await writeCharacters(two.fs, 'C:/u', s2)
  expect([...two.written.keys()].filter(k => k.includes('characters-glb')).length).toBe(2)
  expect([...two.written.values()].every(t => t.length < HOST_FILE_MAX)).toBe(true)
})

test('an unreadable folder is a note, not a crash; ids are made safe', async () => {
  const fs: CharFs = {
    ...memFs({}).fs,
    list: async () => {
      throw new Error('gone')
    },
  }
  const scan = await scanCharacters(fs, 'C:/nope', true)
  expect(scan.chars).toEqual([])
  expect(scan.notes[0]).toContain('cannot read')
  expect([safeCharId('My Model (v2).glb'), safeCharId('..x..'), safeCharId('한글.json'), safeCharId('a'.repeat(80)).length]).toEqual(['My-Model-v2', 'x', 'character', 40])
})

test('/crew characters tells what is there and how the option is read', async () => {
  const { fs } = memFs({ 'mine.json': pack('mine'), 'x.glb': new Uint8Array(4) })
  const scan = await scanCharacters(fs, 'C:/u/characters', false)
  const spec = 'main=crab, Explore=mine, sonnet-coder=ghost, *=random'
  const text = describeCharacters(scan, spec, 'C:/u/characters', parseCharacterRules(spec), false)
  expect(text).toContain('Built-in: crab (Clawd crab: lead, main, generalist); bunny')
  expect(text).toContain('mine  voxel  mine.json')
  expect(text).toContain('x  glb    x.glb')
  expect(text).toContain('Explore -> mine')
  expect(text).toContain('sonnet-coder -> ghost (not found: a crab)')
  expect(text).toContain('* -> a stable pick by agent id')
  expect(describeCharacters(scan, 'auto', 'C:/u/characters', parseCharacterRules('auto'), false)).toContain("* -> the character whose traits fit the agent's role")
  expect(text).toContain('/crew characters reload rescans')
  expect(describeCharacters({ chars: [], notes: [], rev: '0', packs: [] }, '', 'C:/u/characters', [], true)).toContain('every agent is a crab')
  // the README the mod puts in the folder names the pieces a pack needs
  for (const w of ['"bones"', 'mirror', 'legL1', 'mixamorig:Head', 'eyeL_happy', 'characters option', '4 MiB']) expect(CHAR_README).toContain(w === 'characters option' ? '"characters" option' : w)
})

// ---------------------------------------------------------------- pack problems
// Made-up packs only ("puff", "box-buddy", ...): nothing here comes from anyone's real folder.

type Problem = { level: 'error' | 'warn'; code: string; text: string; fix: string }
type PackCore = {
  FOOD_IDS: string[]
  PACK_CODES: string[]
  problem(code: string, detail?: string): Problem
  lintVoxel(def: unknown): Problem[]
  glbProblems(info: { error?: string; big?: boolean; empty?: boolean; names?: string[] }): Problem[]
  sortProblems(list: Problem[]): Problem[]
  statusOf(list: Problem[]): string
  badgeOf(list: Problem[], hideWarn: boolean): { level: string; n: number } | null
  cardLines(list: Problem[], max?: number): { lines: Problem[]; more: number }
}
const pcore = core as unknown as PackCore
const bx = (color: unknown = '#112233') => ({ size: [1, 1, 1], at: [0, 0, 0], color })
const nocolor = () => ({ size: [1, 1, 1], at: [0, 0, 0] })
// a pack with nothing to complain about
const complete = (): Record<string, unknown> => ({
  id: 'puff',
  name: 'Puff',
  traits: ['code'],
  food: 'seed',
  bones: { body: { boxes: [bx()] }, head: { boxes: [bx()] }, mouth: { boxes: [bx()] }, armL: { boxes: [bx()] }, handL: { boxes: [bx()] }, handR: { mirror: 'handL' } },
})
const without = (key: string, p: Record<string, unknown> = complete()) => {
  const q = { ...p }
  delete q[key]
  return q
}
const withBones = (bones: Record<string, unknown>, p: Record<string, unknown> = complete()) => ({ ...p, bones: { ...(p.bones as object), ...bones } })
const codes = (list: Problem[]) => list.map(p => p.code)

// each pack: what it is, and the codes both implementations must report for it
const CORPUS: [string, unknown, string[]][] = [
  ['complete', complete(), []],
  ['null', null, ['no-bones']],
  ['no bones', { id: 'x' }, ['no-bones']],
  ['bones is a list-like string', { id: 'x', bones: 'nope' }, ['no-bones']],
  ['empty bones', { ...complete(), bones: {} }, ['nothing-drawn', 'no-hands', 'no-mouth']],
  ['boxes that are all junk', { ...complete(), bones: { body: { boxes: ['x', null, 5] } } }, ['nothing-drawn', 'no-hands', 'no-mouth']],
  ['a bad food id', { ...complete(), food: 'banana' }, ['food-bad']],
  ['a food of the wrong kind', { ...complete(), food: 7 }, ['food-bad']],
  ['a food list with no box in it', { ...complete(), food: { boxes: [] } }, ['food-bad']],
  ['a food that is a built-in, any case', { ...complete(), food: 'CARROT' }, []],
  ['a food of boxes', { ...complete(), food: [bx('#e8e0d0')] }, []],
  ['no food', without('food'), ['food-none']],
  ['no traits', without('traits'), ['no-traits']],
  ['traits that are all junk', { ...complete(), traits: ['Not valid!', 4] }, ['no-traits']],
  ['no hands', withBones({ handL: undefined, handR: undefined }), ['no-hands']],
  ['one hand is enough', withBones({ handR: undefined }), []],
  ['no mouth', withBones({ mouth: undefined }), ['no-mouth']],
  ['a bone that is not on the rig', withBones({ wing: { boxes: [bx()] } }), ['bone-unknown']],
  ['a mirror of nothing', withBones({ handR: { mirror: 'handX' } }), ['mirror-missing']],
  ['a mirror of a bone that was dropped', withBones({ armR: { mirror: 'armQ' }, legL1: { mirror: 'legL2' } }), ['mirror-missing']],
  ['a box without a color', withBones({ head: { boxes: [bx('red'), bx(), nocolor(), nocolor()] } }), ['box-color']],
  ['an @base box is fine', withBones({ head: { boxes: [bx('@base')] } }), []],
  ['more than 400 boxes', withBones({ body: { boxes: Array.from({ length: 401 }, () => bx()) } }), ['box-limit']],
  ['exactly 400 boxes', withBones({ body: { boxes: Array.from({ length: 396 }, () => bx()) } }), []], // plus the four boxes of the other bones
]

test('every pack problem has a level, a short text and a fix; the page and the mod list the same codes', () => {
  expect([...PACK_CODES]).toEqual(pcore.PACK_CODES)
  expect([...RIG_BONES]).toEqual(core.RIG)
  expect([...FOOD_IDS]).toEqual(pcore.FOOD_IDS)
  expect(PACK_CODES.length).toBeGreaterThanOrEqual(18)
  for (const code of PACK_CODES) {
    for (const detail of [undefined, '"a"', '"a", "b"', '1 box has', '3 boxes have', 'glb', 'JSON Parse error: Expected }']) {
      const mod = problem(code, detail)
      expect(mod).toEqual(pcore.problem(code, detail)) // text and fix, word for word
      expect(mod.level === 'error' || mod.level === 'warn').toBe(true)
      expect(mod.text.length).toBeGreaterThan(10)
      expect(mod.text.length).toBeLessThan(200)
      expect(mod.fix.length).toBeGreaterThan(10)
      if (detail !== undefined) expect(mod.text + mod.fix).not.toContain('undefined')
    }
  }
  expect(() => problem('nope')).toThrow()
})

test('lintVoxel reports the same problems in the mod and in the page, for every pack of the corpus', () => {
  for (const [name, def, want] of CORPUS) {
    const mod = lintVoxel(def)
    expect([name, codes(mod).sort()]).toEqual([name, [...want].sort()])
    expect([name, pcore.lintVoxel(def)]).toEqual([name, mod])
  }
  // errors come first, then warnings, each in a fixed order
  const mixed = lintVoxel({ ...complete(), food: 'banana', traits: [], bones: { body: { boxes: [bx('red')] }, wing: {} } })
  expect(codes(mixed)).toEqual(['food-bad', 'bone-unknown', 'box-color', 'no-hands', 'no-mouth', 'no-traits'])
  expect(statusOf(mixed)).toBe('error')
  expect(statusOf(lintVoxel(without('traits')))).toBe('warn')
  expect(statusOf(lintVoxel(complete()))).toBe('ok')
})

test('lintVoxel agrees with normalizeDef on what it drops, over many odd packs', () => {
  // a small deterministic generator of odd packs; the same pack goes through both implementations of lintVoxel and through normalizeDef
  let seed = 12345
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0
    return (seed >>> 8) % n
  }
  const pick = <T>(a: T[]): T => a[rnd(a.length)] as T
  const names = [...core.RIG, 'wing', 'tentacle', 'Head']
  const anyBox = () => pick<unknown>([bx(), bx('#abcdef'), bx('@base'), bx('red'), nocolor(), bx(7), 'x', null, 5, [], { size: [2, 2, 2] }])
  const anyBones = () => {
    const bones: Record<string, unknown> = {}
    for (let i = rnd(8); i >= 0; i--) {
      const n = pick(names)
      bones[n] = pick<unknown>([{ boxes: Array.from({ length: rnd(4) }, anyBox) }, { boxes: 'x' }, { mirror: pick(names) }, { mirror: 'armL' }, {}, null, 5, { boxes: Array.from({ length: 130 }, () => bx()) }])
    }
    return bones
  }
  let sawBox = 0
  for (let i = 0; i < 400; i++) {
    const def: Record<string, unknown> = { id: 'odd', bones: anyBones() }
    if (rnd(2)) def.food = pick<unknown>(['carrot', 'nope', 7, [], [bx()], { boxes: [bx('red'), 'x'] }, { boxes: [] }, null])
    if (rnd(2)) def.traits = pick<unknown>([['code'], [], 'code', ['x y']])
    if (rnd(3) === 0) def.eyes = { x: [anyBox(), anyBox()], happy: pick<unknown>([[bx('red')], 'x']) }
    const mod = lintVoxel(def)
    expect(pcore.lintVoxel(def)).toEqual(mod)
    const n = core.normalizeDef(def)
    const has = (code: string) => mod.some(p => p.code === code)
    expect(n.def).not.toBeNull()
    expect(has('bone-unknown')).toBe(n.warnings.some(w => w.includes('is not a rig bone')))
    expect(has('mirror-missing')).toBe(n.warnings.some(w => w.includes('mirrors')))
    expect(has('box-limit')).toBe(n.warnings.some(w => w.includes('more than 400')))
    // the number of boxes lintVoxel calls grey is the number of "without a #rrggbb color" warnings
    const grey = n.warnings.filter(w => w.includes('without a #rrggbb color')).length
    const says = mod.find(p => p.code === 'box-color')
    expect(says ? Number(/^(\d+) box/.exec(says.text)?.[1]) : 0).toBe(grey)
    // drawn nothing <=> the character has no box anywhere
    const boxes = Object.values(n.def?.bones ?? {}).reduce((s, b) => s + b.boxes.length, 0)
    expect(has('nothing-drawn')).toBe(boxes === 0)
    sawBox += boxes > 0 ? 1 : 0
    // a food normalizeDef kept is a food lintVoxel did not call bad, and the other way round
    expect(has('food-bad')).toBe(def.food != null && (n.def as { food?: unknown } | null)?.food === undefined)
  }
  expect(sawBox).toBeGreaterThan(100) // the generator makes real characters too, not only empty ones
})

test('what only the page knows: a model that failed, a big one, an empty one, bone names', () => {
  const g = pcore.glbProblems
  expect(codes(g({ error: 'bad magic' }))).toEqual(['glb-failed'])
  expect(g({ error: 'bad magic' })[0]?.text).toContain('bad magic')
  // the loader reads a file without the glTF magic as JSON: its own words are replaced by what they mean
  expect(g({ error: 'Unexpected token \'h\', "this is not"... is not valid JSON' })[0]?.text).toContain('(not a glTF binary file)')
  expect(codes(g({ error: 'cannot read characters/huge.glb from this page', big: true }))).toEqual(['glb-too-big'])
  expect(codes(g({ empty: true }))).toEqual(['glb-empty'])
  expect(codes(g({ names: ['Armature', 'Cube'] }))).toEqual(['glb-no-rig'])
  expect(codes(g({ names: ['Head', 'Arm_L', 'Arm_R'] }))).toEqual(['no-hands', 'no-mouth'])
  expect(codes(g({ names: ['head', 'mixamorig:LeftHand', 'mouth'] }))).toEqual([]) // one hand and a mouth: fine
  expect(g({ names: ['head'] })[0]?.fix).toContain('Hand.L') // the fix is about nodes, not JSON bones
  expect(codes(g({ names: undefined }))).toEqual([]) // not loaded yet: nothing to say
  expect(codes(g({}))).toEqual([])
  expect(['error', 'warn'].includes(g({ error: 'x' })[0]?.level ?? '')).toBe(true)
  expect(g({ error: 'x'.repeat(500) })[0]?.text.length).toBeLessThan(220)
})

test('the badge and the card: errors first, three lines, how many more; warnings can be switched off, an error never', () => {
  const warn = pcore.problem('food-none')
  const err = pcore.problem('glb-failed')
  expect(pcore.sortProblems([warn, err, pcore.problem('no-mouth'), pcore.problem('food-bad')]).map(p => p.code)).toEqual(['glb-failed', 'food-bad', 'food-none', 'no-mouth'])
  expect(pcore.badgeOf([], false)).toBeNull()
  expect(pcore.badgeOf([warn], false)).toEqual({ level: 'warn', n: 1 })
  expect(pcore.badgeOf([warn], true)).toBeNull() // show.packWarnings off
  expect(pcore.badgeOf([warn, err], true)).toEqual({ level: 'error', n: 2 }) // a red badge always shows
  const five = ['no-traits', 'no-mouth', 'no-hands', 'food-none', 'food-bad'].map(c => pcore.problem(c))
  const card = pcore.cardLines(five)
  expect(card.lines.map(p => p.code)).toEqual(['food-bad', 'no-traits', 'no-mouth'])
  expect(card.more).toBe(2)
  expect(pcore.cardLines([warn]).more).toBe(0)
  expect(pcore.statusOf([])).toBe('ok')
})

test('the scan names every file with its problems: what did not load, what loaded with warnings, a model that is big or unreadable', async () => {
  const { fs } = memFs({
    'a-puff.json': JSON.stringify(complete()),
    'b-box-buddy.json': JSON.stringify({ ...without('food', withBones({ mouth: undefined })), id: 'box-buddy' }),
    'c-broken.json': '{ "id": "broken", ',
    'd-empty.json': '',
    'e-nobones.json': '{"id":"hollow"}',
    'f-huge.json': '{}',
    'g-shell.json': JSON.stringify({ id: 'shell', bones: { body: { boxes: [] } }, food: 'banana' }),
    'h-model.glb': new Uint8Array(4),
    'i-big.glb': new Uint8Array(4),
    'j-locked.glb': new Uint8Array(4),
  }, { 'f-huge.json': 600 * 1024, 'i-big.glb': HOST_FILE_MAX + 1 })
  const reader = fs.readBytes
  fs.readBytes = async p => {
    if (p.endsWith('j-locked.glb')) throw new Error('EBUSY')
    return reader(p)
  }
  const failing = { ...fs, read: async (p: string) => { if (p.endsWith('d-empty.json')) throw new Error('EACCES'); return fs.read(p) } }
  const scan = await scanCharacters(failing, 'C:/u/characters', true)
  const by = Object.fromEntries(scan.packs.map(p => [p.file, p]))
  expect(scan.packs.map(p => p.file)).toEqual(['a-puff.json', 'b-box-buddy.json', 'c-broken.json', 'd-empty.json', 'e-nobones.json', 'f-huge.json', 'g-shell.json', 'h-model.glb', 'i-big.glb', 'j-locked.glb'])
  expect(codes(by['a-puff.json']?.problems ?? [])).toEqual([])
  expect(codes(by['b-box-buddy.json']?.problems ?? [])).toEqual(['food-none', 'no-mouth'])
  expect(codes(by['c-broken.json']?.problems ?? [])).toEqual(['bad-json'])
  expect(codes(by['d-empty.json']?.problems ?? [])).toEqual(['unreadable'])
  expect(codes(by['e-nobones.json']?.problems ?? [])).toEqual(['no-bones'])
  expect(codes(by['f-huge.json']?.problems ?? [])).toEqual(['too-big'])
  expect(by['f-huge.json']?.problems[0]?.text).toContain('600 KiB')
  expect(codes(by['g-shell.json']?.problems ?? [])).toContain('nothing-drawn')
  expect(codes(by['g-shell.json']?.problems ?? [])).toContain('food-bad')
  expect(by['h-model.glb']?.problems).toEqual([]) // what the page finds out about a model it tells itself
  expect(codes(by['i-big.glb']?.problems ?? [])).toEqual(['glb-large'])
  expect(codes(by['j-locked.glb']?.problems ?? [])).toEqual(['glb-unread'])
  // a file that did not load keeps the id it would have had; one that loaded has its (unique) id
  expect(by['c-broken.json']?.id).toBe('c-broken')
  expect(by['e-nobones.json']?.id).toBe('hollow')
  expect(by['b-box-buddy.json']?.id).toBe('box-buddy')
  expect(scan.chars.map(c => c.id)).toEqual(['puff', 'box-buddy', 'shell', 'h-model', 'i-big', 'j-locked'])
  expect(scan.notes).toEqual([])
  // the manifest carries all of it
  const m = manifestOf({ ...scan, at: 1234 })
  expect(m).toContain('window.__crewUserPacks = [')
  expect(m).toContain('"code":"bad-json"')
  expect(m).toContain('window.__crewUserScanned = 1234;')
  expect(manifestOf(scan)).not.toContain('__crewUserScanned')
  // fixing a file changes the revision (the page reloads the manifest on that), even when the characters themselves do not change
  const fixed = await scanCharacters(memFs({ 'a-puff.json': JSON.stringify(without('traits')) }).fs, 'C:/u/characters', true)
  const same = await scanCharacters(memFs({ 'a-puff.json': JSON.stringify(complete()) }).fs, 'C:/u/characters', true)
  expect(fixed.rev).not.toBe(same.rev)
  const withBroken = await scanCharacters(memFs({ 'a-puff.json': JSON.stringify(complete()), 'z.json': '{' }).fs, 'C:/u/characters', true)
  expect(withBroken.chars.map(c => c.id)).toEqual(same.chars.map(c => c.id))
  expect(withBroken.rev).not.toBe(same.rev) // a broken file appeared
})

test('/crew characters prints the problems grouped by pack, worst first, each with its fix', async () => {
  const { fs } = memFs({
    'a-puff.json': JSON.stringify(complete()),
    'b-box-buddy.json': JSON.stringify({ ...without('food', withBones({ mouth: undefined })), id: 'box-buddy' }),
    'c-broken.json': '{ nope',
  })
  const scan = await scanCharacters(fs, 'C:/u/characters', false)
  const text = describeCharacters(scan, '', 'C:/u/characters', [], false)
  expect(text).toContain('Pack problems (2 of 3 packs, 1 ok):')
  expect(text).toContain('c-broken.json  ERROR  (not loaded)  as "c-broken"')
  expect(text).toContain('b-box-buddy.json  warnings  as "box-buddy"')
  expect(text.indexOf('c-broken.json  ERROR')).toBeLessThan(text.indexOf('b-box-buddy.json  warnings')) // errors first
  expect(text).not.toMatch(/^ {2}a-puff\.json /m) // a pack without problems is only listed above, not in the problem list
  expect(text).toContain('  puff  voxel  a-puff.json')
  // every problem line is followed by its fix, indented under it
  const lines = text.split('\n')
  lines.forEach((l, i) => {
    if (/^ {4}(error|warn ) {2}/.test(l)) expect(lines[i + 1]).toMatch(/^ {11}fix: .+/)
  })
  expect(text).toContain('No "food", so it eats the seed.')
  expect(text).toContain('fix: Add "food": "seed"')
  expect(text).toContain('No mouth bone, so it eats at the head.')
  // all well: one line
  const clean = describeCharacters(await scanCharacters(memFs({ 'a-puff.json': JSON.stringify(complete()) }).fs, 'C:/u/characters', false), '', 'C:/u/characters', [], false)
  expect(clean).toContain('Pack problems: none (1 pack ok).')
  // a folder with only a broken file still lists it (there are no characters to list above)
  const only = describeCharacters(await scanCharacters(memFs({ 'z.json': '[' }).fs, 'C:/u/characters', false), '', 'C:/u/characters', [], false)
  expect(only).toContain('z.json  ERROR  (not loaded)')
  expect(only).not.toContain('none yet')
})

test('every pack problem code is reached by a pack in these tests', async () => {
  const seen = new Set<string>()
  for (const [, def] of CORPUS) for (const p of lintVoxel(def)) seen.add(p.code)
  const { fs } = memFs({ 'bad.json': '{', 'big.json': '{}', 'big.glb': new Uint8Array(1), 'lock.glb': new Uint8Array(1), 'gone.json': '' }, { 'big.json': 600 * 1024, 'big.glb': HOST_FILE_MAX + 1 })
  const rb = fs.readBytes
  fs.readBytes = async p => {
    if (p.endsWith('lock.glb')) throw new Error('EBUSY')
    return rb(p)
  }
  const scan = await scanCharacters({ ...fs, read: async p => { if (p.endsWith('gone.json')) throw new Error('EACCES'); return fs.read(p) } }, 'C:/u/characters', true)
  for (const p of scan.packs) for (const q of p.problems) seen.add(q.code)
  const info = [{ error: 'x' }, { error: 'x', big: true }, { empty: true }, { names: ['a'] }, { names: ['head'] }]
  for (const i of info) for (const p of pcore.glbProblems(i)) seen.add(p.code)
  expect([...seen].sort()).toEqual([...PACK_CODES].sort())
})
