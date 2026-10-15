export const AUTO_LABEL: string
export const RANDOM_LABEL: string
export const FOLLOW_LABEL: string

export type MenuItem = {
  label?: string
  type?: 'radio' | 'checkbox' | 'separator'
  checked?: boolean
  enabled?: boolean
  submenu?: MenuItem[]
  click?: (item: { checked: boolean }) => void
}
export type PetSettingsLike = { types: Record<string, string>; agents: Record<string, string> }
export type CharChoice = { id: string; name?: string }
export type PackRef = { id: string; level: 'error' | 'warn'; n: number }
export function packLabel(): string

export type AgentLike = { id?: string; status?: string }
export function agentAction(agent: AgentLike | null | undefined): '' | 'dismiss' | 'stop'
export function finishedIds(agents: AgentLike[] | null | undefined): string[]
export function currentValue(settings: PetSettingsLike, agentKey: string, typeKey: string): { value: string; own: boolean }
export function characterItems(a: { chars: CharChoice[]; value: string; pick: (v: string) => void }): MenuItem[]
export function crabItems(a: {
  ctx: { id: string; type?: string; cur?: string; chars?: CharChoice[]; pack?: PackRef | null }
  settings: PetSettingsLike
  session: string
  act: { set: (patch: unknown) => void; focus: () => void; ask?: () => void; dismiss?: () => void; stop?: () => void; packs?: (id: string) => void }
  agentKeyOf: (session: string, id: string) => string
  canAsk?: boolean
  action?: '' | 'dismiss' | 'stop'
}): MenuItem[]
export function windowItems(
  st: { collapsed: boolean; onTop: boolean; ticker: boolean; hasId: boolean; canAsk?: boolean; askHere?: boolean; finished?: number },
  act: { ask?: () => void; dismissAll?: () => void; show: () => void; settings: () => void; collapse: () => void; onTop: (v: boolean) => void; ticker: (v: boolean) => void; reset: () => void; close: () => void; quit: () => void },
): MenuItem[]
export function trayItems(
  st: { sessions: { id: string; name: string; collapsed: boolean; canAsk?: boolean }[]; onTop: boolean; ticker: boolean },
  act: {
    showOne: (id: string) => void
    askOne?: (id: string) => void
    collapseOne: (id: string) => void
    closeOne: (id: string) => void
    showAll: () => void
    settings: () => void
    onTop: (v: boolean) => void
    ticker: (v: boolean) => void
    reset: () => void
    quit: () => void
  },
): MenuItem[]
