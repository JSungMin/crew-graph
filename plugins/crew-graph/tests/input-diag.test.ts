import { expect, test } from 'claude-code/testing'

// The pet's input diagnostics are a classic script; imported for its side effect it sets a global (no `window` here, so globalThis).
import '../web/input-diag-core.js'

type Entry = { t: number; k: string; s: string }
type Ring = { add(kind: string, text: unknown, at?: number): void; list(): Entry[]; size(): number; dropped(): number; last(kind: string): Entry | null }
type Gate = { allow(key: string, now: number, manual?: boolean): boolean; forget(key: string): void }
type Act = { do: string; why: string; value?: boolean }
type Pulse = { frameAgeMs: number; frames: number; upMs: number; sentIgnore?: boolean; mouseAgeMs: number }
type Ctx = { now: number; ignoring: boolean; gesture: boolean; lastRestartAt: number; lastRenewAt: number; cursorMovedInsideAt: number; mismatchBefore: boolean }
type Hits = { circles: [number, number, number][]; rects: [number, number, number, number][] }
type Diag = {
  RING_CAP: number
  DUMP_KEEP: number
  DUMP_GAP_MS: number
  FRAME_STALL_MS: number
  RESTART_GAP_MS: number
  MOVE_LAG_MS: number
  RENEW_GAP_MS: number
  makeRing(cap?: number): Ring
  stamp(ms: number): string
  line(e: Entry, now: number): string
  dumpName(at: number, sessionId?: string): string
  isDumpName(name: string): boolean
  pruneNames(names: string[], keep?: number): string[]
  makeDumpGate(gap?: number): Gate
  render(now: number, blocks: { title: string; rows: [string, unknown][] }[], rings: { title: string; entries: Entry[] }[]): string
  HALO_PX: number
  HALO_ALPHA: number
  PRESS_STUCK_S: number
  wantsClicks(s: { over: boolean; carry: boolean; sizing: boolean; down: boolean }): boolean
  pressStuck(s: { down: boolean; now: number; lastActivity: number }): boolean
  haloAlpha(buf: Uint8Array, n: number, r: number, cx?: number, cy?: number): number
  COVER_HOLD_MS: number
  COVER_SHRINK: number
  overShape(hits: Hits | null, x: number, y: number): boolean
  coverVerdict(s: { x: number | null; y: number; hits: Hits | null; ignoring: boolean; gesture: boolean; since: number; forced: boolean; now: number }): { since: number; forced: boolean; force: boolean }
  ignoreFix(s: { pageWants: boolean; gesture: boolean; realIgnore: boolean | null }): { effective: boolean; apply: boolean }
  pulseVerdict(p: Pulse | null, c: Ctx): Act[]
}
const diag = (globalThis as unknown as { CrewInputDiag: Diag }).CrewInputDiag

// ---------------------------------------------------------------- the ring

test('the ring keeps the newest entries and counts what it dropped', () => {
  const r = diag.makeRing(3)
  for (let i = 1; i <= 5; i++) r.add('k', `e${i}`, i)
  expect(r.list().map(e => e.s)).toEqual(['e3', 'e4', 'e5'])
  expect(r.size()).toBe(3)
  expect(r.dropped()).toBe(2)
  // list() is a copy: changing it does not change the ring
  r.list().pop()
  expect(r.size()).toBe(3)
})

test('the ring takes the time from the caller, clips long text and kinds, and finds the last entry of a kind', () => {
  const r = diag.makeRing(10)
  r.add('ignore', 'a', 1000)
  r.add('probe', 'b', 2000)
  r.add('ignore', 'c', 3000)
  expect(r.last('ignore')).toEqual({ t: 3000, k: 'ignore', s: 'c' })
  expect(r.last('nothing')).toBeNull()
  r.add('x'.repeat(100), 'y'.repeat(1000), 4000)
  const e = r.last('x'.repeat(24))
  expect(e).not.toBeNull()
  expect(e?.s.length).toBe(160)
  r.add('null-text', null, 5000)
  expect(r.last('null-text')?.s).toBe('')
})

test('a ring has room for the default 300 entries', () => {
  const r = diag.makeRing()
  for (let i = 0; i < 400; i++) r.add('k', i, i)
  expect(r.size()).toBe(diag.RING_CAP)
  expect(diag.RING_CAP).toBe(300)
  expect(r.list()[0]?.s).toBe('100')
})

