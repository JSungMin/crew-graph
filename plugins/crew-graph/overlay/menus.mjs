// The pieces of the pet's menus that depend on the settings, as plain template items, kept apart from Electron so they can be
// tested without a Menu. overlay/main.js hands the result to Menu.buildFromTemplate.
//
// Right-clicking a character offers "Character >" (radio items: the rules, Match role (auto), Random, then every character,
// built in and from the user's folder), "Only this agent", and the entries a crab always had.

export const AUTO_LABEL = 'Match role (auto)'
export const RANDOM_LABEL = 'Random'
export const FOLLOW_LABEL = 'Default (follow the rules)'

/** The value ('' | 'auto' | 'random' | a character id) a menu stands on for this agent: its own entry, else its type's, else none. */
export function currentValue(settings, agentKey, typeKey) {
  const own = settings.agents[agentKey]
  if (own) return { value: own, own: true }
  return { value: settings.types[typeKey] || '', own: false }
}

/**
 * The radio items of "Character >". `chars`: [{ id, name }]; `value`: what is chosen now; `pick(value)`: called with '' | 'auto' |
 * 'random' | a character id.
 */
export function characterItems({ chars, value, pick }) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
  const one = (label, v) => ({ label, type: 'radio', checked: v === '' ? !value : same(value, v), click: () => pick(v) })
  return [
    one(FOLLOW_LABEL, ''),
    one(AUTO_LABEL, 'auto'),
    one(RANDOM_LABEL, 'random'),
    { type: 'separator' },
    ...chars.map(c => one(c.name && c.name !== c.id ? `${c.name} (${c.id})` : c.id, c.id)),
  ]
}

/**
 * The top of a character's right-click menu.
 *   ctx: { id, type, cur, chars }  what the page says was clicked (cur: the character it has now)
 *   settings, session: the pet settings and the window's session id
 *   act: { set(patch), focus() }   set applies a settings patch, focus shows the agent in the Crew pane
 * "Only this agent" makes an entry for this one agent (starting from the character it has now); ticked, a pick changes that entry,
 * else it changes the entry of the agent's type. Unticking removes the agent's own entry.
 */
export function crabItems({ ctx, settings, session, act, agentKeyOf }) {
  const key = agentKeyOf(session, ctx.id)
  const typeKey = ctx.type || ctx.id
  const cur = currentValue(settings, key, typeKey)
  const pick = v => act.set(cur.own ? { agents: { [key]: v || null } } : { types: { [typeKey]: v || null } })
  return [
    { label: 'Character', submenu: characterItems({ chars: ctx.chars || [], value: cur.value, pick }) },
    {
      label: 'Only this agent',
      type: 'checkbox',
      checked: cur.own,
      click: item => act.set({ agents: { [key]: item.checked ? ctx.cur || cur.value || 'auto' : null } }),
    },
    { type: 'separator' },
    { label: 'Show in Crew pane', click: () => act.focus() },
    { type: 'separator' },
  ]
}

/** The entries every pet menu ends with. `st`: { collapsed, onTop, ticker, hasId }; `act` holds the callbacks. */
export function windowItems(st, act) {
  const items = [
    { label: 'Show', click: act.show },
    { label: 'Settings…', click: act.settings },
    { label: st.collapsed ? 'Expand' : 'Collapse to title bar', click: act.collapse },
    { label: 'Always on top', type: 'checkbox', checked: st.onTop, click: i => act.onTop(i.checked) },
    { label: 'Activity ticker', type: 'checkbox', checked: st.ticker, click: i => act.ticker(i.checked) },
    { label: 'Reset position & size', click: act.reset },
  ]
  if (st.hasId) items.push({ label: 'Close this window', click: act.close })
  items.push({ type: 'separator' }, { label: 'Quit', click: act.quit })
  return items
}

/** The tray menu: one entry per session window, then the shared ones. */
export function trayItems(st, act) {
  const sessions = st.sessions.map(s => ({
    label: s.name,
    submenu: [
      { label: 'Show', click: () => act.showOne(s.id) },
      { label: s.collapsed ? 'Expand' : 'Collapse to title bar', click: () => act.collapseOne(s.id) },
      { label: 'Close', click: () => act.closeOne(s.id) },
    ],
  }))
  return [
    ...(sessions.length ? [{ label: 'Sessions', enabled: false }, ...sessions, { type: 'separator' }] : []),
    { label: 'Show all', click: act.showAll },
    { label: 'Settings…', click: act.settings },
    { label: 'Always on top', type: 'checkbox', checked: st.onTop, click: i => act.onTop(i.checked) },
    { label: 'Activity ticker', type: 'checkbox', checked: st.ticker, click: i => act.ticker(i.checked) },
    { label: 'Reset position & size', click: act.reset },
    { type: 'separator' },
    { label: 'Quit', click: act.quit },
  ]
}
