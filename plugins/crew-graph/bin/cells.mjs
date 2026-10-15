// Cell encoder for the Crew pane's Raster: each terminal cell becomes the block glyph and the two
// colours that best match its 4x8 samples, and the frame is kept within the Raster's colour pairs.
//
// Only width-1 BMP code points are allowed in a Raster, so the glyphs are the block elements
// (U+2580..U+259F): quadrants, the lower eighths and two left fractions. Their partitions of the
// cell differ, so a cell can follow an edge to an eighth of its height or a quarter of its width.

export const SAMPLE_W = 4
export const SAMPLE_H = 8
const N = SAMPLE_W * SAMPLE_H

/** The Raster paints this many distinct (foreground, background) pairs; the rest go to their nearest. */
export const MAX_PAIRS = 1024

const at = (x, y) => y * SAMPLE_W + x

/** Each glyph: its code point and the samples (row-major, 4 wide, 8 tall) its ink covers. */
function buildGlyphs(set) {
  const out = []
  const add = (cp, inside) => {
    const on = []
    for (let y = 0; y < SAMPLE_H; y += 1) for (let x = 0; x < SAMPLE_W; x += 1) if (inside(x, y)) on.push(at(x, y))
    out.push({ cp, on: Int32Array.from(on) })
  }
  // Quadrants by the four corners they ink: 1 top-left, 2 top-right, 4 bottom-left, 8 bottom-right.
  // Masks 1..7 meet every two-way split once; their complements are the same split, colours swapped.
  const QUAD = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b]
  for (let m = 1; m < 8; m += 1) {
    add(QUAD[m], (x, y) => {
      const bit = (y < SAMPLE_H / 2 ? 0 : 2) + (x < SAMPLE_W / 2 ? 0 : 1)
      return (m & (1 << bit)) !== 0
    })
  }
  if (set === 'quad') return out
  // Lower k/8 blocks, U+2581..U+2587 (k = 4 is the lower half, already a quadrant split).
  for (let k = 1; k < 8; k += 1) if (k !== 4) add(0x2580 + k, (_x, y) => y >= SAMPLE_H - k)
  // Left 1/4 and 3/4 blocks: the widths four samples can tell apart beyond the halves.
  add(0x258e, x => x < 1)
  add(0x258a, x => x < 3)
  return out
}

const GLYPHS = { quad: buildGlyphs('quad'), blocks: buildGlyphs('blocks') }

/** The samples a code point inks, for decoding a frame back into pixels (tests, previews). */
export function inkOf(cp) {
  if (cp === 0x20) return new Int32Array(0)
  if (cp === 0x2588) return Int32Array.from({ length: N }, (_, i) => i)
  return GLYPHS.blocks.find(g => g.cp === cp)?.on ?? GLYPHS.quad.find(g => g.cp === cp)?.on ?? null
}

// Luma weights: an error in green shows more than one in blue.
const WR = 0.3
const WG = 0.59
const WB = 0.11
// A cell this close to flat (weighted squared error over its 32 samples) is drawn as one colour:
// a glyph there would only add noise and use up a colour pair.
const FLAT = N * 2 * 2

/**
 * Encodes one frame of `cols*4` x `rows*8` RGB pixels into Raster cells.
 *
 * @param {Uint8Array} rgb  the frame, 3 bytes a pixel, row-major
 * @param {{ glyphs?: 'blocks' | 'quad', maxPairs?: number, flat?: number }} [opt]  flat: FLAT's override
 * @returns {{ cells: Uint32Array, pairs: number, bits: number }}
 */