// ---------------------------------------------------------------- the file: name, pruning, when to write, text

test('dump names sort by time, carry a clipped session id, and only they are recognised', () => {
  const a = diag.dumpName(Date.UTC(2026, 9, 15, 5, 0, 0), 'abc-123/..\\x')
  expect(diag.isDumpName(a)).toBe(true)
  expect(a).toMatch(/^pet-input-\d{8}T\d{9}-abc123x\.log$/)
  expect(diag.isDumpName(diag.dumpName(Date.now()))).toBe(true)
  const early = diag.dumpName(new Date(2026, 0, 2, 3, 4, 5, 6).getTime(), 'x')
  const late = diag.dumpName(new Date(2026, 0, 2, 3, 4, 5, 7).getTime(), 'x')
  expect(early < late).toBe(true)
  for (const bad of ['pet-input-.log', 'overlay-state.json', 'pet-settings.json', 'pet-input-20260102T030405006-ABCDEFGHIJ.log', '../pet-input-20260102T030405006.log', 'pet-input-20260102T030405006.log.bak']) {
    expect(diag.isDumpName(bad)).toBe(false)
  }
})

test('pruning names the oldest dumps beyond the newest five, and never another file', () => {
  const names = [1, 2, 3, 4, 5, 6, 7].map(i => diag.dumpName(new Date(2026, 0, 1, 0, 0, i).getTime(), 'w'))
  const files = ['overlay-state.json', 'pet-settings.json', 'quit', ...names].reverse()
  expect(diag.pruneNames(files, diag.DUMP_KEEP)).toEqual(names.slice(0, 2))
  expect(diag.pruneNames(files)).toEqual(names.slice(0, 2))
  expect(diag.pruneNames(names.slice(0, 5), 5)).toEqual([])
  expect(diag.pruneNames([], 5)).toEqual([])
  expect(diag.pruneNames(undefined as unknown as string[], 5)).toEqual([])
  expect(diag.pruneNames(names, 0)).toEqual(names)
})

test('an automatic dump of one window waits its gap; the tray one never does', () => {
  const g = diag.makeDumpGate()
  const gap = diag.DUMP_GAP_MS
  expect(g.allow('w1', 1000, false)).toBe(true)
  expect(g.allow('w1', 1000 + gap - 1, false)).toBe(false) // a flurry of folds
  expect(g.allow('w2', 1000 + gap - 1, false)).toBe(true) // another window is its own
  expect(g.allow('w1', 1500, true)).toBe(true) // asked for by hand: always
  expect(g.allow('w1', 1500 + gap - 1, false)).toBe(false) // and it counts as the last one
  expect(g.allow('w1', 1500 + gap, false)).toBe(true)
  g.forget('w1')
  expect(g.allow('w1', 1500 + gap + 1, false)).toBe(true)
  expect(diag.makeDumpGate(50).allow('a', 0, false)).toBe(true)
})

test('the text of a dump: header, state blocks as key: value, rings oldest first with seconds before the dump', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0)
  const r = diag.makeRing(5)
  r.add('ignore', 'setIgnoreMouseEvents(true)', now - 12345)
  r.add('probe', 'miss', now - 500)
  const text = diag.render(now, [{ title: 'pet', rows: [['why', 'fold'], ['displays', [{ id: 1, scale: 1.5 }]], ['nothing', null]] }], [{ title: 'page ring', entries: r.list() }])
  const lines = text.split('\n')
  expect(lines[0]).toContain('crew pet input diagnostics')
  expect(text).toContain('## pet\nwhy: fold\n')
  expect(text).toContain('displays: [{"id":1,"scale":1.5}]')
  expect(text).toContain('nothing: null')
  expect(text).toContain('## page ring (2 entries, oldest first')
  const ign = lines.findIndex(l => l.includes('setIgnoreMouseEvents(true)'))
  const prb = lines.findIndex(l => l.includes(' miss'))
  expect(ign).toBeGreaterThan(0)
  expect(prb).toBeGreaterThan(ign)
  expect(lines[ign]).toContain('-12.345s')
  expect(text.endsWith('\n')).toBe(true)
})

// ---------------------------------------------------------------- the click-through the main process holds

