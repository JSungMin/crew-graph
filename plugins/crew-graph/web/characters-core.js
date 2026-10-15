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
const LIMITS = { boxes: 400, coord: 80, size: 80 };

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
function parseRules(spec) {
  const out = [];
  if (typeof spec !== 'string') return out;
  for (const part of spec.split(/[,;\n]+/)) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim(), val = part.slice(i + 1).trim();
    if (!key || !val || key.length > 80 || val.length > 80) continue;
    out.push([key, /^(random|auto)$/i.test(val) ? 'random' : val]);
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
/* agent + rules + the available character ids -> a character id. No rules at all: the first (the crab). */
function chooseCharacter(rules, agent, ids) {
  if (!ids.length) return null;
  const find = (v) => ids.find((x) => x.toLowerCase() === String(v).toLowerCase());
  if (!rules || !rules.length) return ids[0];
  for (const r of rules) {
    if (!ruleMatches(r[0], agent)) continue;
    if (r[1] === 'random') break;
    return find(r[1]) || ids[0]; // a name nobody has (a pack not loaded): the crab
  }
  return ids[hash(agent && agent.id != null ? agent.id : '') % ids.length];
}

/* ---------------------------------------------------------------- voxel character check */
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
  if (def.hit && typeof def.hit === 'object') out.hit = { y: isNum(def.hit.y) ? Math.max(0, Math.min(40, def.hit.y)) : null, r: isNum(def.hit.r) ? Math.max(0.3, Math.min(3, def.hit.r)) : null };
  if (Array.isArray(def.shadow) && def.shadow.length >= 2) out.shadow = vec(def.shadow, 2, [8.5, 6.5], 40);
  return { def: out, warnings: warn };
}

return { RIG, EYE_VARIANTS, CHAR_ID, hash, normName, rigOf, matchRig, parseRules, ruleMatches, chooseCharacter, normalizeDef, swapLR };
});
