// crew-graph's food sources when the model has no task tools. Claude Code leaves TodoWrite and the Task tools out on newer models unless
// asked, so a session without them has no to-do lists to turn into food; the mod then makes food from proxies of real work (the prompt
// turns of the main loop; the subagent tickets exist in every session). Plain data and text; nothing here touches `$`.
// Source of the availability rules: https://code.claude.com/docs/en/tools-reference#task-tool-availability and https://code.claude.com/docs/en/env-vars
import type { Setup } from '../types'

export type SetupState = Setup

/** The `foodFrom` option: `auto` uses the proxies only when the session has no native task tools; `todos` never; `work` always. */
export type FoodFrom = 'auto' | 'todos' | 'work'
export const FOOD_FROM_LABEL: Record<FoodFrom, string> = { auto: 'auto', todos: 'todos', work: 'todos+work' }

/** The option as written in /config ("auto", "todos", "todos+work"), read leniently; anything else is `auto`. */
export function foodFromOf(v: unknown): FoodFrom {
  const t = typeof v === 'string' ? v.toLowerCase() : ''
  if (t.includes('+') || t === 'work') return 'work'
  if (t.includes('only') || t === 'todos') return 'todos'
  return 'auto'
}

/** The native tools whose presence means the agents' own to-do lists are there. */
const NATIVE = ['TodoWrite', 'TaskCreate']
export const hasNativeTaskTools = (names: readonly string[]) => names.some(n => NATIVE.includes(n))

/** Are the prompt turns food? `auto`: only when the session is known to have no native task tools (an unreadable tool list is not "none"). */
export const proxyFoodOn = (foodFrom: FoodFrom, native: boolean | null) => foodFrom === 'work' || (foodFrom === 'auto' && native === false)

/** A user prompt origin worth a plate: the user's own Enter, a Remote Control client, the owner's Slack ping. */
export const USER_ORIGINS: readonly string[] = ['composer', 'bridge', 'slack-ping']

/**
 * A prompt origin that is a letter to main, not the user's words (PromptOrigin in the engine's types): a teammate's or another session's
 * message, a background task's notification, a coordinating session's hand-off, a channel relay. `scheduled-trigger`, `sdk`,
 * `auto-continuation` and the observer kinds are neither the user nor a report, so they are food for no one.
 */
export const MAIL_ORIGINS: readonly string[] = ['task-notification', 'peer', 'peer-send-message', 'coordinator', 'projects-relay', 'channel']
export const isMailOrigin = (kind: unknown): boolean => typeof kind === 'string' && MAIL_ORIGINS.includes(kind)

export const DOCS_URL = 'https://code.claude.com/docs/en/tools-reference#task-tool-availability'
export const ENV_URL = 'https://code.claude.com/docs/en/env-vars'
export const ENV_KEY = 'CLAUDE_CODE_ENABLE_TODO_TOOLS'

/** `/crew setup`: what was found, which food sources are on, and how to get the native tools. It changes nothing and writes no file. */
export function setupReport(s: SetupState, foodFrom: FoodFrom): string {
  const native = s.native === true ? 'present' : s.native === false ? 'missing' : "unknown (the session's tool list could not be read)"
  const turns = proxyFoodOn(foodFrom, s.native)
  const why =
    foodFrom === 'work' ? 'the setting is "todos+work"' : foodFrom === 'todos' ? 'the setting is "todos"' : s.native === false ? 'this session has no native task tools' : s.native === true ? 'this session has the native task tools' : 'not known whether it has them'
  return [
    'crew-graph setup: food',
    `native task tools (TodoWrite, TaskCreate): ${native}`,
    `food from: ${FOOD_FROM_LABEL[foodFrom]} (the foodFrom option in /config)`,
    'sources:',
    `  to-dos and tasks: from TodoWrite / TaskCreate, ${s.native === false ? 'none in this session' : 'as the agents write them'}`,
    '  subagent tickets: always',
    `  prompt turns: ${turns ? 'on' : 'off'} (${why}); each prompt you send is one item, eaten when the answer is done`,
    '  background jobs: not tracked (the end of a job reaches the mod only as a notification prompt of untyped text, or a transcript row that cannot be read into state)',
    s.native === true
      ? ''
      : `To get the native task tools, set ${ENV_KEY}=1 in the environment before starting Claude Code (or ${ENV_KEY}=1 under "env" in settings.json). They cost some context on every request. Docs: ${DOCS_URL} and ${ENV_URL}`,
    'This command changes nothing and writes no file.',
  ]
    .filter(Boolean)
    .join('\n')
}