test('the real click-through follows the page, except while a gesture holds the window', () => {
  const f = diag.ignoreFix
  expect(f({ pageWants: true, gesture: false, realIgnore: true })).toEqual({ effective: true, apply: false })
  expect(f({ pageWants: true, gesture: false, realIgnore: false })).toEqual({ effective: true, apply: true }) // left open by something
  expect(f({ pageWants: false, gesture: false, realIgnore: true })).toEqual({ effective: false, apply: true })
  expect(f({ pageWants: false, gesture: false, realIgnore: false })).toEqual({ effective: false, apply: false })
  expect(f({ pageWants: true, gesture: true, realIgnore: false })).toEqual({ effective: false, apply: false }) // a drag needs the clicks
  expect(f({ pageWants: true, gesture: true, realIgnore: true })).toEqual({ effective: false, apply: true })
  expect(f({ pageWants: true, gesture: false, realIgnore: null })).toEqual({ effective: true, apply: true }) // never set: set it
})

// ---------------------------------------------------------------- the pulse

const NOW = 1_000_000
const healthy: Pulse = { frameAgeMs: 90, frames: 500, upMs: 60000, sentIgnore: true, mouseAgeMs: 400 }
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ now: NOW, ignoring: true, gesture: false, lastRestartAt: 0, lastRenewAt: 0, cursorMovedInsideAt: 0, mismatchBefore: false, ...over })
const kinds = (a: Act[]) => a.map(x => x.do)

test('a healthy page asks for nothing', () => {
  expect(diag.pulseVerdict(healthy, ctx())).toEqual([])
  expect(diag.pulseVerdict({ ...healthy, frameAgeMs: diag.FRAME_STALL_MS }, ctx())).toEqual([]) // at the limit is not over it
})

test('a page that does not answer is noted and not restarted: a hung renderer cannot run one', () => {
  expect(kinds(diag.pulseVerdict(null, ctx()))).toEqual(['note'])
})

test('a frame loop that stopped is restarted, but not more often than the gap', () => {
  const stalled: Pulse = { ...healthy, frameAgeMs: diag.FRAME_STALL_MS + 1 }
  const a = diag.pulseVerdict(stalled, ctx())
  expect(kinds(a)).toEqual(['restart-frame'])
  expect(a[0]?.why).toContain('2501')
  expect(kinds(diag.pulseVerdict(stalled, ctx({ lastRestartAt: NOW - diag.RESTART_GAP_MS + 1 })))).toEqual([])
  expect(kinds(diag.pulseVerdict(stalled, ctx({ lastRestartAt: NOW - diag.RESTART_GAP_MS })))).toEqual(['restart-frame'])
})

test('a page that never drew a frame is restarted once it has been up for a while, not at once', () => {
  const none: Pulse = { ...healthy, frameAgeMs: -1, frames: 0, upMs: 1000 }
  expect(diag.pulseVerdict(none, ctx())).toEqual([])
  expect(kinds(diag.pulseVerdict({ ...none, upMs: diag.FRAME_STALL_MS * 2 + 1 }, ctx()))).toEqual(['restart-frame'])
  // frames were drawn once but the age is unknown: not a stall
  expect(diag.pulseVerdict({ ...none, frames: 3, upMs: 99999 }, ctx())).toEqual([])
})

test('a disagreement about click-through is settled by taking the page\'s word, on the second pulse that sees it', () => {
  const page: Pulse = { ...healthy, sentIgnore: false }
  expect(diag.pulseVerdict(page, ctx({ ignoring: true, mismatchBefore: false }))).toEqual([]) // a request may be on its way
  const a = diag.pulseVerdict(page, ctx({ ignoring: true, mismatchBefore: true }))
  expect(a).toHaveLength(1)
  expect(a[0]).toMatchObject({ do: 'adopt-ignore', value: false })
  expect(diag.pulseVerdict(page, ctx({ ignoring: false, mismatchBefore: true }))).toEqual([]) // they agree
  expect(diag.pulseVerdict(page, ctx({ ignoring: true, mismatchBefore: true, gesture: true }))).toEqual([]) // the gesture owns it
  expect(diag.pulseVerdict({ ...healthy, sentIgnore: undefined }, ctx({ mismatchBefore: true }))).toEqual([]) // an older page says nothing
})

