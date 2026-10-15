// crew-graph's task tracking: what the agents' to-do lists and tasks say, kept as plain data for the pet and the browser view.
// Four sources become one list (docs/DATA_CONTRACT.md, `tasks`): TodoWrite (an agent's whole list, replaced on every call),
// TaskCreate / TaskUpdate (one shared list, an owner per task), the subagent cards (a ticket owned by the child), and the prompt turns of
// the main loop (proxy food, for a session whose model has no task tools). Nothing here touches `$`.
import type { AgentCard, Parents, TaskBook, TaskItem, TaskStatus } from '../types'
import { clip } from './crew'
import { redact } from './deck/core'

/** Cells of a title in the snapshot; the active text (activeForm) is a little shorter. */
export const MAX_TITLE = 80
export const MAX_ACTIVE = 60
/** A prompt turn's title is shorter: it is the user's own words, and it goes into data.js. */
export const MAX_TURN_TITLE = 60
/** What the snapshot carries: every open task up to this many, the last few closed ones, a deleted one for a moment. */
export const MAX_OPEN = 40
export const MAX_CLOSED = 10
export const DELETED_MS = 5000
/** A prompt waiting behind a running turn for longer than this is not waiting any more (its turn never came); it leaves the book. */
export const QUEUED_STALE_MS = 30 * 60_000
/** What the stored state keeps per list, so a long session does not grow it without bound. */
export const MAX_STORED = 200

export const EMPTY_BOOK: TaskBook = { todo: [], task: [], turn: [], eaten: {} }

/** The tools whose calls are read (see noteTasks in register.tsx). */
export const TASK_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed', 'failed', 'deleted']
const isOpen = (s: TaskStatus) => s === 'pending' || s === 'in_progress'

const hashOf = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** A title or an active text for the snapshot: one line, credentials masked, cut to `n` cells. */
export const taskText = (s: unknown, n: number) => clip(redact(str(s)).replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim(), n)

function normalizeItem(v: unknown): TaskItem | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.title !== 'string') return null
  const status = STATUSES.includes(str(v.status)) ? (v.status as TaskStatus) : 'pending'
  const src = v.src === 'task' || v.src === 'agent' || v.src === 'turn' ? v.src : 'todo'
  const item: TaskItem = { id: v.id, src, title: v.title, status, t: typeof v.t === 'number' ? v.t : 0 }
  if (typeof v.owner === 'string' && v.owner) item.owner = v.owner
  if (typeof v.active === 'string' && v.active) item.active = v.active
  if (Array.isArray(v.blockedBy)) item.blockedBy = v.blockedBy.filter((x): x is string => typeof x === 'string')
  if (typeof v.deliverTo === 'string' && v.deliverTo) item.deliverTo = v.deliverTo
  return item
}

/** A stored book that may be missing, older or damaged, read as a book. */
export function normalizeBook(stored: unknown): TaskBook {
  if (!isObject(stored)) return EMPTY_BOOK
  const list = (v: unknown) => (Array.isArray(v) ? v.map(normalizeItem).filter((x): x is TaskItem => x !== null) : [])
  const eaten: Record<string, number> = {}
  if (isObject(stored.eaten)) for (const [k, n] of Object.entries(stored.eaten)) if (typeof n === 'number' && n > 0) eaten[k] = Math.floor(n)
  return { todo: list(stored.todo), task: list(stored.task), turn: list(stored.turn), eaten }
}

/** Deleted items older than the window go; each list keeps at most MAX_STORED (closed ones go first). */
export function pruneBook(book: TaskBook, now: number): TaskBook {
  const keep = (list: TaskItem[]) => {
    const alive = list.filter(i => i.status !== 'deleted' || now - i.t <= DELETED_MS)
    if (alive.length <= MAX_STORED) return alive
    let excess = alive.length - MAX_STORED
    return alive.filter(i => {
      if (excess > 0 && !isOpen(i.status)) {
        excess -= 1
        return false
      }
      return true
    })
  }
  return { ...book, todo: keep(book.todo), task: keep(book.task), turn: keep(book.turn.filter(i => !(i.status === 'pending' && now - i.t > QUEUED_STALE_MS))) }
}

/** One more thing the agent `eater` has eaten (an id that turned into completed). */
export function bumpEaten(book: TaskBook, eater: string): TaskBook {
  return { ...book, eaten: { ...book.eaten, [eater]: (book.eaten[eater] ?? 0) + 1 } }
}

// ---------------------------------------------------------------- TodoWrite

/**
 * A TodoWrite call: `agent`'s whole list. It replaces that agent's previous list; the ids are stable (agent + a hash of the
 * content, a repeat of the same content numbered), so the page can see an item change. An item that was open and is missing from the
 * new list is deleted (for a moment); one that was closed simply leaves.
 */
