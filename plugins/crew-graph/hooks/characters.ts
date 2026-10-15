// The user's own characters: a folder of voxel packs (*.json) and skinned models (*.glb) that the viewer cannot list
// itself (a page on file:// cannot read a folder), so the mod scans it and writes what the page needs beside the page:
//   characters-user.js          the manifest; JSON packs are inlined, a GLB is listed by name
//   characters-glb/<id>.<n>.js  a GLB as base64 script parts (a page on file:// may not fetch a file, a script it may load)
// Pure apart from the `CharFs` it is handed, so the tests run it on a map.

export type CharFs = {
  list(path: string): Promise<{ name: string; kind: string; size: number; mtimeMs: number }[]>
  read(path: string): Promise<string>
  readBytes(path: string): Promise<string> // base64
  write(path: string, text: string): Promise<void>
  exists(path: string): Promise<boolean>
}

/** The characters that ship with the viewer (web/characters.js); a test keeps this list and that file in step. `traits`: the role words `auto` matches. */
export const BUILTIN_CHARACTERS: readonly { id: string; name: string; traits: readonly string[] }[] = [
  { id: 'crab', name: 'Clawd crab', traits: ['lead', 'main', 'generalist'] },
  { id: 'bunny', name: 'Mochi bunny', traits: ['docs', 'write', 'summarize', 'quick', 'web'] },
  { id: 'cat', name: 'Loaf cat', traits: ['explore', 'search', 'investigate', 'review', 'locate'] },
  { id: 'mochi', name: 'Mochi hamster', traits: ['plan', 'architect', 'design', 'think', 'advisor'] },
  { id: 'robot', name: 'Boxbot', traits: ['code', 'build', 'fix', 'test', 'implement'] },
]

/** "traits": ["Code", "test", ...] -> lower-case words, at most 16 of 1-24 letters, digits, - _ (web/characters-core.js reads them the same way). */
export const traitsOf = (list: unknown): string[] => {
  const out: string[] = []
  if (!Array.isArray(list)) return out
  for (const x of list) {
    const w = typeof x === 'string' ? x.trim().toLowerCase() : ''
    if (/^[a-z0-9_-]{1,24}$/.test(w) && !out.includes(w)) out.push(w)
    if (out.length >= 16) break
  }
  return out
}

/** `$.fs.read` and `$.fs.write` refuse over 4 MiB: a GLB that big cannot be embedded. */
export const HOST_FILE_MAX = 4 * 1024 * 1024
const PART_CHARS = 3_000_000
const MANIFEST_MAX = 3 * 1024 * 1024

// ---------------------------------------------------------------- pack problems
// What is wrong or missing in a user's pack, as { level, code, text, fix }: an error means the character is not drawn as the pack meant (a
// crab, nothing, a food it does not eat), a warning means it works but misses something. This is a twin of PROBLEM_TABLE / lintVoxel in
// web/characters-core.js (the page runs that one for GLBs and as a fallback); a test feeds both the same packs and holds them together.

export type PackProblem = { level: 'error' | 'warn'; code: string; text: string; fix: string }

/** The rig bones (web/characters-core.js RIG) and the built-in foods (web/tasks.js FOODS); a test keeps these lists and those in step. */
export const RIG_BONES: readonly string[] = ['root', 'body', 'head', 'earL', 'earR', 'eyeL', 'eyeR', 'mouth', 'armL', 'handL', 'armR', 'handR', 'legL1', 'legL2', 'legL3', 'legR1', 'legR2', 'legR3', 'tail']
export const FOOD_IDS: readonly string[] = ['fish', 'carrot', 'treat', 'seed', 'battery', 'ticket']
const EYE_VARIANTS = ['x', 'squint', 'happy', 'sleepy', 'dizzy']
const BOX_LIMIT = 400
const FOOD_BOX_LIMIT = 40

