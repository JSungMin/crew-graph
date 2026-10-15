// What the desktop pet may ask of the mod, kept apart from `$` so it can be tested on its own: checking an inbox
// message, composing the prompts the mod submits for it, and hiding dismissed agents. Nothing here touches the host.
import type { AgentCard, CrewEvent, FileNode, LastReply, LoopAct } from '../types'
import { redact } from './deck/core'
import { clip } from './crew'

export const ASK_MAX = 4000
export const REPLY_CELLS = 200
export const AUTO_DISMISS_MINUTES = [5, 10, 30]
/** The dismissed set keeps at most this many agents (the card list itself keeps 24). */
const DISMISSED_MAX = 60

export type PetMsg = {
  seq?: number
  at?: number
  kind?: string
  sessionId?: string
  token?: string
  mode?: string
  text?: string
  agentId?: string
  id?: string
  ids?: unknown
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * An inbox message the mod may act on: an ask, a dismiss, a stop or a rescan of the characters folder that carries this session's id and the token the mod gave the
 * pet when it launched it. Anything else is refused with a reason (never containing the token).
 */
export function checkPetMsg(raw: unknown, sessionId: string, token: string): { ok: true; msg: PetMsg } | { ok: false; why: string } {
  if (!isObject(raw)) return { ok: false, why: 'not an object' }
  const msg = raw as PetMsg
  if (msg.kind !== 'ask' && msg.kind !== 'dismiss' && msg.kind !== 'stop' && msg.kind !== 'rescan') return { ok: false, why: 'not a request that needs a token' }
  if (!sessionId || !token) return { ok: false, why: 'this session has no pet token' }
  if (msg.sessionId !== sessionId) return { ok: false, why: 'another session' }
  if (typeof msg.token !== 'string' || msg.token !== token) return { ok: false, why: 'wrong token' }
  return { ok: true, msg }
}

/** The text of an ask, trimmed; null when it is empty or longer than ASK_MAX. */
export function cleanAsk(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const t = text.replace(/\0/g, '').trim()
  return t.length > 0 && t.length <= ASK_MAX ? t : null
}

// ---------------------------------------------------------------- what the user pointed at

export type AskAbout = { id: string; type: string; status: string; description: string; recent: string[]; files: string[] }

/** The few facts about an agent that go along with a question about it: last 5 event texts and the files it touched. */
export function aboutOf(card: { id: string; type: string; status: string; description: string }, events: CrewEvent[], files: FileNode[]): AskAbout {
  const recent = events
    .filter(e => e.from === card.id)
    .slice(-5)
    .map(e => clip(redact(e.text || e.tool || e.kind), 120))
  const touched = files.filter(f => f.by && f.by[card.id]).map(f => f.path)
  return {
    id: card.id,
    type: card.type,
    status: card.status,
    description: clip(redact(card.description), 160),
    recent,
    files: touched.slice(0, 8),
  }
}

/** The user's text, then (with an agent attached) what the crew knows about that agent. The engine frames the whole as coming from the plugin. */
export function composeAsk(text: string, about: AskAbout | null): string {
  const head = `The user typed this into the crew-graph desktop pet:\n\n${text}`
  if (!about) return head
  const lines = [
    `${head}\n\nContext from crew-graph about the agent the user pointed at:`,
    `- agent: ${about.type} (id ${about.id}), status ${about.status}`,
    ...(about.description ? [`- task: ${about.description}`] : []),
    ...(about.recent.length ? ['- last events:', ...about.recent.map(r => `  - ${r}`)] : []),
    ...(about.files.length ? [`- files touched: ${about.files.join(', ')}`] : []),
  ]
  return lines.join('\n')
}

/** The framed prompt that asks Claude to stop a running agent; the mod has no way to stop one itself. */
export function composeStop(card: { id: string; type: string; description: string }): string {
  const task = card.description ? `, task: ${clip(redact(card.description), 120)}` : ''
  return `The user asked from the crew-graph desktop pet to stop the running ${card.type} agent (id ${card.id}${task}). Please stop it if you can (the TaskStop tool does) and say what you did. The crew-graph plugin cannot stop agents itself.`
}

/** The first characters of the answer to a pet ask, for the pet's speech bubble: one line, credentials masked. */
export function replyOf(answer: string, reason: string, at: number): LastReply {
  const text = answer.trim() ? clip(redact(answer), REPLY_CELLS) : `(the turn ended: ${reason})`
  return { at, text }
}

// ---------------------------------------------------------------- dismissing

const RUNNING = new Set(['running', 'pending'])
/** An agent with no work in flight: finished, failed, stopped, or sitting idle. */
export const isFinished = (c: Pick<AgentCard, 'status'>) => !RUNNING.has(c.status)

type Acts = Record<string, LoopAct>

/** What a dismissal remembers of an agent; a later step, tool call or end changes it, which brings the agent back. */
export const stampOf = (c: Pick<AgentCard, 'id' | 'endedAt' | 'steps' | 'status'>, acts: Acts) => `${c.status}:${c.endedAt ?? 0}:${c.steps}:${acts[c.id]?.calls ?? 0}`

export function dismissedOf(stored: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isObject(stored)) return out
  for (const k of Object.keys(stored)) if (typeof stored[k] === 'string') out[k] = stored[k] as string
  return out
}