export function applyTodoWrite(book: TaskBook, agent: string, input: unknown, now: number): TaskBook {
  const raw = isObject(input) && Array.isArray(input.todos) ? input.todos : []
  const seen = new Map<string, number>()
  const prev = new Map(book.todo.filter(i => i.owner === agent).map(i => [i.id, i]))
  const next: TaskItem[] = []
  let eaten = book.eaten
  for (const r of raw) {
    if (!isObject(r) || typeof r.content !== 'string' || !r.content.trim()) continue
    const base = `todo:${agent}:${hashOf(r.content)}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    const id = n === 1 ? base : `${base}#${n}`
    const status: TaskStatus = r.status === 'in_progress' || r.status === 'completed' ? r.status : 'pending'
    const was = prev.get(id)
    const item: TaskItem = { id, src: 'todo', owner: agent, title: taskText(r.content, MAX_TITLE), status, t: was && was.status === status ? was.t : now }
    const active = taskText(r.activeForm, MAX_ACTIVE)
    if (active) item.active = active
    next.push(item)
    if (status === 'completed' && was?.status !== 'completed') eaten = { ...eaten, [agent]: (eaten[agent] ?? 0) + 1 }
  }
  const nextIds = new Set(next.map(i => i.id))
  const gone: TaskItem[] = [...prev.values()].filter(i => !nextIds.has(i.id) && isOpen(i.status)).map(i => ({ ...i, status: 'deleted' as const, t: now }))
  const others = book.todo.filter(i => i.owner !== agent)
  return pruneBook({ ...book, todo: [...others, ...next, ...gone], eaten }, now)
}

// ---------------------------------------------------------------- TaskCreate / TaskUpdate

/** The id a TaskCreate result names: `result.task.id`, else the `#<n>` of its text. Null when neither is there. */
export function createdId(result: unknown, text?: unknown): string | null {
  const task = isObject(result) && isObject(result.task) ? result.task : null
  if (task && (typeof task.id === 'string' || typeof task.id === 'number') && String(task.id)) return String(task.id)
  const m = typeof text === 'string' ? /#(\d+)/.exec(text) : null
  return m?.[1] ?? null
}

export function applyTaskCreate(book: TaskBook, id: string, input: unknown, now: number): TaskBook {
  const i = isObject(input) ? input : {}
  const taskId = `task:${id}`
  const item: TaskItem = { id: taskId, src: 'task', title: taskText(i.subject, MAX_TITLE) || `task ${id}`, status: 'pending', t: now }
  const active = taskText(i.activeForm, MAX_ACTIVE)
  if (active) item.active = active
  return pruneBook({ ...book, task: [...book.task.filter(x => x.id !== taskId), item] }, now)
}

/** An agent the owner field may name: its id, and the type or name it was started under. */
export type KnownAgent = { id: string; type: string }

/** The agent an `owner` text names: an id, else a type or name (the latest of those), else null. */
export function ownerOf(text: unknown, known: KnownAgent[]): string | null {
  const t = str(text).trim()
  if (!t) return null
  const byId = known.find(k => k.id === t)
  if (byId) return byId.id
  const lc = t.toLowerCase()
  for (let i = known.length - 1; i >= 0; i -= 1) if (known[i]?.type.toLowerCase() === lc) return known[i]?.id ?? null
  return null
}

/**
 * A TaskUpdate call by `agent`. The owner is the agent that last set the task in_progress (or the `owner` field, when it names a known
 * agent); a task nobody took is unowned. A task this book never saw is made from the update, so a late start still shows it.
 */
export function applyTaskUpdate(book: TaskBook, input: unknown, agent: string, known: KnownAgent[], now: number): TaskBook {
  const i = isObject(input) ? input : {}
  const raw = typeof i.taskId === 'number' ? String(i.taskId) : str(i.taskId)
  if (!raw) return book
  const id = `task:${raw}`
  const found = book.task.find(x => x.id === id)
  let item: TaskItem = found ?? { id, src: 'task', title: taskText(i.subject, MAX_TITLE) || `task ${raw}`, status: 'pending', t: now }
  if (typeof i.subject === 'string' && taskText(i.subject, MAX_TITLE)) item = { ...item, title: taskText(i.subject, MAX_TITLE) }
  if (typeof i.activeForm === 'string') {
    const active = taskText(i.activeForm, MAX_ACTIVE)
    if (active) item = { ...item, active }
    else delete item.active
  }
  const named = ownerOf(i.owner, known)
  if (named) item = { ...item, owner: named }
  const status = str(i.status)
  let eaten = book.eaten
  if (status === 'pending' || status === 'in_progress' || status === 'completed' || status === 'deleted') {
    if (status !== item.status) item = { ...item, status, t: now }
    if (status === 'in_progress' && !named) item = { ...item, owner: agent }
    if (status === 'completed' && found?.status !== 'completed') {
      const eater = item.owner ?? 'main'
      eaten = { ...eaten, [eater]: (eaten[eater] ?? 0) + 1 }
    }
  }
  if (Array.isArray(i.addBlockedBy)) {
    const add = i.addBlockedBy.map(x => (typeof x === 'number' || typeof x === 'string' ? `task:${x}` : '')).filter(Boolean)
    const merged = [...new Set([...(item.blockedBy ?? []), ...add])].filter(x => x !== id)
    if (merged.length > 0) item = { ...item, blockedBy: merged }
  }
  return pruneBook({ ...book, eaten, task: found ? book.task.map(x => (x.id === id ? item : x)) : [...book.task, item] }, now)
}