type Row = [level: 'error' | 'warn', text: (d?: string) => string, fix: (d?: string) => string]
const listOf = (a: string[]): string => a.slice(0, 4).map(x => `"${x}"`).join(', ') + (a.length > 4 ? ` and ${a.length - 4} more` : '')
const PROBLEM_TABLE: Record<string, Row> = {
  // errors
  unreadable: ['error', () => 'The file could not be read.', () => 'Check that it exists and is not locked by another program, then rescan.'],
  'bad-json': ['error', d => `Not valid JSON${d ? ` (${d})` : ''}, so it is skipped.`, () => 'Fix the syntax (a trailing comma or a missing quote is the usual cause) and rescan.'],
  'too-big': ['error', d => `Too big (${d || 'over 512 KiB'}), so it is skipped.`, () => `Use fewer boxes: a pack is meant to be small, up to ${BOX_LIMIT} boxes.`],
  'no-bones': ['error', () => 'There is no "bones" object, so nothing can be drawn.', () => 'Add "bones": { "body": { "boxes": [ { "size": [5,3,4], "at": [0,2,0], "color": "#88aaff" } ] } }.'],
  'nothing-drawn': ['error', () => 'No box is left to draw, so the character is invisible.', () => 'Give "body" (or another bone) at least one box: { "size": [w,h,d], "at": [x,y,z], "color": "#rrggbb" }.'],
  'food-bad': ['error', () => '"food" is not a built-in food or a list of boxes, so it eats the seed.', () => `Use one of ${FOOD_IDS.join(', ')}, or boxes: "food": { "boxes": [ ... ] }.`],
  'glb-failed': ['error', d => `The model could not be loaded${d ? ` (${d})` : ''}, so a crab is drawn instead.`, () => 'Export it again as a plain glTF binary (.glb) without Draco, Meshopt or KTX2 compression, then rescan.'],
  'glb-too-big': ['error', () => 'The model is over 4 MiB and this page cannot read it from the folder, so a crab is drawn instead.', () => 'Make it smaller than 4 MiB (fewer polygons, smaller textures), or use the desktop pet (/crew pet), which can read it.'],
  'glb-empty': ['error', () => 'The model has no geometry, so a crab is drawn instead.', () => 'Export the meshes together with the skeleton, not the armature alone.'],
  // warnings
  'food-none': ['warn', () => 'No "food", so it eats the seed.', () => 'Add "food": "seed" (or fish, carrot, treat, battery, ticket), or a list of boxes.'],
  'no-hands': ['warn', d => `No handL / handR ${d === 'glb' ? 'nodes' : 'bones'}, so items are held at the arm.`, d => (d === 'glb' ? 'Name the hand nodes handL and handR (Blender: Hand.L, Hand.R).' : 'Add "handL": { "parent": "armL", ... } and "handR": { "mirror": "handL" }.')],
  'no-mouth': ['warn', d => `No mouth ${d === 'glb' ? 'node' : 'bone'}, so it eats at the head.`, d => (d === 'glb' ? 'Name a node on the face "mouth".' : 'Add a "mouth" bone (parent "head") with a small box on the face.')],
  'no-traits': ['warn', () => 'No "traits", so auto never picks it by role.', () => 'Add "traits": ["code", "test"]; README.txt in the characters folder lists the words that count.'],
  'bone-unknown': ['warn', d => (/,| and /.test(d ?? '') ? `${d} are not rig bones, so they are skipped.` : `${d} is not a rig bone, so it is skipped.`), () => `Rename it to a rig bone (${RIG_BONES.join(' ')}) or remove it.`],
  'mirror-missing': ['warn', d => (/,| and /.test(d ?? '') ? `${d} mirror bones that are not defined, so they are skipped.` : `${d} mirrors a bone that is not defined, so it is skipped.`), () => 'Define the bone it mirrors, or give this one boxes of its own.'],
  'box-color': ['warn', d => `${d} no #rrggbb color and ${/^1 /.test(d ?? '') ? 'is' : 'are'} drawn light grey.`, () => 'Give each box "color": "#rrggbb" (or "@base" for the body color).'],
  'box-limit': ['warn', () => `More than ${BOX_LIMIT} boxes, so the rest are ignored.`, () => `Merge boxes or make them bigger; ${BOX_LIMIT} is the limit.`],
  'glb-large': ['warn', () => 'Over 4 MiB: the mod does not embed it, so the pet reads it from the folder and a browser may refuse.', () => 'Make it smaller than 4 MiB to work everywhere.'],
  'glb-unread': ['warn', () => 'The mod could not read the file, so the page will try the folder itself.', () => 'Check that it is not locked by another program, then rescan.'],
  'glb-no-rig': ['warn', () => 'No node is named like a rig bone, so only the whole model moves.', () => 'Name the nodes head, armL, handL, legL1 and so on (case and _ . - are ignored).'],
}
export const PACK_CODES: readonly string[] = Object.keys(PROBLEM_TABLE)

export function problem(code: string, detail?: string): PackProblem {
  const row = PROBLEM_TABLE[code]
  if (!row) throw new Error(`unknown pack problem code ${code}`)
  return { level: row[0], code, text: row[1](detail), fix: row[2](detail) }
}

