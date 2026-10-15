import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

import type { AgentRow, FileNode, LoopAct } from '../types'

const PANE = 'crew-graph'
const TICK_MS = 450
const MAX_NODES = 60

const loops = atom({ plugin: 'crew-graph', key: 'loops' } as const, {})
const nodes = atom({ plugin: 'crew-graph', key: 'nodes' } as const, [])
const agents = atom({ plugin: 'crew-graph', key: 'agents' } as const, [])
const frame = atom({ plugin: 'crew-graph', key: 'frame' } as const, 0)
const isBusy = atom({ plugin: 'crew-graph', key: 'isBusy' } as const, false)
const autoOpened = atom({ plugin: 'crew-graph', key: 'autoOpened' } as const, false)

// 동작별 2프레임 크리터. 모두 1칸 폭 ASCII 라 터미널 정렬이 깨지지 않는다.
const SPRITES: Record<string, [string, string]> = {
  read: ['(o.o)[=]', '(-.o)[=]'],
  edit: ['(>.<)/~', '(>.<)-~'],
  search: ['(o_o)?  ', '(O_O)!  '],
  run: ['\\(^o^)/', '/(^o^)\\'],
  web: ['(o.o)@  ', '(o.o) @ '],
  spawn: ['(^.^)>  ', '(^.^)>>>'],
  plan: ['(._.)..', '(._.)...'],
  think: ['(-.-)zZ', '(-.-)Zz'],
  done: ['(^_^)v ', '(^_^)v '],
  failed: ['(x_x)  ', '(x_x)  '],
}

const PLAN_RE = /(^|\/)(plans?|specs?|\.omc\/plans)\/|(^|\/)(plan|intent|spec|prd|roadmap)[^/]*\.(md|d4a)$/i
const DOC_RE = /\.(md|d4a|txt|rst|adoc)$|(^|\/)docs?\//i

function kindOf(path: string): FileNode['kind'] {
  if (PLAN_RE.test(path)) return 'plan'
  if (DOC_RE.test(path)) return 'doc'
  return 'code'
}

function shortPath(path: string, cwd: string): string {
  const norm = path.replace(/\\/g, '/')
  const root = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = root && norm.toLowerCase().startsWith(root.toLowerCase() + '/') ? norm.slice(root.length + 1) : norm
  return rel.length > 48 ? '…' + rel.slice(-47) : rel
}

