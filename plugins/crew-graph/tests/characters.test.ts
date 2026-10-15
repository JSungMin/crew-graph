import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/characters-core.js'
import '../web/characters.js'

import { BUILTIN_CHARACTERS, CHAR_README, HOST_FILE_MAX, describeCharacters, manifestOf, safeCharId, scanCharacters, writeCharacters } from '../hooks/characters'
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
  chooseCharacter(rules: [string, string][], agent: { id: string; type?: string; isArchitect?: boolean }, ids: string[]): string | null
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
  expect(parseCharacterRules('  a = b ,junk, =x, y=, z=AUTO ')).toEqual([
    ['a', 'b'],
    ['z', 'random'],
  ])
  expect(parseCharacterRules('')).toEqual([])
  expect(parseCharacterRules(42)).toEqual([])
  expect(parseCharacterRules(Array.from({ length: 200 }, (_, i) => `a${i}=crab`).join(',')).length).toBe(64)
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
  for (const s of ['main=crab, Explore=bunny; *=random', ' a = b ,junk, =x, y=, z=AUTO ', '', 'x==y', 'a=b,\n\nc=d']) expect(core.parseRules(s)).toEqual(parseCharacterRules(s))
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
  expect(scan.notes.some(n => n.startsWith('bad.json'))).toBe(true)
  expect(scan.notes.some(n => n.startsWith('nobones.json'))).toBe(true)
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
  expect(scan.notes[0]).toContain('not embedded')
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
  expect(text).toContain('Built-in: crab (Clawd crab), bunny')
  expect(text).toContain('mine  voxel  mine.json')
  expect(text).toContain('x  glb    x.glb')
  expect(text).toContain('Explore -> mine')
  expect(text).toContain('sonnet-coder -> ghost (not found: a crab)')
  expect(text).toContain('* -> a stable pick by agent id')
  expect(text).toContain('/crew characters reload rescans')
  expect(describeCharacters({ chars: [], notes: [], rev: '0' }, '', 'C:/u/characters', [], true)).toContain('every agent is a crab')
  // the README the mod puts in the folder names the pieces a pack needs
  for (const w of ['"bones"', 'mirror', 'legL1', 'mixamorig:Head', 'eyeL_happy', 'characters option', '4 MiB']) expect(CHAR_README).toContain(w === 'characters option' ? '"characters" option' : w)
})