/** 'error' if any problem is an error, 'warn' if there are only warnings, else 'ok'. */
export const statusOf = (list: readonly PackProblem[]): 'ok' | 'warn' | 'error' => (list.some(p => p.level === 'error') ? 'error' : list.length > 0 ? 'warn' : 'ok')

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const colorOk = (c: unknown): boolean => typeof c === 'string' && (/^#[0-9a-f]{6}$/i.test(c) || c === '@base')

/** A voxel pack as parsed JSON -> its problems; follows normalizeDef in web/characters-core.js step by step (same loops, same limits). */
export function lintVoxel(def: unknown): PackProblem[] {
  if (!isObj(def) || !isObj(def.bones)) return [problem('no-bones')]
  const bones = def.bones
  const errors: PackProblem[] = []
  const warns: PackProblem[] = []
  const unknown: string[] = []
  const missing: string[] = []
  const defined: Record<string, number> = {}
  let total = 0
  let over = false
  let drawn = 0
  let grey = 0
  const lintBox = (b: unknown): boolean => {
    if (!isObj(b)) return false
    if (!colorOk(b.color)) grey++
    return true
  }
  for (const name of Object.keys(bones)) {
    if (!RIG_BONES.includes(name)) {
      unknown.push(name)
      continue
    }
    const src = bones[name]
    if (!isObj(src) || typeof src.mirror === 'string') continue
    let n = 0
    for (const bx of Array.isArray(src.boxes) ? (src.boxes as unknown[]) : []) {
      if (total >= BOX_LIMIT) {
        over = true
        break
      }
      if (lintBox(bx)) {
        total++
        n++
      }
    }
    defined[name] = n
    drawn += n
  }
  for (const name of Object.keys(bones)) {
    const src = bones[name]
    if (!RIG_BONES.includes(name) || !isObj(src) || typeof src.mirror !== 'string') continue
    const from = Object.hasOwn(defined, src.mirror) ? defined[src.mirror] : undefined
    if (from == null) {
      missing.push(name)
      continue
    }
    defined[name] = from
    drawn += from
  }
  const eyes = def.eyes
  for (const v of EYE_VARIANTS) {
    if (!isObj(eyes) || !Array.isArray(eyes[v])) continue
    ;(eyes[v] as unknown[]).slice(0, 12).forEach(lintBox)
  }
  let food: 'none' | 'ok' | 'bad' = 'none'
  const f = def.food
  if (f != null) {
    food = 'bad'
    if (typeof f === 'string') {
      if (/^[a-z0-9_-]{1,24}$/.test(f.toLowerCase()) && FOOD_IDS.includes(f.toLowerCase())) food = 'ok'
    } else {
      const fl = Array.isArray(f) ? (f as unknown[]) : isObj(f) && Array.isArray(f.boxes) ? (f.boxes as unknown[]) : null
      if (fl) {
        let n = 0
        fl.slice(0, FOOD_BOX_LIMIT).forEach(bx => {
          if (lintBox(bx)) n++
        })
        if (n) food = 'ok'
      }
    }
  }
  if (drawn === 0) errors.push(problem('nothing-drawn'))
  if (food === 'bad') errors.push(problem('food-bad'))
  if (unknown.length) warns.push(problem('bone-unknown', listOf(unknown)))
  if (missing.length) warns.push(problem('mirror-missing', listOf(missing)))
  if (grey) warns.push(problem('box-color', `${grey} ${grey === 1 ? 'box has' : 'boxes have'}`))
  if (over) warns.push(problem('box-limit'))
  if (food === 'none') warns.push(problem('food-none'))
  if (defined.handL == null && defined.handR == null) warns.push(problem('no-hands'))
  if (defined.mouth == null) warns.push(problem('no-mouth'))
  if (traitsOf(def.traits).length === 0) warns.push(problem('no-traits'))
  return [...errors, ...warns]
}

export type UserChar =
  | { kind: 'voxel'; file: string; id: string; name: string; json: unknown; traits: string[] }
  | { kind: 'glb'; file: string; id: string; name: string; bytes: number; rev: string; parts: string[] | null }

/** One file of the folder: what it is, the id it has (or would have) and what is wrong with it. A pack that did not load has problems too. */
export type PackInfo = { file: string; id: string; kind: 'voxel' | 'glb'; problems: PackProblem[] }

/** `notes`: what is wrong with the folder itself (it cannot be read); a file's own problems are in `packs`. `at`: when it was scanned (ms). */
export type Scan = { chars: UserChar[]; notes: string[]; rev: string; packs: PackInfo[]; at?: number }

export const safeCharId = (s: string): string => {
  const id = s.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  return id || 'character'
}

/**
 * Reads the folder. With `withData` a GLB is read and cut into base64 parts; without it only its size is looked at
 * (`/crew characters` just lists). Every .json and .glb gets an entry in `packs`, loaded or not, with its problems.
 */
export async function scanCharacters(fs: CharFs, folder: string, withData: boolean): Promise<Scan> {
  const notes: string[] = []
  const chars: UserChar[] = []
  const packs: PackInfo[] = []
  let entries: Awaited<ReturnType<CharFs['list']>> = []
  try {
    entries = await fs.list(folder)
  } catch {
    return { chars, notes: [`cannot read ${folder}`], rev: '0', packs }
  }
  const taken = new Set<string>(BUILTIN_CHARACTERS.map(c => c.id.toLowerCase()))
  const unique = (id: string) => {
    let out = id
    for (let n = 2; taken.has(out.toLowerCase()); n++) out = `${id.slice(0, 36)}-${n}`
    taken.add(out.toLowerCase())
    return out
  }
  let manifestBytes = 0
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.kind !== 'file') continue
    const low = e.name.toLowerCase()
    const path = `${folder}/${e.name}`
    if (low.endsWith('.json')) {
      // A pack that does not load keeps the id it would have had, so a rule that names it can be traced back to this file.
      const failed = (id: string, ...problems: PackProblem[]) => void packs.push({ file: e.name, id, kind: 'voxel', problems })
      if (e.size > 512 * 1024) {
        failed(safeCharId(e.name), problem('too-big', `${Math.round(e.size / 1024)} KiB, the limit is 512 KiB`))
        continue
      }
      let text: string
      try {
        text = await fs.read(path)
      } catch {
        failed(safeCharId(e.name), problem('unreadable'))
        continue
      }
      let json: unknown
      try {
        json = JSON.parse(text.replace(/^﻿/, ''))
      } catch (err) {
        failed(safeCharId(e.name), problem('bad-json', String((err as Error)?.message ?? '').replace(/ is not valid JSON$/, '').replace(/\s+/g, ' ').slice(0, 60)))
        continue
      }
      const j = json as { id?: unknown; name?: unknown; bones?: unknown } | null
      // A pack names itself ("id"); a file without a usable id takes its file name. A taken id (a built-in's, another pack's) gets a suffix.
      const wanted = j && typeof j === 'object' && typeof j.id === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(j.id) ? j.id : safeCharId(e.name)
      if (!j || typeof j !== 'object' || !j.bones || typeof j.bones !== 'object') {
        failed(wanted, problem('no-bones'))
        continue
      }
      const size = JSON.stringify(json).length
      if (manifestBytes + size > MANIFEST_MAX) {
        failed(wanted, problem('too-big', `the manifest would pass ${MANIFEST_MAX >> 20} MiB`))
        continue
      }
      const id = unique(wanted)
      manifestBytes += size
      chars.push({ kind: 'voxel', file: e.name, id, name: typeof j.name === 'string' && j.name ? j.name.slice(0, 60) : id, json: { ...(json as object), id }, traits: traitsOf((j as { traits?: unknown }).traits) })
      packs.push({ file: e.name, id, kind: 'voxel', problems: lintVoxel(json) })
    } else if (low.endsWith('.glb')) {
      const id = unique(safeCharId(e.name))
      const rev = `${e.size}-${Math.round(e.mtimeMs)}`
      const problems: PackProblem[] = []
      let parts: string[] | null = null
      if (e.size > HOST_FILE_MAX) {
        // not embedded: the page loads the file itself where it may (the desktop pet); a browser on file:// may refuse
        problems.push(problem('glb-large'))
      } else if (withData) {
        try {
          const b64 = await fs.readBytes(path)
          parts = []
          for (let i = 0; i < b64.length; i += PART_CHARS) parts.push(b64.slice(i, i + PART_CHARS))
        } catch {
          problems.push(problem('glb-unread'))
        }
      }
      chars.push({ kind: 'glb', file: e.name, id, name: id, bytes: e.size, rev, parts })
      packs.push({ file: e.name, id, kind: 'glb', problems })
    }
  }
  const rev = chars.map(c => `${c.id}:${c.kind === 'glb' ? c.rev : JSON.stringify(c.json).length}`).join('|') + `#${JSON.stringify(packs)}`
  return { chars, notes, rev: String(hash32(rev)), packs }
}

