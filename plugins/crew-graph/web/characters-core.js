/* crew-graph characters: the pure parts (rig names, name matching, assignment rules, voxel character checking).
   A classic script that sets window.CrewCharCore; it is also require()d by the tests. No THREE in here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewCharCore = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* One bone set for every character. A character has some of these; the animation skips the ones it lacks. */
const RIG = ['root', 'body', 'head', 'earL', 'earR', 'eyeL', 'eyeR', 'mouth', 'armL', 'handL', 'armR', 'handR',
  'legL1', 'legL2', 'legL3', 'legR1', 'legR2', 'legR3', 'tail'];
const EYE_VARIANTS = ['x', 'squint', 'happy', 'sleepy', 'dizzy'];
const CHAR_ID = /^[A-Za-z0-9._-]{1,40}$/;
const LIMITS = { boxes: 400, coord: 80, size: 80, food: 40 };
const FOOD_ID = /^[a-z0-9_-]{1,24}$/;
/* The foods that ship with the viewer (web/tasks.js FOODS; a test keeps the two in step). A pack without a valid `food` eats the seed. */
const FOOD_IDS = ['fish', 'carrot', 'treat', 'seed', 'battery', 'ticket'];
const DEFAULT_FOOD = 'seed';

const hash = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/* ---------------------------------------------------------------- bone names (GLB nodes) */
// "Head", "arm_L", "Arm.L", "arm L", "mixamorig:Head" -> lower case, no _ . space - and no namespace before a colon.
const normName = (s) => String(s == null ? '' : s).split(':').pop().toLowerCase().replace(/[\s_.\-]+/g, '');
const RIG_KEY = {};
RIG.forEach((n) => { RIG_KEY[normName(n)] = n; });
// "arm_L" is armL, and so is "L_arm" / "left arm"; a trailing .001 (Blender's duplicate suffix) does not count.
function rigOf(nodeName) {
  const n = normName(String(nodeName == null ? '' : nodeName).replace(/\.\d{3}$/, ''));
  if (RIG_KEY[n]) return RIG_KEY[n];
  let m = /^(left|right|l|r)(arm|hand|ear|eye|leg\d?)$/.exec(n), side = '', part = '';
  if (m) { side = m[1].charAt(0); part = m[2]; }
  else if ((m = /^(arm|hand|ear|eye|leg\d?)(left|right)$/.exec(n))) { side = m[2].charAt(0); part = m[1]; }
  if (!side && (m = /^leg(\d)(l|r)$/.exec(n))) return RIG_KEY['leg' + m[2] + m[1]] || null;
  if (!side) return null;
  const lg = /^leg(\d?)$/.exec(part);
  return RIG_KEY[lg ? 'leg' + side + (lg[1] || '1') : part + side] || null;
}
/* node names -> { bones: { rigName: nodeName }, variants: { eyeL: { x: nodeName } } }. The first node with a name wins. */
function matchRig(names) {
  const bones = {}, variants = {};
  for (const nm of names) {
    const rg = rigOf(nm);
    if (rg) { if (!bones[rg]) bones[rg] = nm; continue; }
    const n = normName(String(nm).replace(/\.\d{3}$/, ''));
    for (const side of ['eyeL', 'eyeR']) {
      const pre = side.toLowerCase();
      if (n.startsWith(pre) && EYE_VARIANTS.indexOf(n.slice(pre.length)) >= 0) {
        variants[side] = variants[side] || {};
        if (!variants[side][n.slice(pre.length)]) variants[side][n.slice(pre.length)] = nm;
      }
    }
  }
  return { bones, variants };
}

/* ---------------------------------------------------------------- assignment: "main=crab, Explore=bunny, *=random" */
/* A part without "=" is `*=<it>`: "random", "auto" or "bunny" alone work, and so does "main=crab, random".
   `random` is a stable pick by hash of the agent id, `auto` matches the agent's role to a character's traits. */
