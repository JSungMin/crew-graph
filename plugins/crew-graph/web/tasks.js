/* crew-graph tasks: the agents' to-do items as little voxel "food" the characters work on and eat.
   A classic script (a module would be blocked on file://) that sets window.CrewTasks; the tests require() it.
   The pure parts (cleaning the snapshot's `tasks`, diffing two snapshots, where things sit) have no THREE in them;
   create(api) builds the 3D part, and app.js hands it everything it needs, so this file reaches for no global but THREE through api.T.

   What it shows (docs/DATA_CONTRACT.md, `tasks` and `eaten`):
   - pending:      a small stack on a plate beside the owner (five at most, then a "+N" chip); an unowned task sits on a shared table by main
   - in_progress:  the owner holds it at its hand and works on it (a motion per character, only while the verb leaves the arms free)
   - completed:    it is brought to the mouth, three chomps while it shrinks, crumbs, happy eyes, a hop; then the owner's "✓ N" counts it
   - an agent ticket: the child carries it along its link tube to its parent, who eats it
   - failed:       grey, and the owner sighs.  deleted: a puff of smoke.  blocked: a little lock on it, and the owner taps its foot
   Only changes seen live are played: the first snapshot after a start or a reset is the baseline, so a reload does not replay old eats. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewTasks = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const STATUS = { pending: 1, in_progress: 1, completed: 1, failed: 1, deleted: 1 };
const isOpen = (s) => s === 'pending' || s === 'in_progress';
const MAX_LIST = 80, SHOWN = 5;
/* the eat, in seconds: grab the item off the plate and lift it to the mouth, three chomps, a swallow (2.3 s in all). Eats of one eater go one after another. */
const EAT = { grab: 0.55, chomp: 0.42, chomps: 3, total: 2.3, gap: 0.25, pop: 1.5, last: 0.7, minPx: 14 };
const CARRY_MIN = 0.6, CARRY_MAX = 1.6;
const FOOD_SCALE = 1.4; // food against the character: the pet window is small, a food at the crab's own scale reads as a speck

/* ---------------------------------------------------------------- pure: the data */
/* anything -> a list of tasks the page can trust (what is wrong is dropped, texts are bounded) */
function cleanList(raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const d of raw) {
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || !STATUS[d.status]) continue;
    out.push({
      id: d.id.slice(0, 200),
      src: d.src === 'task' || d.src === 'agent' || d.src === 'turn' ? d.src : 'todo',
      owner: typeof d.owner === 'string' && d.owner ? d.owner.slice(0, 200) : null,
      title: typeof d.title === 'string' ? d.title.slice(0, 200) : '',
      active: typeof d.active === 'string' ? d.active.slice(0, 200) : '',
      status: d.status,
      blockedBy: Array.isArray(d.blockedBy) ? d.blockedBy.filter((x) => typeof x === 'string').slice(0, 20) : [],
      deliverTo: typeof d.deliverTo === 'string' && d.deliverTo ? d.deliverTo.slice(0, 200) : null,
      t: Number.isFinite(+d.t) ? +d.t : 0,
    });
    if (out.length >= MAX_LIST) break;
  }
  return out;
}
/* the ids of the tasks that wait for an open one */
function blockedIds(list) {
  const open = new Set(list.filter((d) => isOpen(d.status)).map((d) => d.id)), out = new Set();
  for (const d of list) if (isOpen(d.status) && d.blockedBy.some((x) => open.has(x))) out.add(d.id);
  return out;
}
/* prev: Map id -> the last status seen for every id of this session; list: cleanList(); first: this is the baseline (nothing is played).
   -> [{ k, d, isNew }]; k: 'rest' (baseline: an open or failed item just is there), 'show' (a new open item), 'start' (taken in hand),
   'back' (put back on the plate), 'eat', 'fail', 'poof' */
function diff(prev, list, first) {
  const ev = [];
  for (const d of list) {
    const was = prev.get(d.id);
    if (first) { if (d.status !== 'completed' && d.status !== 'deleted') ev.push({ k: 'rest', d }); continue; }
    if (was === undefined) {
      ev.push({ k: d.status === 'completed' ? 'eat' : d.status === 'failed' ? 'fail' : d.status === 'deleted' ? 'poof' : 'show', d, isNew: true });
      if (d.status === 'in_progress') ev.push({ k: 'start', d, isNew: true });
    } else if (was !== d.status) {
      ev.push({ k: d.status === 'completed' ? 'eat' : d.status === 'failed' ? 'fail' : d.status === 'deleted' ? 'poof' : d.status === 'in_progress' ? 'start' : 'back', d });
    }
  }
  return ev;
}
/* who works on it and who eats it: an agent id from the snapshot, else main, else nobody */
function agentFor(id, has, mainId) { return id != null && has(id) ? id : has(mainId) ? mainId : null; }
const eaterId = (d) => d.deliverTo || d.owner || 'main';
/* Eats of one eater are queued: when `free` is the time its last scheduled eat ends, an eat of `dur` seconds asked for at `now` starts at
   -> { at, free } (the new free time, with a short gap so two eats do not run together). */
function eatSlot(free, now, dur) {
  const at = Math.max(now, free || 0);
  return { at, free: at + dur + EAT.gap };
}
/* How much bigger than its resting size an item held or eaten must be to stand `minPx` tall on screen. `hm`: its height in voxels (see foodHeight),
   `base`: the world size of one voxel of it, `pxw`: pixels per world unit where it is. Never smaller than 1, never more than 4. */
function boostFor(hm, base, pxw, minPx) {
  const px = hm * base * pxw;
  return px >= minPx || !(px > 0) ? 1 : Math.min(4, minPx / px);
}
/* the height an item shows, in voxels: its box, or the length of a long thing lying on its side */
function foodHeight(boxes) {
  let y0 = 1e9, y1 = -1e9, x0 = 1e9, x1 = -1e9;
  for (const b of boxes) { y0 = Math.min(y0, b.at[1] - b.size[1] / 2); y1 = Math.max(y1, b.at[1] + b.size[1] / 2); x0 = Math.min(x0, b.at[0] - b.size[0] / 2); x1 = Math.max(x1, b.at[0] + b.size[0] / 2); }
  return boxes.length ? Math.max(y1 - y0, 0.55 * (x1 - x0)) : 1;
}
/* the size of the item (1 = as it came off the plate) at `t` seconds into the part of the eat that starts when it reaches the mouth:
   grows to EAT.pop on the way up, each chomp takes a bit (down to EAT.last of that), the swallow takes the rest */