const hash32 = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * The manifest the page loads: `window.__crewUserCharacters` (what can be drawn), `window.__crewUserPacks` (every file with its problems,
 * also those that did not load), a revision it compares to know that something changed, and when the folder was scanned.
 */
export function manifestOf(scan: Scan): string {
  const list = scan.chars.map(c =>
    c.kind === 'voxel'
      ? { file: c.file, id: c.id, name: c.name, json: c.json }
      : { id: c.id, name: c.name, kind: 'glb', rev: c.rev, glb: { file: `characters/${c.file}`, parts: c.parts ? c.parts.length : 0, bytes: c.bytes } },
  )
  const at = typeof scan.at === 'number' ? `window.__crewUserScanned = ${Math.round(scan.at)};\n` : ''
  return `window.__crewUserCharacters = ${JSON.stringify(list)};\nwindow.__crewUserPacks = ${JSON.stringify(scan.packs)};\nwindow.__crewUserRev = ${JSON.stringify(scan.rev)};\n${at}`
}

/** Writes the manifest and the GLB parts into `dir` (the viewer's folder). */
export async function writeCharacters(fs: CharFs, dir: string, scan: Scan): Promise<void> {
  for (const c of scan.chars) {
    if (c.kind !== 'glb' || !c.parts) continue
    for (let i = 0; i < c.parts.length; i++) {
      await fs.write(`${dir}/characters-glb/${c.id}.${i}.js`, `window.__crewGlbPart(${JSON.stringify(c.id)}, ${i}, ${JSON.stringify(c.parts[i])});\n`)
    }
  }
  await fs.write(`${dir}/characters-user.js`, manifestOf(scan))
}

