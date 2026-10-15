import { expect, test } from 'claude-code/testing'

// The viewer's pure parts are classic scripts; imported for their side effect they set globals (no `window` here, so globalThis).
import '../web/characters-core.js'
import '../web/characters.js'
import '../web/tasks.js'

type Pool<T> = { take(make: () => T): T; give(x: T | null | undefined): void; size(): number }
const makePool = (globalThis as unknown as { CrewTasks: { makePool<T>(): Pool<T> } }).CrewTasks.makePool

// What crumb() does: the ended ones go back to the pool, a new one is made only when the pool is empty.
test('a released item is handed out again instead of making a new one', () => {
  const pool = makePool<{ n: number }>()
  let made = 0
  const make = () => ({ n: ++made })
  const a = pool.take(make)
  const b = pool.take(make)
  expect(made).toBe(2)
  pool.give(a)
  expect(pool.size()).toBe(1)
  expect(pool.take(make)).toBe(a)
  expect(made).toBe(2)
  expect(pool.take(make)).not.toBe(b)
  expect(made).toBe(3)
})

test('a long run of short-lived items makes only as many as were alive at once', () => {
  const pool = makePool<object>()
  let made = 0
  const make = () => ({ id: ++made })
  const alive: object[] = []
  // 3000 crumbs thrown, 3 a tick, each alive for 5 ticks: 15 alive at most
  for (let tick = 0; tick < 1000; tick++) {
    if (alive.length >= 15) for (const x of alive.splice(0, 3)) pool.give(x)
    for (let i = 0; i < 3; i++) alive.push(pool.take(make))
  }
  expect(made).toBeLessThanOrEqual(18)
})

test('giving the same item twice, or nothing, does not put it in twice', () => {
  const pool = makePool<{ n: number }>()
  const a = { n: 1 }
  pool.give(a)
  pool.give(a)
  pool.give(null)
  pool.give(undefined)
  expect(pool.size()).toBe(1)
  expect(pool.take(() => ({ n: 2 }))).toBe(a)
  expect(pool.take(() => ({ n: 3 })).n).toBe(3)
})
