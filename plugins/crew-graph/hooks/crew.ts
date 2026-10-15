// crew-graph's own pure helpers: what a tool call means for the crew, file kinds, cell-width
// clipping, and the snapshot the browser view reads. Nothing here touches `$`.
import type { AgentCard, Architect, CrewEvent, FileNode, Gate, LoopAct, Main, Parents, Receipt, Turn, Usage, Verb } from '../types'
import { gateSummary, isAdvising, redact } from './deck/core'

export const MAX_FILES = 60
export const MAX_EVENTS = 200

const PLAN_RE = /(^|\/)(plans?|specs?|\.omc\/plans)\/|(^|\/)(plan|intent|spec|prd|roadmap)[^/]*\.(md|d4a)$/i
const DOC_RE = /\.(md|d4a|txt|rst|adoc)$|(^|\/)docs?\//i

export function kindOf(path: string): FileNode['kind'] {
  if (PLAN_RE.test(path)) return 'plan'
  if (DOC_RE.test(path)) return 'doc'
  return 'code'
}

export function shortPath(path: string, cwd: string): string {
  const norm = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = root && norm.toLowerCase().startsWith(root.toLowerCase() + '/') ? norm.slice(root.length + 1) : norm
  return rel.length > 48 ? '…' + rel.slice(-47) : rel
}

/** Hangul, CJK and full-width forms take two terminal cells. */
export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)
  return isWide ? 2 : 1
}

/** Cuts to `n` cells. Folds line breaks only; indentation and alignment spaces stay. */
export function clip(text: string, n: number): string {
  const one = text.replace(/[\r\n\t]+/g, ' ')
  let used = 0
  let out = ''
  for (const ch of one) {
    const w = cellWidth(ch)
    if (used + w > n - 1) return out + '…'
    used += w
    out += ch
  }
  return out
}

export type Touch = { verb: Verb; target: string; file?: string; op?: 'r' | 'w' }

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** One tool call read as what the crab is doing. Input fields arrive flattened on the event. */
export function describeCall(tool: string, e: Record<string, unknown>, cwd: string): Touch {
  const file = str(e.file_path) || str(e.notebook_path)
  switch (tool) {
    case 'Read':
      return { verb: 'read', target: shortPath(file, cwd), file, op: 'r' }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return { verb: 'edit', target: shortPath(file, cwd), file, op: 'w' }
    case 'Grep':
    case 'Glob':
      return { verb: 'search', target: clip(str(e.pattern), 30) }
    case 'Bash':
    case 'PowerShell':
      return { verb: 'run', target: clip(redact(str(e.command)), 34) }
    case 'WebFetch':
      return { verb: 'web', target: clip(str(e.url), 34) }
    case 'WebSearch':
      return { verb: 'web', target: clip(str(e.query), 34) }
    case 'Agent':
      return { verb: 'spawn', target: clip(`${str(e.subagent_type) || 'agent'}: ${str(e.description)}`, 34) }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TodoWrite':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { verb: 'plan', target: tool }
    default:
      return { verb: 'run', target: tool }
  }
}