test('the mouse forwarding is renewed only when the cursor moves over a click-through window and the page hears none of it', () => {
  const moving = ctx({ cursorMovedInsideAt: NOW - 200 })
  const deaf: Pulse = { ...healthy, mouseAgeMs: 60000 }
  expect(kinds(diag.pulseVerdict(deaf, moving))).toEqual(['renew-hook'])
  expect(kinds(diag.pulseVerdict({ ...deaf, mouseAgeMs: -1 }, moving))).toEqual(['renew-hook'])
  // the page heard a move after the cursor's last one: forwarding works
  expect(diag.pulseVerdict({ ...healthy, mouseAgeMs: 150 }, moving)).toEqual([])
  // within the lag it is not yet a loss
  expect(diag.pulseVerdict({ ...healthy, mouseAgeMs: 200 + diag.MOVE_LAG_MS }, moving)).toEqual([])
  expect(kinds(diag.pulseVerdict({ ...healthy, mouseAgeMs: 201 + diag.MOVE_LAG_MS }, moving))).toEqual(['renew-hook'])
  // the cursor has not moved over the window lately, or never: nothing to renew for
  expect(diag.pulseVerdict(deaf, ctx({ cursorMovedInsideAt: NOW - diag.MOVE_LAG_MS }))).toEqual([])
  expect(diag.pulseVerdict(deaf, ctx())).toEqual([])
  // not while the window takes clicks (the page sees its own moves) or a gesture runs
  expect(diag.pulseVerdict(deaf, { ...moving, ignoring: false })).toEqual([])
  expect(diag.pulseVerdict(deaf, { ...moving, gesture: true })).toEqual([])
  // and not again within the gap
  expect(diag.pulseVerdict(deaf, { ...moving, lastRenewAt: NOW - diag.RENEW_GAP_MS + 1 })).toEqual([])
  expect(kinds(diag.pulseVerdict(deaf, { ...moving, lastRenewAt: NOW - diag.RENEW_GAP_MS }))).toEqual(['renew-hook'])
})

test('a page can need several things at once', () => {
  const bad: Pulse = { frameAgeMs: 9000, frames: 10, upMs: 99999, sentIgnore: false, mouseAgeMs: 9000 }
  const a = diag.pulseVerdict(bad, ctx({ cursorMovedInsideAt: NOW - 100, mismatchBefore: true }))
  expect(kinds(a)).toEqual(['restart-frame', 'adopt-ignore', 'renew-hook'])
})

// ---------------------------------------------------------------- who gets the mouse

test('the window takes clicks over content and while anything holds the pointer, a button pressed on content included', () => {
  const w = diag.wantsClicks
  const idle = { over: false, carry: false, sizing: false, down: false }
  expect(w(idle)).toBe(false)
  expect(w({ ...idle, over: true })).toBe(true)
  expect(w({ ...idle, carry: true })).toBe(true)
  expect(w({ ...idle, sizing: true })).toBe(true)
  // a right-drag that rotates the camera has no flag but the press: the pointer leaving content must not turn click-through on
  expect(w({ ...idle, down: true, over: false })).toBe(true)
})

test('a press whose release never came is let go after a while without a move, and only then', () => {
  const limit = diag.PRESS_STUCK_S
  expect(diag.pressStuck({ down: true, now: 100 + limit, lastActivity: 100 })).toBe(false)
  expect(diag.pressStuck({ down: true, now: 100 + limit + 0.01, lastActivity: 100 })).toBe(true)
  expect(diag.pressStuck({ down: false, now: 9999, lastActivity: 0 })).toBe(false)
  expect(diag.pressStuck({ down: true, now: 100.5, lastActivity: 100 })).toBe(false)
})

// An n x n block of RGBA bytes, all transparent, with the given pixels opaque (alpha a).
const block = (n: number, px: [number, number, number][]) => {
  const b = new Uint8Array(n * n * 4)
  for (const [x, y, a] of px) b[(y * n + x) * 4 + 3] = a
  return b
}

test('the halo finds a drawn pixel inside the disc, not outside it', () => {
  const r = 14
  const n = 2 * r + 1
  const c = r
  expect(diag.HALO_PX).toBeGreaterThanOrEqual(12)
  expect(diag.HALO_PX).toBeLessThanOrEqual(16)
  expect(diag.haloAlpha(block(n, []), n, r)).toBe(0)
  expect(diag.haloAlpha(block(n, [[c, c, 255]]), n, r)).toBe(255) // under the pointer
  expect(diag.haloAlpha(block(n, [[c + r, c, 200]]), n, r)).toBe(200) // on the rim
  expect(diag.haloAlpha(block(n, [[c, c - r, 90]]), n, r)).toBe(90)
  expect(diag.haloAlpha(block(n, [[0, 0, 255], [n - 1, n - 1, 255], [0, n - 1, 255]]), n, r)).toBe(0) // the block's corners lie outside the disc
  expect(diag.haloAlpha(block(n, [[c + 5, c, 30], [c - 6, c + 3, 120], [c, c + 8, 70]]), n, r)).toBe(120) // the highest in the disc
})