function parseRules(spec) {
  const out = [];
  if (typeof spec !== 'string') return out;
  for (const part of spec.split(/[,;\n]+/)) {
    const i = part.indexOf('=');
    if (i === 0) continue;
    const key = i < 0 ? '*' : part.slice(0, i).trim(), val = (i < 0 ? part : part.slice(i + 1)).trim();
    if (!key || !val || key.length > 80 || val.length > 80) continue;
    out.push([key, /^random$/i.test(val) ? 'random' : /^auto$/i.test(val) ? 'auto' : val]);
  }
  return out.slice(0, 64);
}
function ruleMatches(key, agent) {
  const k = key.toLowerCase();
  if (k === '*') return true;
  const names = [agent && agent.id, agent && agent.type].filter((x) => x != null).map((x) => String(x).toLowerCase());
  if (agent && agent.isArchitect && k === 'architect') return true;
  if (k.charAt(k.length - 1) === '*') { const p = k.slice(0, -1); return names.some((n) => n.startsWith(p)); }
  return names.indexOf(k) >= 0;
}
/* agent + rules + the available character ids -> a character id. No rules at all: the first (the crab).
   `auto` (optional): agent -> { id, why } for the rules that say `auto`; without it `auto` is a stable pick like `random`. */
function chooseCharacter(rules, agent, ids, auto) {
  if (!ids.length) return null;
  const find = (v) => ids.find((x) => x.toLowerCase() === String(v).toLowerCase());
  if (!rules || !rules.length) return ids[0];
  for (const r of rules) {
    if (!ruleMatches(r[0], agent)) continue;
    if (r[1] === 'auto' && auto) { const a = auto(agent); if (a && a.id) return a.id; }
    if (r[1] === 'random' || r[1] === 'auto') break;
    return find(r[1]) || ids[0]; // a name nobody has (a pack not loaded): the crab
  }
  return ids[hash(agent && agent.id != null ? agent.id : '') % ids.length];
}

/* ---------------------------------------------------------------- roles and traits: `auto` */
// A character may declare traits (role words: "code", "explore", "docs", ...). An agent's role is read from its type, its task text and
// the verb it is doing; `auto` picks the character whose traits overlap the role most. Small, fixed tables: the same input gives the same
// pick everywhere (the mod's /crew characters has a twin of this in hooks/characters.ts, held to it by a test).
const TYPE_ROLES = [ // the first entry that matches the agent's type decides it
  [/plan|architect|advisor|design|strateg/, ['plan', 'architect', 'design', 'think', 'advisor']],
  [/explor|search|locat|scout|find|investig|research|survey/, ['explore', 'search', 'investigate', 'locate']],
  [/review|audit|critic|verif|inspect|lint/, ['review', 'investigate']],
  [/doc|writer|write|summar|readme|wiki|translat|scribe|changelog/, ['docs', 'write', 'summarize']],
  [/web|fetch|browse|crawl|scrape/, ['web', 'quick']],
  [/cod(e|er|ing)|implement|build|develop|\bdev\b|engineer|fix|debug|refactor|test|tdd|resolver/, ['code', 'build', 'fix', 'test', 'implement']],
  [/quick|fast|haiku|mini|lite/, ['quick']],
  [/general|purpose|orchestr|coordinat|manager|lead/, ['generalist', 'lead']],
];
const TEXT_ROLES = [ // every entry that matches the task text adds its words
  [/\b(implement\w*|code|coding|refactor\w*|build|compile|migrat\w*)\b|구현|코드/, ['code', 'build', 'implement']],
  [/\b(fix\w*|bugs?|debug\w*|patch\w*|repair\w*)\b|수정|버그/, ['fix', 'code']],
  [/\b(tests?|testing|specs?)\b|테스트/, ['test']],
  [/\b(run|execute|npm|script)\b|실행/, ['run']],
  [/\b(review\w*|audit\w*|critique|verify|check\w*)\b|리뷰|검토/, ['review']],
  [/\b(search\w*|find|locate|grep|look ?up|map|trace|survey)\b|검색|탐색|찾/, ['search', 'locate', 'explore']],
  [/\b(investigat\w*|analy[sz]\w*|research\w*|explor\w*|explain\w*)\b|조사|분석/, ['investigate', 'explore']],
  [/\b(docs?|document\w*|readme|write|writing|changelog|guide|translat\w*)\b|문서|작성/, ['docs', 'write']],
  [/\b(summari[sz]\w*|summary|tl;?dr)\b|요약/, ['summarize']],
  [/\b(web|fetch|url|https?|browse)\b/, ['web']],
  [/\b(plan\w*|design\w*|architect\w*|strategy|propose)\b|계획|설계/, ['plan', 'design']],
];
const VERB_ROLES = { edit: ['code', 'fix', 'implement'], run: ['run', 'build', 'test'], read: ['explore', 'search'], search: ['search', 'explore', 'locate'], web: ['web'], plan: ['plan', 'design'], think: ['think'], spawn: ['lead'] };
const W_TYPE = 3, W_TEXT = 1.2, W_VERB = 0.8, W_REPEAT = 0.75;

