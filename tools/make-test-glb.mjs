#!/usr/bin/env node
// Writes a small skinned glTF binary with a rig-named skeleton, for trying the viewer's GLB path without anyone's model:
//   node tools/make-test-glb.mjs <out.glb>
// A round "puff" built from boxes, each box bound to one bone. The bone names are spelled the way different tools spell them
// (Head, ear_L, Ear.R, Arm_L, arm.R, leg_L1, LegR1, ...), and the bones have turned rest poses like an exported armature, so
// it exercises the name matching and the frame mapping. Also has eyeL_happy / eyeR_happy nodes (shown for the ^ ^ face).
// Original: a made-up shape, nothing taken from anywhere.
import { deflateSync, crc32 } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const out = process.argv[2]
if (!out) {
  console.error('usage: node tools/make-test-glb.mjs <out.glb>')
  process.exit(2)
}

// ---- small matrix helpers (column-major 4x4 like glTF)
const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const mul = (a, b) => {
  const o = new Array(16).fill(0)
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k]
  return o
}
const trs = (t, q) => {
  const [x, y, z, w] = q
  const m = I()
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w)
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w)
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y)
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]
  return m
}
const inv = (m) => { // rigid transform inverse (rotation + translation only)
  const o = I()
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[c * 4 + r] = m[r * 4 + c]
  for (let r = 0; r < 3; r++) o[12 + r] = -(o[r] * m[12] + o[4 + r] * m[13] + o[8 + r] * m[14])
  return o
}
const rotQ = (axis, deg) => { const h = (deg * Math.PI) / 360, s = Math.sin(h); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)] }

// ---- the skeleton: name, parent, local translation (meters), local rotation
const BONES = [
  ['root', -1, [0, 0, 0], [0, 0, 0, 1]],
  ['Body', 0, [0, 0.3, 0], [0, 0, 0, 1]],
  ['Head', 1, [0, 0.3, 0], [0, 0, 0, 1]],
  ['ear_L', 2, [-0.13, 0.3, 0], rotQ([0, 0, 1], 12)],
  ['Ear.R', 2, [0.13, 0.3, 0], rotQ([0, 0, 1], -12)],
  ['eyeL', 2, [-0.1, 0.12, 0.2], [0, 0, 0, 1]],
  ['eye_R', 2, [0.1, 0.12, 0.2], [0, 0, 0, 1]],
  ['Arm_L', 1, [-0.28, 0.12, 0], rotQ([0, 0, 1], 90)], // bone y along -x, like an exported arm
  ['arm.R', 1, [0.28, 0.12, 0], rotQ([0, 0, 1], -90)],
  ['leg_L1', 0, [-0.12, 0.1, 0], rotQ([1, 0, 0], 90)],
  ['LegR1', 0, [0.12, 0.1, 0], rotQ([1, 0, 0], 90)],
  ['tail', 1, [0, -0.05, -0.28], [0, 0, 0, 1]],
]
const world = []
BONES.forEach((b, i) => { const l = trs(b[2], b[3]); world[i] = b[1] < 0 ? l : mul(world[b[1]], l) })
const at = (i) => [world[i][12], world[i][13], world[i][14]]

// ---- boxes bound to a bone; material 0 = body (textured), 1 = dark, 2 = accent
const parts = []
const add = (joint, mat, c, s) => parts.push({ joint, mat, c, s })
const P = (i, d) => { const p = at(i); return [p[0] + d[0], p[1] + d[1], p[2] + d[2]] }
add(1, 0, [0, 0.3, 0], [0.52, 0.42, 0.44])           // body
add(2, 0, [0, 0.68, 0], [0.62, 0.38, 0.5])           // head
add(3, 0, P(3, [0, 0.14, 0]), [0.1, 0.3, 0.08])       // ears
add(4, 0, P(4, [0, 0.14, 0]), [0.1, 0.3, 0.08])
add(5, 1, P(5, [0, 0, 0.065]), [0.09, 0.12, 0.04])    // eyes
add(6, 1, P(6, [0, 0, 0.065]), [0.09, 0.12, 0.04])
add(7, 2, P(7, [-0.1, 0, 0]), [0.2, 0.12, 0.12])     // arms
add(8, 2, P(8, [0.1, 0, 0]), [0.2, 0.12, 0.12])
add(9, 2, [-0.12, 0.05, 0.04], [0.14, 0.1, 0.2])     // feet
add(10, 2, [0.12, 0.05, 0.04], [0.14, 0.1, 0.2])
add(11, 0, P(11, [0, 0.04, -0.06]), [0.16, 0.16, 0.14]) // tail