// ---------------------------------------------------------------- prompt turns (proxy food)

/** What the engine puts in front of a prompt the plugin submitted ("The crew-graph plugin sent a message: ..."): not the user's words. */
const PLUGIN_FRAME = /^\s*The [\w-]+ plugin sent a message:\s*/i

/** A prompt as a turn's title: the plugin's frame dropped, one line, credentials masked, cut to MAX_TURN_TITLE cells. */
export const turnTitle = (text: string) => taskText(text.replace(PLUGIN_FRAME, ''), MAX_TURN_TITLE) || 'prompt'

const turnItem = (id: string, title: string, status: TaskStatus, now: number): TaskItem => ({ id: `turn:${id}`, src: 'turn', owner: 'main', title, status, t: now })

/** A prompt typed while a turn runs waits its turn: a pending item on main's plate, under the queue id `qid`. */
export function applyTurnQueued(book: TaskBook, qid: string, text: string, now: number): TaskBook {
  const id = `turn:${qid}`
  return pruneBook({ ...book, turn: [...book.turn.filter(i => i.id !== id), turnItem(qid, turnTitle(text), 'pending', now)] }, now)
}

/**
 * Main's turn `turnId` starts with `text`: the queued item `fromQid` becomes it (in progress), else a new in-progress item. A turn that
 * is still in progress when the next one starts lost its end (a reload, a missed event): it is closed as failed so it cannot stay in hand.
 */
export function applyTurnStart(book: TaskBook, turnId: string, text: string, now: number, fromQid?: string): TaskBook {
  const id = `turn:${turnId}`
  const from = fromQid ? `turn:${fromQid}` : ''
  const queued = from ? book.turn.find(i => i.id === from) : undefined
  const title = queued && !text.trim() ? queued.title : turnTitle(text)
  const rest = book.turn.map(i => (i.status === 'in_progress' && i.id !== id ? { ...i, status: 'failed' as const, t: now } : i)).filter(i => i.id !== from && i.id !== id)
  // the queued item's place in the line is kept: it was there first
  const at = queued ? book.turn.indexOf(queued) : rest.length
  const next = [...rest]
  next.splice(Math.min(at, next.length), 0, turnItem(turnId, title, 'in_progress', now))
  return pruneBook({ ...book, turn: next }, now)
}

/** Main's turn `turnId` ended: `answer` is eaten (completed, main's count goes up), anything else (aborted, error, refusal) fails. A turn the book never saw changes nothing. */
export function applyTurnEnd(book: TaskBook, turnId: string, reason: string, now: number): TaskBook {
  const id = `turn:${turnId}`
  const found = book.turn.find(i => i.id === id)
  if (!found) return book
  const status: TaskStatus = reason === 'answer' ? 'completed' : 'failed'
  const eaten = status === 'completed' && found.status !== 'completed' ? { ...book.eaten, main: (book.eaten.main ?? 0) + 1 } : book.eaten
  return pruneBook({ ...book, eaten, turn: book.turn.map(i => (i.id === id ? { ...i, status, t: now } : i)) }, now)
}

// ---------------------------------------------------------------- the snapshot's list

/** A subagent card as a ticket owned by the child, to be handed to its parent when it is done. */
export function ticketOf(c: AgentCard, parents: Parents): TaskItem {
  const status: TaskStatus = c.status === 'done' ? 'completed' : c.status === 'failed' || c.status === 'stopped' ? 'failed' : 'in_progress'
  return {
    id: `agent:${c.id}`,
    src: 'agent',
    owner: c.id,
    title: taskText(c.description, MAX_TITLE) || taskText(c.type, MAX_TITLE) || 'agent',
    status,
    deliverTo: parents[c.id] ?? 'main',
    t: c.endedAt ?? c.spawnedAt,
  }
}

/**
 * What the snapshot lists: every open task up to MAX_OPEN, the last MAX_CLOSED closed ones (completed or failed) and the items deleted
 * a moment ago. The subagent tickets come from the cards, so they exist whether or not an agent uses the task tools (and come
 * first, so the cap never cuts one). `hidden`: agents the pet dismissed; their items are left out.
 */
export function tasksOf(book: TaskBook, cards: AgentCard[], parents: Parents, now: number, hidden?: ReadonlySet<string>): TaskItem[] {
  // the tickets first: a long to-do list must not push a subagent's ticket out of the cap
  const mine = (i: TaskItem) => !(hidden && i.owner !== undefined && hidden.has(i.owner))
  const all = [...cards.map(c => ticketOf(c, parents)), ...book.todo, ...book.task, ...book.turn].filter(mine)
  const open = all.filter(i => isOpen(i.status)).slice(0, MAX_OPEN)
  const closed = all
    .filter(i => i.status === 'completed' || i.status === 'failed')
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_CLOSED)
  const gone = all.filter(i => i.status === 'deleted' && now - i.t <= DELETED_MS)
  return [...open, ...closed, ...gone]
}
