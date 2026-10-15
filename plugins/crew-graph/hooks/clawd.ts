// Clawd, Claude Code's crab, as terminal block art: one big 3-row pose for a loop's header and
// a 1-row mini for tree rows. Two frames per verb; every glyph is one cell wide.
import type { Verb } from '../types'

type Frames = [string[], string[]]

const EYES_UP = ' ▐▛███▜▌ '
const EYES_DOWN = ' ▐▙███▟▌ '
const BLINK = ' ▐█████▌ '
const X_EYES = ' ▐▚███▞▌ '
const ARMS_DOWN = '▝▜█████▛▘'
const ARMS_UP = '▗▟█████▙▖'
const LEGS_A = '  ▘▘ ▝▝  '
const LEGS_B = '  ▝▝ ▘▘  '
const HOP = '         '

const shift = (rows: string[]) => rows.map(r => ` ${r.slice(0, -1)}`)

export const BIG: Record<Verb, Frames> = {
  think: [[EYES_UP, ARMS_DOWN, LEGS_A], [BLINK, ARMS_DOWN, LEGS_A]],
  read: [[EYES_DOWN, ARMS_DOWN, LEGS_A], [EYES_UP, ARMS_DOWN, LEGS_A]],
  edit: [[EYES_DOWN, ARMS_UP, LEGS_A], [EYES_DOWN, ARMS_DOWN, LEGS_A]],
  search: [[EYES_UP, ARMS_DOWN, LEGS_A], shift([EYES_UP, ARMS_DOWN, LEGS_B])],
  run: [[EYES_UP, ARMS_DOWN, LEGS_A], [EYES_UP, ARMS_DOWN, LEGS_B]],
  web: [[EYES_UP, ARMS_UP, LEGS_A], [BLINK, ARMS_UP, LEGS_A]],
  spawn: [[EYES_UP, ARMS_UP, LEGS_A], [EYES_UP, ARMS_UP, HOP]],
  plan: [[EYES_DOWN, ARMS_DOWN, LEGS_A], [EYES_DOWN, ARMS_UP, LEGS_A]],
  done: [[EYES_UP, ARMS_UP, LEGS_A], [EYES_UP, ARMS_UP, HOP]],
  failed: [[X_EYES, ARMS_DOWN, LEGS_A], [X_EYES, ARMS_DOWN, LEGS_A]],
  wait: [[EYES_UP, ARMS_DOWN, LEGS_A], [EYES_UP, ARMS_DOWN, LEGS_A]],
}

export const MINI: Record<Verb, [string, string]> = {
  think: ['▝▜█▛▘', '▝▜▀▛▘'],
  read: ['▝▜█▛▘', '▝▙█▟▘'],
  edit: ['▗▟█▙▖', '▝▜█▛▘'],
  search: ['▝▜█▛▘', ' ▝▜█▛'],
  run: ['▝▜█▛▘', '▘▜█▛▝'],
  web: ['▗▟█▙▖', '▗▟▀▙▖'],
  spawn: ['▗▟█▙▖', '▗▟█▙▖'],
  plan: ['▝▙█▟▘', '▗▙█▟▖'],
  done: ['▗▟█▙▖', '▗▟█▙▖'],
  failed: ['▝▚█▞▘', '▝▚█▞▘'],
  wait: ['▝▜█▛▘', '▝▜█▛▘'],
}

/** What the crab holds or says beside its body, per verb and frame. */
export const PROP: Record<Verb, [string, string]> = {
  think: ['z ', 'zZ'],
  read: ['▤ ', ' ▤'],
  edit: ['✎ ', '✎·'],
  search: ['? ', '!?'],
  run: ['» ', '»»'],
  web: ['@ ', ' @'],
  spawn: ['+ ', '++'],
  plan: ['… ', '..'],
  done: ['✓ ', '✓ '],
  failed: ['✗ ', '✗ '],
  wait: ['· ', '··'],
}

/** Verbs whose crab moves; the rest hold still and need no frame clock. */
export const isMoving = (v: Verb) => v !== 'done' && v !== 'failed' && v !== 'wait'

export const bigFrame = (v: Verb, f: number) => BIG[v][f % 2] ?? BIG.think[0]
export const miniFrame = (v: Verb, f: number) => MINI[v][f % 2] ?? MINI.think[0]
export const propFrame = (v: Verb, f: number) => PROP[v][f % 2] ?? ''