/** The set after dismissing these ids; running agents and unknown ids are skipped. Returns the new set and the ids taken. */
export function dismiss(set: Record<string, string>, ids: string[], cards: AgentCard[], acts: Acts): { set: Record<string, string>; taken: string[] } {
  const next = { ...set }
  const taken: string[] = []
  for (const id of ids) {
    const c = cards.find(x => x.id === id)
    if (!c || !isFinished(c)) continue
    next[id] = stampOf(c, acts)
    taken.push(id)
  }
  // Only agents that still have a card are worth remembering.
  const keep = Object.keys(next).filter(k => cards.some(c => c.id === k))
  const pruned: Record<string, string> = {}
  for (const k of keep.slice(-DISMISSED_MAX)) pruned[k] = next[k] as string
  return { set: pruned, taken }
}

/** The ids hidden now: dismissed, and not active or changed since. */
export function hiddenIds(cards: AgentCard[], set: Record<string, string>, acts: Acts): Set<string> {
  const out = new Set<string>()
  for (const c of cards) if (set[c.id] !== undefined && set[c.id] === stampOf(c, acts) && isFinished(c)) out.add(c.id)
  return out
}

/** Auto-dismiss: the set with every agent that has been finished for `minutes` added; null when nothing changed. */
export function autoDismissed(cards: AgentCard[], set: Record<string, string>, acts: Acts, now: number, minutes: number): Record<string, string> | null {
  if (!AUTO_DISMISS_MINUTES.includes(minutes)) return null
  const old = cards.filter(c => isFinished(c) && c.endedAt !== null && now - c.endedAt >= minutes * 60_000 && set[c.id] !== stampOf(c, acts)).map(c => c.id)
  return old.length ? dismiss(set, old, cards, acts).set : null
}

/** The `autoDismiss` of pet-settings.json (minutes) read tolerantly: a BOM, bad JSON or a value that is not 5, 10 or 30 mean off (0). */
export function autoDismissOf(text: unknown): number {
  if (typeof text !== 'string') return 0
  try {
    const v = (JSON.parse(text.replace(/^﻿/, '')) as Record<string, unknown> | null)?.autoDismiss
    return typeof v === 'number' && AUTO_DISMISS_MINUTES.includes(v) ? v : 0
  } catch {
    return 0
  }
}

export type Shown = {
  cards: AgentCard[]
  files: FileNode[]
  acts: Record<string, LoopAct>
  events: CrewEvent[]
  parents: Record<string, string>
}

/** What the snapshot and the Crew pane show: without the hidden agents, their events, and their name in the files' `by`. A file only they touched goes too. */
export function withoutHidden(all: Shown, hidden: Set<string>): Shown {
  if (hidden.size === 0) return all
  // A hidden agent's children hang from the nearest agent above it that is shown (main at the top).
  const up = (id: string): string => {
    let p = all.parents[id] ?? 'main'
    for (let i = 0; i < 24 && hidden.has(p); i += 1) p = all.parents[p] ?? 'main'
    return p
  }
  const parents: Record<string, string> = {}
  for (const k of Object.keys(all.parents)) if (!hidden.has(k)) parents[k] = up(k)
  const acts: Record<string, LoopAct> = {}
  for (const k of Object.keys(all.acts)) if (!hidden.has(k)) acts[k] = all.acts[k] as LoopAct
  const files: FileNode[] = []
  for (const f of all.files) {
    const keys = Object.keys(f.by ?? {})
    const by: FileNode['by'] = {}
    for (const k of keys) if (!hidden.has(k)) by[k] = f.by[k] as 'r' | 'w' | 'rw'
    if (keys.length === 0 || Object.keys(by).length > 0) files.push(keys.length === Object.keys(by).length ? f : { ...f, by })
  }
  return {
    cards: all.cards.filter(c => !hidden.has(c.id)),
    files,
    acts,
    events: all.events.filter(e => !hidden.has(e.from) && !(e.to !== undefined && hidden.has(e.to))),
    parents,
  }
}