/** Creates the folder and its README.txt when they are not there. */
export async function ensureCharacterFolder(fs: CharFs, folder: string): Promise<void> {
  if (!(await fs.exists(`${folder}/README.txt`).catch(() => false))) await fs.write(`${folder}/README.txt`, CHAR_README)
}

export const CHAR_README = `crew-graph characters
=====================

Drop your own characters in this folder. The mod scans it when a session starts (/crew web, /crew pet)
and on  /crew characters reload ; a running pet or browser view picks the change up within a few seconds.
Then choose who is who with the "characters" option, for example
    main=crab, Explore=bunny, sonnet-coder=mymodel, *=auto
(left side: an agent id or type, "architect", or a prefix with * ; right side: a character id, "random" (a stable pick per agent)
or "auto" (the character whose traits fit the agent's role)). A part without "=" means "*=": "auto" alone is fine.
The pet's Settings window (tray icon or right-click menu, "Settings...") sets characters too: a default, a character per agent type,
or one agent, and it wins over the option. /crew characters lists what was found and what each agent would get.

Two kinds of file
-----------------

1. NAME.json   a voxel character: boxes on a named rig. Small, editable by hand.

   {
     "id": "mybot", "name": "My bot", "scale": 1,
     "bones": {
       "body":  { "boxes": [ { "size": [5,3,4], "at": [0,2,0], "color": "#88aaff" } ] },
       "head":  { "at": [0,3.5,0], "boxes": [ { "size": [4,3,4], "at": [0,1.5,0], "color": "#99bbff" } ] },
       "eyeL":  { "parent": "head", "at": [-1,1.6,2.1], "boxes": [ { "size": [0.8,1,0.3], "at": [0,0,0], "color": "#10131c" } ] },
       "eyeR":  { "mirror": "eyeL" },
       "armL":  { "at": [-2.8,2.5,0], "boxes": [ { "size": [1.4,1,1], "at": [-0.7,0,0], "color": "#88aaff" } ] },
       "armR":  { "mirror": "armL" },
       "legL1": { "at": [-1.2,0.5,0], "gait": 0, "boxes": [ { "size": [1.2,1,1.4], "at": [0,0,0], "color": "#5570c0" } ] },
       "legR1": { "mirror": "legL1", "gait": 2 }
     }
   }

   Units: the crab is 7 wide. x is to the right, y up, z toward the viewer (the character faces +z).
   "at" is relative to the bone's parent ("parent": a rig name, default "body"). A bone moves about its own origin,
   so put the origin where it should bend (an arm at the shoulder, an ear at its base). "mirror": "armL" copies a
   bone with x flipped. A box is { size, at, color } plus optional "rot": [rx,ry,rz] in radians, "unlit": true
   (an LED that ignores light) and "fixed": true (not tinted when the agent fails or is done).
   Colors are "#rrggbb"; "@base" is the body colour from "base": { "h":15, "s":0.7, "l":0.56, "spread":15 }.
   Optional: "eyes": { "x": [...], "squint": [...], "happy": [...], "sleepy": [...], "dizzy": [...] } = boxes for the
   LEFT eye in each expression (the right one is mirrored); without them the viewer draws default ones.
   Also optional: "props": { "page": {"at":[x,y,z]}, "hat": {"at":[x,y,z],"s":1}, "anten": {"at":[x,y,z],"spread":1.5} },
   "hit": { "y": 3, "r": 1 }, "shadow": [8,6], "travel": 1 (how far the eyes slide).
   "traits": ["code", "test", "cheerful"]: role words for "auto". An agent's role comes from its type (Explore, Plan, sonnet-coder,
   code-reviewer, general-purpose, ...), the words of its task and what it is doing; the character whose traits overlap the most is
   chosen (siblings are spread over equally good characters, and an agent keeps the character it was first given). Words that
   count: lead main generalist code build fix test implement run explore search investigate locate review docs write summarize
   quick web plan architect design think advisor. Other words are fine, they just never match.
   "food": "carrot": what this character works on and eats when the pet shows its tasks. A built-in (fish carrot treat seed battery
   ticket), or boxes like a bone: "food": { "boxes": [ { "size":[2.4,0.5,0.5], "at":[0,0,0], "color":"#e8e0d0" }, ... ] }, centred on 0,
   about 2.5 voxels long with the long side along x, at most 40 boxes. Without one (or with one that is not valid), the crab gets a fish,
   the bunny a carrot, the cat a treat stick, the hamster a sunflower seed, the robot a battery, and your own characters a sunflower seed
   (a .glb has no food of its own: it eats the seed).

   The rig (every bone is optional; an animation skips the bones a character lacks):
     root body head earL earR eyeL eyeR mouth armL handL armR handR legL1 legL2 legL3 legR1 legR2 legR3 tail

2. NAME.glb   a skinned model (glTF binary) whose bones (nodes) have those names. Case does not matter and _ . space
   - are ignored: "Head", "arm_L", "Arm.L", "mixamorig:Head" -> head, armL ... "left arm" and "L_Leg" work too.
   Bones the animation drives: head, ears, eyes, mouth, arms, hands, legs, tail (the model as a whole bobs, leans and squashes).
   Rotate the bones in the model's own rest pose: the viewer moves them relative to it.
   It is scaled to fit the crab's footprint (about 7 wide, 6.5 tall) and stood on the ground facing +z (a model whose eyes are
   at its back is turned around). Optional extra nodes next to the eye bones, named eyeL_happy, eyeL_x, eyeL_squint,
   eyeL_sleepy, eyeL_dizzy (and the same for eyeR), are shown instead of the eye for that expression.
   Draco, Meshopt and KTX2 compression are not supported. Files up to 4 MiB are embedded; a larger one is read from this
   folder by the page itself, which the desktop pet can do and a browser on file:// may refuse.

Problems
--------

A file that is wrong or misses something is not silently ignored: a character whose pack has problems wears a small badge over its head
(red "!" for an error, amber "!" for warnings only), its hover card lists the first three, and the pet's Settings window has a
"Character packs" section with every file, its status and what to change. /crew characters prints the same list. Errors: the file cannot be read
or parsed, a model fails to load (a crab is drawn), nothing is left to draw, an invalid "food". Warnings: no "food" (it eats the seed), no
hand bones or no mouth (items are held at the arm, it eats at the head), no "traits", boxes or bones that were dropped.
`