export function encodeCells(rgb, cols, rows, opt = {}) {
  const glyphs = GLYPHS[opt.glyphs === 'quad' ? 'quad' : 'blocks']
  const maxPairs = opt.maxPairs ?? MAX_PAIRS
  const W = cols * SAMPLE_W
  const cp = new Uint32Array(cols * rows)
  const fg = new Float32Array(cols * rows * 3)
  const bg = new Float32Array(cols * rows * 3)
  const r = new Float32Array(N)
  const g = new Float32Array(N)
  const b = new Float32Array(N)
  for (let cy = 0; cy < rows; cy += 1) {
    for (let cx = 0; cx < cols; cx += 1) {
      let tr = 0
      let tg = 0
      let tb = 0
      let sq = 0
      for (let y = 0; y < SAMPLE_H; y += 1) {
        const row = ((cy * SAMPLE_H + y) * W + cx * SAMPLE_W) * 3
        for (let x = 0; x < SAMPLE_W; x += 1) {
          const k = at(x, y)
          const i = row + x * 3
          r[k] = rgb[i]
          g[k] = rgb[i + 1]
          b[k] = rgb[i + 2]
          tr += r[k]
          tg += g[k]
          tb += b[k]
          sq += WR * r[k] * r[k] + WG * g[k] * g[k] + WB * b[k] * b[k]
        }
      }
      const c = cy * cols + cx
      // Error of a split = sq - sum over both sides of |side sum|^2 / side count (per channel,
      // luma-weighted); sq is common to all, so the best split has the largest `gain`.
      const flatGain = (WR * tr * tr + WG * tg * tg + WB * tb * tb) / N
      let bestGain = flatGain
      let best = null
      let br = 0
      let bgc = 0
      let bb = 0
      let bn = 0
      if (sq - flatGain > (opt.flat ?? FLAT)) {
        for (const gl of glyphs) {
          let sr = 0
          let sg = 0
          let sb = 0
          const on = gl.on
          for (let j = 0; j < on.length; j += 1) {
            const k = on[j]
            sr += r[k]
            sg += g[k]
            sb += b[k]
          }
          const n = on.length
          const m = N - n
          const or = tr - sr
          const og = tg - sg
          const ob = tb - sb
          const gain = (WR * sr * sr + WG * sg * sg + WB * sb * sb) / n + (WR * or * or + WG * og * og + WB * ob * ob) / m
          if (gain > bestGain + 1e-3) {
            bestGain = gain
            best = gl
            br = sr
            bgc = sg
            bb = sb
            bn = n
          }
        }
      }
      if (best === null) {
        cp[c] = 0x20
        fg[c * 3] = bg[c * 3] = tr / N
        fg[c * 3 + 1] = bg[c * 3 + 1] = tg / N
        fg[c * 3 + 2] = bg[c * 3 + 2] = tb / N
      } else {
        const m = N - bn
        cp[c] = best.cp
        fg[c * 3] = br / bn
        fg[c * 3 + 1] = bgc / bn
        fg[c * 3 + 2] = bb / bn
        bg[c * 3] = (tr - br) / m
        bg[c * 3 + 1] = (tg - bgc) / m
        bg[c * 3 + 2] = (tb - bb) / m
      }
    }
  }
  // Fewest bits dropped that keeps the frame within the Raster's pairs: past the limit the
  // Raster repaints the extra pairs as their nearest, which shows as wrong-coloured cells.
  const cells = new Uint32Array(cols * rows * 3)
  let bits = 8
  for (; bits >= 3; bits -= 1) {
    const pairs = quantize(cells, cp, fg, bg, bits)
    if (pairs <= maxPairs || bits === 3) return { cells, pairs, bits }
  }
  return { cells, pairs: 0, bits }
}

function q(v, bits) {
  const x = Math.max(0, Math.min(255, Math.round(v)))
  if (bits >= 8) return x
  const step = 1 << (8 - bits)
  return Math.min(255, Math.floor(x / step) * step + (step >> 1))
}

/** Fills `cells` at `bits` bits a channel and returns how many distinct colour pairs it holds. */
function quantize(cells, cp, fg, bg, bits) {
  const seen = new Set()
  for (let c = 0; c < cp.length; c += 1) {
    const f = (q(fg[c * 3], bits) << 16) | (q(fg[c * 3 + 1], bits) << 8) | q(fg[c * 3 + 2], bits)
    const k = (q(bg[c * 3], bits) << 16) | (q(bg[c * 3 + 1], bits) << 8) | q(bg[c * 3 + 2], bits)
    // Two colours that came out the same: a flat cell, one pair fewer.
    const flat = cp[c] === 0x20 || f === k
    cells[c * 3] = flat ? 0x20 : cp[c]
    cells[c * 3 + 1] = flat ? k : f
    cells[c * 3 + 2] = k
    seen.add(flat ? k * 16777216 + k : f * 16777216 + k)
  }
  return seen.size
}