test('a halo block pushed in from the edge of the canvas is centred on the pointer, not on the block', () => {
  const r = 14
  const n = 2 * r + 1
  // the pointer is 3 px from the left edge of the canvas: its place in the block is x = 3
  expect(diag.haloAlpha(block(n, [[3 + r, 10, 255]]), n, r, 3, 10)).toBe(255) // on the rim of a disc centred at (3, 10)
  expect(diag.haloAlpha(block(n, [[3 + r + 1, 10, 255]]), n, r, 3, 10)).toBe(0) // one pixel further out
  expect(diag.haloAlpha(block(n, [[28, 2, 255]]), n, r)).toBe(0) // far from the middle of the block
  expect(diag.haloAlpha(block(n, [[28, 2, 255]]), n, r, 20, 6)).toBe(255) // and close to a pointer at (20, 6)
})

test('whether a pixel is content is a threshold on its alpha', () => {
  expect(diag.HALO_ALPHA).toBe(40)
})

// ---------------------------------------------------------------- the main process opens the window itself when the page does not

const shapes: Hits = { circles: [[100, 100, 40]], rects: [[10, 5, 80, 20]] } // a crab and the name pill

test('a point is over a shape when it is inside the shrunk circle or the rectangle', () => {
  const o = diag.overShape
  expect(o(shapes, 100, 100)).toBe(true)
  expect(o(shapes, 100 + 40 * diag.COVER_SHRINK - 1, 100)).toBe(true)
  expect(o(shapes, 100 + 40 * diag.COVER_SHRINK + 1, 100)).toBe(false) // inside the full circle, outside the part the main process trusts
  expect(o(shapes, 12, 10)).toBe(true) // the pill
  expect(o(shapes, 90, 10)).toBe(false) // the rectangle is half open on the right
  expect(o(shapes, 12, 25)).toBe(false)
  expect(o(null, 100, 100)).toBe(false)
  expect(o({ circles: [], rects: [] }, 100, 100)).toBe(false)
})

const cv = (over: Partial<Parameters<Diag['coverVerdict']>[0]>) => diag.coverVerdict({ x: 100, y: 100, hits: shapes, ignoring: true, gesture: false, since: 0, forced: false, now: 10_000, ...over })

test('the window is opened after the cursor has held over content with click-through on, once per visit', () => {
  const a = cv({})
  expect(a).toEqual({ since: 10_000, forced: false, force: false }) // the clock starts
  const b = cv({ since: a.since, forced: a.forced, now: 10_000 + diag.COVER_HOLD_MS - 1 })
  expect(b.force).toBe(false)
  const c = cv({ since: a.since, forced: b.forced, now: 10_000 + diag.COVER_HOLD_MS })
  expect(c).toEqual({ since: 10_000, forced: true, force: true })
  // later ticks of the same visit do not force again, even if click-through came back on
  const d = cv({ since: c.since, forced: c.forced, now: 30_000 })
  expect(d.force).toBe(false)
  expect(d.forced).toBe(true)
})

test('leaving every shape starts the next visit afresh; a window the page already opened, or a gesture, stops the clock', () => {
  expect(cv({ x: 400, y: 400, since: 5000, forced: true })).toEqual({ since: 0, forced: false, force: false })
  expect(cv({ x: null, y: 0, since: 5000, forced: true })).toEqual({ since: 0, forced: false, force: false }) // cursor outside the window
  expect(cv({ ignoring: false, since: 5000 })).toEqual({ since: 0, forced: false, force: false }) // the page took the clicks itself
  expect(cv({ gesture: true, since: 5000, forced: true })).toEqual({ since: 0, forced: true, force: false })
  // click-through coming back on after the page opened it starts a new wait, it does not fire at once
  const r = cv({ since: 0, forced: false, now: 99_000 })
  expect(r.force).toBe(false)
  expect(r.since).toBe(99_000)
  // no shapes reported yet: nothing to decide
  expect(cv({ hits: null })).toEqual({ since: 0, forced: false, force: false })
})