const MATS = [
  { name: 'body', pbrMetallicRoughness: { baseColorTexture: { index: 0 }, baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
  { name: 'dark', pbrMetallicRoughness: { baseColorFactor: [0.08, 0.07, 0.12, 1], metallicFactor: 0, roughnessFactor: 0.8 } },
  { name: 'accent', pbrMetallicRoughness: { baseColorFactor: [1, 0.55, 0.62, 1], metallicFactor: 0, roughnessFactor: 0.9 } },
]

const FACES = [ // normal, then 4 corners (counter-clockwise seen from outside), uv
  [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
  [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
  [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
  [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
  [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
]
const UV = [[0, 1], [1, 1], [1, 0], [0, 0]]

// ---- binary buffers
const chunks = []
let offset = 0
const views = [], accessors = []
const pushView = (buf, target) => {
  const pad = (4 - (offset % 4)) % 4
  if (pad) { chunks.push(Buffer.alloc(pad)); offset += pad }
  views.push({ buffer: 0, byteOffset: offset, byteLength: buf.length, ...(target ? { target } : {}) })
  chunks.push(buf); offset += buf.length
  return views.length - 1
}
const f32 = (arr) => Buffer.from(new Float32Array(arr).buffer)
const addAcc = (buf, target, componentType, count, type, extra = {}) => {
  accessors.push({ bufferView: pushView(buf, target), componentType, count, type, ...extra })
  return accessors.length - 1
}

const prims = []
for (let mi = 0; mi < 3; mi++) {
  const pos = [], nor = [], uv = [], jnt = [], wgt = [], idx = []
  let base = 0
  for (const p of parts.filter(q => q.mat === mi)) {
    for (const [n, corners] of FACES) {
      corners.forEach((c, k) => {
        pos.push(p.c[0] + (c[0] * p.s[0]) / 2, p.c[1] + (c[1] * p.s[1]) / 2, p.c[2] + (c[2] * p.s[2]) / 2)
        nor.push(...n); uv.push(...UV[k])
        jnt.push(p.joint, 0, 0, 0); wgt.push(1, 0, 0, 0)
      })
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3); base += 4
    }
  }
  if (!idx.length) continue
  const mins = [1e9, 1e9, 1e9], maxs = [-1e9, -1e9, -1e9]
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { mins[k] = Math.min(mins[k], pos[i + k]); maxs[k] = Math.max(maxs[k], pos[i + k]) }
  prims.push({
    attributes: {
      POSITION: addAcc(f32(pos), 34962, 5126, pos.length / 3, 'VEC3', { min: mins, max: maxs }),
      NORMAL: addAcc(f32(nor), 34962, 5126, nor.length / 3, 'VEC3'),
      TEXCOORD_0: addAcc(f32(uv), 34962, 5126, uv.length / 2, 'VEC2'),
      JOINTS_0: addAcc(Buffer.from(new Uint8Array(jnt)), 34962, 5121, jnt.length / 4, 'VEC4'),
      WEIGHTS_0: addAcc(f32(wgt), 34962, 5126, wgt.length / 4, 'VEC4'),
    },
    indices: addAcc(Buffer.from(new Uint16Array(idx).buffer), 34963, 5123, idx.length, 'SCALAR'),
    material: mi,
  })
}
const ibm = BONES.flatMap((_, i) => inv(world[i]))
const ibmAcc = addAcc(f32(ibm), 0, 5126, BONES.length, 'MAT4')

// the happy-eye variants: a flat '^' made of two thin boxes, not skinned
const hp = []
const hpIdx = []
{
  let base = 0
  for (const [dx, rz] of [[-0.035, 0.7], [0.035, -0.7]]) {
    for (const [n, corners] of FACES) {
      corners.forEach((c) => {
        const x = (c[0] * 0.07) / 2, y = (c[1] * 0.03) / 2, z = (c[2] * 0.02) / 2
        hp.push(dx + x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz), z)
      })
      hpIdx.push(base, base + 1, base + 2, base, base + 2, base + 3); base += 4
    }
  }
}
const hpMin = [1e9, 1e9, 1e9], hpMax = [-1e9, -1e9, -1e9]
for (let i = 0; i < hp.length; i += 3) for (let k = 0; k < 3; k++) { hpMin[k] = Math.min(hpMin[k], hp[i + k]); hpMax[k] = Math.max(hpMax[k], hp[i + k]) }
const happy = { attributes: { POSITION: addAcc(f32(hp), 34962, 5126, hp.length / 3, 'VEC3', { min: hpMin, max: hpMax }) }, indices: addAcc(Buffer.from(new Uint16Array(hpIdx).buffer), 34963, 5123, hpIdx.length, 'SCALAR'), material: 1 }

// ---- an 8x8 PNG for the body: soft stripes
const png = (() => {
  const W = 8, H = 8, raw = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0
    for (let x = 0; x < W; x++) {
      const o = y * (W * 4 + 1) + 1 + x * 4, on = (x + y) % 4 < 2
      raw[o] = on ? 255 : 255; raw[o + 1] = on ? 236 : 205; raw[o + 2] = on ? 120 : 140; raw[o + 3] = 255
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
})()
const imgView = pushView(png)

// ---- nodes: Armature > skeleton, the skinned mesh beside it, the happy eyes under Head
const nodes = [{ name: 'Armature', children: [1] }]
BONES.forEach((b, i) => {
  nodes.push({ name: b[0], translation: b[2], rotation: b[3], children: BONES.map((c, j) => (c[1] === i ? j + 1 : -1)).filter(j => j >= 0) })
})
nodes[1 + 2].children.push(nodes.length, nodes.length + 1) // under Head
nodes.push({ name: 'eyeL_happy', translation: [-0.1, 0.12, 0.27], mesh: 1 }, { name: 'eyeR_happy', translation: [0.1, 0.12, 0.27], mesh: 1 })
const meshNode = nodes.length
nodes.push({ name: 'Puff', mesh: 0, skin: 0 })
nodes.forEach((n) => { if (n.children && n.children.length === 0) delete n.children })

const gltf = {
  asset: { version: '2.0', generator: 'crew-graph tools/make-test-glb.mjs' },
  scene: 0, scenes: [{ nodes: [0, meshNode] }],
  nodes,
  meshes: [{ name: 'Puff', primitives: prims }, { name: 'happy', primitives: [happy] }],
  skins: [{ skeleton: 1, joints: BONES.map((_, i) => i + 1), inverseBindMatrices: ibmAcc }],
  materials: MATS, textures: [{ source: 0, sampler: 0 }], samplers: [{ magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }],
  images: [{ bufferView: imgView, mimeType: 'image/png' }],
  accessors, bufferViews: views,
  buffers: [{ byteLength: 0 }],
}
const bin = Buffer.concat(chunks)
const binPadded = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)])
gltf.buffers[0].byteLength = binPadded.length
let json = Buffer.from(JSON.stringify(gltf))
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
const header = Buffer.alloc(12)
header.write('glTF', 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + binPadded.length, 8)
const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4); return b }
writeFileSync(out, Buffer.concat([header, ch(json.length, 'JSON'), json, ch(binPadded.length, 'BIN\0'), binPadded]))
console.log(`wrote ${out}: ${BONES.length} bones (${BONES.map(b => b[0]).join(', ')}), ${binPadded.length} bytes of data`)
