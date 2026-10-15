/* crew-graph pet settings: the pure parts (what a settings file may hold, merging a change into it, and which character an agent gets
   from the settings, the mod's `characters` option and the roles). A classic script that sets window.CrewPetCore; overlay/main.js and the
   tests require() it. No THREE and no Electron in here.

   pet-settings.json (~/.claude/crew-graph/overlay/), written by the pet's main process only:
   {
     "v": 1,
     "default": null | "auto" | "random" | "<character id>",   // for agents nothing else decided; null: the mod option, else the crab
     "types":  { "<agent type | main | architect | prefix* | *>": "<character id | random | auto>" },
     "agents": { "<session id>|<agent id>": "<character id | random | auto>" },
     "show": { "bubbles": true, "ticker": true, "papers": true, "nameplate": true },
     "reduceMotion": false, "alwaysOnTop": true, "opacity": 100, "size": "" | "S" | "M" | "L"
   }
   Which character an agent gets, first match wins: its own entry in "agents", then "types" (specific keys first, "*" last), then the
   mod's `characters` option, then "default". */
(function (root, factory) {
  const CC = typeof module === 'object' && module.exports && typeof require === 'function' ? require('./characters-core.js') : root.CrewCharCore;
  const api = factory(CC);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewPetCore = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function (CC) {
'use strict';

const SIZES = { S: { width: 260, height: 220 }, M: { width: 360, height: 300 }, L: { width: 520, height: 430 } };
const OPACITY_MIN = 60, MAX_TYPES = 64, MAX_AGENTS = 200;
const SHOW_KEYS = ['bubbles', 'ticker', 'papers', 'nameplate'];
const UNSAFE_KEYS = ['__proto__', 'constructor', 'prototype'];

const defaults = () => ({ v: 1, default: null, types: {}, agents: {}, show: { bubbles: true, ticker: true, papers: true, nameplate: true }, reduceMotion: false, alwaysOnTop: true, opacity: 100, size: '' });
/* a value a rule may have: a character id (the form only; a pack that is not loaded is not an error), `random` or `auto` */
const okValue = (v) => typeof v === 'string' && CC.CHAR_ID.test(v);
const okKey = (k) => typeof k === 'string' && k.length >= 1 && k.length <= 200 && !/[\u0000-\u001f]/.test(k) && UNSAFE_KEYS.indexOf(k) < 0;
const agentKey = (session, id) => String(session == null ? '' : session) + '|' + String(id);

function cleanMap(m, max) {
  const out = {};
  if (!m || typeof m !== 'object' || Array.isArray(m)) return out;
  for (const k of Object.keys(m).slice(-max)) if (okKey(k) && okValue(m[k])) out[k] = m[k];
  return out;
}
/* anything -> settings that are all valid (what is wrong is dropped, what is missing is the default) */
function sanitize(raw) {
  const s = defaults();
  if (!raw || typeof raw !== 'object') return s;
  if (okValue(raw.default)) s.default = raw.default;
  s.types = cleanMap(raw.types, MAX_TYPES);
  s.agents = cleanMap(raw.agents, MAX_AGENTS);
  const sh = raw.show && typeof raw.show === 'object' ? raw.show : {};
  SHOW_KEYS.forEach((k) => { if (typeof sh[k] === 'boolean') s.show[k] = sh[k]; });
  if (typeof raw.reduceMotion === 'boolean') s.reduceMotion = raw.reduceMotion;
  if (typeof raw.alwaysOnTop === 'boolean') s.alwaysOnTop = raw.alwaysOnTop;
  if (typeof raw.opacity === 'number' && isFinite(raw.opacity)) s.opacity = Math.max(OPACITY_MIN, Math.min(100, Math.round(raw.opacity)));
  if (typeof raw.size === 'string' && SIZES[raw.size]) s.size = raw.size;
  return s;
}
/* settings + a patch -> new settings. In "types" and "agents" a value of null or "" removes the key; "default": null clears it;
   "show" takes any of its keys. Unknown keys and invalid values are ignored. */
function merge(cur, patch) {
  const next = sanitize(cur);
  if (!patch || typeof patch !== 'object') return next;
  if ('default' in patch) { if (patch.default === null || patch.default === '') next.default = null; else if (okValue(patch.default)) next.default = patch.default; }
  for (const f of ['types', 'agents']) {
    const p = patch[f];
    if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
    for (const k of Object.keys(p)) {
      if (!okKey(k)) continue;
      delete next[f][k]; // set again below: the newest entries are the last, and the oldest go first when the map is full
      if (okValue(p[k])) next[f][k] = p[k];
    }
  }
  if (patch.show && typeof patch.show === 'object') SHOW_KEYS.forEach((k) => { if (typeof patch.show[k] === 'boolean') next.show[k] = patch.show[k]; });
  // a value of the wrong kind changes nothing (it does not clear what was there)
  ['reduceMotion', 'alwaysOnTop'].forEach((k) => { if (typeof patch[k] === 'boolean') next[k] = patch[k]; });
  if (typeof patch.opacity === 'number' && isFinite(patch.opacity)) next.opacity = patch.opacity;
  if (typeof patch.size === 'string' && (patch.size === '' || SIZES[patch.size])) next.size = patch.size;
  return sanitize(next);
}

/* ---------------------------------------------------------------- which character
   agent { id, type, description, verb, isArchitect, parentId }; ctx { ids: every character id, auto: agent -> { id, why } | null, session }.
   -> { id, how, mode, why }: how = 'agent' | 'type:<key>' | 'option' | 'default' | 'legacy', mode = 'set' | 'random' | 'auto'. */
function resolve(s, modRules, agent, ctx) {
  const ids = ctx.ids;
  if (!ids.length) return null;
  const lc = (x) => String(x).toLowerCase();
  const find = (v) => ids.find((x) => lc(x) === lc(v));
  const randomId = () => ids[CC.hash(agent && agent.id != null ? agent.id : '') % ids.length];
  const take = (v, how) => {
    if (v === 'random') return { id: randomId(), how, mode: 'random', why: null };
    if (v === 'auto') {
      const a = ctx.auto ? ctx.auto(agent) : null;
      return a && a.id ? { id: a.id, how, mode: 'auto', why: a.why || [] } : { id: randomId(), how, mode: 'random', why: null };
    }
    const f = find(v);
    return f ? { id: f, how, mode: 'set', why: null } : null;
  };
  const own = s.agents[agentKey(ctx.session, agent && agent.id)];
  let r = own ? take(own, 'agent') : null;
  if (r) return r;
  const keys = Object.keys(s.types), ordered = keys.filter((k) => k !== '*').concat(keys.indexOf('*') >= 0 ? ['*'] : []);
  for (const k of ordered) {
    if (!CC.ruleMatches(k, agent)) continue;
    r = take(s.types[k], 'type:' + k);
    if (r) return r;
  }
  const rule = (modRules || []).find((q) => CC.ruleMatches(q[0], agent));
  if (rule) return take(rule[1], 'option') || { id: ids[0], how: 'option', mode: 'set', why: null }; // a name nobody has: the crab
  if (s.default) { r = take(s.default, 'default'); if (r) return r; }
  return modRules && modRules.length ? { id: randomId(), how: 'legacy', mode: 'random', why: null } : { id: ids[0], how: 'legacy', mode: 'set', why: null };
}
/* a resolve() result in words, for the hover card: "matched: code, test", "set for Explore", ... */
function explain(r) {
  if (!r) return '';
  if (r.mode === 'auto') return r.why && r.why.length ? 'matched: ' + r.why.join(', ') : 'auto: no trait fits, a stable pick';
  if (r.mode === 'random') return 'random pick';
  if (r.how === 'agent') return 'set for this agent';
  if (r.how.indexOf('type:') === 0) return 'set for ' + (r.how.slice(5) === '*' ? 'all types' : r.how.slice(5));
  if (r.how === 'option') return 'from the characters option';
  if (r.how === 'default') return 'pet default';
  return 'default';
}

/* ---------------------------------------------------------------- the file
   fsx: { readFileSync, writeFileSync, renameSync, mkdirSync } (node's fs, or a stand-in). */
const dirOf = (file) => file.replace(/[\\/][^\\/]*$/, '');
/* the settings in the file, or null when it is missing or not JSON */
function load(fsx, file) {
  try { return sanitize(JSON.parse(String(fsx.readFileSync(file, 'utf8')).replace(/^﻿/, ''))); } catch (e) { return null; }
}
/* written to a temp file and renamed over the real one: a reader sees the old file or the new one, never half of it */
function save(fsx, file, settings) {
  fsx.mkdirSync(dirOf(file), { recursive: true });
  fsx.writeFileSync(file + '.tmp', JSON.stringify(settings, null, 2));
  fsx.renameSync(file + '.tmp', file);
}

return { SIZES, OPACITY_MIN, SHOW_KEYS, defaults, sanitize, merge, agentKey, resolve, explain, load, save, okValue };
});