/** What `/crew characters` prints: the built-in and user characters, every pack with its problems and what to change, and the current assignment. `extra`: more lines (the pet's own settings, the agents' picks). */
export function describeCharacters(
  scan: Scan,
  spec: string,
  folder: string,
  rules: readonly (readonly [string, string])[],
  reloaded: boolean,
  extra: readonly string[] = [],
): string {
  const lines: string[] = []
  lines.push(`Built-in: ${BUILTIN_CHARACTERS.map(c => `${c.id} (${c.name}: ${c.traits.join(', ')})`).join('; ')}`)
  if (scan.chars.length === 0 && scan.packs.length === 0) lines.push(`Your characters: none yet. Put *.json (voxel) or *.glb (skinned) files in ${folder}; README.txt there says how.`)
  else {
    lines.push(`Your characters (${folder}):`)
    for (const c of scan.chars) {
      lines.push(
        c.kind === 'voxel'
          ? `  ${c.id}  voxel  ${c.file}${c.traits.length ? `  traits: ${c.traits.join(', ')}` : ''}`
          : `  ${c.id}  glb    ${c.file}  ${(c.bytes / 1048576).toFixed(1)} MiB  ${c.parts ? 'embedded' : 'read from the file'}`,
      )
    }
    // Every file with a problem, grouped by pack, worst first; a file that did not load is listed here and nowhere above.
    const bad = scan.packs.filter(p => p.problems.length > 0).sort((a, b) => Number(statusOf(b.problems) === 'error') - Number(statusOf(a.problems) === 'error'))
    const loaded = new Set(scan.chars.map(c => c.file))
    const sick = scan.packs.filter(p => !loaded.has(p.file))
    const oks = scan.packs.length - bad.length
    lines.push(bad.length === 0 ? `Pack problems: none (${oks} pack${oks === 1 ? '' : 's'} ok).` : `Pack problems (${bad.length} of ${scan.packs.length} pack${scan.packs.length === 1 ? '' : 's'}${oks > 0 ? `, ${oks} ok` : ''}):`)
    for (const p of bad) {
      lines.push(`  ${p.file}  ${statusOf(p.problems) === 'error' ? 'ERROR' : 'warnings'}${sick.includes(p) ? '  (not loaded)' : ''}  as "${p.id}"`)
      for (const pr of p.problems) {
        lines.push(`    ${pr.level === 'error' ? 'error' : 'warn '}  ${pr.text}`)
        lines.push(`           fix: ${pr.fix}`)
      }
    }
  }
  for (const n of scan.notes) lines.push(`  ! ${n}`)
  if (spec.trim() === '') lines.push('Assignment: no "characters" option set, so every agent is a crab (unless the pet\'s Settings say otherwise). Set it in /config, e.g. main=crab, Explore=bunny, *=auto')
  else {
    const ids = new Set([...BUILTIN_CHARACTERS.map(c => c.id.toLowerCase()), ...scan.chars.map(c => c.id.toLowerCase())])
    lines.push(`Assignment: ${spec.trim()}`)
    for (const [who, ch] of rules) {
      lines.push(`  ${who} -> ${ch === 'random' ? 'a stable pick by agent id' : ch === 'auto' ? 'the character whose traits fit the agent\'s role' : ids.has(ch.toLowerCase()) ? ch : `${ch} (not found: a crab)`}`)
    }
    lines.push('  anyone else -> a stable pick by agent id among all of the above')
  }
  lines.push(...extra)
  lines.push(reloaded ? 'Rescanned: a running pet or browser view picks the change up within a few seconds.' : '/crew characters reload rescans the folder.')
  return lines.join('\n')
}