/* agent { id, type, description, verb, isArchitect } -> { word: weight } */
function roleOf(agent) {
  const w = {}, add = (words, k) => words.forEach((x) => { w[x] = (w[x] || 0) + k; });
  if (!agent) return w;
  const type = String(agent.type == null ? '' : agent.type).toLowerCase();
  if (agent.id === 'main' || type === 'main') add(['lead', 'main', 'generalist'], W_TYPE);
  if (agent.isArchitect) add(['architect', 'plan', 'design', 'think', 'advisor'], W_TYPE);
  for (const r of TYPE_ROLES) if (r[0].test(type)) { add(r[1], W_TYPE); break; }
  const text = String(agent.description == null ? '' : agent.description).toLowerCase().slice(0, 300);
  for (const r of TEXT_ROLES) if (r[0].test(text)) add(r[1], W_TEXT);
  if (VERB_ROLES[agent.verb]) add(VERB_ROLES[agent.verb], W_VERB);
  return w;
}
/* The best character for the role. chars: [{ id, traits: [word] }]; state.locks: Map agentId -> { id, why, parent } (the first pick
   of an agent stays, so a changing verb mix does not flip it). Siblings (same parent) that already took a character make it a
   little less attractive: equally good alternatives spread out. Ties: a stable hash of the agent id and the character id. */
function autoPick(chars, agent, state) {
  if (!chars || !chars.length) return null;
  const key = String(agent && agent.id), locks = state.locks;
  const had = locks.get(key);
  if (had && chars.some((c) => c.id === had.id)) return had;
  const role = roleOf(agent), parent = agent && agent.parentId != null ? String(agent.parentId) : '';
  const taken = {};
  locks.forEach((v, k) => { if (k !== key && v.parent === parent) taken[v.id] = (taken[v.id] || 0) + 1; });
  const rows = chars.map((c) => {
    const hit = (Array.isArray(c.traits) ? c.traits : []).filter((x) => role[x] > 0).sort((x, y) => role[y] - role[x]);
    return { c, hit, fit: hit.reduce((s, x) => s + role[x], 0) };
  });
  // a repeat costs a fifth of the best fit on offer (a flat bit when nobody fits): a lone good match is kept, a near one takes over
  const unit = Math.max(...rows.map((r) => r.fit)) > 0 ? 0.2 * Math.max(...rows.map((r) => r.fit)) : W_REPEAT;
  let best = null;
  for (const { c, hit, fit } of rows) {
    const score = fit - unit * (taken[c.id] || 0);
    const tie = hash(key + '|' + c.id);
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) <= 1e-9 && tie < best.tie)) best = { id: c.id, why: hit.slice(0, 3), score, tie };
  }
  const pick = { id: best.id, why: best.why, parent };
  locks.set(key, pick);
  return pick;
}

