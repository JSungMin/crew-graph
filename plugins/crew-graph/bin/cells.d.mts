// Types for cells.mjs (the Crew pane's 3D cell encoder), for the tests that import it.
export const SAMPLE_W: number
export const SAMPLE_H: number
export const MAX_PAIRS: number
export function inkOf(cp: number): Int32Array | null
export function encodeCells(
  rgb: Uint8Array,
  cols: number,
  rows: number,
  opt?: { glyphs?: 'blocks' | 'quad'; maxPairs?: number; flat?: number },
): { cells: Uint32Array; pairs: number; bits: number }
