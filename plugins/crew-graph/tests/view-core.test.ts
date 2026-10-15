import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/view-core.js'

type Follow = { sid: string | null; snapNow: number | null; at: number }
type Core = {
  FOLLOW_STALE_MS: number
  newFollow(): Follow
  followSource(f: Follow, now: number): string
  followAccepts(f: Follow, sid: string | null | undefined, now: number): boolean
  followNote(f: Follow, sid: string | null | undefined, snapNow: number, now: number): void
}
const core = (globalThis as unknown as { CrewViewCore: Core }).CrewViewCore

// ---------------------------------------------------------------- following one session (data.js is whoever wrote last)

// What the page does with each poll of data.js: ask first, then note what it showed.
function poll(f: Follow, sid: string, snapNow: number, now: number): boolean {
  if (!core.followAccepts(f, sid, now)) return false
  core.followNote(f, sid, snapNow, now)
  return true
}

test("the first snapshot is taken, and the page then reads that session's own file", () => {
  const f = core.newFollow()
  expect(core.followSource(f, 0)).toBe('data.js')
  expect(poll(f, 'A', 1, 0)).toBe(true)
  expect(core.followSource(f, 100)).toBe('sessions/A.js')
})

test('two sessions writing at once: the page keeps the first and never swaps', () => {
  const f = core.newFollow()
  const shown: string[] = []
  // data.js alternates A, B, A, B ... every 450 ms, each with its own clock
  for (let i = 0; i < 40; i++) {
    const sid = i % 2 ? 'B' : 'A'
    if (poll(f, sid, 1000 + i * 450, i * 450)) shown.push(sid)
  }
  expect(new Set(shown)).toEqual(new Set(['A']))
  expect(shown.length).toBe(20)
})

test('a session that stopped moving is let go: the page reads data.js again and takes the next session', () => {
  const f = core.newFollow()
  expect(poll(f, 'A', 1, 0)).toBe(true)
  // A's file is read again and again but its snapshot does not change: that is not moving
  for (let t = 500; t < core.FOLLOW_STALE_MS; t += 500) expect(poll(f, 'A', 1, t)).toBe(true)
  expect(core.followSource(f, core.FOLLOW_STALE_MS - 1)).toBe('sessions/A.js')
  expect(core.followSource(f, core.FOLLOW_STALE_MS)).toBe('data.js')
  expect(poll(f, 'B', 7, core.FOLLOW_STALE_MS + 10)).toBe(true)
  expect(core.followSource(f, core.FOLLOW_STALE_MS + 20)).toBe('sessions/B.js')
})

test('a session that keeps writing is kept, and a snapshot without an id changes nothing', () => {
  const f = core.newFollow()
  for (let i = 0; i < 100; i++) expect(poll(f, 'A', i, i * 1000)).toBe(true) // 100 s, a new snapshot each second
  expect(core.followSource(f, 99_500)).toBe('sessions/A.js')
  expect(core.followAccepts(f, undefined, 99_500)).toBe(true)
  core.followNote(f, undefined, 5, 99_500)
  expect(f.sid).toBe('A')
})

test('an id that cannot be a file name is never put in a path', () => {
  const f = core.newFollow()
  expect(poll(f, '../../x', 1, 0)).toBe(true)
  expect(core.followSource(f, 1)).toBe('data.js')
})