function eatSize(t) {
  const G = EAT.grab, C = EAT.chomp * EAT.chomps;
  if (t < 0) return 1;
  if (t < G) { const u = t / G; return 1 + (EAT.pop - 1) * (u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u)); }
  if (t < G + C) { const f = (t - G) / C; return EAT.pop * (1 - f * (1 - EAT.last)); }
  const tail = EAT.total - G - C, u = (t - G - C) / tail;
  return u < 0.3 ? EAT.pop * EAT.last * (1 - u / 0.3) + 0.0005 : 0.0005;
}
/* a stack of flat things on a plate: the i-th from the bottom (x, z: a little off true, ry: a little turned) */
function stackSlot(i, id) {
  const h = hash(id + '#' + i);
  return { x: ((h % 7) - 3) * 0.09, z: (((h >> 3) % 7) - 3) * 0.09, ry: (((h >> 6) % 9) - 4) * 0.07, y: i * 0.6 };
}
/* the i-th place on the shared table: two rows of three */
const tableSlot = (i) => ({ x: ((i % 3) - 1) * 2.1, z: (Math.floor(i / 3) - 0.5) * 1.9 });
function hash(s) { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const clipText = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const STATUS_WORD = { pending: 'waiting', in_progress: 'in progress', completed: 'done', failed: 'failed', deleted: 'deleted' };
/* the lines of the hover card: [[text, kind]]; kind 'b' bold, 's' normal, 'p' pale */
function cardLines(d, ownerName, blocked) {
  const out = [[clipText(d.title || '(untitled)', 90), 'b']];
  out.push([STATUS_WORD[d.status] + (blocked ? ' · blocked' : '') + (d.src === 'agent' ? ' · subagent' : d.src === 'task' ? ' · task' : d.src === 'turn' ? ' · prompt' : ' · to-do'), 's']);
  if (ownerName) out.push([(d.src === 'agent' ? 'agent: ' : 'owner: ') + ownerName, 'p']); else out.push(['nobody has taken it', 'p']);
  if (d.deliverTo && d.src === 'agent') out.push(['hands it to ' + d.deliverTo, 'p']);
  if (d.active && d.status === 'in_progress') out.push(['now: ' + clipText(d.active, 80), 'p']);
  return out;
}

/* ---------------------------------------------------------------- pure: the food */
// Boxes in voxels of the crab (7 wide), centred on 0, the long side along x, facing +z; about 2.5 long. `crumb`: the colour of what flies off.
const bx = (w, h, d, x, y, z, color) => ({ size: [w, h, d], at: [x, y, z], color });
const FOODS = {
  fish: { crumb: '#9ec7e6', boxes: [bx(2.2, 1.0, 0.6, 0, 0, 0, '#86b8dc'), bx(1.8, 0.34, 0.62, 0.05, -0.32, 0, '#dcecf7'), bx(0.55, 1.1, 0.4, 1.35, 0, 0, '#6aa0c8'),
    bx(0.35, 0.5, 0.4, 1.7, 0.55, 0, '#6aa0c8'), bx(0.35, 0.5, 0.4, 1.7, -0.55, 0, '#6aa0c8'), bx(0.7, 0.4, 0.4, 0.1, 0.68, 0, '#6aa0c8'), bx(0.22, 0.22, 0.64, -0.75, 0.18, 0, '#1b1410')] },
  carrot: { crumb: '#ffa45e', boxes: [bx(1.0, 0.95, 0.95, -0.55, 0, 0, '#ff8f3f'), bx(1.0, 0.72, 0.72, 0.4, 0, 0, '#ff8f3f'), bx(0.8, 0.46, 0.46, 1.2, 0, 0, '#f27f2c'), bx(0.4, 0.24, 0.24, 1.7, 0, 0, '#f27f2c'),
    bx(0.12, 0.8, 0.98, -0.1, 0, 0, '#e5742a'), bx(0.9, 0.3, 0.3, -1.4, 0.32, 0, '#58c26a'), bx(0.9, 0.3, 0.3, -1.4, -0.3, 0.08, '#4cb15d'), bx(1.1, 0.26, 0.26, -1.5, 0, 0.1, '#6bd47b')] },
  treat: { crumb: '#ffcf8a', boxes: [bx(2.5, 0.5, 0.5, 0, 0, 0, '#ecd6a4'), bx(0.5, 0.56, 0.56, 0.3, 0, 0, '#e8575c'), bx(0.55, 0.62, 0.62, -1.3, 0, 0, '#ffb46a'), bx(0.3, 0.42, 0.42, -1.7, 0, 0, '#ffd08a'), bx(0.2, 0.56, 0.56, 1.1, 0, 0, '#e8575c')] },
  seed: { crumb: '#d9d6cc', boxes: [bx(1.5, 0.95, 0.5, 0, 0, 0, '#34343a'), bx(1.3, 0.18, 0.52, 0, 0.26, 0, '#ece9df'), bx(1.3, 0.18, 0.52, 0, -0.26, 0, '#ece9df'), bx(0.45, 0.55, 0.48, 0.95, 0, 0, '#34343a'), bx(0.3, 0.3, 0.46, 1.25, 0, 0, '#34343a')] },
  battery: { crumb: '#9bf0b6', boxes: [bx(2.0, 1.1, 0.9, 0, 0, 0, '#5d6877'), bx(0.5, 1.14, 0.94, 0.4, 0, 0, '#5ee08a'), bx(0.35, 0.5, 0.5, 1.2, 0, 0, '#c9ced6'), bx(0.6, 0.2, 0.96, -0.5, 0.2, 0, '#ffd166')] },
  ticket: { crumb: '#f4f1e8', boxes: [bx(2.4, 1.4, 0.12, 0, 0, 0, '#f4f1e8'), bx(0.4, 1.4, 0.14, -1.0, 0, 0, '#7ee0ff'), bx(1.2, 0.12, 0.14, 0.35, 0.35, 0, '#59506b'), bx(1.0, 0.12, 0.14, 0.25, 0, 0, '#59506b'), bx(1.3, 0.12, 0.14, 0.4, -0.35, 0, '#59506b')] },
};
/* a prompt turn (src 'turn', proxy food when the model has no task tools): main eats each of the user's prompts as a rice ball, whoever main is */
const TURN_FOOD = { key: 'riceball', crumb: '#f7f5ee', boxes: [bx(1.7, 1.3, 0.95, 0, -0.1, 0, '#f7f5ee'), bx(1.1, 0.7, 0.95, 0, 0.85, 0, '#f7f5ee'), bx(1.8, 0.55, 1.0, 0, -0.55, 0, '#1f2a24'), bx(0.25, 0.2, 1.0, -0.4, 0.2, 0, '#e3dfd2')] };
const BUILTIN_FOOD = { crab: 'fish', bunny: 'carrot', cat: 'treat', mochi: 'seed', robot: 'battery' };
// what each built-in does with its food while it works; any other character just fidgets
const MOTION_OF = { crab: 'snip', bunny: 'nibble', cat: 'paw', mochi: 'roll', robot: 'hammer' };
/* the food a character gets: its pack's own (a built-in id or boxes), else the built-in's, else the sunflower seed for a user's pack (a GLB
   has no food of its own); a paper ticket only when nobody holds it (no character) or `setting` says so: 'character' | 'ticket'
   -> { key, boxes, crumb }. `src`: the task's source; a prompt turn ('turn') is a rice ball (the paper ticket setting still wins). */
function foodFor(charId, def, setting, src) {
  if (setting === 'ticket') return { key: 'ticket', boxes: FOODS.ticket.boxes, crumb: FOODS.ticket.crumb };
  if (src === 'turn') return { key: TURN_FOOD.key, boxes: TURN_FOOD.boxes, crumb: TURN_FOOD.crumb };
  const f = def && def.food;
  if (f && f.boxes && f.boxes.length) return { key: 'own:' + charId, boxes: f.boxes, crumb: f.boxes[0].color === '@base' ? '#dddddd' : f.boxes[0].color };
  if (f && f.id && FOODS[f.id]) return { key: f.id, boxes: FOODS[f.id].boxes, crumb: FOODS[f.id].crumb };
  const id = BUILTIN_FOOD[charId] || (charId ? 'seed' : 'ticket');
  return { key: id, boxes: FOODS[id].boxes, crumb: FOODS[id].crumb };
}

/* ---------------------------------------------------------------- demo data (?demo, ?demo=tasks)
   h: { agents(): the demo's agent list, dAgent, dEv, dVerb, dA: the demo's own helpers in app.js }.
   -> { script: the ?demo=tasks scenario [[seconds, fn]], steps: to-do list entries for the default demo's script, reset(), tasks(), eaten() }.
   The tasks are written as the mod lists them (docs/DATA_CONTRACT.md); the subagent tickets come from the demo's agents, as the mod makes them. */
function demo(h) {
  const D = { tk: [], eaten: {}, cycle: 0 };
  const tid = (n) => 'c' + D.cycle + ':' + n;
  const add = (n, src, owner, title, status, extra) => { D.tk.push(Object.assign({ id: tid(n), src, owner: owner || undefined, title, status, t: Date.now() }, extra || {})); };
  const get = (n) => D.tk.find((x) => x.id === tid(n));
  const set = (n, status, extra) => {
    const x = get(n); if (!x) return;
    if (x.status !== status) x.t = Date.now();
    x.status = status; Object.assign(x, extra || {});
    if (status === 'completed') { const e = x.owner || 'main'; D.eaten[e] = (D.eaten[e] || 0) + 1; }
  };
  const drop = (n) => { D.tk = D.tk.filter((x) => x.id !== tid(n)); };
  const tickets = () => h.agents().filter((a) => a.id !== 'main' && !a.isArchitect).map((a) => ({ id: 'agent:' + a.id, src: 'agent', owner: a.id, title: a.description,
    status: a.status === 'completed' ? 'completed' : a.status === 'failed' || a.status === 'killed' ? 'failed' : 'in_progress', deliverTo: a.parentId || 'main', t: a.endedAt || a.startedAt }));
  const AGENTS = [['a1', 'Explore', 'map the loader'], ['a2', 'sonnet-coder', 'implement the fix'], ['a3', 'doc-writer', 'update the docs'], ['a4', 'Plan', 'plan the release']];
  // ?demo=tasks: every character with its own food; to-do items go pending -> in progress -> eaten, a ticket is carried to its parent, one task is blocked, one fails, one is deleted
  const script = [
    [0.1, () => { h.dEv('prompt', 'main', null, null, 'Fix the loader and ship the release'); h.dVerb('main', 'wait', ''); AGENTS.forEach((x) => { h.dAgent(x[0], 'main', x[1], x[2], 'wait', ''); h.dEv('spawn', 'main', x[0], 'Agent', 'spawn ' + x[1]); }); }],
    [0.4, () => { add('m1', 'todo', 'main', 'Read the loader', 'pending'); add('m2', 'todo', 'main', 'Fix the loader', 'pending'); add('m3', 'todo', 'main', 'Update the docs', 'pending'); add('m4', 'todo', 'main', 'Run the tests', 'pending'); }],
    [1.0, () => {
      add('c1', 'todo', 'a1', 'Grep the callers', 'pending'); add('c2', 'todo', 'a1', 'Trace the loader', 'pending');
      add('r1', 'todo', 'a2', 'Patch the loader', 'pending'); add('r2', 'todo', 'a2', 'Add a test', 'pending');
      add('b1', 'todo', 'a3', 'Draft the guide', 'pending'); add('b2', 'todo', 'a3', 'Translate the guide', 'pending');
      add('s1', 'todo', 'a4', 'Outline the release', 'pending'); add('s2', 'todo', 'a4', 'Write the changelog', 'pending');
    }],
    [2.0, () => set('m1', 'in_progress', { active: 'Reading the loader' })],
    [2.4, () => set('c1', 'in_progress', { active: 'Grepping the callers' })],
    [2.6, () => set('r1', 'in_progress', { active: 'Patching the loader' })],
    [2.8, () => set('b1', 'in_progress', { active: 'Drafting the guide' })],
    [3.0, () => set('s1', 'in_progress', { active: 'Outlining the release' })],
    [6.0, () => set('m1', 'completed')],
    [6.4, () => set('m2', 'in_progress', { active: 'Fixing the loader' })],
    [7.5, () => { set('c1', 'completed'); set('c2', 'in_progress', { active: 'Tracing the loader' }); }],
    [8.5, () => { set('r1', 'completed'); set('r2', 'in_progress', { active: 'Adding a test' }); }],
    [9.0, () => { set('b1', 'completed'); set('b2', 'in_progress', { active: 'Translating the guide' }); }],
    [9.5, () => { set('s1', 'completed'); set('s2', 'in_progress', { active: 'Writing the changelog' }); }],
    [11.0, () => { add('t1', 'task', null, 'Review the release notes', 'pending'); add('t2', 'task', null, 'Tag the release', 'pending', { blockedBy: [tid('t1')] }); }],
    [4.6, () => add('q1', 'turn', 'main', 'Fix the loader and ship the release', 'in_progress', { active: 'working on your prompt' })],
    [11.0, () => set('q1', 'completed')], // the user's prompt: main eats it as a rice ball
    [12.5, () => { set('m2', 'completed'); set('m3', 'completed'); set('m4', 'completed'); }], // three at once: main eats them one after another from its stack
    [14.0, () => set('b2', 'failed')],
    [15.0, () => set('c2', 'deleted')],
    [16.0, () => { const a = h.dA('a2'); a.status = 'completed'; a.verb = 'done'; a.endedAt = Date.now(); h.dEv('answer', 'a2', 'main', null, 'fix is in'); }],
    [18.0, () => set('t1', 'in_progress', { owner: 'main', active: 'Reviewing the release notes' })],
    [19.5, () => set('t1', 'completed')],
    [20.0, () => drop('c2')],
    [21.5, () => set('t2', 'in_progress', { owner: 'main', active: 'Tagging the release' })],
    [23.0, () => set('t2', 'completed')],
  ];
  // the default demo (?demo): the main loop's own to-do list, merged into its script by time
  const steps = [
    [2.5, () => { add('m1', 'todo', 'main', 'Map the loader', 'in_progress', { active: 'Mapping the loader' }); add('m2', 'todo', 'main', 'Implement the change', 'pending'); add('m3', 'todo', 'main', 'Update the docs', 'pending'); }],
    [13.5, () => { set('m1', 'completed'); set('m2', 'in_progress', { active: 'Implementing the change' }); }],
    [30.8, () => { set('m2', 'completed'); set('m3', 'in_progress', { active: 'Updating the docs' }); }],
    [38, () => set('m3', 'completed')],
  ];
  return {
    script: script.concat([[27.0, () => h.reset && h.reset()]]),
    steps,
    reset: () => { D.tk = []; D.eaten = {}; D.cycle++; },
    tasks: () => JSON.parse(JSON.stringify(D.tk.concat(tickets()))),
    eaten: () => {
      const e = Object.assign({}, D.eaten);
      tickets().filter((x) => x.status === 'completed').forEach((x) => { e[x.deliverTo] = (e[x.deliverTo] || 0) + 1; });
      return e;
    },
  };
}

/* ---------------------------------------------------------------- the 3D part */
function create(api) {
  const T = api.T, scene = api.scene, agents = api.agents;
  const { clamp, lerp, easeIO, easeOutBack, nowS } = api;
  const BOX = new T.BoxGeometry(1, 1, 1);
  const world = new T.Group();            // everything of the tasks that is not a character: items, plates, tables, chips, crumbs
  scene.add(world);
  const S = {
    recs: new Map(),                      // task id -> the item on show
    base: new Map(),                      // task id -> the last status seen, for every id of the session
    inited: false, list: [], blocked: new Set(), eatenTarget: {}, eatenShown: new Map(), on: true,
    stations: new Map(),                  // agent id -> { plate, eaten chip, more chip }
    table: null, own: new Map(),          // own: agent id -> what its pose needs this frame
    crumbs: [], puffs: [], moving: false, seq: 0, lockTex: null, frame: 0,
    eatFree: new Map(),                   // eater id -> when its last scheduled eat ends: the next one starts then
    noms: [], plus: [], nomTex: null, plusTex: null,   // the "nom" pops at the mouth, the "+1" flying to the counter
  };
  const _v = new T.Vector3(), _w = new T.Vector3(), _m = new T.Vector3(), _c = new T.Color();
  const GREY = new T.Color(0x8d8d92);
  const ps = () => api.ps();

  /* ---- small makers */
  function chipTex(text, col) {
    const cv = document.createElement('canvas'); cv.width = 192; cv.height = 64;
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
    const chip = { cv, tex, text: '', col: '', sp: new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false })), n: 0, born: -9 };
    chip.sp.renderOrder = 10; chip.sp.visible = false; world.add(chip.sp);
    paintChip(chip, text, col);
    return chip;
  }
  function paintChip(ch, text, col) {
    if (ch.text === text && ch.col === col) return;
    ch.text = text; ch.col = col;
    const c = ch.cv.getContext('2d'), w = ch.cv.width, h = ch.cv.height;
    c.clearRect(0, 0, w, h);
    c.font = '700 34px ' + api.FONT; c.textBaseline = 'middle'; c.textAlign = 'center';
    const tw = c.measureText(text).width, bw = Math.min(w - 6, tw + 34), x0 = (w - bw) / 2;
    c.fillStyle = 'rgba(14,16,24,.92)'; c.strokeStyle = col; c.lineWidth = 3.5;
    c.beginPath(); if (c.roundRect) c.roundRect(x0, 8, bw, h - 16, 20); else c.rect(x0, 8, bw, h - 16); c.fill(); c.stroke();
    c.fillStyle = col; c.fillText(text, w / 2, h / 2 + 1);
    ch.tex.needsUpdate = true;
  }
  function disposeChip(ch) { if (!ch) return; world.remove(ch.sp); ch.tex.dispose(); ch.sp.material.dispose(); }
  const lockSprite = () => {
    if (!S.lockTex) {
      const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
      const c = cv.getContext('2d');
      c.lineWidth = 7; c.strokeStyle = 'rgba(40,30,0,.9)'; c.lineJoin = 'round';
      c.beginPath(); c.arc(32, 26, 13, Math.PI, 0); c.stroke();
      c.strokeStyle = '#ffd166'; c.lineWidth = 4; c.beginPath(); c.arc(32, 26, 13, Math.PI, 0); c.stroke();
      c.fillStyle = '#ffcf40'; c.strokeStyle = 'rgba(40,30,0,.9)'; c.lineWidth = 5;
      c.beginPath(); if (c.roundRect) c.roundRect(15, 26, 34, 28, 6); else c.rect(15, 26, 34, 28); c.fill(); c.stroke();
      c.fillStyle = '#6b4a00'; c.beginPath(); c.arc(32, 38, 4.5, 0, 6.283); c.fill(); c.fillRect(30, 40, 4, 8);
      S.lockTex = new T.CanvasTexture(cv); S.lockTex.colorSpace = T.SRGBColorSpace;
    }
    const sp = new T.Sprite(new T.SpriteMaterial({ map: S.lockTex, transparent: true, depthTest: false, fog: false }));
    sp.renderOrder = 11; sp.visible = false; world.add(sp);
    return sp;
  };
  function buildFood(food) {
    const g = new T.Group(), mats = [];
    g.rotation.order = 'YXZ';
    const inner = new T.Group(); g.add(inner);
    for (const b of food.boxes) {
      const col = b.color === '@base' ? '#dddddd' : b.color;
      const m = new T.MeshLambertMaterial({ color: new T.Color(col), flatShading: true });
      const o = new T.Mesh(BOX, m);
      o.scale.set(b.size[0], b.size[1], b.size[2]); o.position.set(b.at[0], b.at[1], b.at[2]);
      if (b.rot) o.rotation.set(b.rot[0], b.rot[1], b.rot[2]);
      inner.add(o); mats.push({ m, base: m.color.clone() });
    }
    world.add(g);
    return { g, inner, mats, hm: foodHeight(food.boxes) };
  }
  function disposeRec(rec) {
    world.remove(rec.g); rec.mats.forEach((x) => x.m.dispose());
    if (rec.lock) { world.remove(rec.lock); rec.lock.material.dispose(); }
    S.recs.delete(rec.id);
  }
  function setOpacity(rec, o) {
    const tr = o < 0.999;
    for (const x of rec.mats) { if (x.m.transparent !== tr) { x.m.transparent = tr; x.m.needsUpdate = true; } x.m.opacity = o; }
  }

  /* ---- records */
  function ownerAgent(d) { const id = agentFor(d.owner, (k) => agents.has(k), 'main'); return id == null ? null : agents.get(id); }
  function eaterAgent(d) { const id = agentFor(eaterId(d), (k) => agents.has(k), 'main'); return id == null ? null : agents.get(id); }
  function makeRec(d, mode) {
    const rec = { id: d.id, tk: true, d, mode, mt: nowS(), seq: ++S.seq, g: null, inner: null, mats: [], foodKey: '', crumb: '#ffffff', cur: new T.Vector3(), from: new T.Vector3(), has: false, flyT: -9, flyDur: 0,
      scale: 0, born: nowS(), grey: 0, op: 1, lock: null, pos: new T.Vector3(), eat: null, poof: null, a: null, id2: d.id };
    S.recs.set(d.id, rec);
    return rec;
  }
  function modelFor(rec, a) {
    const ch = a && a.ch, def = ch && ch.rec && ch.rec.def;
    const food = foodFor(a ? a.chId : '', def, ps().food, rec.d.src);
    if (rec.foodKey === food.key && rec.g) return;
    if (rec.g) { world.remove(rec.g); rec.mats.forEach((x) => x.m.dispose()); }
    const m = buildFood(food);
    rec.g = m.g; rec.inner = m.inner; rec.mats = m.mats; rec.foodKey = food.key; rec.crumb = food.crumb; rec.hm = m.hm; rec.top = null;
    rec.g.visible = false;
  }
  function fly(rec, now, dur) { rec.from.copy(rec.cur); rec.flyT = now; rec.flyDur = dur; rec.has = true; }

  /* ---- sync: a new snapshot */
  function sync(s) {
    const list = cleanList(s && s.tasks);
    S.eatenTarget = {};
    if (s && s.eaten && typeof s.eaten === 'object') for (const k of Object.keys(s.eaten)) { const n = Math.floor(+s.eaten[k]); if (n > 0) S.eatenTarget[k] = n; }
    const first = !S.inited;
    S.blocked = blockedIds(list);
    const now = nowS(), live = ps().show.tasks !== false;
    const ev = diff(S.base, list, first);
    const byId = new Map(list.map((d) => [d.id, d]));
    if (first) S.eatenShown.clear();
    for (const e of ev) {
      const d = e.d;
      let rec = S.recs.get(d.id);
      if (!live) continue;
      if (e.k === 'rest') { rec = rec || makeRec(d, d.status === 'failed' ? 'ground' : d.status === 'in_progress' ? 'hand' : 'plate'); rec.d = d; if (d.status === 'failed') rec.grey = 1; continue; }
      if (!rec && e.k !== 'poof') rec = makeRec(d, d.status === 'in_progress' ? 'hand' : 'plate');
      if (e.k === 'poof') { if (rec) startPoof(rec, now); else { rec = makeRec(d, 'plate'); rec.d = d; startPoof(rec, now); } continue; }
      rec.d = d;
      if (e.k === 'show') { rec.mode = 'plate'; rec.born = now; rec.scale = 0; }
      else if (e.k === 'start') { rec.mode = 'hand'; if (rec.has) fly(rec, now, 0.45); }
      else if (e.k === 'back') { rec.mode = 'plate'; if (rec.has) fly(rec, now, 0.4); }
      else if (e.k === 'fail') { rec.mode = 'ground'; rec.failT = now; if (rec.has) fly(rec, now, 0.35); const a = ownerAgent(d); if (a) sigh(a, now); }
      else if (e.k === 'eat') queueEat(rec, d, now);
    }
    // known items that did not change keep their data (the card reads it); the ones that left the list fade away
    for (const rec of S.recs.values()) {
      const d = byId.get(rec.id);
      if (d) { rec.d = d; continue; }
      if (rec.mode !== 'eat' && rec.mode !== 'poof' && rec.mode !== 'fade') { rec.mode = 'fade'; rec.mt = now; }
    }
    for (const d of list) S.base.set(d.id, d.status);
    S.inited = true; S.list = list;
    if (first || !live) Object.keys(S.eatenTarget).forEach((k) => S.eatenShown.set(k, S.eatenTarget[k]));
    if (live && ev.some((e) => e.k !== 'rest')) api.pulse(1500);
  }
  function startPoof(rec, now) {
    rec.mode = 'poof'; rec.mt = now; rec.poof = { n: 0 };
    api.pulse(1200);
  }
  /* a task finished: it is eaten at its turn. Several that finish together (one eater) are eaten one after another, each leaving the stack when its
     turn comes; with reduced motion there is no queue (a short fade each). */
  function carryOf(d) {
    const eater = eaterAgent(d), child = ownerAgent(d);
    const carry = !!(d.deliverTo && child && eater && child !== eater && !ps().reduceMotion);
    return { eater, child, carry, dur: carry ? clamp(child.pos.distanceTo(eater.pos) / 9, CARRY_MIN, CARRY_MAX) : 0 };
  }
  function queueEat(rec, d, now) {
    if (ps().reduceMotion) return startEat(rec, d, now);
    const c = carryOf(d), key = c.eater ? c.eater.id : '', slot = eatSlot(S.eatFree.get(key), now, c.dur + EAT.total);
    S.eatFree.set(key, slot.free);
    if (slot.at <= now + 0.02) return startEat(rec, d, now);
    rec.wait = slot.at; rec.waitD = d; rec.waitEater = key;
    api.pulse((slot.at - now) * 1000 + 3000);
  }
  function startEat(rec, d, now) {
    const c = carryOf(d), eater = c.eater, child = c.child, carry = c.carry, carryDur = c.dur;
    rec.mode = 'eat'; rec.mt = now; rec.wait = 0;
    rec.eat = { t0: now, carry: carry ? { dur: carryDur, child, parent: eater } : null, eaterId: eater ? eater.id : null, chomps: 0, from: new T.Vector3(), started: false };
    api.pulse(3000 + carryDur * 1000);
  }
  function sigh(a, now) {
    const st = ownerState(a); st.sighT = now;
    if (!ps().reduceMotion) { api.spawnRfx('sweat', a, 0); api.spawnRfx('puff', a, 0.05); }
  }
  function ownerState(a) {
    let st = S.own.get(a.id);
    if (!st) { st = { hold: null, eat: null, sighT: -9, blocked: false, motion: '', holdPrev: null }; S.own.set(a.id, st); }
    return st;
  }
  function reset() {
    S.recs.forEach((r) => { world.remove(r.g); r.mats.forEach((x) => x.m.dispose()); if (r.lock) { world.remove(r.lock); r.lock.material.dispose(); } });
    S.recs.clear(); S.base.clear(); S.inited = false; S.list = []; S.blocked = new Set(); S.eatenTarget = {}; S.eatenShown.clear(); S.own.clear();
    S.stations.forEach((st) => { world.remove(st.plate); disposeChip(st.eaten); disposeChip(st.more); }); S.stations.clear();
    if (S.table) { world.remove(S.table.g); disposeChip(S.table.more); S.table = null; }
    S.crumbs.forEach((c) => { c.m.visible = false; }); S.crumbs.length = 0;
    S.puffs.forEach((p) => { p.sp.visible = false; }); S.puffs.length = 0;
    S.noms.forEach((n) => { n.sp.visible = false; }); S.noms.length = 0;
    S.plus.forEach((n) => { n.sp.visible = false; }); S.plus.length = 0;
    S.eatFree.clear();
  }

  /* ---- stations: the plate beside an agent, the table by main */
  const PLATE = [bx(4.3, 0.3, 4.3, 0, 0.15, 0, '#efe9dc'), bx(4.7, 0.16, 4.7, 0, 0.08, 0, '#c9c0ae'), bx(3.1, 0.12, 3.1, 0, 0.32, 0, '#fbf8f0')];
  const TABLE = [bx(7.4, 0.4, 4.6, 0, 1.6, 0, '#b98a5e'), bx(7.4, 0.14, 4.6, 0, 1.42, 0, '#8f6743'), bx(0.55, 1.5, 0.55, -3.3, 0.75, -1.9, '#8a6342'), bx(0.55, 1.5, 0.55, 3.3, 0.75, -1.9, '#8a6342'),
    bx(0.55, 1.5, 0.55, -3.3, 0.75, 1.9, '#8a6342'), bx(0.55, 1.5, 0.55, 3.3, 0.75, 1.9, '#8a6342')];
  function propGroup(boxes) {
    const g = new T.Group();
    for (const b of boxes) {
      const o = new T.Mesh(BOX, new T.MeshLambertMaterial({ color: new T.Color(b.color), flatShading: true }));
      o.scale.set(b.size[0], b.size[1], b.size[2]); o.position.set(b.at[0], b.at[1], b.at[2]); g.add(o);
    }
    g.visible = false; world.add(g);
    return g;
  }
  function stationOf(a) {
    let st = S.stations.get(a.id);
    if (!st) { st = { plate: propGroup(PLATE), eaten: chipTex('✓ 0', '#5ee08a'), more: chipTex('+0', '#c3cadb'), a }; S.stations.set(a.id, st); }
    return st;
  }
  function tableOf() {
    if (!S.table) S.table = { g: propGroup(TABLE), more: chipTex('+0', '#c3cadb') };
    return S.table;
  }
  // an agent-local spot (x right, y up, z toward the viewer, in voxels) -> the world
  function toWorld(a, x, y, z, out) {
    const r = a.root, c = Math.cos(r.rotation.y), s = Math.sin(r.rotation.y), k = r.scale.x;
    out.set((x * c + z * s) * k + r.position.x, y * k + r.position.y, (-x * s + z * c) * k + r.position.z);
    return out;
  }
  const bodyW = (a) => (a.ch ? a.ch.bw : 7);
  const platePos = (a) => ({ x: -(Math.min(9, bodyW(a) * 0.5) + 3.7), z: 2.2 });
  const tablePos = (a) => ({ x: Math.min(9, bodyW(a) * 0.5) + 7.4, z: 1.6 });

  /* ---- hand and mouth of an agent, in the world (matrices are brought up to date first, once per agent per frame) */
  function handOf(a) {
    const ch = a.ch;
    if (a.tkH && a.tkH.ch === ch) return a.tkH; // the character built again (a swap, a pack that changed) has new bones
    const B = a.bn, name = B.handR ? 'handR' : B.armR ? 'armR' : B.handL ? 'handL' : B.armL ? 'armL' : null;
    const def = ch.rec && ch.rec.def;
    let lx = 0.5, ly = 0, lz = 0.7;
    if (name && def && def.bones[name] && def.bones[name].boxes.length) {
      let best = null, bd = -1; // the box farthest from the bone's origin: the fingertips, the claw
      for (const b of def.bones[name].boxes) { const dd = Math.hypot(b.at[0], b.at[1], b.at[2]); if (dd > bd) { bd = dd; best = b; } }
      lx = best.at[0]; ly = best.at[1]; lz = best.at[2] + best.size[2] * 0.5 + 0.35;
    }
    a.tkH = { ch, bone: name ? B[name].o : null, tip: new T.Vector3(lx, ly, lz), mouth: B.mouth ? B.mouth.o : null, motion: MOTION_OF[a.chId] || 'bob' };
    return a.tkH;
  }
  function freshen(a) { if (a.tkF !== S.frame) { a.tkF = S.frame; a.root.updateMatrixWorld(true); } }
  function handWorld(a, out) {
    freshen(a);
    const h = handOf(a);
    if (h.bone) return h.bone.localToWorld(out.copy(h.tip));
    const ch = a.ch;
    return a.body.localToWorld(out.set(ch.page[0], ch.page[1] * 0.8, ch.page[2]));
  }
  function mouthWorld(a, out) {
    freshen(a);
    const h = handOf(a), ch = a.ch;
    if (h.mouth) return h.mouth.localToWorld(out.set(0, 0, 0.55));
    return a.body.localToWorld(out.set(0, Math.min(ch.page[1], ch.top * 0.6), ch.page[2] - 0.6));
  }

  /* ---- crumbs and smoke */
  const crumbMats = new Map();
  /* crumbs from `pos`: `k` is the size of the eater (world per voxel). With `land` (a world point: the plate) they arc down onto it and rest a moment;
     without, they fall straight down. */
  function crumb(pos, color, n, k, land) {
    if (ps().reduceMotion) return;
    let m = crumbMats.get(color);
    if (!m) { m = new T.MeshLambertMaterial({ color: new T.Color(color), flatShading: true }); crumbMats.set(color, m); }
    const kk = k || 0.3;
    for (let i = 0; i < n; i++) {
      let c = S.crumbs.length >= 60 ? S.crumbs.shift() : null;
      if (!c) { c = { m: new T.Mesh(BOX, m) }; world.add(c.m); } else c.m.material = m;
      c.m.visible = true; c.t0 = nowS(); c.fall = 0.6 + Math.random() * 0.35; c.rest = land ? 0.4 : 0; c.life = c.fall + c.rest;
      c.sz = (0.4 + Math.random() * 0.35) * kk;                  // 4 to 8 px at the pet's default size
      c.p0 = (c.p0 || new T.Vector3()).copy(pos);
      const tx = land ? land.x + (Math.random() - 0.5) * 3.2 * kk : pos.x + (Math.random() - 0.5) * 2.4 * kk, tz = land ? land.z + (Math.random() - 0.5) * 3.2 * kk : pos.z + (Math.random() - 0.5) * 2.4 * kk;
      c.p1 = (c.p1 || new T.Vector3()).set(tx, land ? land.y + 0.4 * kk : Math.max(0, pos.y - 4 * kk), tz);
      c.h = (0.8 + Math.random() * 1.4) * kk;                    // how high the arc rises above the straight line
      c.m.position.copy(pos); c.m.scale.setScalar(c.sz);
      S.crumbs.push(c);
    }
  }
  /* "nom" and "+1": small labels in the style of the chips */
  function labelTex(text, col, boxed) {
    const cv = document.createElement('canvas'); cv.width = 160; cv.height = 64;
    const c = cv.getContext('2d'), w = cv.width, h = cv.height;
    c.font = '700 36px ' + api.FONT; c.textBaseline = 'middle'; c.textAlign = 'center';
    if (boxed) {
      const bw = Math.min(w - 6, c.measureText(text).width + 34), x0 = (w - bw) / 2;
      c.fillStyle = 'rgba(14,16,24,.92)'; c.strokeStyle = col; c.lineWidth = 3.5;
      c.beginPath(); if (c.roundRect) c.roundRect(x0, 8, bw, h - 16, 20); else c.rect(x0, 8, bw, h - 16); c.fill(); c.stroke();
    } else { c.lineWidth = 7; c.strokeStyle = 'rgba(8,20,12,.85)'; c.lineJoin = 'round'; c.strokeText(text, w / 2, h / 2 + 1); }
    c.fillStyle = col; c.fillText(text, w / 2, h / 2 + 1);
    const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
    return tex;
  }
  function popSprite(tex, order) {
    const sp = new T.Sprite(new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false }));
    sp.renderOrder = order; sp.visible = false; world.add(sp);
    return sp;
  }
  function nom(pos, k, now) { // one "nom" next to the mouth, rising and fading
    if (ps().reduceMotion) return;
    if (!S.nomTex) S.nomTex = labelTex('nom', '#ffd166', true);
    let n = S.noms.length >= 8 ? S.noms.shift() : null;
    if (!n) n = { sp: popSprite(S.nomTex, 13) };
    n.t0 = now; n.k = k; n.x = pos.x; n.y = pos.y; n.z = pos.z; n.dx = (Math.random() < 0.5 ? -1 : 1) * (1.5 + Math.random() * 0.8) * k;
    S.noms.push(n);
  }
  function plusOne(eater, from, now) { // the "+1": it flies from the mouth to the counter, which counts it on arrival (with reduced motion it only rises and fades there)
    if (!S.plusTex) S.plusTex = labelTex('+1', '#5ee08a', false);
    const reduce = ps().reduceMotion, p = { sp: popSprite(S.plusTex, 14), id: eater.id, t0: now, dur: reduce ? 0.7 : 0.8, from: new T.Vector3().copy(from), reduce, k: eater.root.scale.x, counted: false };
    S.plus.push(p);
    stationOf(eater);
  }
  function countOne(id, now) {
    const target = S.eatenTarget[id] || 0, shown = S.eatenShown.get(id) || 0;
    if (target > shown) S.eatenShown.set(id, shown + 1);
    const st = S.stations.get(id); if (st) st.eaten.born = now;
  }
  const counterPos = (a, out) => { const pp = platePos(a); return toWorld(a, pp.x, 0.2 + 1.4, pp.z + 3.4, out); };
  function puff(pos, size, delay) {
    if (ps().reduceMotion) return;
    let p = S.puffs.length >= 24 ? S.puffs.shift() : null;
    if (!p) { p = { sp: new T.Sprite(new T.SpriteMaterial({ map: api.SMOKE_TEX, transparent: true, depthTest: false, fog: false })) }; p.sp.renderOrder = 11; world.add(p.sp); }
    p.sp.visible = false; p.sp.material.opacity = 0;
    p.x = pos.x + (Math.random() - 0.5) * size * 0.6; p.y = pos.y; p.z = pos.z + (Math.random() - 0.5) * size * 0.6; p.t0 = nowS() + (delay || 0); p.dur = 0.7; p.size = size; p.vy = 0.8 + Math.random() * 0.8; p.rot = Math.random() * 6;
    S.puffs.push(p);
  }
  function stepFx(now, dt) {
    for (let i = S.crumbs.length - 1; i >= 0; i--) {
      const c = S.crumbs[i], el = now - c.t0;
      if (el >= c.life) { c.m.visible = false; S.crumbs.splice(i, 1); continue; }
      const u = Math.min(1, el / c.fall), e = u * u * (0.35 + 0.65 * u);   // eases in like something falling
      c.m.position.set(lerp(c.p0.x, c.p1.x, u), lerp(c.p0.y, c.p1.y, e) + 4 * c.h * u * (1 - u), lerp(c.p0.z, c.p1.z, u));
      if (el < c.fall) { c.m.rotation.x += dt * 9; c.m.rotation.y += dt * 7; }
      c.m.scale.setScalar(c.sz * (el < c.fall ? 1 : 1 - 0.85 * (el - c.fall) / Math.max(0.01, c.rest)));
    }
    for (let i = S.noms.length - 1; i >= 0; i--) {
      const n = S.noms[i], u = (now - n.t0) / 0.6;
      if (u >= 1) { n.sp.visible = false; S.noms.splice(i, 1); continue; }
      n.sp.visible = true; n.sp.position.set(n.x + n.dx * (0.6 + 0.4 * u), n.y + (1.2 + 1.6 * u) * n.k, n.z);
      const pop = 1 + 0.35 * Math.max(0, 1 - u / 0.25);
      n.sp.scale.set(2.2 * n.k * 3.2 * pop * 0.5, 0.88 * n.k * 3.2 * pop * 0.5, 1); n.sp.material.opacity = u < 0.6 ? 1 : 1 - (u - 0.6) / 0.4;
    }
    for (let i = S.plus.length - 1; i >= 0; i--) {
      const p = S.plus[i], u = (now - p.t0) / p.dur, a = agents.get(p.id);
      if (!a || !a.ch || u >= 1) { if (!p.counted && a) countOne(p.id, now); p.sp.visible = false; world.remove(p.sp); p.sp.material.dispose(); S.plus.splice(i, 1); continue; }
      counterPos(a, _pv);
      const sz = 0.5 + 0.55 * p.k * 3;
      if (p.reduce) { // no flight: it rises where the counter is and fades; the count is already up
        if (!p.counted) { p.counted = true; countOne(p.id, now); }
        p.sp.position.set(_pv.x, _pv.y + 0.25 + 0.5 * u * p.k * 3, _pv.z); p.sp.material.opacity = 1 - u; p.sp.scale.set(sz * 1.2, sz * 0.6, 1);
      } else {
        const w = easeIO(u);
        p.sp.position.set(lerp(p.from.x, _pv.x, w), lerp(p.from.y, _pv.y, w) + Math.sin(u * Math.PI) * 1.6 * p.k * 3, lerp(p.from.z, _pv.z, w));
        p.sp.material.opacity = 1; p.sp.scale.set(sz * 1.2 * (1 + 0.3 * Math.sin(u * Math.PI)), sz * 0.6 * (1 + 0.3 * Math.sin(u * Math.PI)), 1);
        if (u > 0.92 && !p.counted) { p.counted = true; countOne(p.id, now); }
      }
      p.sp.visible = true;
    }
    for (let i = S.puffs.length - 1; i >= 0; i--) {
      const p = S.puffs[i], u = (now - p.t0) / p.dur;
      if (u < 0) continue;
      if (u >= 1) { p.sp.visible = false; S.puffs.splice(i, 1); continue; }
      p.sp.visible = true; p.sp.position.set(p.x, p.y + p.vy * u * p.dur * 0.5, p.z);
      p.sp.scale.setScalar(p.size * (0.5 + 1.1 * Math.min(1, u * 2))); p.sp.material.opacity = 0.9 * (1 - clamp((u - 0.15) / 0.85, 0, 1)); p.sp.material.rotation = p.rot + u * 1.5;
    }
  }

  /* pixels per world unit at a point (the camera looks at the middle of the window) */
  const _cp = new T.Vector3(), _pv = new T.Vector3();
  function pxPerWorld(p) {
    const cam = api.camera, d = Math.max(0.5, _cp.copy(cam.position).sub(p).length());
    return (api.size()[1] / 2) / (Math.tan(cam.fov * Math.PI / 360) * d);
  }

  /* ---- per frame */
  const MOTION_FREE = { think: 1, plan: 1, wait: 1, spawn: 1 }; // the verbs that leave the arms free: only then does the character work on its food
  function update(dt, now) {
    S.frame++;
    const on = ps().show.tasks !== false;
    if (on !== S.on) {
      S.on = on;
      if (on) { // turned back on: what is there shows at rest, nothing is played
        const list = S.list;
        S.inited = false; S.base.clear(); S.recs.forEach((r) => { world.remove(r.g); r.mats.forEach((x) => x.m.dispose()); }); S.recs.clear();
        sync({ tasks: list, eaten: S.eatenTarget });
      }
    }
    world.visible = on;
    S.own.forEach((st) => { st.hold = null; st.eat = null; st.blocked = false; });
    if (!on) { S.moving = false; return; }
    const calm = api.calm(), reduce = !!ps().reduceMotion;
    let moving = S.crumbs.length > 0 || S.puffs.length > 0 || S.noms.length > 0 || S.plus.length > 0;
    for (const rec of S.recs.values()) if (rec.wait) { if (now >= rec.wait) startEat(rec, rec.waitD, now); else moving = true; } // a queued eat whose turn has come
    // group by owner: who is holding what, and the plates
    const holders = new Map(), plates = new Map(), grounds = new Map(), table = [];
    const recs = [...S.recs.values()].sort((x, y) => x.seq - y.seq);
    // what an agent holds: the first of its own to-do items or tasks in progress; its ticket (the job it was given) only when there is nothing else, else it waits on the plate
    const pickHold = new Map();
    for (const rec of recs) {
      const a = ownerAgent(rec.d);
      if (!a || rec.d.status !== 'in_progress' || rec.mode === 'eat' || rec.mode === 'poof' || rec.mode === 'fade') continue;
      const cur = pickHold.get(a.id);
      if (!cur || (cur.d.src === 'agent' && rec.d.src !== 'agent')) pickHold.set(a.id, rec);
    }
    for (const rec of recs) {
      const d = rec.d, a = ownerAgent(d);
      rec.a = a;
      if (!a || !a.ch) { // nobody to hold it: a transition in flight ends, the rest waits for its owner
        if (rec.mode === 'eat' || rec.mode === 'poof' || rec.mode === 'fade') disposeRec(rec); else if (rec.g) rec.g.visible = false;
        continue;
      }
      modelFor(rec, a);
      if (rec.mode === 'eat' || rec.mode === 'poof' || rec.mode === 'fade') continue;
      if (d.status === 'failed') rec.mode = 'ground';
      else if (d.status === 'in_progress') {
        if (pickHold.get(a.id) === rec) { holders.set(a.id, rec); if (rec.mode !== 'hand') { if (rec.has) fly(rec, now, 0.45); rec.mode = 'hand'; } }
        else if (rec.mode !== 'plate') { if (rec.has) fly(rec, now, 0.4); rec.mode = 'plate'; }
      } else if (d.status === 'pending' && rec.mode !== 'plate') { if (rec.has) fly(rec, now, 0.4); rec.mode = 'plate'; }
      if (rec.mode === 'plate') {
        if (d.owner && agents.has(d.owner)) { if (!plates.has(a.id)) plates.set(a.id, []); plates.get(a.id).push(rec); }
        else table.push(rec);
      } else if (rec.mode === 'ground') { if (!grounds.has(a.id)) grounds.set(a.id, []); grounds.get(a.id).push(rec); }
    }
    // stations: plates with their stacks, the counters, the table
    const wanted = new Set();
    const placeStation = (a) => {
      const st = stationOf(a); wanted.add(a.id);
      const pp = platePos(a), list = plates.get(a.id) || [], shown = list.slice(0, SHOWN);
      toWorld(a, pp.x, 0, pp.z, _v);
      st.plate.position.copy(_v); st.plate.rotation.y = a.root.rotation.y; st.plate.scale.setScalar(a.root.scale.x);
      st.plate.visible = (list.length > 0 || (S.eatenShown.get(a.id) || 0) > 0) && a.root.visible; // an empty plate stays as long as it has a count
      shown.forEach((rec, i) => { rec.slot = { kind: 'plate', i, pp, extra: i }; });
      list.slice(SHOWN).forEach((rec) => { rec.slot = null; });
      const hidden = Math.max(0, list.length - SHOWN);
      st.more.sp.visible = hidden > 0;
      if (hidden > 0) { paintChip(st.more, '+' + hidden, '#c3cadb'); toWorld(a, pp.x + 2.8, 3.6 + Math.min(list.length, SHOWN) * 0.5, pp.z, _v); st.more.sp.position.copy(_v); st.more.sp.scale.set(1.5, 0.5, 1); }
      const shownN = S.eatenShown.get(a.id) || 0;
      st.eaten.sp.visible = shownN > 0;
      if (shownN > 0) {
        paintChip(st.eaten, '✓ ' + shownN, '#5ee08a');
        toWorld(a, pp.x, 0.2, pp.z + 3.4, _v); st.eaten.sp.position.copy(_v);
        const pop = 1 + 0.35 * Math.max(0, 1 - (now - st.eaten.born) / 0.4);
        st.eaten.sp.scale.set(1.65 * pop, 0.55 * pop, 1);
      }
    };
    agents.forEach((a) => {
      if ((plates.get(a.id) || []).length || (S.eatenShown.get(a.id) || 0) > 0 || S.stations.has(a.id)) placeStation(a);
    });
    S.stations.forEach((st, id) => { if (!wanted.has(id)) { world.remove(st.plate); disposeChip(st.eaten); disposeChip(st.more); S.stations.delete(id); } });
    const mainA = agents.get('main') || null;
    if (table.length && mainA) {
      const tb = tableOf(), tp = tablePos(mainA);
      toWorld(mainA, tp.x, 0, tp.z, _v);
      tb.g.position.copy(_v); tb.g.rotation.y = mainA.root.rotation.y; tb.g.scale.setScalar(mainA.root.scale.x); tb.g.visible = mainA.root.visible;
      table.forEach((rec, i) => { rec.slot = i < 6 ? { kind: 'table', i, tp } : null; });
      const hidden = Math.max(0, table.length - 6);
      tb.more.sp.visible = hidden > 0;
      if (hidden > 0) { paintChip(tb.more, '+' + hidden, '#c3cadb'); toWorld(mainA, tp.x + 3, 4, tp.z, _v); tb.more.sp.position.copy(_v); tb.more.sp.scale.set(1.5, 0.5, 1); }
    } else if (S.table) { S.table.g.visible = false; S.table.more.sp.visible = false; }
    // each item
    for (const rec of recs) {
      const a = rec.a;
      if (!a || !a.ch || !rec.g) continue;
      const d = rec.d, k = a.root.scale.x, st = ownerState(a);
      let visible = a.root.visible, tx = 0, ty = 0, tz = 0, ry = 0, rx = 0, rz = 0, sc = 1, op = 1;
      const tgt = _w;
      if (rec.mode === 'plate') {
        if (!rec.slot) visible = false;
        else if (rec.slot.kind === 'plate') {
          const sl = stackSlot(rec.slot.i, rec.id), pp = rec.slot.pp;
          toWorld(a, pp.x + sl.x, 0.5 + sl.y + 0.3, pp.z + sl.z, tgt); ry = sl.ry; rx = -1.15;
        } else {
          const tp = rec.slot.tp, ts = tableSlot(rec.slot.i), sl = stackSlot(0, rec.id);
          toWorld(mainA, tp.x + ts.x, 2.1, tp.z + ts.z, tgt); ry = sl.ry; rx = -1.15;
        }
      } else if (rec.mode === 'hand') {
        const hw = handWorld(a, tgt), motion = handOf(a).motion;
        if (motion === 'nibble') { mouthWorld(a, _m); hw.lerp(_m, 0.78); }
        else if (motion === 'snip') { mouthWorld(a, _m); hw.lerp(_m, 0.3); }
        const working = !calm && !reduce && MOTION_FREE[a.d.verb || 'wait'] && a.d.status === 'running';
        const tt = now + rec.seq;
        if (working && motion === 'roll') { ry = tt * 4; rz = tt * 3; }
        else if (working && motion === 'hammer') { rz = 0.5 * Math.sin(tt * 10); }
        else if (working && motion === 'paw') { rz = 0.3 * Math.sin(tt * 12); hw.y -= 0.02 * k * Math.abs(Math.sin(tt * 12)); }
        else rz = 0.25 + 0.08 * Math.sin(tt * 2.2);
        st.hold = rec; st.motion = motion;
      } else if (rec.mode === 'ground') {
        const list = grounds.get(a.id) || [], i = list.indexOf(rec);
        const pp = platePos(a);
        toWorld(a, pp.x + 2.8 + (i % 3) * 2.0, 0.35, pp.z + 2.4 + Math.floor(i / 3) * 1.6, tgt); rx = -1.45; ry = stackSlot(0, rec.id).ry;
        rec.grey += (1 - rec.grey) * (1 - Math.exp(-dt * 6));
      } else if (rec.mode === 'fade') {
        const u = (now - rec.mt) / 0.35;
        if (u >= 1) { disposeRec(rec); continue; }
        op = 1 - u; tgt.copy(rec.cur); sc = 1 - 0.3 * u;
      } else if (rec.mode === 'poof') {
        const p = rec.poof, u = (now - rec.mt) / 0.5;
        tgt.copy(rec.has ? rec.cur : _v.set(a.pos.x, a.pos.y + 1, a.pos.z));
        if (!p.done) { p.done = true; for (let i = 0; i < 4; i++) puff(tgt, 0.8 + Math.random() * 0.5, i * 0.04); crumb(tgt, rec.crumb, 4); }
        sc = Math.max(0.001, 1 - u * u * 1.2); op = 1 - clamp(u - 0.3, 0, 0.7) / 0.7;
        moving = true;
        if (u >= 1.2) { disposeRec(rec); continue; }
      } else if (rec.mode === 'eat') {
        const r = eatStep(rec, a, now, dt, tgt);
        if (r.done) { disposeRec(rec); continue; }
        sc = r.sc; op = r.op; rx = r.rx; ry = r.ry; rz = r.rz; moving = true;
        if (r.eater) { const es = ownerState(r.eater); es.eat = r; }
      }
      // blocked: the lock
      const blocked = S.blocked.has(rec.id) && isOpen(d.status);
      if (blocked) { st.blocked = true; if (!rec.lock) rec.lock = lockSprite(); } else if (rec.lock) { rec.lock.visible = false; }
      // arrive: a flight from where it was to where it goes, with a little arc
      if (rec.flyDur > 0 && now - rec.flyT < rec.flyDur) {
        const u = easeIO((now - rec.flyT) / rec.flyDur);
        tgt.lerpVectors(rec.from, tgt, u); tgt.y += Math.sin(u * Math.PI) * 0.9 * k * 3;
        moving = true;
      }
      rec.cur.copy(tgt); rec.has = true; rec.pos.copy(tgt);
      // pop in
      const age = now - rec.born, pop = rec.mode === 'plate' || rec.mode === 'hand' || rec.mode === 'ground' ? easeOutBack(clamp(age / 0.4, 0, 1)) : 1;
      if (age < 0.45) moving = true;
      let food = FOOD_SCALE * k * (rec.mode === 'hand' ? 1.15 : 1);
      if (rec.mode === 'hand' || rec.mode === 'eat') food *= boostFor(rec.hm || 1, food, pxPerWorld(tgt), EAT.minPx); // held and eaten: at least minPx tall on screen
      if (rec.mode === 'eat' && rec.top !== rec.g) { // eaten: drawn over everything (the character's body, the link tubes)
        rec.top = rec.g;
        rec.mats.forEach((x) => { x.m.depthTest = false; x.m.needsUpdate = true; });
        rec.inner.children.forEach((o) => { o.renderOrder = 12; });
      }
      rec.g.visible = visible && sc > 0.002;
      rec.g.position.copy(tgt);
      rec.g.scale.setScalar(Math.max(0.0005, food * sc * Math.max(0.001, pop)));
      rec.g.rotation.set(rx, a.root.rotation.y + ry, rz);
      if (rec.mode === 'eat' || rec.mode === 'poof' || rec.mode === 'fade') rec.g.visible = visible && sc > 0.002;
      // grey (failed) and the fade
      for (const x of rec.mats) x.m.color.copy(x.base).lerp(GREY, rec.grey * 0.85);
      if (op !== rec.op) { setOpacity(rec, op); rec.op = op; }
      if (rec.lock) {
        rec.lock.visible = blocked && visible;
        if (blocked) { rec.lock.position.set(tgt.x, tgt.y + 1.1 * k + 0.25, tgt.z); rec.lock.scale.setScalar(0.5); }
      }
    }
    // counters follow the eats; with nothing left to eat the number is simply the snapshot's
    const eating = new Set();
    for (const rec of S.recs.values()) { if (rec.mode === 'eat') eating.add(rec.eat && rec.eat.eaterId); else if (rec.wait) eating.add(rec.waitEater); }
    S.plus.forEach((p) => eating.add(p.id));
    for (const id of new Set([...Object.keys(S.eatenTarget), ...S.eatenShown.keys()])) {
      const target = S.eatenTarget[id] || 0, shown = S.eatenShown.get(id) || 0;
      if (eating.has(id) || target === shown) continue;
      S.eatenShown.set(id, target); // up: an eat that was skipped; down: the count was cleared (/crew reset)
      const st = S.stations.get(id); if (st && target > shown) st.eaten.born = now;
    }
    stepFx(now, dt);
    S.moving = moving;
    S.own.forEach((st, id) => { if (!agents.has(id)) S.own.delete(id); });
  }

  /* the eat of one item: [carry along the link], lift it off the plate to the front of the face, three chomps ("nom", crumbs that fall to the plate), a swallow,
     then it is gone and a "+1" flies to the counter */
  const _f = new T.Vector3(), _l = new T.Vector3();
  function eatStep(rec, child, now, dt, out) {
    const E = rec.eat, reduce = !!ps().reduceMotion;
    const eater = E.eaterId != null && agents.has(E.eaterId) ? agents.get(E.eaterId) : child;
    const res = { done: false, sc: 1, op: 1, rx: -0.2, ry: 0, rz: 0.2, mouth: 0, happy: false, hop: 0, tilt: 0, squash: 0, eater };
    if (!eater.ch) { res.done = true; return res; }
    if (reduce) { // no carry, no crumbs, no labels: a short fade, then the count (a "+1" rises at the counter)
      const u = (now - E.t0) / 0.3;
      out.copy(rec.has ? rec.cur : _m.set(eater.pos.x, eater.pos.y + 1, eater.pos.z)); res.op = 1 - clamp(u, 0, 1); res.sc = 1 - 0.3 * clamp(u, 0, 1);
      if (u >= 1) { finishEat(rec, eater, now); res.done = true; }
      return res;
    }
    let t = now - E.t0;
    if (E.carry) { // along the tube between the two, the same curve app.js draws
      const C = E.carry;
      if (t < C.dur) {
        const u = easeIO(t / C.dur);
        api.anchorOf(C.parent, _m); api.anchorOf(C.child, _c0);
        const mid = _v0.copy(_m).add(_c0).multiplyScalar(0.5); mid.y += _m.distanceTo(_c0) * 0.28 + 1.1;
        // quadratic bezier from the child's anchor to the parent's
        const a0 = _c0, a1 = mid, a2 = _m, iu = 1 - u;
        out.set(iu * iu * a0.x + 2 * iu * u * a1.x + u * u * a2.x, iu * iu * a0.y + 2 * iu * u * a1.y + u * u * a2.y, iu * iu * a0.z + 2 * iu * u * a1.z + u * u * a2.z);
        res.rx = -0.3; res.rz = 0.4 * Math.sin(t * 9); res.eater = null;
        return res;
      }
      t -= C.dur;
    }
    const k = eater.root.scale.x;
    // in front of the face, toward the camera: the character turns to it, so the mouth is on that side
    mouthWorld(eater, _m);
    _f.copy(api.camera.position).sub(_m).normalize(); _m.addScaledVector(_f, 1.3 * k);
    if (!E.started) { E.started = true; E.from.copy(rec.has ? rec.cur : eater.pos); if (E.carry) E.from.copy(eater.pos).setY(eater.pos.y + eater.h); }
    const G = EAT.grab, nCh = EAT.chomps, chomp = EAT.chomp, tail = EAT.total - G - nCh * chomp;
    res.sc = eatSize(t);
    if (t < G) { // off the plate (or out of the hand) and up to the face, with an arc
      const u = easeIO(t / G);
      out.lerpVectors(E.from, _m, u); out.y += Math.sin(u * Math.PI) * 1.1 * k * 3;
      res.rx = -0.25 * (1 - u); res.rz = 0.2 * (1 - u);
    } else if (t < G + nCh * chomp) {
      const ct = t - G, ci = Math.min(nCh - 1, Math.floor(ct / chomp)), f = (ct - ci * chomp) / chomp;
      out.copy(_m); out.y += 0.12 * k * Math.sin(Math.PI * f);
      res.mouth = 0.95 * Math.sin(Math.PI * f); res.squash = 0.06 * Math.sin(Math.PI * f); res.tilt = 0.1 * Math.sin(Math.PI * f);
      res.rz = 0.25 * Math.sin(f * Math.PI * 2); res.happy = true;
      if (ci + f >= E.chomps + 0.5) {
        E.chomps = ci + 1;
        const plate = S.stations.has(eater.id) || (S.eatenShown.get(eater.id) || 0) > 0 || rec.slotPlate;
        const pp = platePos(eater); toWorld(eater, pp.x, 0, pp.z, _l); _l.y += 0.45 * k;
        crumb(_m, rec.crumb, 7, k, plate ? _l : null); nom(_m, k, now);
      }
    } else {
      const u = (t - G - nCh * chomp) / tail;
      out.copy(_m); res.happy = true; res.hop = Math.sin(Math.PI * clamp(u, 0, 1));
      if (u >= 1) { finishEat(rec, eater, now, out); res.done = true; }
    }
    return res;
  }
  const _c0 = new T.Vector3(), _v0 = new T.Vector3();
  function finishEat(rec, eater, now, at) {
    plusOne(eater, at || _m.set(eater.pos.x, eater.pos.y + eater.h, eater.pos.z), now); // the counter counts it when the "+1" arrives
  }

  /* ---- the pose: deltas on top of the verb pose (called from reactCrab, so it sums with the pet / pinch reactions) */
  function pose(a, R, v, now, dt) {
    const st = S.own.get(a.id);
    if (!st || !S.on) return;
    const reduce = !!ps().reduceMotion, tt = now;
    // eating: mouth, a squash on each chomp, happy eyes, the hop at the end
    const e = st.eat;
    if (e && !reduce) {
      R.mouth = Math.max(R.mouth, e.mouth); R.sy *= 1 - e.squash; R.rx += e.tilt;
      if (e.happy) R.happy = true;
      R.by += 1.4 * e.hop;
    }
    // failed: a sigh
    const sg = now - st.sighT;
    if (sg >= 0 && sg < 1.5 && !reduce) { const k = Math.sin(Math.PI * clamp(sg / 1.5, 0, 1)); R.headX += 0.5 * k; R.rx += 0.1 * k; R.esy *= 1 - 0.4 * k; R.by -= 0.15 * k; R.dA -= 0.2 * k; }
    const working = !api.calm() && !reduce && api.running();
    // working on the item in hand (only while the verb leaves the arms alone)
    if (st.hold && working && v !== 'read' && v !== 'edit' && v !== 'run' && v !== 'search' && v !== 'web' && v !== 'failed' && v !== 'done') {
      switch (st.motion) {
        case 'hammer': R.dR += 0.9 * Math.max(0, Math.sin(tt * 10)); R.by += 0.1 * Math.abs(Math.sin(tt * 10)); R.rx += 0.1; break;
        case 'paw': R.dR += 0.35 * Math.sin(tt * 12); R.dL += 0.15 * Math.sin(tt * 12 + 1); R.headX += 0.18 * Math.sin(tt * 6); R.rx += 0.18; break;
        case 'nibble': R.headX += 0.12 * Math.sin(tt * 16); R.mouth = Math.max(R.mouth, 0.5 + 0.5 * Math.sin(tt * 16)); R.dR += 0.25; R.dL += 0.2; R.rx += 0.08; break;
        case 'snip': R.dL += 0.55 * Math.max(0, Math.sin(tt * 14)); R.dR += 0.55 * Math.max(0, Math.sin(tt * 14 + Math.PI)); R.by += 0.05 * Math.abs(Math.sin(tt * 14)); break;
        case 'roll': R.rz += 0.1 * Math.sin(tt * 5); R.dR += 0.25 * Math.sin(tt * 6); R.dL += 0.25 * Math.sin(tt * 6 + 1.5); R.by += 0.1 * Math.abs(Math.sin(tt * 5)); break;
        default: R.dR += 0.2 * Math.sin(tt * 4); R.by += 0.05 * Math.abs(Math.sin(tt * 4));
      }
    }
    // blocked: tapping a foot
    if (st.blocked && working) R.lg[1] += 0.45 * Math.max(0, Math.sin(tt * 9));
  }

  /* ---- hover */
  function pickAt(px, py) {
    if (!S.on) return null;
    const W = api.size()[0], H = api.size()[1], r = api.overlay ? 20 : 16;
    let best = null, bd = 1e9;
    S.recs.forEach((rec) => {
      if (!rec.g || !rec.g.visible || rec.mode === 'poof' || rec.mode === 'fade') return;
      _v.copy(rec.pos).project(api.camera);
      if (_v.z > 1) return;
      const dx = (_v.x * 0.5 + 0.5) * W - px, dy = (-_v.y * 0.5 + 0.5) * H - py, dd = Math.hypot(dx, dy);
      if (dd < r && dd < bd) { bd = dd; best = rec; }
    });
    return best;
  }
  const ownerName = (rec) => { const a = ownerAgent(rec.d); return rec.d.owner ? (a ? (a.id === 'main' ? 'main' : a.d.type || a.id) : rec.d.owner) : ''; };
  const lines = (rec) => cardLines(rec.d, ownerName(rec), S.blocked.has(rec.id));
  function fillCard(rec, el, mk) {
    for (const [text, kind] of lines(rec)) { const row = mk('div', kind === 'b' ? null : kind === 'p' ? 'p' : 's'); if (kind === 'b') row.appendChild(mk('b', null, text)); else row.textContent = text; el.appendChild(row); }
  }
  const tipText = (rec) => lines(rec).map((l) => l[0]).join('\n');
  const cardKey = (rec) => ['t', rec.id, rec.d.status, rec.d.active, rec.d.owner, S.blocked.has(rec.id) ? 1 : 0].join('|');

  /* ---- what the bubble says: the active text of the item in hand */
  function activeText(a) {
    if (!S.on) return '';
    const st = S.own.get(a.id);
    return st && st.hold && a.d.status === 'running' && st.hold.d.active && st.hold.d.status === 'in_progress' ? st.hold.d.active : '';
  }

  return {
    sync, update, pose, reset, pickAt, fillCard, tipText, cardKey, activeText,
    busy: () => S.on && S.moving,
    state: () => S,
    counts: () => ({ on: S.on, visible: world.visible, crumbs: S.crumbs.length, recs: S.recs.size, modes: [...S.recs.values()].map((r) => r.id + ':' + r.mode), shown: [...S.eatenShown], moving: S.moving }),
  };
}

return { demo, cleanList, blockedIds, diff, agentFor, eaterId, stackSlot, tableSlot, cardLines, FOODS, TURN_FOOD, BUILTIN_FOOD, MOTION_OF, foodFor, create, SHOWN, EAT, eatSlot, boostFor, foodHeight, eatSize };
});