/** A tool call's file as an absolute path in forward slashes: a relative one is taken from `cwd`. */
export function absPath(file: string, cwd: string): string | undefined {
  if (!file) return undefined
  const f = file.replace(/\\/g, '/')
  if (f.startsWith('/') || /^[A-Za-z]:\//.test(f)) return f
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  return root ? `${root}/${f.replace(/^\.\//, '')}` : undefined
}

export function touchFile(list: FileNode[], path: string, key: string, op: 'r' | 'w', now: number, abs?: string): FileNode[] {
  const found = list.find(n => n.path === path)
  const prev = found?.by[key]
  const merged: 'r' | 'w' | 'rw' = prev && prev !== op ? 'rw' : op
  const node: FileNode = found
    ? { ...found, by: { ...found.by, [key]: merged }, last: now, ...(abs ? { abs } : {}) }
    : { path, kind: kindOf(path), by: { [key]: op }, last: now, ...(abs ? { abs } : {}) }
  return [node, ...list.filter(n => n.path !== path)].slice(0, MAX_FILES)
}

export function pushEvent(list: CrewEvent[], e: Omit<CrewEvent, 'id'>): CrewEvent[] {
  const id = (list[list.length - 1]?.id ?? 0) + 1
  return [...list, { ...e, id }].slice(-MAX_EVENTS)
}

/** A card's status as the crab shows it. */
export function verbOfCard(c: AgentCard, act: LoopAct | undefined): Verb {
  if (c.status === 'done') return 'done'
  if (c.status === 'failed' || c.status === 'stopped') return 'failed'
  return act?.verb ?? 'think'
}

const basename = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() ?? ''

/** A session's name for its window: the first prompt on one line, credentials masked, about 32 cells. */
export function titleOf(text: string): string {
  return clip(redact(text.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim()), 32)
}

export type SnapshotInput = {
  now: number
  sessionId: string
  /** The session's title (its first prompt, see titleOf); empty before there is one. */
  title?: string
  cwd: string
  main: Main
  usage: Usage
  architect: Architect
  gate: Gate
  cards: AgentCard[]
  architectIds: string[]
  acts: Record<string, LoopAct>
  files: FileNode[]
  events: CrewEvent[]
  parents: Parents
  turn: Turn
  receipt: Receipt | null
}

/** What the browser view reads (docs/DATA_CONTRACT.md, v1). */
export function snapshotOf(s: SnapshotInput) {
  const g = gateSummary(s.gate)
  const mainAct = s.acts.main
  const mainAgent = {
    id: 'main',
    parentId: null,
    type: 'main',
    description: 'main loop',
    status: s.main.isRunning ? 'running' : 'idle',
    verb: s.main.isRunning ? (mainAct?.verb ?? 'think') : 'wait',
    target: s.main.isRunning ? (mainAct?.target ?? '') : '',
    since: mainAct?.since ?? s.now,
    steps: s.main.steps,
    calls: mainAct?.calls ?? 0,
    startedAt: s.turn.startedAt || s.now,
  }
  const agents = s.cards.map(c => {
    const act = s.acts[c.id]
    const status = c.status === 'done' ? 'completed' : c.status === 'stopped' ? 'killed' : c.status
    return {
      id: c.id,
      parentId: s.parents[c.id] ?? 'main',
      type: c.type,
      description: c.description,
      status,
      verb: verbOfCard(c, act),
      target: act?.target ?? '',
      since: act?.since ?? c.spawnedAt,
      steps: c.steps,
      calls: act?.calls ?? 0,
      ctxTokens: c.ctx,
      outTokens: c.out,
      startedAt: c.spawnedAt,
      endedAt: c.endedAt ?? undefined,
      isArchitect: s.architectIds.includes(c.id),
    }
  })
  const lastConsult = s.architect.consults[s.architect.consults.length - 1]
  return {
    v: 1,
    now: s.now,
    session: {
      id: s.sessionId,
      cwd: basename(s.cwd),
      title: s.title || undefined,
      // The full working directory, for the pet's "show in folder"; the data file lives under the user's own home.
      cwdAbs: s.cwd ? s.cwd.replace(/\\/g, '/') : undefined,
      model: s.main.model,
      effort: s.main.effort || undefined,
      mode: s.main.mode || undefined,
      requests: s.main.steps,
      ctx: s.usage.tokens !== null && s.usage.window > 0 ? { used: s.usage.tokens, max: s.usage.window } : undefined,
      compactions: s.usage.compactions,
      costUsd: s.usage.costUsd ?? undefined,
      rate: s.usage.limits.map(l => ({ label: l.kind, pct: l.pct, resetsAt: l.resetsAt ?? undefined })),
      ttftMs: s.main.speed?.ttftMs,
      tokPerSec: s.main.speed?.tokPerS ?? undefined,
      turn: s.turn.startedAt
        ? {
            running: s.main.isRunning,
            startedAt: s.turn.startedAt,
            endedAt: s.main.isRunning || !s.receipt ? undefined : s.turn.startedAt + s.receipt.durationMs,
            edits: s.turn.edits,
            errors: s.turn.errors,
            agents: s.receipt?.agents ?? s.cards.filter(c => c.spawnedAt >= s.turn.startedAt).length,
          }
        : undefined,
    },
    agents: [mainAgent, ...agents],
    files: s.files,
    events: s.events,
    gate: { allowed: g.rule, asked: g.cleared, denied: g.deny, pending: g.ask },
    architect: {
      consults: s.architect.consults.length,
      running: isAdvising(s.architect),
      lastMs: lastConsult?.endAt ? lastConsult.endAt - lastConsult.at : undefined,
    },
  }
}

export const dataJs = (snapshot: unknown) => `window.__crewUpdate && window.__crewUpdate(${JSON.stringify(snapshot)});\n`

/** The scrollbar column for a window of `bodyRows` at `offset` over `total` rows; null when it all fits. */
export function scrollbar(offset: number, bodyRows: number, total: number): { top: number; thumbTop: number; thumbLen: number } | null {
  if (bodyRows <= 0 || total <= bodyRows) return null
  const top = Math.max(0, Math.min(offset, total - bodyRows))
  const thumbLen = Math.max(1, Math.min(bodyRows, Math.round((bodyRows * bodyRows) / total)))
  const thumbTop = Math.round((top * (bodyRows - thumbLen)) / (total - bodyRows))
  return { top, thumbTop, thumbLen }
}