/* ---------------------------------------------------------------- voxel character check */
/* "traits": ["Code", "test", ...] -> lower-case words, at most 16 of 1-24 letters, digits, - _ */
function traitsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list) {
    const w = typeof x === 'string' ? x.trim().toLowerCase() : '';
    if (/^[a-z0-9_-]{1,24}$/.test(w) && out.indexOf(w) < 0) out.push(w);
    if (out.length >= 16) break;
  }
  return out;
}
const isNum = (x) => typeof x === 'number' && isFinite(x);
function vec(a, n, d, lim) {
  if (!Array.isArray(a) || a.length < n) return d.slice();
  const o = [];
  for (let i = 0; i < n; i++) o.push(isNum(a[i]) ? Math.max(-lim, Math.min(lim, a[i])) : d[i]);
  return o;
}
const swapLR = (n) => (/L\d?$/.test(n) ? n.replace(/L(\d?)$/, 'R$1') : /R\d?$/.test(n) ? n.replace(/R(\d?)$/, 'L$1') : n);
function box(b, warn, where) {
  if (!b || typeof b !== 'object') return null;
  const size = vec(b.size, 3, [1, 1, 1], LIMITS.size).map((x) => Math.max(0.01, Math.abs(x)));
  const color = typeof b.color === 'string' && (/^#[0-9a-f]{6}$/i.test(b.color) || b.color === '@base') ? b.color : null;
  if (!color) { warn.push(where + ': box without a #rrggbb color'); }
  const o = { size, at: vec(b.at, 3, [0, 0, 0], LIMITS.coord), color: color || '#cccccc' };
  if (Array.isArray(b.rot)) o.rot = vec(b.rot, 3, [0, 0, 0], 7);
  if (b.fixed === true || b.fixed === false) o.fixed = b.fixed;
  if (b.unlit === true) o.unlit = true;
  return o;
}
const mirrorBox = (b) => Object.assign({}, b, { at: [-b.at[0], b.at[1], b.at[2]], rot: b.rot ? [b.rot[0], -b.rot[1], -b.rot[2]] : undefined });
/* A pack's optional `food` (what its agent works on and eats): the id of a built-in food ("carrot"; FOOD_IDS), or boxes like a bone
   ({ boxes: [...] } or a bare list, on the same box rules, centred on 0, about 2 voxels long, the long side along x) -> { id } | { boxes } | null. */
function foodOf(f, warn) {
  if (typeof f === 'string') return FOOD_ID.test(f.toLowerCase()) && FOOD_IDS.indexOf(f.toLowerCase()) >= 0 ? { id: f.toLowerCase() } : null;
  const list = Array.isArray(f) ? f : f && typeof f === 'object' && Array.isArray(f.boxes) ? f.boxes : null;
  if (!list) return null;
  const boxes = [];
  for (const bx of list.slice(0, LIMITS.food)) { const nb = box(bx, warn, 'food'); if (nb) boxes.push(nb); }
  return boxes.length ? { boxes } : null;
}
/* A voxel character as JSON -> a checked copy (every number finite and bounded, `mirror` expanded), or null.
   { id, name, scale?, base?, bones: { <rig name>: { parent?, at, rot?, gait?, mirror?, boxes } }, eyes?, props?, hit?, shadow?, travel? } */
function normalizeDef(def) {
  const warn = [];
  if (!def || typeof def !== 'object' || !def.bones || typeof def.bones !== 'object') return { def: null, warnings: ['no "bones" object'] };
  if (typeof def.id !== 'string' || !CHAR_ID.test(def.id)) return { def: null, warnings: ['"id" must be 1-40 letters, digits, . _ -'] };
  const out = { id: def.id, name: typeof def.name === 'string' && def.name ? def.name.slice(0, 60) : def.id, scale: isNum(def.scale) ? Math.max(0.2, Math.min(4, def.scale)) : 1, bones: {}, eyes: {} };
  if (def.base && typeof def.base === 'object' && isNum(def.base.h)) {
    out.base = { h: def.base.h, s: isNum(def.base.s) ? Math.max(0, Math.min(1, def.base.s)) : 0.6, l: isNum(def.base.l) ? Math.max(0, Math.min(1, def.base.l)) : 0.55, spread: isNum(def.base.spread) ? Math.max(0, Math.min(60, Math.round(def.base.spread))) : 0 };
  }
  if (isNum(def.travel)) out.travel = Math.max(0, Math.min(3, def.travel));
  out.traits = traitsOf(def.traits);
  let total = 0;
  const take = (name, src, mirrored) => {
    const parent = typeof src.parent === 'string' && RIG.indexOf(src.parent) >= 0 ? (mirrored ? swapLR(src.parent) : src.parent) : null;
    const b = { parent, at: vec(src.at, 3, [0, 0, 0], LIMITS.coord), boxes: [] };
    if (Array.isArray(src.rot)) b.rot = vec(src.rot, 3, [0, 0, 0], 7);
    if (isNum(src.gait)) b.gait = Math.max(0, Math.min(3, Math.round(src.gait)));
    for (const bx of Array.isArray(src.boxes) ? src.boxes : []) {
      if (total >= LIMITS.boxes) { warn.push('more than ' + LIMITS.boxes + ' boxes: the rest are ignored'); break; }
      const nb = box(bx, warn, name);
      if (nb) { b.boxes.push(nb); total++; }
    }
    return b;
  };
  for (const name of Object.keys(def.bones)) {
    if (RIG.indexOf(name) < 0) { warn.push('"' + name + '" is not a rig bone (skipped)'); continue; }
    const src = def.bones[name];
    if (!src || typeof src !== 'object') continue;
    if (typeof src.mirror === 'string') continue; // second pass
    out.bones[name] = take(name, src, false);
  }
  for (const name of Object.keys(def.bones)) {
    const src = def.bones[name];
    if (RIG.indexOf(name) < 0 || !src || typeof src.mirror !== 'string') continue;
    const from = out.bones[src.mirror];
    if (!from) { warn.push('"' + name + '" mirrors "' + src.mirror + '", which is not defined'); continue; }
    out.bones[name] = {
      parent: from.parent ? swapLR(from.parent) : null, at: [-from.at[0], from.at[1], from.at[2]],
      rot: from.rot ? [from.rot[0], -from.rot[1], -from.rot[2]] : undefined, gait: isNum(src.gait) ? Math.max(0, Math.min(3, Math.round(src.gait))) : from.gait,
      boxes: from.boxes.map(mirrorBox),
    };
  }
  if (!out.bones.body) out.bones.body = { parent: null, at: [0, 0, 0], boxes: [] };
  if (def.eyes && typeof def.eyes === 'object') {
    for (const v of EYE_VARIANTS) {
      if (!Array.isArray(def.eyes[v])) continue;
      const list = [];
      for (const bx of def.eyes[v].slice(0, 12)) { const nb = box(bx, warn, 'eyes.' + v); if (nb) list.push(nb); }
      if (list.length) out.eyes[v] = list;
    }
  }
  const p = def.props;
  if (p && typeof p === 'object') {
    out.props = {};
    ['page', 'hat'].forEach((k) => { if (p[k] && typeof p[k] === 'object') out.props[k] = { at: vec(p[k].at, 3, [0, 0, 0], LIMITS.coord), s: isNum(p[k].s) ? Math.max(0.2, Math.min(4, p[k].s)) : 1 }; });
    if (p.anten && typeof p.anten === 'object') out.props.anten = { at: vec(p.anten.at, 3, [0, 0, 0], LIMITS.coord), spread: isNum(p.anten.spread) ? Math.max(0.2, Math.min(20, p.anten.spread)) : 1.5 };
  }
  if (def.food != null) { const fd = foodOf(def.food, warn); if (fd) out.food = fd; else warn.push('"food" must be a built-in food id or a list of boxes (ignored)'); }
  if (def.hit && typeof def.hit === 'object') out.hit = { y: isNum(def.hit.y) ? Math.max(0, Math.min(40, def.hit.y)) : null, r: isNum(def.hit.r) ? Math.max(0.3, Math.min(3, def.hit.r)) : null };
  if (Array.isArray(def.shadow) && def.shadow.length >= 2) out.shadow = vec(def.shadow, 2, [8.5, 6.5], 40);
  return { def: out, warnings: warn };
}

/* ---------------------------------------------------------------- pack problems
   Everything that is wrong or missing in a user's pack, as { level: 'error' | 'warn', code, text, fix }: an error means the character is
   not drawn as the pack meant (a crab, or nothing), a warning means it works but misses something. The mod's scan (hooks/characters.ts has a
   twin of this table and of lintVoxel, held to it by a test) writes them next to each pack in characters-user.js; what only the page can see
   (a GLB that failed to load, its bone names) comes from glbProblems(). `detail` is a short extra for the text (a name, a reason). */
const list = (a) => a.slice(0, 4).map((x) => '"' + x + '"').join(', ') + (a.length > 4 ? ' and ' + (a.length - 4) + ' more' : '');
const PROBLEM_TABLE = {
  // errors
  'unreadable': ['error', () => 'The file could not be read.', () => 'Check that it exists and is not locked by another program, then rescan.'],
  'bad-json': ['error', (d) => 'Not valid JSON' + (d ? ' (' + d + ')' : '') + ', so it is skipped.', () => 'Fix the syntax (a trailing comma or a missing quote is the usual cause) and rescan.'],
  'too-big': ['error', (d) => 'Too big (' + (d || 'over 512 KiB') + '), so it is skipped.', () => 'Use fewer boxes: a pack is meant to be small, up to ' + LIMITS.boxes + ' boxes.'],
  'no-bones': ['error', () => 'There is no "bones" object, so nothing can be drawn.', () => 'Add "bones": { "body": { "boxes": [ { "size": [5,3,4], "at": [0,2,0], "color": "#88aaff" } ] } }.'],
  'nothing-drawn': ['error', () => 'No box is left to draw, so the character is invisible.', () => 'Give "body" (or another bone) at least one box: { "size": [w,h,d], "at": [x,y,z], "color": "#rrggbb" }.'],
  'food-bad': ['error', () => '"food" is not a built-in food or a list of boxes, so it eats the seed.', () => 'Use one of ' + FOOD_IDS.join(', ') + ', or boxes: "food": { "boxes": [ ... ] }.'],
  'glb-failed': ['error', (d) => 'The model could not be loaded' + (d ? ' (' + d + ')' : '') + ', so a crab is drawn instead.', () => 'Export it again as a plain glTF binary (.glb) without Draco, Meshopt or KTX2 compression, then rescan.'],
  'glb-too-big': ['error', () => 'The model is over 4 MiB and this page cannot read it from the folder, so a crab is drawn instead.', () => 'Make it smaller than 4 MiB (fewer polygons, smaller textures), or use the desktop pet (/crew pet), which can read it.'],
  'glb-empty': ['error', () => 'The model has no geometry, so a crab is drawn instead.', () => 'Export the meshes together with the skeleton, not the armature alone.'],
  // warnings
  'food-none': ['warn', () => 'No "food", so it eats the seed.', () => 'Add "food": "seed" (or fish, carrot, treat, battery, ticket), or a list of boxes.'],
  'no-hands': ['warn', (d) => 'No handL / handR ' + (d === 'glb' ? 'nodes' : 'bones') + ', so items are held at the arm.', (d) => (d === 'glb' ? 'Name the hand nodes handL and handR (Blender: Hand.L, Hand.R).' : 'Add "handL": { "parent": "armL", ... } and "handR": { "mirror": "handL" }.')],
  'no-mouth': ['warn', (d) => 'No mouth ' + (d === 'glb' ? 'node' : 'bone') + ', so it eats at the head.', (d) => (d === 'glb' ? 'Name a node on the face "mouth".' : 'Add a "mouth" bone (parent "head") with a small box on the face.')],
  'no-traits': ['warn', () => 'No "traits", so auto never picks it by role.', () => 'Add "traits": ["code", "test"]; README.txt in the characters folder lists the words that count.'],
  'bone-unknown': ['warn', (d) => (/,| and /.test(d) ? d + ' are not rig bones, so they are skipped.' : d + ' is not a rig bone, so it is skipped.'), () => 'Rename it to a rig bone (' + RIG.join(' ') + ') or remove it.'],
  'mirror-missing': ['warn', (d) => (/,| and /.test(d) ? d + ' mirror bones that are not defined, so they are skipped.' : d + ' mirrors a bone that is not defined, so it is skipped.'), () => 'Define the bone it mirrors, or give this one boxes of its own.'],
  'box-color': ['warn', (d) => d + ' no #rrggbb color and ' + (/^1 /.test(d) ? 'is' : 'are') + ' drawn light grey.', () => 'Give each box "color": "#rrggbb" (or "@base" for the body color).'],
  'box-limit': ['warn', () => 'More than ' + LIMITS.boxes + ' boxes, so the rest are ignored.', () => 'Merge boxes or make them bigger; ' + LIMITS.boxes + ' is the limit.'],
  'glb-large': ['warn', () => 'Over 4 MiB: the mod does not embed it, so the pet reads it from the folder and a browser may refuse.', () => 'Make it smaller than 4 MiB to work everywhere.'],
  'glb-unread': ['warn', () => 'The mod could not read the file, so the page will try the folder itself.', () => 'Check that it is not locked by another program, then rescan.'],
  'glb-no-rig': ['warn', () => 'No node is named like a rig bone, so only the whole model moves.', () => 'Name the nodes head, armL, handL, legL1 and so on (case and _ . - are ignored).'],
};
const PACK_CODES = Object.keys(PROBLEM_TABLE);
function problem(code, detail) {
  const t = PROBLEM_TABLE[code];
  return { level: t[0], code, text: t[1](detail), fix: t[2](detail) };
}
/* worst first (errors, then warnings); the order inside a level stays */
const sortProblems = (l) => l.filter((p) => p.level === 'error').concat(l.filter((p) => p.level !== 'error'));
const statusOf = (l) => (l.some((p) => p.level === 'error') ? 'error' : l.length ? 'warn' : 'ok');
const colorOk = (c) => typeof c === 'string' && (/^#[0-9a-f]{6}$/i.test(c) || c === '@base');

/* A voxel pack as parsed JSON -> its problems. It follows normalizeDef step by step (same loops, same limits), so what it reports is what
   normalizeDef drops or fills in. */
function lintVoxel(def) {
  if (!def || typeof def !== 'object' || !def.bones || typeof def.bones !== 'object') return [problem('no-bones')];
  const errors = [], warns = [], unknown = [], missing = [], defined = {};
  let total = 0, over = false, drawn = 0, grey = 0;
  const lintBox = (b) => { if (!b || typeof b !== 'object') return false; if (!colorOk(b.color)) grey++; return true; };
  for (const name of Object.keys(def.bones)) {
    if (RIG.indexOf(name) < 0) { unknown.push(name); continue; }
    const src = def.bones[name];
    if (!src || typeof src !== 'object' || typeof src.mirror === 'string') continue;
    let n = 0;
    for (const bx of Array.isArray(src.boxes) ? src.boxes : []) {
      if (total >= LIMITS.boxes) { over = true; break; }
      if (lintBox(bx)) { total++; n++; }
    }
    defined[name] = n; drawn += n;
  }
  for (const name of Object.keys(def.bones)) {
    const src = def.bones[name];
    if (RIG.indexOf(name) < 0 || !src || typeof src.mirror !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(defined, src.mirror)) { missing.push(name); continue; }
    defined[name] = defined[src.mirror]; drawn += defined[name];
  }
  for (const v of EYE_VARIANTS) {
    if (!def.eyes || typeof def.eyes !== 'object' || !Array.isArray(def.eyes[v])) continue;
    def.eyes[v].slice(0, 12).forEach(lintBox);
  }
  let food = 'none';
  if (def.food != null) {
    food = 'bad';
    if (typeof def.food === 'string') { if (FOOD_ID.test(def.food.toLowerCase()) && FOOD_IDS.indexOf(def.food.toLowerCase()) >= 0) food = 'ok'; }
    else {
      const fl = Array.isArray(def.food) ? def.food : typeof def.food === 'object' && Array.isArray(def.food.boxes) ? def.food.boxes : null;
      if (fl) { let n = 0; fl.slice(0, LIMITS.food).forEach((bx) => { if (lintBox(bx)) n++; }); if (n) food = 'ok'; }
    }
  }
  if (drawn === 0) errors.push(problem('nothing-drawn'));
  if (food === 'bad') errors.push(problem('food-bad'));
  if (unknown.length) warns.push(problem('bone-unknown', list(unknown)));
  if (missing.length) warns.push(problem('mirror-missing', list(missing)));
  if (grey) warns.push(problem('box-color', grey + (grey === 1 ? ' box has' : ' boxes have')));
  if (over) warns.push(problem('box-limit'));
  if (food === 'none') warns.push(problem('food-none'));
  if (defined.handL == null && defined.handR == null) warns.push(problem('no-hands'));
  if (defined.mouth == null) warns.push(problem('no-mouth'));
  if (!traitsOf(def.traits).length) warns.push(problem('no-traits'));
  return errors.concat(warns);
}

/* The badge over a character with problems: { level: 'error' | 'warn', n } or null. `hideWarn`: a list of warnings only gets none
   (the pet setting show.packWarnings off); an error always shows. */
function badgeOf(list, hideWarn) {
  if (!list || !list.length) return null;
  const level = statusOf(list);
  return level === 'error' || !hideWarn ? { level, n: list.length } : null;
}
/* What a hover card shows of a list: the first `max` problems, worst first, and how many are left. */
function cardLines(list, max) {
  const l = sortProblems(list || []), m = max == null ? 3 : max;
  return { lines: l.slice(0, m), more: Math.max(0, l.length - m) };
}

/* What only the page knows about a GLB: info { error?: the load error (a string), big?: it is over the mod's 4 MiB, so it was read from the
   folder, empty?: no geometry, names?: the node names of the loaded model } -> problems. */
function glbProblems(info) {
  const i = info || {};
  // the loader tries the file as JSON text when it does not start with the glTF magic: its own words would only confuse
  const why = (e) => (/JSON|Unexpected token/i.test(e) ? 'not a glTF binary file' : e.slice(0, 80));
  if (i.error) return [problem(i.big ? 'glb-too-big' : 'glb-failed', i.big ? '' : why(String(i.error)))];
  if (i.empty) return [problem('glb-empty')];
  if (!Array.isArray(i.names)) return [];
  const got = matchRig(i.names).bones, out = [];
  if (!Object.keys(got).length) return [problem('glb-no-rig')];
  if (!got.handL && !got.handR) out.push(problem('no-hands', 'glb'));
  if (!got.mouth) out.push(problem('no-mouth', 'glb'));
  return out;
}

return { RIG, EYE_VARIANTS, CHAR_ID, FOOD_IDS, DEFAULT_FOOD, PACK_CODES, problem, lintVoxel, glbProblems, sortProblems, statusOf, badgeOf, cardLines, hash, normName, rigOf, matchRig, parseRules, ruleMatches, chooseCharacter, roleOf, autoPick, traitsOf, normalizeDef, swapLR };
});
