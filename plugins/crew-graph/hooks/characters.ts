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

/** The characters that ship with the viewer (web/characters.js); a test keeps this list and that file in step. */
export const BUILTIN_CHARACTERS: readonly { id: string; name: string }[] = [
  { id: 'crab', name: 'Clawd crab' },
  { id: 'bunny', name: 'Mochi bunny' },
  { id: 'cat', name: 'Loaf cat' },
  { id: 'mochi', name: 'Mochi hamster' },
  { id: 'robot', name: 'Boxbot' },
]

/** `$.fs.read` and `$.fs.write` refuse over 4 MiB: a GLB that big cannot be embedded. */
export const HOST_FILE_MAX = 4 * 1024 * 1024
const PART_CHARS = 3_000_000
const MANIFEST_MAX = 3 * 1024 * 1024

export type UserChar =
  | { kind: 'voxel'; file: string; id: string; name: string; json: unknown }
  | { kind: 'glb'; file: string; id: string; name: string; bytes: number; rev: string; parts: string[] | null }

export type Scan = { chars: UserChar[]; notes: string[]; rev: string }

export const safeCharId = (s: string): string => {
  const id = s.replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 40)
  return id || 'character'
}

/**
 * Reads the folder. With `withData` a GLB is read and cut into base64 parts; without it only its size is looked at
 * (`/crew characters` just lists).
 */
export async function scanCharacters(fs: CharFs, folder: string, withData: boolean): Promise<Scan> {
  const notes: string[] = []
  const chars: UserChar[] = []
  let entries: Awaited<ReturnType<CharFs['list']>> = []
  try {
    entries = await fs.list(folder)
  } catch {
    return { chars, notes: [`cannot read ${folder}`], rev: '0' }
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
      if (e.size > 512 * 1024) {
        notes.push(`${e.name}: over 512 KiB, skipped`)
        continue
      }
      let json: unknown
      try {
        json = JSON.parse((await fs.read(path)).replace(/^﻿/, ''))
      } catch {
        notes.push(`${e.name}: not valid JSON, skipped`)
        continue
      }
      const j = json as { id?: unknown; name?: unknown; bones?: unknown } | null
      if (!j || typeof j !== 'object' || !j.bones || typeof j.bones !== 'object') {
        notes.push(`${e.name}: no "bones" object, skipped`)
        continue
      }
      // A pack names itself ("id"); a file without a usable id takes its file name. A taken id (a built-in's, another pack's) gets a suffix.
      const wanted = typeof j.id === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(j.id) ? j.id : safeCharId(e.name)
      const id = unique(wanted)
      const size = JSON.stringify(json).length
      if (manifestBytes + size > MANIFEST_MAX) {
        notes.push(`${e.name}: the manifest would pass ${MANIFEST_MAX >> 20} MiB, skipped`)
        continue
      }
      manifestBytes += size
      chars.push({ kind: 'voxel', file: e.name, id, name: typeof j.name === 'string' && j.name ? j.name.slice(0, 60) : id, json: { ...(json as object), id } })
    } else if (low.endsWith('.glb')) {
      const id = unique(safeCharId(e.name))
      const rev = `${e.size}-${Math.round(e.mtimeMs)}`
      let parts: string[] | null = null
      if (e.size > HOST_FILE_MAX) {
        notes.push(`${e.name}: ${(e.size / 1048576).toFixed(1)} MiB is over the ${HOST_FILE_MAX >> 20} MiB the mod can read, so it is not embedded; the page loads the file itself where it may (the desktop pet), a browser on file:// may refuse`)
      } else if (withData) {
        try {
          const b64 = await fs.readBytes(path)
          parts = []
          for (let i = 0; i < b64.length; i += PART_CHARS) parts.push(b64.slice(i, i + PART_CHARS))
        } catch (err) {
          notes.push(`${e.name}: cannot read it (${String(err).slice(0, 60)})`)
        }
      }
      chars.push({ kind: 'glb', file: e.name, id, name: id, bytes: e.size, rev, parts })
    }
  }
  const rev = chars.map(c => `${c.id}:${c.kind === 'glb' ? c.rev : JSON.stringify(c.json).length}`).join('|')
  return { chars, notes, rev: String(hash32(rev)) }
}

const hash32 = (s: string): number => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The manifest the page loads: `window.__crewUserCharacters` and a revision it compares to know that something changed. */
export function manifestOf(scan: Scan): string {
  const list = scan.chars.map(c =>
    c.kind === 'voxel'
      ? { file: c.file, id: c.id, name: c.name, json: c.json }
      : { id: c.id, name: c.name, kind: 'glb', rev: c.rev, glb: { file: `characters/${c.file}`, parts: c.parts ? c.parts.length : 0, bytes: c.bytes } },
  )
  return `window.__crewUserCharacters = ${JSON.stringify(list)};\nwindow.__crewUserRev = ${JSON.stringify(scan.rev)};\n`
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
    main=crab, Explore=bunny, sonnet-coder=mymodel, *=random
(left side: an agent id or type, "architect", or a prefix with * ; right side: a character id, or random).
/crew characters lists what was found.

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
`

/** What `/crew characters` prints: the built-in and user characters, what was wrong with a file, and the current assignment. */
export function describeCharacters(scan: Scan, spec: string, folder: string, rules: readonly (readonly [string, string])[], reloaded: boolean): string {
  const lines: string[] = []
  lines.push(`Built-in: ${BUILTIN_CHARACTERS.map(c => `${c.id} (${c.name})`).join(', ')}`)
  if (scan.chars.length === 0) lines.push(`Your characters: none yet. Put *.json (voxel) or *.glb (skinned) files in ${folder}; README.txt there says how.`)
  else {
    lines.push(`Your characters (${folder}):`)
    for (const c of scan.chars) {
      lines.push(c.kind === 'voxel' ? `  ${c.id}  voxel  ${c.file}` : `  ${c.id}  glb    ${c.file}  ${(c.bytes / 1048576).toFixed(1)} MiB  ${c.parts ? 'embedded' : 'read from the file'}`)
    }
  }
  for (const n of scan.notes) lines.push(`  ! ${n}`)
  if (spec.trim() === '') lines.push('Assignment: no "characters" option set, so every agent is a crab. Set it in /config, e.g. main=crab, Explore=bunny, *=random')
  else {
    const ids = new Set([...BUILTIN_CHARACTERS.map(c => c.id.toLowerCase()), ...scan.chars.map(c => c.id.toLowerCase())])
    lines.push(`Assignment: ${spec.trim()}`)
    for (const [who, ch] of rules) lines.push(`  ${who} -> ${ch === 'random' ? 'a stable pick by agent id' : ids.has(ch.toLowerCase()) ? ch : `${ch} (not found: a crab)`}`)
    lines.push('  anyone else -> a stable pick by agent id among all of the above')
  }
  lines.push(reloaded ? 'Rescanned: a running pet or browser view picks the change up within a few seconds.' : '/crew characters reload rescans the folder.')
  return lines.join('\n')
}