// ---------------------------------------------------------------- `auto`: the character whose traits fit the agent's role
// A twin of roleOf / autoPick in web/characters-core.js (the pet runs that one); a test feeds both the same agents and holds them together.

export type RoleAgent = { id: string; type?: string; description?: string; verb?: string; isArchitect?: boolean; parentId?: string | null }
export type Traited = { id: string; traits: readonly string[] }
export type AutoPick = { id: string; why: string[]; parent: string }
export type AutoState = { locks: Map<string, AutoPick> }

const TYPE_ROLES: [RegExp, string[]][] = [
  [/plan|architect|advisor|design|strateg/, ['plan', 'architect', 'design', 'think', 'advisor']],
  [/explor|search|locat|scout|find|investig|research|survey/, ['explore', 'search', 'investigate', 'locate']],
  [/review|audit|critic|verif|inspect|lint/, ['review', 'investigate']],
  [/doc|writer|write|summar|readme|wiki|translat|scribe|changelog/, ['docs', 'write', 'summarize']],
  [/web|fetch|browse|crawl|scrape/, ['web', 'quick']],
  [/cod(e|er|ing)|implement|build|develop|\bdev\b|engineer|fix|debug|refactor|test|tdd|resolver/, ['code', 'build', 'fix', 'test', 'implement']],
  [/quick|fast|haiku|mini|lite/, ['quick']],
  [/general|purpose|orchestr|coordinat|manager|lead/, ['generalist', 'lead']],
]
const TEXT_ROLES: [RegExp, string[]][] = [
  [/\b(implement\w*|code|coding|refactor\w*|build|compile|migrat\w*)\b|구현|코드/, ['code', 'build', 'implement']],
  [/\b(fix\w*|bugs?|debug\w*|patch\w*|repair\w*)\b|수정|버그/, ['fix', 'code']],
  [/\b(tests?|testing|specs?)\b|테스트/, ['test']],
  [/\b(run|execute|npm|script)\b|실행/, ['run']],
  [/\b(review\w*|audit\w*|critique|verify|check\w*)\b|리뷰|검토/, ['review']],
  [/\b(search\w*|find|locate|grep|look ?up|map|trace|survey)\b|검색|탐색|찾/, ['search', 'locate', 'explore']],
  [/\b(investigat\w*|analy[sz]\w*|research\w*|explor\w*|explain\w*)\b|조사|분석/, ['investigate', 'explore']],
  [/\b(docs?|document\w*|readme|write|writing|changelog|guide|translat\w*)\b|문서|작성/, ['docs', 'write']],
  [/\b(summari[sz]\w*|summary|tl;?dr)\b|요약/, ['summarize']],
  [/\b(web|fetch|url|https?|browse)\b/, ['web']],
  [/\b(plan\w*|design\w*|architect\w*|strategy|propose)\b|계획|설계/, ['plan', 'design']],
]
const VERB_ROLES: Record<string, string[]> = {
  edit: ['code', 'fix', 'implement'],
  run: ['run', 'build', 'test'],
  read: ['explore', 'search'],
  search: ['search', 'explore', 'locate'],
  web: ['web'],
  plan: ['plan', 'design'],
  think: ['think'],
  spawn: ['lead'],
}
const W_TYPE = 3
const W_TEXT = 1.2
const W_VERB = 0.8
const W_REPEAT = 0.75

/** An agent's role as { word: weight }, from its type, its task text and its verb. */
export function roleOf(agent: RoleAgent): Record<string, number> {
  const w: Record<string, number> = {}
  const add = (words: string[], k: number) => words.forEach(x => (w[x] = (w[x] ?? 0) + k))
  const type = String(agent.type ?? '').toLowerCase()
  if (agent.id === 'main' || type === 'main') add(['lead', 'main', 'generalist'], W_TYPE)
  if (agent.isArchitect) add(['architect', 'plan', 'design', 'think', 'advisor'], W_TYPE)
  for (const [re, words] of TYPE_ROLES) {
    if (re.test(type)) {
      add(words, W_TYPE)
      break
    }
  }
  const text = String(agent.description ?? '').toLowerCase().slice(0, 300)
  for (const [re, words] of TEXT_ROLES) if (re.test(text)) add(words, W_TEXT)
  const v = agent.verb ? VERB_ROLES[agent.verb] : undefined
  if (v) add(v, W_VERB)
  return w
}