// 한글·CJK·전각 문자는 터미널에서 2칸을 차지한다.
function cellWidth(ch: string): number {
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

// 칸(cell) 기준으로 자른다. 줄바꿈만 접고, 들여쓰기·정렬용 공백은 그대로 둔다.
function clip(text: string, n: number): string {
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

type Touch = { verb: string; target: string; file?: string; op?: 'r' | 'w' }

// 도구 호출 하나를 "무슨 일을 하는가"로 번역한다.
function describeCall(e: ToolCallInput, cwd: string): Touch {
  switch (e.tool) {
    case 'Read':
      return { verb: 'read', target: shortPath(e.file_path, cwd), file: e.file_path, op: 'r' }
    case 'Edit':
    case 'Write':
      return { verb: 'edit', target: shortPath(e.file_path, cwd), file: e.file_path, op: 'w' }
    case 'NotebookEdit':
      return { verb: 'edit', target: shortPath(e.notebook_path, cwd), file: e.notebook_path, op: 'w' }
    case 'Grep':
      return { verb: 'search', target: clip(e.pattern, 30) }
    case 'Glob':
      return { verb: 'search', target: clip(e.pattern, 30) }
    case 'Bash':
    case 'PowerShell':
      return { verb: 'run', target: clip(e.command, 34) }
    case 'WebFetch':
      return { verb: 'web', target: clip(e.url, 34) }
    case 'WebSearch':
      return { verb: 'web', target: clip(e.query, 34) }
    case 'Agent':
      return { verb: 'spawn', target: clip(`${e.subagent_type ?? 'agent'}: ${e.description}`, 34) }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'ExitPlanMode':
      return { verb: 'plan', target: e.tool }
    default:
      return { verb: 'run', target: e.tool }
  }
}

function loopKey(e: { agentId?: string }): string {
  return e.agentId ?? 'main'
}

let cwd = ''
let tick: { cancel: () => void } | undefined
let lastAgentPoll = 0

async function refreshAgents($: EngineInterface): Promise<AgentRow[]> {
  const list = await $.agent.list()
  const rows: AgentRow[] = list.map(a => ({
    id: a.id,
    type: a.type,
    description: a.description,
    status: a.status,
    parentId: a.parentId,
  }))
  await update($, agents, () => rows)
  return rows
}

// 애니메이션 타이머: 누군가 일하는 동안만 돈다. 2초마다 에이전트 목록도 갱신.
async function onTick($: EngineInterface): Promise<void> {
  await update($, frame, f => (f + 1) % 1000)
  const now = await $.clock.now()
  if (now - lastAgentPoll < 2000) return
  lastAgentPoll = now
  const rows = await refreshAgents($)
  const anyRunning = rows.some(a => a.status === 'running' || a.status === 'pending')
  if (!anyRunning && !(await read($, isBusy))) {
    tick?.cancel()
    tick = undefined
  }
}

function startTick($: EngineInterface): void {
  if (tick) return
  tick = $.clock.every(TICK_MS, () => void onTick($))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cwd = e.cwd ?? ''
    await $.command.register({
      name: 'crew',
      description: 'Show the agent crew: who does what, and which plans/docs they touch',
    })
    return next(e)
  })

  on('command.run', { command: 'crew' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Crew' })
    await refreshAgents($)
    return { text: 'Crew pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    await update($, isBusy, () => true)
    await update($, loops, all => ({
      ...all,
      main: { key: 'main', verb: 'think', tool: '', target: '', since: 0, calls: all.main?.calls ?? 0 },
    }))
    startTick($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await update($, isBusy, () => false)
    await update($, loops, all =>
      all.main ? { ...all, main: { ...all.main, verb: 'done', target: '' } } : all,
    )
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const key = loopKey(e)
    const touch = describeCall(e, cwd)
    const now = await $.clock.now()

    await update($, loops, all => ({
      ...all,
      [key]: {
        key,
        verb: touch.verb,
        tool: e.tool,
        target: touch.target,
        since: now,
        calls: (all[key]?.calls ?? 0) + 1,
      },
    }))

    if (touch.file && touch.op) {
      const path = shortPath(touch.file, cwd)
      const op = touch.op
      await update($, nodes, list => {
        const found = list.find(n => n.path === path)
        const merged = (prev?: string) => (prev && prev !== op ? 'rw' : op)
        const node: FileNode = found
          ? { ...found, by: { ...found.by, [key]: merged(found.by[key]) }, last: now }
          : { path, kind: kindOf(path), by: { [key]: op }, last: now }
        return [node, ...list.filter(n => n.path !== path)].slice(0, MAX_NODES)
      })
    }

    if (e.tool === 'Agent') {
      // 세션의 첫 서브에이전트에서만 창을 연다. 사용자가 닫은 뒤엔 다시 띄우지 않는다(/crew 로 재오픈).
      if (!(await read($, autoOpened))) {
        await update($, autoOpened, () => true)
        void $.ui.open({ id: PANE, title: 'Crew' })
      }
      startTick($)
    }

    const ran = await next(e)

    if (ran.deny === undefined && ran.isError === true) {
      await update($, loops, all => (all[key] ? { ...all, [key]: { ...all[key], verb: 'failed' } } : all))
    }
    if (e.tool === 'Agent') await refreshAgents($)

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const f = await read($, frame)
    const acts = await read($, loops)
    const rows = await read($, agents)
    const files = await read($, nodes)
    const now = await $.clock.now()
    const cols = e.viewport?.columns ?? 60
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 2)

    const nameOf = (key: string) => {
      if (key === 'main') return 'main'
      const a = rows.find(r => r.id === key)
      return a ? a.type : key.slice(0, 6)
    }
    const sprite = (verb: string): string => (SPRITES[verb] ?? SPRITES.think ?? ['', ''])[f % 2] ?? ''
    const secs = (act?: LoopAct) => (act && act.since && act.verb !== 'done' ? `${Math.round((now - act.since) / 1000)}s` : '')

    const lines: { text: string; color?: string; dim?: boolean; bold?: boolean }[] = []
    const running = rows.filter(r => r.status === 'running' || r.status === 'pending').length
    lines.push({ text: `Crew · ${running} running · ${files.length} files`, bold: true })

    // 에이전트 트리: main → 자식 → 손자. 각 줄 = 크리터 + 동사 + 대상.
    const actLine = (prefix: string, key: string, label: string, status?: string) => {
      const act = acts[key]
      const ended = status && status !== 'running' && status !== 'pending' && status !== 'waiting'
      const verb = ended ? (status === 'completed' ? 'done' : status === 'idle' ? 'think' : 'failed') : act?.verb ?? 'think'
      const what = ended ? status : `${verb} ${act?.target ?? ''}`
      lines.push({
        text: clip(`${prefix}${sprite(verb)} ${label}  ${what} ${secs(act)}`, cols),
        color: verb === 'failed' ? 'red' : verb === 'done' ? 'green' : 'cyan',
        dim: Boolean(ended),
      })
    }
    actLine('● ', 'main', 'main')
    const walk = (parent: string | undefined, depth: number) => {
      const kids = rows.filter(r => r.parentId === parent)
      kids.forEach((k, i) => {
        const last = i === kids.length - 1
        actLine(`${'  '.repeat(depth)}${last ? '└─' : '├─'}`, k.id, `${k.type} "${clip(k.description, 20)}"`, k.status)
        walk(k.id, depth + 1)
      })
    }
    walk(undefined, 0)

    // 관계 그래프: 계획·문서 노드 ← 누가 읽고(r) 썼는지(w).
    const graph = files.filter(n => n.kind !== 'code')
    const code = files.filter(n => n.kind === 'code')
    lines.push({ text: '' })
    lines.push({ text: `Plans & docs (${graph.length})`, bold: true })
    if (graph.length === 0) lines.push({ text: '  (none touched yet)', dim: true })
    for (const n of graph) {
      const who = Object.entries(n.by).map(([k, op]) => `${nameOf(k)}:${op}`).join(' ')
      lines.push({
        text: clip(`  ${n.kind === 'plan' ? '■ plan' : '□ doc '} ${n.path} ◄─ ${who}`, cols),
        color: n.kind === 'plan' ? 'magenta' : 'yellow',
      })
    }
    lines.push({ text: '' })
    lines.push({ text: `Code (${code.length})`, bold: true })
    for (const n of code) {
      const who = Object.entries(n.by).map(([k, op]) => `${nameOf(k)}:${op}`).join(' ')
      lines.push({ text: clip(`  · ${n.path} ◄─ ${who}`, cols), dim: true })
    }

    return (
      <Box flexDirection="column">
        {lines.slice(0, room).map(l => (
          <Text color={l.color} dimColor={l.dim} bold={l.bold} wrap="truncate-end">
            {l.text || ' '}
          </Text>
        ))}
      </Box>
    )
  })
}