/** The best character for the role; the first pick of an agent is kept (state.locks); siblings that took a character make it a little less attractive. */
export function autoPick(chars: readonly Traited[], agent: RoleAgent, state: AutoState): AutoPick | null {
  if (chars.length === 0) return null
  const key = String(agent.id)
  const had = state.locks.get(key)
  if (had && chars.some(c => c.id === had.id)) return had
  const role = roleOf(agent)
  const parent = agent.parentId != null ? String(agent.parentId) : ''
  const taken: Record<string, number> = {}
  state.locks.forEach((v, k) => {
    if (k !== key && v.parent === parent) taken[v.id] = (taken[v.id] ?? 0) + 1
  })
  const rows = chars.map(c => {
    const hit = c.traits.filter(x => (role[x] ?? 0) > 0).sort((x, y) => (role[y] ?? 0) - (role[x] ?? 0))
    return { c, hit, fit: hit.reduce((s, x) => s + (role[x] ?? 0), 0) }
  })
  const top = Math.max(...rows.map(r => r.fit))
  const unit = top > 0 ? 0.2 * top : W_REPEAT
  let best: { id: string; why: string[]; score: number; tie: number } | null = null
  for (const { c, hit, fit } of rows) {
    const score = fit - unit * (taken[c.id] ?? 0)
    const tie = hash32(`${key}|${c.id}`)
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && tie < best.tie)) best = { id: c.id, why: hit.slice(0, 3), score, tie }
  }
  const pick = { id: best!.id, why: best!.why, parent }
  state.locks.set(key, pick)
  return pick
}

/** The agents of a snapshot file (data.js / sessions/<id>.js); [] when the text is missing or not a snapshot. */
export function agentsFromDataJs(text: string | null | undefined): RoleAgent[] {
  const mark = '&& window.__crewUpdate('
  const at = typeof text === 'string' ? text.indexOf(mark) : -1
  if (!text || at < 0) return []
  try {
    const snap = JSON.parse(text.slice(at + mark.length, text.lastIndexOf(')'))) as { agents?: unknown }
    if (!Array.isArray(snap.agents)) return []
    return snap.agents
      .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object' && typeof (a as { id?: unknown }).id === 'string')
      .map(a => ({
        id: String(a.id),
        type: typeof a.type === 'string' ? a.type : '',
        description: typeof a.description === 'string' ? a.description : '',
        verb: typeof a.verb === 'string' ? a.verb : '',
        isArchitect: a.isArchitect === true,
        parentId: typeof a.parentId === 'string' ? a.parentId : null,
      }))
  } catch {
    return []
  }
}

/** What `auto` would give each agent of the latest snapshot, with the reason (the pet keeps the first pick it made for an agent). */
export function describeAgentPicks(agents: readonly RoleAgent[], chars: readonly Traited[]): string[] {
  if (agents.length === 0) return []
  const state: AutoState = { locks: new Map() }
  const lines = ['Auto-match for the agents of the latest snapshot (the pet keeps the first pick it made):']
  for (const a of agents) {
    const p = autoPick(chars, a, state)
    if (!p) continue
    const label = a.id === 'main' ? 'main' : a.type || a.id
    lines.push(`  ${label}${a.description && a.id !== 'main' ? ` (${a.description.slice(0, 40)})` : ''} -> ${p.id}${p.why.length ? ` (matched: ${p.why.join(', ')})` : ' (no trait fits: a stable pick)'}`)
  }
  return lines
}

/** What the pet's own settings file says about characters, for `/crew characters`; tolerant of a missing or broken file. */
export function describePetSettings(raw: string | null | undefined): string[] {
  if (raw == null) {
    return ["Pet settings: none yet. The pet's Settings window (tray icon or right-click menu: Settings...) sets a default, a character per agent type, or one agent; it wins over the option."]
  }
  let j: unknown
  try {
    j = JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return ["Pet settings: overlay/pet-settings.json is not valid JSON, so the pet ignores it (it writes a fresh one when you change a setting in the pet's Settings window)."]
  }
  const o = (j && typeof j === 'object' ? j : {}) as { default?: unknown; types?: unknown; agents?: unknown }
  const pairs = (m: unknown): [string, string][] =>
    m && typeof m === 'object' && !Array.isArray(m) ? Object.entries(m as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string') : []
  const types = pairs(o.types)
  const agents = pairs(o.agents)
  const lines = ["Pet settings (overlay/pet-settings.json, set in the pet's Settings window; they win over the option):"]
  lines.push(`  default: ${typeof o.default === 'string' && o.default ? (o.default === 'auto' ? 'auto (match the role)' : o.default) : 'none (the option, else a crab)'}`)
  for (const [k, v] of types) lines.push(`  ${k === '*' ? 'any other type (*)' : k} -> ${v}`)
  if (agents.length > 0) lines.push(`  ${agents.length} agent${agents.length === 1 ? '' : 's'} with a character of their own`)
  return lines
}
