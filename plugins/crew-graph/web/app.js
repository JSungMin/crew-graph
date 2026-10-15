/* crew-graph viewer: voxel Clawd crabs on a ground plane. Plain script, no imports, no network. */
(() => {
'use strict';
const T = THREE;
const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const lerp = (a, b, t) => a + (b - a) * t;
const easeIO = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const easeOutBack = (t) => { const c = 1.9; t = clamp(t, 0, 1) - 1; return 1 + (c + 1) * t * t * t + c * t * t; };
const hash = (s) => { let h = 2166136261; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
const FONT = 'system-ui,"Segoe UI","Malgun Gothic","Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const nowS = () => performance.now() / 1000;
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

const EDGE = { tree: 0xdfe6ff, r: 0x4aa3ff, w: 0xff9340, rw: 0xb07cff };
const PCOL = { prompt: 0xffd166, spawn: 0x7ee0ff, tool: 0x9aa4bd, read: 0x4aa3ff, write: 0xff9340, done: 0x5ee08a, red: 0xff4d4d, check: 0x9db4ff, consult: 0xc08cff, answer: 0x4de3c1, compact: 0xff8fd0 };
const KCOL = { prompt: '#ffd166', spawn: '#7ee0ff', tool: '#8b93a7', read: '#4aa3ff', write: '#ff9340', done: '#5ee08a', fail: '#ff5c5c', deny: '#ff5c5c', check: '#9db4ff', consult: '#c08cff', answer: '#4de3c1', compact: '#ff8fd0' };
const SCOL = { running: '#5ee08a', pending: '#ffb84d', waiting: '#ffb84d', idle: '#8b93a7', completed: '#4de3c1', failed: '#ff5c5c', killed: '#c97b7b' };

/* ---------------------------------------------------------------- state */
const agents = new Map();   // id -> crab record
const files = new Map();    // path -> file record
let edges = [];
let lastSnap = null, recvAt = 0, gotReal = false, demoOn = false;
let maxSeen = 0, inited = false, sessionId = null, fileSeq = 0;
let selected = null, hover = null;
let TK = null;              // the tasks (tasks.js): the agents' to-do items as food they work on and eat; null in ?embed and the Settings previews
const params = new URLSearchParams(location.search || '');
const forceDemo = params.has('demo');
// ?embed: drawn into the terminal's Crew pane by bin/crew-3d.mjs; no HUD, no demo fallback.
const embed = params.has('embed');
// ?overlay: the desktop pet (overlay/main.js): a transparent window with no world, only the crabs.
// Everything overlay-specific below is behind this flag; ?embed and the plain page behave as before.
const overlay = params.has('overlay');
const pet = overlay ? (window.crewPet || null) : null; // absent when the page is opened in a browser
// ?preview: the pet's Settings window (settings.html): this same code draws a live, idling copy of every character into small tiles.
const preview = params.has('preview');
// ?session=<id>: read sessions/<id>.js instead of data.js, so every Claude session gets its own window.
const petSession = /^[A-Za-z0-9._-]{1,80}$/.test(params.get('session') || '') ? params.get('session') : '';
// The calmer wiring: tubes to children, files in arcs beside their agent, short fading read/write arcs. ?embed keeps the old lines.
const wire2 = !embed;

/* ---------------------------------------------------------------- scene */
const host = $('stage');
let renderer = null;
try {
  // Embedded, the page is drawn by software GL (SwiftShader) on the CPU: no MSAA, 1:1 pixels, low-power GPU hint.
  renderer = new T.WebGLRenderer({ antialias: !embed, alpha: overlay || preview, powerPreference: embed ? 'low-power' : 'default' });
  renderer.setPixelRatio(embed ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  if (overlay || preview) renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
} catch (err) { renderer = null; }

const scene = new T.Scene();
// Overlay: no background and no fog (fog tints the edges toward its colour and leaves a halo on the desktop).
scene.background = overlay || preview ? null : new T.Color(0x12141c);
scene.fog = overlay || preview ? null : new T.Fog(0x12141c, 50, 150);
const camera = new T.PerspectiveCamera(50, 1, 0.1, 400);
scene.add(new T.HemisphereLight(0xfff4ea, 0x6b5a50, 1.15));
const sun = new T.DirectionalLight(0xffffff, 1.0);
sun.position.set(12, 26, 16);
scene.add(sun);

function canvasTex(w, h, draw) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  draw(cv.getContext('2d'), w, h);
  const t = new T.CanvasTexture(cv); t.colorSpace = T.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
const radialTex = (rgb, a0) => canvasTex(64, 64, (c) => {
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, `rgba(${rgb},${a0})`); g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g; c.fillRect(0, 0, 64, 64);
});
const glyphTex = (ch, col) => canvasTex(64, 64, (c) => {
  c.font = `bold 50px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.lineWidth = 6; c.strokeStyle = 'rgba(0,0,0,.55)'; c.strokeText(ch, 32, 34);
  c.fillStyle = col; c.fillText(ch, 32, 34);
});
const gateTex = canvasTex(64, 64, (c) => {
  c.strokeStyle = '#bcd0ff'; c.lineWidth = 5; c.shadowColor = '#7aa2ff'; c.shadowBlur = 8;
  c.strokeRect(10, 6, 44, 52);
  c.beginPath(); c.moveTo(10, 32); c.lineTo(54, 32); c.stroke();
});

const grid = new T.GridHelper(240, 120, 0x2b3150, 0x1c2136);
grid.visible = !overlay && !preview;
scene.add(grid);
const disc = new T.Mesh(new T.CircleGeometry(46, 48).rotateX(-Math.PI / 2),
  new T.MeshBasicMaterial({ map: radialTex('90,100,160', 0.38), transparent: true, depthWrite: false, fog: false }));
disc.position.y = -0.02; disc.visible = !overlay && !preview; scene.add(disc);

/* shared geometry / material */
const BOX = new T.BoxGeometry(1, 1, 1);
const FLAT = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const RING = new T.RingGeometry(0.8, 1, 40).rotateX(-Math.PI / 2);
const M = {
  eye: new T.MeshLambertMaterial({ color: 0x1b1410, flatShading: true }),
  xeye: new T.MeshLambertMaterial({ color: 0x3a0d0d, flatShading: true }),
  page: new T.MeshLambertMaterial({ color: 0xf4f1e8, flatShading: true }),
  ink: new T.MeshBasicMaterial({ color: 0x59506b }),
  hat: new T.MeshLambertMaterial({ color: 0x8e5bd6, flatShading: true }),
  plan: new T.MeshLambertMaterial({ color: 0x9b6bff, emissive: 0x2a1760, flatShading: true }),
  doc: new T.MeshLambertMaterial({ color: 0xffd75e, emissive: 0x4a3a00, flatShading: true }),
  code: new T.MeshLambertMaterial({ color: 0x9aa3b5, emissive: 0x1a1d25, flatShading: true }),
  codeIn: new T.MeshLambertMaterial({ color: 0xc6cddc, flatShading: true }),
  shadow: new T.MeshBasicMaterial({ map: radialTex('0,0,0', 0.5), transparent: true, depthWrite: false, fog: false }),
  sel: new T.MeshBasicMaterial({ color: 0x7ee0ff, transparent: true, opacity: 0.85, depthWrite: false, side: T.DoubleSide }),
};
const GLYPH = { z: glyphTex('z', '#bcd0ff'), q: glyphTex('?', '#ffe08a'), bang: glyphTex('!', '#ffb36b') };
GLYPH.hurt = glyphTex('!', '#ff3355');
// the pack-problem badge: a small round chip with a "!", red for an error, amber for warnings only
const badgeTex = (col) => canvasTex(64, 64, (c) => {
  c.beginPath(); c.arc(32, 32, 24, 0, 6.2832); c.fillStyle = col; c.fill();
  c.lineWidth = 5; c.strokeStyle = 'rgba(24,12,12,.7)'; c.stroke();
  c.font = `bold 38px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#fff'; c.fillText('!', 32, 35);
});
GLYPH.packErr = badgeTex('#e5484d'); GLYPH.packWarn = badgeTex('#f0a020');
// pink heart and red anger mark for the pet / pinch reactions (shared by every crab)
const HEART_TEX = canvasTex(64, 64, (c) => {
  c.translate(32, 34);
  c.beginPath(); c.moveTo(0, 22); c.bezierCurveTo(-34, -2, -22, -26, 0, -10); c.bezierCurveTo(22, -26, 34, -2, 0, 22); c.closePath();
  c.lineWidth = 5; c.lineJoin = 'round'; c.strokeStyle = 'rgba(120,10,50,.85)'; c.stroke();
  c.fillStyle = '#ff5c9a'; c.fill();
  c.fillStyle = 'rgba(255,255,255,.6)'; c.beginPath(); c.ellipse(-12, -9, 6, 4, -0.6, 0, 6.2832); c.fill();
});
const ANGER_TEX = canvasTex(64, 64, (c) => {
  c.translate(32, 32); c.lineCap = 'round';
  [['rgba(70,0,10,.9)', 12], ['#ff2d3d', 7]].forEach(([col, w]) => {
    c.strokeStyle = col; c.lineWidth = w;
    for (let i = 0; i < 4; i++) { c.save(); c.rotate(i * Math.PI / 2); c.beginPath(); c.arc(-17, -17, 14, 0.1, Math.PI / 2 - 0.1); c.stroke(); c.restore(); }
  });
});
// yellow star and blue sweat drop for the shaken / dizzy crab
const STAR_TEX = canvasTex(64, 64, (c) => {
  c.translate(32, 33); c.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 27, an = -Math.PI / 2 + i * Math.PI / 5; c.lineTo(Math.cos(an) * r, Math.sin(an) * r); }
  c.closePath(); c.lineWidth = 5; c.lineJoin = 'round'; c.strokeStyle = 'rgba(120,80,0,.9)'; c.stroke(); c.fillStyle = '#ffe14d'; c.fill();
});
const DROP_TEX = canvasTex(64, 64, (c) => {
  c.beginPath(); c.moveTo(32, 6); c.bezierCurveTo(48, 28, 52, 38, 44, 50); c.bezierCurveTo(38, 60, 26, 60, 20, 50); c.bezierCurveTo(12, 38, 16, 28, 32, 6); c.closePath();
  c.lineWidth = 5; c.strokeStyle = 'rgba(10,60,120,.9)'; c.stroke(); c.fillStyle = '#7fd4ff'; c.fill();
  c.fillStyle = 'rgba(255,255,255,.65)'; c.beginPath(); c.ellipse(26, 40, 4, 7, 0.4, 0, 6.2832); c.fill();
});
// a soft grey-white puff for the character swap
const SMOKE_TEX = radialTex('238,240,247', 0.95);
const TINT = { failed: new T.Color(0xc42f2f), done: new T.Color(0x7a6a64), killed: new T.Color(0x6b6b6b), dim: new T.Color(0x8a7f78) };

/* ---------------------------------------------------------------- labels */
function fit(ctx, text, maxW) {
  text = String(text == null ? '' : text);
  if (ctx.measureText(text).width <= maxW) return text;
  while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
  return text + '…';
}
function makeLabel(w, h, worldH) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
  const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false });
  const sp = new T.Sprite(mat); sp.center.set(0.5, 0); sp.renderOrder = 10;
  sp.scale.set(worldH * w / h, worldH, 1);
  // Labels are unreadable at the terminal's few pixels: the embedded view draws none.
  if (embed) mat.opacity = 0;
  // The pet shows no name tags (a few pixels per crab): the hover card names things, the speech bubble says what they do.
  if (overlay || preview) sp.visible = false;
  return { cv, tex, mat, sp };
}
function paintLabel(L, l1, l2, dot, big) {
  const c = L.cv.getContext('2d'), w = L.cv.width, h = L.cv.height;
  c.clearRect(0, 0, w, h);
  c.fillStyle = 'rgba(14,16,24,.78)';
  c.beginPath(); c.roundRect ? c.roundRect(3, 3, w - 6, h - 6, h * 0.22) : c.rect(3, 3, w - 6, h - 6); c.fill();
  c.strokeStyle = 'rgba(255,255,255,.14)'; c.lineWidth = 2; c.stroke();
  const f1 = big ? h * 0.38 : h * 0.5, f2 = h * 0.3, px = h * 0.34;
  c.textBaseline = 'middle'; c.textAlign = 'left';
  if (dot) { c.fillStyle = dot; c.beginPath(); c.arc(px, big ? h * 0.33 : h / 2, h * 0.09, 0, 6.2832); c.fill(); }
  c.font = `600 ${f1}px ${FONT}`; c.fillStyle = '#f3f5fb';
  const x0 = dot ? px + h * 0.17 : h * 0.22;
  c.fillText(fit(c, l1, w - x0 - h * 0.2), x0, big ? h * 0.33 : h / 2);
  if (l2) { c.font = `${f2}px ${FONT}`; c.fillStyle = '#aab2c6'; c.fillText(fit(c, l2, w - h * 0.5), h * 0.22, h * 0.72); }
  L.tex.needsUpdate = true;
}

/* ---------------------------------------------------------------- crab */
const POSE_KEYS = ['by', 'rx', 'ry', 'rz', 'aL', 'aR', 'aLx', 'aRx', 'l0', 'l1', 'l2', 'l3', 'eyeX', 'eyeSY', 'sq'];
const P = {};

// A stable colour per session, from a hash of its id (or of the folder name when there is no id)
const sessionHue = () => hash(petSession || (lastSnap && lastSnap.session && lastSnap.session.cwd) || 'crew') % 360;
const sessionHsl = (l) => 'hsl(' + sessionHue() + ',70%,' + l + '%)';
function sessionRgb() { const c = new T.Color(); c.setHSL(sessionHue() / 360, 0.7, 0.6); return `${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)}`; }
/* ---------------------------------------------------------------- characters: one rig, many looks */
// A character is a set of named bones (CC.RIG) with boxes (a voxel character: window.__crewCharacters, window.__crewUserCharacters)
// or a skinned GLB whose nodes carry those names. All animation below sets bones by name and skips the ones a character lacks.
const CC = window.CrewCharCore;
const PC = window.CrewPetCore;
let PS = PC.sanitize(null);   // the pet settings (overlay/main.js owns them and tells every window); the defaults in a browser
const autoState = { locks: new Map() }; // `auto`: an agent keeps the character it was first given
const CHARS = new Map();      // id -> record { id, name, kind: 'voxel' | 'glb', user, def, glb, state, gltf }
let charIds = [];             // every declared id, built-ins first (the pool for the stable hash pick)
let charRules = CC.parseRules(params.get('chars') || (params.get('demo') === 'tasks' ? 'main=crab, *=auto' : '')); // [[who, id], ...]: ?chars= here, the snapshot's `chars` when it brings one
let charSig = '';
const DEFAULT_GAIT = { legL1: 0, legL2: 1, legL3: 2, legR3: 1, legR2: 2, legR1: 3 };
const boneOf = (o) => ({ o, px: o.position.x, py: o.position.y, pz: o.position.z, rx: o.rotation.x, ry: o.rotation.y, rz: o.rotation.z, qa: null, qb: null, kpos: 1, });

const glbKeep = new Map();   // id|rev -> the record of a GLB already loaded, so a reload of the manifest does not parse it again
/* ---- pack problems: what the mod's scan says about each file (window.__crewUserPacks) plus what only this page sees (a GLB's load) */
const PACKS = new Map();     // id -> { file, id, kind, problems } of a user pack that loaded
const FAILED = new Map();    // lower-case id -> the same for a file that did not load (the id it would have had)
let packVer = 0;             // bumped whenever any of this changes: the badges look again
function loadPacks() {
  PACKS.clear(); FAILED.clear();
  (window.__crewUserPacks || []).forEach((p) => {
    if (!p || typeof p.id !== 'string' || !Array.isArray(p.problems)) return;
    const rec = CHARS.get(p.id);
    if (rec && rec.user) PACKS.set(p.id, p); else if (!rec) FAILED.set(p.id.toLowerCase(), p);
  });
  packVer++;
}
/* the problems of a loaded user character, worst first: the scan's (without a scan, a lint of its JSON) and the page's own (a GLB) */
function problemsOf(id) {
  const rec = CHARS.get(id);
  if (!rec || !rec.user) return [];
  const mine = rec.pageProblems || [], p = PACKS.get(id);
  const base = (p ? p.problems : rec.raw ? CC.lintVoxel(rec.raw) : []).filter((x) => !(x.code === 'glb-large' && mine.some((y) => y.code === 'glb-too-big')));
  return CC.sortProblems(base.concat(mine));
}
function glbCheck(g) {
  const names = []; g.scene.traverse((o) => { if (o !== g.scene && o.name) names.push(o.name); });
  return CC.glbProblems({ empty: new T.Box3().setFromObject(g.scene, true).isEmpty(), names });
}
function loadCharacters() {
  const was = charIds.join();
  CHARS.clear();
  const add = (raw, user) => {
    try {
      if (!raw || typeof raw !== 'object') return;
      if (raw.glb || raw.kind === 'glb') {
        const id = String(raw.id || '');
        if (!CC.CHAR_ID.test(id)) return;
        const old = glbKeep.get(id + '|' + (raw.rev || ''));
        CHARS.set(id, old || { id, name: String(raw.name || id).slice(0, 60), kind: 'glb', user: true, glb: { file: String(raw.glb && raw.glb.file || raw.file || ''), parts: +(raw.glb && raw.glb.parts || raw.parts) || 0, bytes: +(raw.glb && raw.glb.bytes) || 0, rev: String(raw.rev || '') }, state: 'idle', gltf: null });
        glbKeep.set(id + '|' + (raw.rev || ''), CHARS.get(id));
        return;
      }
      const r = CC.normalizeDef(raw.json || raw);
      if (!r.def) { if (window.console) console.warn('crew-graph character ' + (raw.file || raw.id || '?') + ': ' + r.warnings.join('; ')); return; }
      if (r.warnings.length && window.console) console.warn('crew-graph character ' + r.def.id + ': ' + r.warnings.join('; '));
      CHARS.set(r.def.id, { id: r.def.id, name: r.def.name, kind: 'voxel', user, def: r.def, state: 'ready', traits: r.def.traits || [], raw: user ? (raw.json || raw) : null });
    } catch (err) { if (window.console) console.warn('crew-graph character skipped', err); }
  };
  (window.__crewCharacters || []).forEach((r) => add(r, false));
  (window.__crewUserCharacters || []).forEach((r) => add(r, true));
  if (!CHARS.has('crab')) CHARS.set('crab', { id: 'crab', name: 'crab', kind: 'voxel', user: false, def: CC.normalizeDef({ id: 'crab', bones: { body: { boxes: [{ size: [7, 3, 4], at: [0, 2, 0], color: '#e0855e' }] } } }).def, state: 'ready' });
  // The built-ins first in their own order, then the user's by name: the pool for the hash pick stays put when a pack is added.
  charIds = [...CHARS.keys()].sort((x, y) => (CHARS.get(x).user - CHARS.get(y).user) || (CHARS.get(x).user ? (x < y ? -1 : 1) : 0));
  const builtin = (window.__crewCharacters || []).map((d) => d && d.id).filter((id) => CHARS.has(id));
  charIds = [...new Set([...builtin, ...charIds])];
  loadPacks();
  return was !== charIds.join();
}

const autoChars = () => charIds.map((id) => ({ id, traits: (CHARS.get(id) || {}).traits || [] }));
// Which character an agent gets, and why: its own entry in the pet settings, the settings' type rules, the mod's `characters` option, the default.
function charPickFor(d) {
  if (params.get('demo') === 'lineup' && CHARS.has(d.type)) return { id: d.type, how: 'lineup', mode: 'set', why: null };
  if (d.pvChar) return { id: d.pvChar, how: 'preview', mode: 'set', why: null };
  return PC.resolve(PS, charRules, d, { ids: charIds, auto: (q) => CC.autoPick(autoChars(), q, autoState), session: petSession }) || { id: 'crab', how: 'legacy', mode: 'set', why: null };
}
const charIdFor = (d) => charPickFor(d).id;
const typeKeyOf = (a) => (a.id === 'main' ? 'main' : a.d.type || a.id);
/* The pack behind an agent's character, when it has problems: { id, file, problems, level, fallback }. `fallback`: the agent is not drawn as the
   pack it was given (a model that failed to load, a pack that did not load, so a crab or another character stands in). Cached per agent. */
function packInfo(a) {
  const miss = a.pick && a.pick.miss;
  if (a.pkV === packVer && a.pkCh === a.chId && a.pkWant === a.wantId && a.pkMiss === miss) return a.pk;
  a.pkV = packVer; a.pkCh = a.chId; a.pkWant = a.wantId; a.pkMiss = miss;
  const want = CHARS.get(a.wantId), gone = miss != null && !CHARS.has(miss) ? FAILED.get(String(miss).toLowerCase()) : null;
  let id = a.chId, problems = null, fallback = false, file = '';
  if (gone) { id = gone.id; file = gone.file; problems = gone.problems; fallback = true; }
  else if (want && want.user && want.id !== a.chId && want.state !== 'loading' && want.state !== 'idle') {
    const wp = problemsOf(want.id);
    if (CC.statusOf(wp) === 'error') { id = want.id; problems = wp; fallback = true; }
  }
  if (!problems) problems = problemsOf(id);
  if (!file) file = (PACKS.get(id) || {}).file || '';
  return (a.pk = problems.length ? { id, file, problems: CC.sortProblems(problems), level: CC.statusOf(problems), fallback } : null);
}
/* the same, unless it is only warnings and the pet setting hides those (a red badge always shows) */
const packBadge = (a) => { if (preview) return null; const pk = packInfo(a); return pk && CC.badgeOf(pk.problems, PS.show.packWarnings === false) ? pk : null; };
/* the lines a card or tooltip shows for it (plain text): the first `max` problems, then how many more */
function packText(pk, max, where) {
  const cl = CC.cardLines(pk.problems, max);
  return [pk.fallback ? 'Pack ' + (pk.file || pk.id) + ' failed, so another character stands in' : 'Pack problems' + (pk.file ? ' \u00b7 ' + pk.file : '')]
    .concat(cl.lines.map((p) => (p.level === 'error' ? '\u25cf ' : '\u25b2 ') + p.text)).concat(cl.more ? ['+' + cl.more + ' more \u00b7 ' + where] : []);
}
// The agents whose character is not the one their rules ask for (a pack arrived, the rules changed) are redrawn.
function reskinAll() {
  agents.forEach((a) => { const pk = charPickFor(a.d); a.pick = pk; if (a.wantId !== pk.id) { a.wantId = pk.id; } mountWanted(a); });
}
function mountWanted(a) {
  const rec = CHARS.get(a.wantId || 'crab') || CHARS.get('crab');
  if (a.swap) { a.swap.rec = rec; if (a.swap.done) mountChar(a, rec); return; } // changed again in the middle of a swap
  if (a.chId === rec.id) return;
  if (rec.kind === 'glb') { ensureGlb(rec); if (rec.state !== 'ready') { if (!a.ch) mountChar(a, CHARS.get('crab')); return; } }
  // A character that is already on show changes with a little show: spin away, a puff of smoke, the new one pops in.
  if (a.ch && a.chId && overlay && !PS.reduceMotion) { a.swap = { t0: nowS(), rec, done: false }; busyUntil = Math.max(busyUntil, nowS() + 1.2); kick(); return; }
  mountChar(a, rec);
}
const SWAP_SHRINK = 0.22, SWAP_END = 0.7;
// -> { k: size factor, spin: extra turn about y } while a swap runs, else null. Halfway (the character is gone) the new one is built.
function swapStep(a, now) {
  const S = a.swap;
  if (!S) return null;
  const u = now - S.t0;
  if (!S.done && u >= SWAP_SHRINK) {
    S.done = true;
    for (let i = 0; i < 6; i++) spawnRfx('puff', a, i * 0.015);
    mountChar(a, S.rec);
    a.born = now; // the pop-in of a new arrival
  }
  if (u >= SWAP_END) { a.swap = null; return null; }
  return { k: u < SWAP_SHRINK ? 1 - 0.85 * easeIO(u / SWAP_SHRINK) : 1, spin: Math.PI * 2 * easeIO(clamp(u / 0.5, 0, 1)) };
}

/* ---- GLB: the bytes come as base64 script parts written by the mod (characters-glb/<id>.<n>.js), else from the file itself */
const glbParts = {};
window.__crewGlbPart = (id, n, b64) => { (glbParts[id] = glbParts[id] || [])[n] = String(b64 || ''); };
function ensureGlb(rec) {
  if (rec.state !== 'idle') return;
  rec.state = 'loading';
  const fail = (why) => {
    rec.state = 'error'; rec.err = why; if (window.console) console.warn('crew-graph glb ' + rec.id + ': ' + why);
    rec.pageProblems = CC.glbProblems({ error: why, big: rec.glb.bytes > 4 * 1048576 && !(rec.glb.parts > 0) }); packVer++; kick();
  };
  const parse = (buf) => {
    if (!T.GLTFLoader) return fail('GLTFLoader is not loaded');
    try {
      new T.GLTFLoader().parse(buf, '', (g) => { rec.gltf = g; rec.state = 'ready'; rec.pageProblems = glbCheck(g); packVer++; reskinAll(); }, (e) => fail(String(e && e.message || e)));
    } catch (e) { fail(String(e && e.message || e)); }
  };
  const fromFile = () => {
    if (!rec.glb.file) return fail('no data and no file');
    const x = new XMLHttpRequest();
    x.open('GET', rec.glb.file + '?t=' + Date.now()); x.responseType = 'arraybuffer';
    x.onload = () => { if ((x.status === 200 || x.status === 0) && x.response && x.response.byteLength) { rec.via = 'file'; parse(x.response); } else fail('cannot read ' + rec.glb.file + ' (' + x.status + ')'); };
    x.onerror = () => fail('cannot read ' + rec.glb.file + ' from this page');
    x.send();
  };
  const n = rec.glb.parts;
  if (!(n > 0)) return fromFile();
  let left = n;
  const done = () => {
    if (--left > 0) return;
    const parts = glbParts[rec.id] || [];
    if (parts.length !== n || parts.some((p) => !p)) return fromFile();
    try {
      const bin = atob(parts.join('')), u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      rec.via = 'base64'; delete glbParts[rec.id];
      parse(u8.buffer);
    } catch (e) { fail('bad base64 data'); }
  };
  for (let i = 0; i < n; i++) {
    const sc = document.createElement('script');
    sc.src = 'characters-glb/' + rec.id + '.' + i + '.js?r=' + encodeURIComponent(rec.glb.rev);
    sc.onload = () => { sc.remove(); done(); }; sc.onerror = () => { sc.remove(); done(); };
    document.head.appendChild(sc);
  }
}
// SkeletonUtils.clone, for a skinned model each agent needs its own copy of
function cloneSkinned(source) {
  const srcOf = new Map(), cloneOf = new Map(), clone = source.clone();
  const walk = (a, b) => { srcOf.set(b, a); cloneOf.set(a, b); for (let i = 0; i < a.children.length; i++) walk(a.children[i], b.children[i]); };
  walk(source, clone);
  clone.traverse((n) => {
    if (!n.isSkinnedMesh) return;
    const s = srcOf.get(n);
    n.skeleton = s.skeleton.clone();
    n.bindMatrix.copy(s.bindMatrix);
    n.skeleton.bones = s.skeleton.bones.map((bn) => cloneOf.get(bn));
    n.bind(n.skeleton, n.bindMatrix);
  });
  return clone;
}

/* ---- building a character into the agent's body group */
function newChar(rec) {
  return { id: rec.id, rec, b: {}, tinted: [], mats: [], eyes: { eyeL: null, eyeR: null }, legs: [], glb: false, armBase: 0, travel: 1, scale: 1, top: 4.7, crown: 4.7, bw: 7, hitY: 2.35, hitR: 1, shadow: [8.5, 6.5], ringR: 6.8,
    page: [0, 2.5, 3.2], hat: [0, 5.05, 0], hatS: 1, anten: [0, 5.9, 0], antenSp: 1.5, sleepyEyes: false, base: new T.Color(0xe0855e), disp: [], skel: [] };
}
function clearChar(a) {
  const ch = a.ch; if (!ch) return;
  while (a.body.children.length) a.body.remove(a.body.children[0]);
  ch.mats.forEach((m) => m.dispose());
  ch.skel.forEach((s) => s.dispose());
  if (a.pageMat) a.pageMat.dispose();
  if (a.tipMat) a.tipMat.dispose();
  a.ch = null;
}
function genEyes(open) { // default expression boxes for the left eye from its open boxes
  const o = open[0] || { size: [1, 1, 0.3], color: '#222222' }, w = o.size[0], h = o.size[1], d = o.size[2];
  const t = Math.max(0.2, Math.min(w, h) * 0.32 + 0.04), len = Math.max(w, h) * 1.15, ex = { unlit: o.unlit, fixed: o.fixed };
  const bx = (sz, at, rot, col) => Object.assign({ size: sz, at, rot: [0, 0, rot], color: col || o.color }, ex);
  const out = {
    x: [bx([len, t, d], [0, 0, 0.03], 0.785, o.unlit ? '#ff5c5c' : '#3a0d0d'), bx([len, t, d], [0, 0, 0.03], -0.785, o.unlit ? '#ff5c5c' : '#3a0d0d')],
    squint: [bx([w * 1.2, t, d], [-0.1 * w, -0.25 * h, 0.03], 0.55), bx([w * 1.2, t, d], [-0.1 * w, 0.25 * h, 0.03], -0.55)],
    happy: [bx([w, t, d], [-0.38 * w, -0.04 * h, 0.03], 0.7), bx([w, t, d], [0.38 * w, -0.04 * h, 0.03], -0.7)],
    dizzy: [],
  };
  const R0 = Math.max(w, h) * 0.52;
  for (let i = 0; i < 8; i++) { const an = i * 1.1, r = R0 * (0.12 + 0.125 * i); out.dizzy.push(bx([t * 0.85, t * 0.85, d], [Math.cos(an) * r, Math.sin(an) * r, 0.03], 0)); }
  return out;
}
function buildVoxel(a, rec) {
  const def = rec.def, isMain = a.d.id === 'main', ch = newChar(rec);
  ch.scale = def.scale; ch.travel = def.travel != null ? def.travel : 1;
  const col = ch.base;
  if (def.base) col.setHSL((def.base.h + (isMain || !def.base.spread ? 0 : (CC.hash(a.d.type) % (2 * def.base.spread + 1)) - def.base.spread)) / 360, def.base.s, def.base.l);
  else { const f = Object.values(def.bones).flatMap((bd) => bd.boxes).find((x) => x.color !== '@base' && !x.unlit); col.set(f ? f.color : '#c9c4d4'); }
  const cache = new Map();
  const matOf = (bx, eye) => {
    const hex = bx.color === '@base' ? null : bx.color, fixed = bx.unlit || (bx.fixed !== undefined ? bx.fixed : eye);
    const key = (bx.unlit ? 'u' : fixed ? 'f' : 't') + (hex || '@');
    let m = cache.get(key);
    if (m) return m;
    if (bx.unlit) m = new T.MeshBasicMaterial({ color: new T.Color(hex || '#ffffff') });
    else {
      m = new T.MeshLambertMaterial({ color: hex ? new T.Color(hex) : col.clone(), flatShading: true });
      if (!fixed) ch.tinted.push({ m, base: hex ? new T.Color(hex) : col }); // '@base' follows a.base, which the links read too
    }
    ch.mats.push(m); cache.set(key, m);
    return m;
  };
  const addBox = (bx, parent, eye) => {
    const o = new T.Mesh(BOX, matOf(bx, eye));
    o.scale.set(bx.size[0], bx.size[1], bx.size[2]); o.position.set(bx.at[0], bx.at[1], bx.at[2]);
    if (bx.rot) o.rotation.set(bx.rot[0], bx.rot[1], bx.rot[2]);
    parent.add(o);
  };
  const flip = (bx) => Object.assign({}, bx, { at: [-bx.at[0], bx.at[1], bx.at[2]], rot: bx.rot ? [bx.rot[0], -bx.rot[1], -bx.rot[2]] : undefined });
  const wp = { root: [0, 0, 0], body: [0, 0, 0] }, lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9], cr = [-1e9], bwx = [1e9, -1e9];
  const track = (n, bx) => {
    const c = [wp[n][0] + bx.at[0], wp[n][1] + bx.at[1], wp[n][2] + bx.at[2]];
    for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], c[i] - bx.size[i] / 2); hi[i] = Math.max(hi[i], c[i] + bx.size[i] / 2); }
    if (n !== 'earL' && n !== 'earR' && n !== 'tail') cr[0] = Math.max(cr[0], c[1] + bx.size[1] / 2);
    if (n === 'body' || n === 'head') { bwx[0] = Math.min(bwx[0], c[0] - bx.size[0] / 2); bwx[1] = Math.max(bwx[1], c[0] + bx.size[0] / 2); }
  };
  ch.b.root = boneOf(a.root); ch.b.body = boneOf(a.body);
  def.bones.body.boxes.forEach((bx) => { addBox(bx, a.body, false); track('body', bx); });
  const todo = Object.keys(def.bones).filter((n) => n !== 'body' && n !== 'root');
  for (let guard = 0; todo.length && guard < 40; guard++) {
    for (let i = 0; i < todo.length; i++) {
      const n = todo[i], bd = def.bones[n], pn = bd.parent && def.bones[bd.parent] ? bd.parent : 'body';
      if (!ch.b[pn]) continue;
      const g = new T.Group(); g.position.set(bd.at[0], bd.at[1], bd.at[2]);
      if (bd.rot) g.rotation.set(bd.rot[0], bd.rot[1], bd.rot[2]);
      ch.b[pn].o.add(g);
      wp[n] = [wp[pn][0] + bd.at[0], wp[pn][1] + bd.at[1], wp[pn][2] + bd.at[2]];
      const bone = ch.b[n] = boneOf(g);
      const eye = n === 'eyeL' || n === 'eyeR';
      let open = g;
      if (eye) { open = new T.Group(); g.add(open); ch.eyes[n] = { bone, open, v: {} }; }
      bd.boxes.forEach((bx) => { addBox(bx, open, eye); track(n, bx); });
      if (/^leg[LR]\d$/.test(n)) ch.legs.push({ b: bone, g: bd.gait != null ? bd.gait : DEFAULT_GAIT[n] });
      todo.splice(i--, 1);
    }
  }
  // expressions: the character's own boxes where it gave them, generated ones where it did not (sleepy only when given)
  const baseOpen = (def.bones.eyeL || def.bones.eyeR || { boxes: [] }).boxes;
  const gen = genEyes(baseOpen), ev = {};
  CC.EYE_VARIANTS.forEach((k) => { ev[k] = def.eyes[k] || gen[k]; });
  ch.sleepyEyes = !!def.eyes.sleepy;
  ['eyeL', 'eyeR'].forEach((n) => {
    const e = ch.eyes[n]; if (!e) return;
    CC.EYE_VARIANTS.forEach((k) => {
      if (!ev[k]) return;
      const grp = new T.Group(); grp.visible = false; e.bone.o.add(grp);
      ev[k].forEach((bx) => addBox(n === 'eyeR' ? flip(bx) : bx, grp, true));
      e.v[k] = grp;
    });
  });
  ch.top = hi[1]; ch.crown = cr[0]; ch.bw = Math.max(1, bwx[1] - bwx[0]);
  const wid = hi[0] - lo[0], dep = hi[2] - lo[2];
  ch.hitY = def.hit && def.hit.y != null ? def.hit.y : ch.top * 0.5;
  ch.hitR = def.hit && def.hit.r != null ? def.hit.r : clamp((wid / 11.2 + ch.top / 4.7) / 2, 0.6, 1.5);
  ch.shadow = def.shadow || [clamp(wid * 0.85, 5.5, 14), clamp(dep * 1.25, 5, 10)];
  ch.ringR = clamp(Math.max(ch.shadow[0], ch.shadow[1]) * 0.8, 5, 12);
  const pr = def.props || {}, hw = ch.bw;
  ch.page = pr.page ? pr.page.at : [0, ch.top * 0.5, hi[2] + 1];
  ch.hat = pr.hat ? pr.hat.at : [0, ch.crown + 0.35, 0]; ch.hatS = pr.hat ? pr.hat.s : clamp(hw / 7, 0.6, 1.3);
  ch.anten = pr.anten ? pr.anten.at : [0, ch.crown + 1.2, 0]; ch.antenSp = pr.anten ? pr.anten.spread : hw * 0.214;
  ch.wp = wp;
  return ch;
}
function buildGlb(a, rec) {
  const ch = newChar(rec), clone = cloneSkinned(rec.gltf.scene);
  ch.glb = true; ch.armBase = 0.25; ch.travel = 0.6;
  const fit = new T.Group(); fit.add(clone); // measured on its own: not yet in the agent, whose world transform would leak into the numbers
  fit.updateMatrixWorld(true);
  const names = []; clone.traverse((o) => { if (o !== clone && o.name) names.push(o.name); });
  const mt = CC.matchRig(names), node = new Map();
  clone.traverse((o) => { if (o.name && !node.has(o.name)) node.set(o.name, o); });
  const box = new T.Box3().setFromObject(clone, true);
  if (box.isEmpty()) return buildVoxel(a, CHARS.get('crab'));
  // a model that faces -z (its eyes are behind its middle) is turned around
  const eyeZ = ['eyeL', 'eyeR'].map((n) => node.get(mt.bones[n])).filter(Boolean).map((o) => new T.Vector3().setFromMatrixPosition(o.matrixWorld).z);
  const flipY = eyeZ.length && (eyeZ.reduce((x, y) => x + y, 0) / eyeZ.length) < (box.min.z + box.max.z) / 2 - 0.02 * (box.max.z - box.min.z);
  if (flipY) { clone.rotation.y = Math.PI; fit.updateMatrixWorld(true); box.setFromObject(clone, true); }
  const sz = box.getSize(new T.Vector3()), ct = box.getCenter(new T.Vector3());
  const k = Math.min(7.5 / Math.max(sz.x, sz.z, 1e-6), 6.5 / Math.max(sz.y, 1e-6));
  fit.scale.setScalar(k);
  clone.position.set(clone.position.x - ct.x, clone.position.y - box.min.y, clone.position.z - ct.z);
  fit.updateMatrixWorld(true);
  // each rig bone: where its parent sits relative to the model, so a turn about the character's axes can be mapped into the bone's own frame
  const inv = new T.Matrix4().copy(clone.matrixWorld).invert(), Fq = clone.quaternion.clone(), Fi = Fq.clone().invert();
  ch.b.root = boneOf(a.root); ch.b.body = boneOf(a.body);
  Object.keys(mt.bones).forEach((rg) => {
    const o = node.get(mt.bones[rg]); if (!o || rg === 'root' || rg === 'body') return;
    const bone = boneOf(o), pm = new T.Matrix4().multiplyMatrices(inv, o.parent ? o.parent.matrixWorld : clone.matrixWorld);
    const pp = new T.Vector3(), pq = new T.Quaternion(), ps = new T.Vector3();
    pm.decompose(pp, pq, ps);
    const q0 = o.quaternion.clone();
    bone.qa = pq.clone().invert().multiply(Fi);         // character frame -> this bone's parent frame
    bone.qb = Fq.clone().multiply(pq).multiply(q0);     // ... and back, with the bone's rest turn
    bone.kpos = 1 / (k * Math.max(1e-6, ps.x));
    bone.q0 = q0; bone.sx = o.scale.x; bone.sy = o.scale.y; bone.sz = o.scale.z;
    const wq = new T.Quaternion(); o.getWorldQuaternion(wq);
    bone.aligned = 2 * Math.acos(clamp(Math.abs(wq.w), 0, 1)) < 0.6; // its own axes line up with the model's: a blink can squash y alone
    ch.b[rg] = bone;
    if (/^leg[LR]\d$/.test(rg)) ch.legs.push({ b: bone, g: DEFAULT_GAIT[rg] });
  });
  ['eyeL', 'eyeR'].forEach((n) => {
    const bone = ch.b[n]; if (!bone) return;
    const e = ch.eyes[n] = { bone, open: null, v: {} };
    const vs = mt.variants[n] || {};
    CC.EYE_VARIANTS.forEach((kk) => { const o = vs[kk] && node.get(vs[kk]); if (o) { o.visible = false; e.v[kk] = o; } });
  });
  ch.sleepyEyes = !!(ch.eyes.eyeL && ch.eyes.eyeL.v.sleepy);
  // look: every material cloned (the agents tint them separately), metal tamed (no environment map here), no culling of skinned parts
  let basec = null;
  clone.traverse((o) => {
    if (o.isSkinnedMesh && o.skeleton) ch.skel.push(o.skeleton);
    if (!o.isMesh) return;
    o.frustumCulled = false;
    const list = Array.isArray(o.material) ? o.material : [o.material], out = list.map((m0) => {
      const m = m0.clone();
      if (m.metalness !== undefined) m.metalness = Math.min(m.metalness, 0.2);
      if (m.color) { ch.tinted.push({ m, base: m.color.clone() }); if (!basec && m.color.getHSL({ h: 0, s: 0, l: 0 }).l < 0.93) basec = m.color.clone(); }
      ch.mats.push(m);
      return m;
    });
    o.material = Array.isArray(o.material) ? out : out[0];
  });
  ch.base.copy(basec || new T.Color().setHSL((CC.hash(a.d.type) % 360) / 360, 0.5, 0.6));
  const w = sz.x * k, h = sz.y * k, d = sz.z * k;
  ch.top = h; ch.crown = h; ch.bw = Math.min(w, 7);
  ch.hitY = h * 0.5; ch.hitR = clamp((w / 11.2 + h / 4.7) / 2, 0.6, 1.5);
  ch.shadow = [clamp(w * 0.9, 5.5, 14), clamp(d * 1.3, 5, 10)]; ch.ringR = clamp(Math.max(ch.shadow[0], ch.shadow[1]) * 0.8, 5, 12);
  ch.page = [0, h * 0.5, d / 2 + 1]; ch.hat = [0, h + 0.35, 0]; ch.hatS = clamp(ch.bw / 7, 0.6, 1.3); ch.anten = [0, h + 1.2, 0]; ch.antenSp = ch.bw * 0.214;
  ch.wp = {};
  a.body.add(fit);
  return ch;
}
function mountChar(a, rec) {
  clearChar(a);
  const ch = rec.kind === 'glb' ? buildGlb(a, rec) : buildVoxel(a, rec);
  a.ch = ch; a.chId = ch.id; a.bn = ch.b; a.base = ch.base; a.cs = ch.scale; a.s = a.s0 * ch.scale; a.h = ch.hitY * a.s;
  // props: the page a reading crab holds, the architect's hat, the web antenna; they sit on the body (the hat and antenna on the head if there is one)
  const hd = ch.b.head && ch.wp.head ? ch.b.head.o : a.body, off = hd === a.body ? [0, 0, 0] : ch.wp.head;
  const V = (w, hh, dd, x, y, z, m, p) => { const o = new T.Mesh(BOX, m); o.scale.set(w, hh, dd); o.position.set(x, y, z); p.add(o); return o; };
  a.tipMat = new T.MeshBasicMaterial({ color: 0x66e6ff });
  a.anten = new T.Group(); a.anten.visible = false; a.anten.position.set(ch.anten[0] - off[0], ch.anten[1] - off[1], ch.anten[2] - off[2]); hd.add(a.anten);
  [-1, 1].forEach((sg) => { V(0.3, 1.8, 0.3, sg * ch.antenSp, 0, 0, ch.mats.length ? ch.mats[0] : M.eye, a.anten); V(0.7, 0.7, 0.7, sg * ch.antenSp, 1.1, 0, a.tipMat, a.anten); });
  a.hat = new T.Group(); a.hat.visible = !!a.d.isArchitect; a.hat.position.set(ch.hat[0] - off[0], ch.hat[1] - off[1], ch.hat[2] - off[2]); a.hat.scale.setScalar(ch.hatS); hd.add(a.hat);
  V(3.2, 0.7, 3.2, 0, 0, 0, M.hat, a.hat); V(2, 0.9, 2, 0, 0.75, 0, M.hat, a.hat); V(0.9, 0.7, 0.9, 0, 1.45, 0, M.hat, a.hat);
  a.page = new T.Group(); a.page.position.set(ch.page[0], ch.page[1], ch.page[2]); a.page.rotation.x = -0.35; a.page.visible = false; a.body.add(a.page);
  a.pageMat = M.page.clone();
  V(2.6, 3.2, 0.15, 0, 0, 0, a.pageMat, a.page);
  [0.9, 0.3, -0.3, -0.9].forEach((y) => V(1.8, 0.14, 0.05, 0, y, 0.1, M.ink, a.page));
  // the antenna's poles take the body colour
  if (ch.tinted.length) a.anten.children.forEach((o) => { if (o.material !== a.tipMat) o.material = ch.tinted[0].m; });
  a.shadow.scale.set(ch.shadow[0], 1, ch.shadow[1]); a.ring.scale.setScalar(ch.ringR);
}

function makeCrab(d) {
  const isMain = d.id === 'main';
  const s0 = isMain ? 0.42 : d.isArchitect ? 0.3 : 0.28;
  const root = new T.Group(), body = new T.Group();
  body.rotation.order = 'YXZ'; root.add(body);
  const shadow = new T.Mesh(FLAT, M.shadow); shadow.scale.set(8.5, 1, 6.5); shadow.position.y = 0.03; shadow.renderOrder = 1; root.add(shadow);
  const ring = new T.Mesh(RING, M.sel); ring.scale.setScalar(6.8); ring.position.y = 0.06; ring.visible = false; root.add(ring);
  // The main crab stands in a soft ring in its session's colour: windows of several sessions tell apart at a glance.
  if (overlay && isMain) {
    const sr = new T.Mesh(new T.CircleGeometry(1, 40).rotateX(-Math.PI / 2), new T.MeshBasicMaterial({ map: radialTex(sessionRgb(), 0.85), transparent: true, depthWrite: false, fog: false }));
    sr.scale.set(11, 1, 11); sr.position.y = 0.05; sr.renderOrder = 1; root.add(sr);
  }
  const spr = (g) => { const m = new T.SpriteMaterial({ map: g, transparent: true, depthTest: false, fog: false }); const sp = new T.Sprite(m); sp.visible = false; sp.renderOrder = 9; root.add(sp); return sp; };
  const fx = { z: [spr(GLYPH.z), spr(GLYPH.z), spr(GLYPH.z)], q: spr(GLYPH.q), bang: spr(GLYPH.bang), pack: spr(GLYPH.packWarn), orb: [spr(STAR_TEX), spr(STAR_TEX), spr(STAR_TEX)] };
  const label = makeLabel(512, 128, isMain ? 1.05 : 0.85);
  scene.add(label.sp);
  root.scale.setScalar(0.001);
  scene.add(root);
  const cur = {}; POSE_KEYS.forEach((k) => { cur[k] = 0; }); cur.eyeSY = 1; cur.sq = 1; cur.aL = cur.aR = -0.25;
  const a = { id: d.id, d, s0, s: s0, cs: 1, h: 2.7 * s0, root, body, shadow, ring, fx, label, labelKey: '', ch: null, chId: '', wantId: 'crab', bn: {}, base: new T.Color(), hat: null, page: null, pageMat: null, anten: null, tipMat: null,
    re: newReact(), mood: { pets: 0, pinches: 0 }, bub: overlay ? makeBubble() : null, look: 0, dim: 0, hiddenN: 0, chip: null, mo: 0, byPrev: 0, earV: 0, sp: newSprings(),
    pos: new T.Vector3(), tgt: new T.Vector3(), cur, enterT: nowS(), born: nowS(), lastVerb: '', bye: 0, byeDone: false, gone: false, goneAt: 0, tintF: 0, yaw: 0, ph: (hash(d.id) % 628) / 100, depth: 0, ang: 0, lv: 1 };
  a.pick = charPickFor(d); a.wantId = a.pick.id;
  mountWanted(a);
  if (!a.ch) mountChar(a, CHARS.get('crab')); // a GLB still loading: the crab stands in, then the model replaces it
  return a;
}

function effVerb(d) {
  const st = d.status;
  if (st === 'failed' || st === 'killed') return 'failed';
  if (st === 'completed') return 'done';
  if (st === 'pending' || st === 'waiting' || st === 'idle') return d.verb === 'think' && st !== 'idle' ? 'think' : 'wait';
  return d.verb || 'wait';
}

function poseTarget(v, t, lt) {
  for (const k of POSE_KEYS) P[k] = 0;
  P.eyeSY = 1; P.sq = 1; P.aL = P.aR = -0.25;
  const s = Math.sin;
  switch (v) {
    case 'think': P.by = 0.3 * s(t * 1.4); P.rz = 0.05 * s(t * 0.9); P.eyeSY = 0.55; P.aR = 0.3 + 0.1 * s(t * 1.4); P.eyeX = 0.3 * s(t * 0.7); break;
    case 'read': P.rx = 0.38; P.eyeX = 0.8 * s(t * 2.8); P.aL = P.aR = 0.3; P.by = 0.05 * s(t * 2); break;
    case 'edit': { const u = s(t * 11) > 0; P.aL = u ? 1.15 : -0.3; P.aR = u ? -0.3 : 1.15; P.by = 0.12 * Math.abs(s(t * 11)); P.rx = 0.12; P.eyeX = 0.2 * s(t * 3); break; }
    case 'search': P.ry = 0.7 * s(t * 1.8); P.eyeX = 0.8 * s(t * 3.6); P.aR = 0.45 + 0.3 * s(t * 3); P.rz = 0.05 * s(t * 1.8); break;
    case 'run': for (let i = 0; i < 4; i++) P['l' + i] = 0.55 * Math.max(0, s(t * 15 + i * 1.6)); P.by = 0.5 * Math.abs(s(t * 7.5)); P.aL = P.aR = 0.1 + 0.45 * s(t * 7.5); P.rx = 0.1; break;
    case 'web': P.eyeSY = s(t * 5) > 0.9 ? 0.12 : 1; P.by = 0.1 * s(t * 2); P.aL = 0.2 + 0.2 * s(t * 4); P.aR = 0.2 - 0.2 * s(t * 4); P.eyeX = 0.5 * s(t * 1.2); break;
    case 'spawn': P.by = 1.9 * Math.abs(s(t * 4.2)); P.aL = P.aR = 1.3; P.sq = 1 + 0.06 * s(t * 8.4); break;
    case 'plan': P.rx = 0.28; P.aR = 0.3 + 0.35 * s(t * 14); P.aRx = 0.4 * Math.cos(t * 11); P.aL = 0.2; P.eyeX = 0.5 * s(t * 1.5); break;
    case 'done':
      if (lt < 1.5) { P.by = 1.7 * Math.abs(s(lt * 4.2)); P.aL = P.aR = 1.2; }
      else { P.by = -0.45; P.sq = 0.93; P.aL = P.aR = -0.4; P.eyeSY = 0.45; for (let i = 0; i < 4; i++) P['l' + i] = 0.3; P.rx = 0.08; }
      break;
    case 'failed': { const k = Math.exp(-lt * 1.2); P.rx = -1.5; P.by = 2.05; P.rz = 0.14 * s(lt * 18) * k; P.aL = 0.9 + 0.5 * s(lt * 14) * k; P.aR = 0.9 - 0.5 * s(lt * 14) * k; for (let i = 0; i < 4; i++) P['l' + i] = 0.6 * k * Math.max(0, s(lt * 13 + i)); break; }
    default: P.by = 0.05 * s(t * 1.2); P.sq = 1 + 0.015 * s(t * 1.6);
  }
  if (v !== 'web' && v !== 'think' && v !== 'done' && v !== 'failed' && s(t * 0.9 + 1.3) > 0.985) P.eyeSY = 0.15;
}

const _qa = new T.Quaternion(), _ea = new T.Euler(), _va = new T.Vector3();
// A turn about the character's own axes (x right, y up, z forward); a voxel bone is axis-aligned, a GLB bone is mapped into its own frame.
function setRot(b, x, y, z) {
  if (!b) return;
  if (!b.qa) b.o.rotation.set(b.rx + x, b.ry + y, b.rz + z);
  else { _ea.set(x, y, z); _qa.setFromEuler(_ea); b.o.quaternion.copy(b.qa).multiply(_qa).multiply(b.qb); }
}
// A push in the same frame, in the crab's units.
function setOff(b, x, y, z) {
  if (!b) return;
  if (!b.qa) b.o.position.set(b.px + x, b.py + y, b.pz + z);
  else { _va.set(x, y, z).applyQuaternion(b.qa).multiplyScalar(b.kpos); b.o.position.set(b.px + _va.x, b.py + _va.y, b.pz + _va.z); }
}
// An eye: the mode picks which set of boxes (or nodes) is shown; `open` is blinked by scaling it.
function showEye(e, mode, esy, now, sg) {
  const v = e.v;
  if (e.open) { // a voxel eye: groups of boxes
    e.open.visible = mode === 'open'; e.open.scale.y = esy;
    for (const k in v) v[k].visible = k === mode;
    if (mode === 'dizzy' && v.dizzy) v.dizzy.rotation.z = -sg * now * 9;
    return;
  }
  const b = e.bone, vv = v[mode], closed = mode === 'open' ? esy : mode === 'dizzy' ? 0.3 + 0.7 * Math.abs(Math.sin(now * 9)) : mode === 'x' ? 0.05 : 0.14;
  for (const k in v) v[k].visible = k === mode;
  const sy = vv ? 0.02 : closed;
  if (b.aligned) b.o.scale.set(b.sx, b.sy * sy, b.sz); else { const u = Math.sqrt(sy); b.o.scale.set(b.sx * u, b.sy * u, b.sz * u); }
  if (vv && mode === 'dizzy') vv.rotation.z = -sg * now * 9;
}

function updateCrab(a, dt, t, camPos) {
  const now = nowS(), sw = swapStep(a, now), ch = a.ch, B = a.bn;
  const v = effVerb(a.d);
  if (v !== a.lastVerb) { a.lastVerb = v; a.enterT = now; }
  const lt = now - a.enterT, tt = t + a.ph;
  poseTarget(v, tt, lt);
  const rate = 1 - Math.exp(-dt * (v === 'failed' ? 5 : 11)), c = a.cur;
  for (const k of POSE_KEYS) c[k] += (P[k] - c[k]) * rate;
  // pet / pinch reactions ride on top of the smoothed pose and never write into it
  const R = reactCrab(a, v, dt, now);
  a.body.position.y = c.by + R.by;
  a.body.rotation.set(c.rx + R.rx, c.ry + R.ry, c.rz + R.rz);
  const sxz = 1 + (1 - R.sy) * 0.45;
  a.body.scale.set(sxz, c.sq * R.sy, sxz);
  // the rig: every bone is set by name, a character without the bone just skips the line
  const ab = ch.armBase, al = c.aL + R.dA + R.dL + ab, ar = c.aR + R.dA + R.dR + ab;
  setRot(B.armL, c.aLx, R.armY, -al);
  setRot(B.armR, c.aRx, -R.armY, ar);
  if (B.handL) setRot(B.handL, 0, 0, -0.3 * al);
  if (B.handR) setRot(B.handR, 0, 0, 0.3 * ar);
  for (let i = 0; i < ch.legs.length; i++) { const l = ch.legs[i]; setOff(l.b, 0, c['l' + l.g] + R.lg[l.g], 0); }
  const mode = v === 'failed' ? 'x' : R.dizzy ? 'dizzy' : R.squint ? 'squint' : R.happy ? 'happy' : (ch.sleepyEyes && a.re.sleep > 0.7 ? 'sleepy' : 'open');
  const esy = Math.max(0.05, c.eyeSY * R.esy);
  for (let i = 0; i < 2; i++) {
    const e = ch.eyes[i ? 'eyeR' : 'eyeL'];
    if (!e) continue;
    setOff(e.bone, (c.eyeX * 0.45 + R.ex) * ch.travel, 0, 0);
    showEye(e, mode, esy, now, i ? -1 : 1);
  }
  if (B.head) setRot(B.head, 0.35 * (c.rx + R.rx) + R.headX + 0.04 * Math.sin(tt * 1.1), 0.5 * (c.ry + R.ry) + R.headY, 0.45 * (c.rz + R.rz) + R.headZ);
  if (B.earL || B.earR) { // ears lag the body's bounce, droop when tired or flopped, and wiggle when happy
    const vy = (a.body.position.y - a.byPrev) / Math.max(dt, 0.001); a.byPrev = a.body.position.y;
    a.earV += (vy - a.earV) * (1 - Math.exp(-dt * 14));
    const happy = Math.max(a.re.pet, R.happy ? 1 : 0);
    const dr = clamp(a.earV * 0.035, -0.5, 0.5) + (v === 'failed' ? 0.9 : 0) + a.re.sleep * 0.45 + (v === 'think' ? 0.15 : 0) - 0.2 * happy + R.earX;
    const wg = 0.07 * Math.sin(tt * 2.3) + 0.2 * happy * Math.sin(now * 14) + R.earZ;
    setRot(B.earL, -dr, 0, wg); setRot(B.earR, -dr, 0, -wg);
  }
  if (B.tail) {
    const hp = Math.max(a.re.pet, R.happy ? 1 : 0), run = v === 'run' ? 1 : 0;
    const wag = (0.18 + 0.4 * hp + 0.25 * run) * Math.sin(tt * (3 + 9 * hp + 5 * run)) + R.tailW;
    setRot(B.tail, 0.1 * Math.sin(tt * 1.7), wag, 0.4 * wag);
  }
  if (B.mouth) { // opens for a yelp, a yawn-ish think, a cheer
    let mo = R.mouth;
    if (R.squint || v === 'failed') mo = Math.max(mo, 0.9);
    if (R.happy) mo = Math.max(mo, 0.5);
    if (v === 'spawn') mo = Math.max(mo, 0.7);
    if (v === 'plan' || v === 'think') mo = Math.max(mo, 0.25 * (0.5 + 0.5 * Math.sin(tt * 6)));
    a.mo += (mo - a.mo) * (1 - Math.exp(-dt * 14));
    const m = B.mouth, al2 = !m.qa || m.aligned;
    if (al2) m.o.scale.set((m.sx || 1) * (1 + 0.2 * a.mo), (m.sy || 1) * (1 + 1.6 * a.mo), m.sz || 1); else m.o.scale.setScalar((m.sx || 1) * (1 + 0.5 * a.mo));
  }
  a.page.visible = v === 'read' || v === 'plan';
  if (a.page.visible) a.pageMat.color.setHex(v === 'plan' ? 0xe3d6ff : 0xf4f1e8);
  a.anten.visible = v === 'web';
  if (a.anten.visible) a.tipMat.color.setRGB(0.4, 0.9, 1).multiplyScalar(s01(Math.sin(t * 7)) * 0.9 + 0.1);
  // glyph sprites, placed from the top of the character (the crab's own is 4.7)
  const F = a.fx, tp = ch.top;
  // zZ: while thinking, and in the pet while asleep
  const zk = v === 'think' ? 1 : a.re.sleep > 0.35 ? a.re.sleep : 0;
  for (let i = 0; i < 3; i++) {
    const sp = F.z[i], life = (t * (v === 'think' ? 0.45 : 0.28) + i / 3) % 1;
    sp.visible = zk > 0;
    if (sp.visible) { sp.position.set(1.8 + life * 1.6, tp + 0.9 + life * 3.4, 0.5); sp.scale.setScalar(1.2 + life * 1.4); sp.material.opacity = Math.sin(life * Math.PI) * 0.95 * zk; }
  }
  F.q.visible = v === 'search';
  if (F.q.visible) { F.q.position.set(2.2, tp + 1.9 + 0.3 * Math.sin(t * 3), 0.5); F.q.scale.setScalar(2.4); F.q.material.rotation = 0.2 * Math.sin(t * 2); }
  F.bang.visible = v === 'spawn';
  if (F.bang.visible) { F.bang.position.set(0, tp + 2.3 + c.by, 0.5); F.bang.scale.setScalar(2.4); }
  const pk = packBadge(a);   // a small chip at the head's upper right: the character's pack has problems
  F.pack.visible = !!pk;
  if (pk) {
    const pm = pk.level === 'error' ? GLYPH.packErr : GLYPH.packWarn;
    if (F.pack.material.map !== pm) { F.pack.material.map = pm; F.pack.material.needsUpdate = true; }
    F.pack.position.set(ch.bw * 0.45, tp + 1.3, 0.5); F.pack.scale.setScalar(2.3);
  }
  for (let i = 0; i < 3; i++) { // dizzy: stars circling the head
    const sp = F.orb[i], on = R.orbit > 0.02;
    sp.visible = on;
    if (on) { const an = now * 4.2 + i * 2.094, rr = Math.max(1.8, ch.bw * 0.4); sp.position.set(Math.cos(an) * rr, ch.crown + 0.9 + 0.25 * Math.sin(now * 6 + i), Math.sin(an) * rr * 0.7); sp.scale.setScalar(1.15); sp.material.opacity = R.orbit; }
  }
  // tint
  const tf = v === 'failed' ? 0.75 : v === 'done' ? (lt > 1.5 ? 0.5 : 0.15) : a.d.status === 'killed' ? 0.7 : (a.d.status === 'idle' || a.d.status === 'pending') ? 0.12 : 0;
  a.tintF += (tf - a.tintF) * (1 - Math.exp(-dt * 4));
  const tc = v === 'failed' ? TINT.failed : a.d.status === 'killed' ? TINT.killed : v === 'done' ? TINT.done : TINT.dim;
  const re = a.re, eb = embed ? 1.4 : 1;
  const dimT = wire2 ? (relatedSet && !relatedSet.has('a:' + a.id) ? 1 : 0) : 0;
  if (wire2) a.dim += (dimT - a.dim) * (1 - Math.exp(-dt * 8)); // hovering something dims every crab it has nothing to do with
  const tr = a.dim > 0.02, em0 = (0.32 * re.pet + 0.42 * re.red) * eb, em1 = (0.1 * re.pet + 0.02 * re.red) * eb, em2 = 0.17 * re.pet * eb;
  for (let i = 0; i < ch.tinted.length; i++) {
    const m = ch.tinted[i].m;
    m.color.copy(ch.tinted[i].base).lerp(tc, a.tintF);
    if (re.red > 0.01) m.color.lerp(REDC, 0.4 * re.red);
    if (m.emissive) m.emissive.setRGB(em0, em1, em2);
    if (wire2) { if (m.transparent !== tr) m.transparent = tr; m.opacity = 1 - 0.65 * a.dim; }
  }
  // placement
  a.pos.lerp(a.tgt, 1 - Math.exp(-dt * 3));
  a.root.position.copy(a.pos);
  const want = Math.atan2(camPos.x - a.pos.x, camPos.z - a.pos.z);
  let dy = want - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  a.yaw += dy * (1 - Math.exp(-dt * 4));
  a.root.rotation.y = a.yaw + (sw ? sw.spin : 0);
  const age = now - a.born;
  a.root.scale.setScalar(a.s * Math.max(0.001, easeOutBack(age / 0.55)) * (sw ? sw.k : 1));
  a.label.sp.position.set(a.pos.x, a.s * (tp + 5.8) + 0.4, a.pos.z);
  a.ring.visible = !!(selected === a.id || (hover && hover.o === a));
  if (a.bub) updateBubble(a, v, dt);
  if (a.bye) {
    const kk = a.byeDone ? clamp(1 - (now - a.bye - 1.0) / 0.2, 0, 1) : 1;
    a.root.scale.multiplyScalar(Math.max(0.001, kk));
    a.root.visible = !(a.gone && kk <= 0.001);
    if (a.gone && a.bub) a.bub.sp.visible = false;
  }
}
const s01 = (x) => x * 0.5 + 0.5;

function refreshCrabLabel(a) {
  const d = a.d, key = [d.type, d.description, d.status].join('|');
  if (key === a.labelKey) return;
  a.labelKey = key;
  paintLabel(a.label, d.id === 'main' ? 'main' : d.type || d.id, d.description || '', SCOL[d.status] || '#8b93a7', true);
}

function disposeCrab(a) {
  scene.remove(a.root); scene.remove(a.label.sp);
  for (let i = rfx.length - 1; i >= 0; i--) if (rfx[i].a === a) { rfxRelease(rfx[i]); rfx.splice(i, 1); }
  clearChar(a);
  if (a.chip) { scene.remove(a.chip.sp); a.chip.tex.dispose(); a.chip.mat.dispose(); }
  if (a.bub) { scene.remove(a.bub.sp); a.bub.tex.dispose(); a.bub.mat.dispose(); }
  a.label.tex.dispose(); a.label.mat.dispose();
  a.fx.z.forEach((s) => s.material.dispose()); a.fx.q.material.dispose(); a.fx.bang.material.dispose(); a.fx.pack.material.dispose(); a.fx.orb.forEach((s) => s.material.dispose());
}

/* ---------------------------------------------------------------- reactions (pet / pinch) */
// Purely client-side. A reaction is a small overlay (RX) computed per frame from timestamps in crab.re;
// updateCrab adds it on top of the verb pose, so the pose smoothing underneath is never touched.
const EM = embed ? 2 : 1; // the terminal shows a few pixels per crab: make effects twice as big
const REDC = new T.Color(0xe02a1a);
const RX = { by: 0, rx: 0, rz: 0, sy: 1, dA: 0, armY: 0, squint: false, happy: false, ry: 0, ex: 0, esy: 1, lg: [0, 0, 0, 0],
  // from the character system: per-arm extra, dizzy eyes and stars, head / ear / tail / mouth drive
  dL: 0, dR: 0, dizzy: false, orbit: 0, headX: 0, headY: 0, headZ: 0, earX: 0, earZ: 0, tailW: 0, mouth: 0 };
const RFX_MAX = 60;
const rfxPool = [], rfx = [];
function newReact() {
  const n = nowS();
  return { pinchT: -99, pinchTimes: [], grumpT: -99, redUntil: 0, red: 0, petUntil: 0, pet: 0, nextHeart: 0, session: false, sessionT: 0, happyT: -99,
    // the pet's own: drop bounce, wobble, hello hop, wake-up stretch, blink, idle shuffle, sleep depth
    dropT: -99, wobT: -99, hopT: -99, stretchT: -99, blinkAt: n + 1 + Math.random() * 4, blinkT: -99, shufAt: n + 3 + Math.random() * 8, shufT: -99, sleep: 0,
    // shaken in the carried window: dizzy stagger (and a sit-down first after a hard shake), the next star / drop
    dizzyT: -99, dizzyDur: 0, sitT: -99, sitDur: 0, starAt: 0 };
}
function rfxAcquire() {
  let sp = rfxPool.pop();
  if (!sp) {
    if (rfx.length >= RFX_MAX) sp = rfx.shift().sp; // recycle the oldest
    else { sp = new T.Sprite(new T.SpriteMaterial({ transparent: true, depthTest: false, fog: false })); sp.renderOrder = 11; scene.add(sp); }
  }
  return sp;
}
function rfxRelease(o) {
  const sp = o.sp; sp.visible = false;
  if (rfxPool.length < 16) rfxPool.push(sp);
  else { scene.remove(sp); sp.material.dispose(); }
}
function spawnRfx(kind, a, delay) {
  const sp = rfxAcquire();
  sp.material.map = kind === 'heart' ? HEART_TEX : kind === 'anger' ? ANGER_TEX : kind === 'sweat' ? DROP_TEX : kind === 'star' ? STAR_TEX : kind === 'puff' ? SMOKE_TEX : GLYPH.hurt;
  sp.material.opacity = 0; sp.material.rotation = 0; sp.visible = false;
  const o = { sp, k: kind, a, t0: nowS() + (delay || 0), dur: kind === 'heart' ? 1.15 : kind === 'anger' ? 1.4 : kind === 'sweat' ? 0.85 : kind === 'puff' ? 0.75 : kind === 'star' ? 0.95 : 0.95, ph: Math.random() * 6.283, size: 1, x0: 0, y0: 0, z0: 0, vx: 0, vy: 0 };
  if (kind === 'heart') {
    const off = (Math.random() * 2 - 1) * 2.2 * a.s * EM;
    o.x0 = a.pos.x + Math.cos(a.yaw) * off; o.z0 = a.pos.z - Math.sin(a.yaw) * off; o.y0 = a.pos.y + a.s * (a.ch.top + 1.7);
    o.size = (0.6 + Math.random() * 0.3) * EM * (0.75 + a.s);
  } else if (kind === 'puff') { // around the middle of the character, drifting up
    const an = Math.random() * 6.283, rr = a.s * (1.2 + Math.random() * 2.6);
    o.x0 = a.pos.x + Math.cos(an) * rr; o.z0 = a.pos.z + Math.sin(an) * rr * 0.6; o.y0 = a.pos.y + a.s * (a.ch.top * 0.35);
    o.vy = 0.9 + Math.random() * 0.9; o.size = (1.3 + Math.random() * 1.1) * (0.6 + a.s) * EM;
  } else if (kind === 'sweat' || kind === 'star') { // flung off the head, sideways and up
    const sd = Math.random() < 0.5 ? -1 : 1;
    o.x0 = a.pos.x + Math.cos(a.yaw) * sd * a.s * 3; o.z0 = a.pos.z - Math.sin(a.yaw) * sd * a.s * 3; o.y0 = a.pos.y + a.s * (a.ch.crown + 0.6);
    o.vx = sd * (1.6 + Math.random() * 2.4) * (0.6 + a.s); o.vy = (kind === 'sweat' ? 2.2 : 3.2) + Math.random() * 2.2;
    o.size = (kind === 'sweat' ? 0.75 : 0.85) * EM * (0.75 + a.s);
  } else o.size = (kind === 'anger' ? 1.2 : 1.0) * EM * (0.75 + a.s);
  rfx.push(o);
}
function updateRfx(now) {
  for (let i = rfx.length - 1; i >= 0; i--) {
    const o = rfx[i], sp = o.sp, a = o.a, u = (now - o.t0) / o.dur;
    if (u >= 1 || agents.get(a.id) !== a) { rfx.splice(i, 1); rfxRelease(o); continue; }
    if (u < 0) { sp.visible = false; continue; }
    sp.visible = true;
    const m = sp.material;
    if (o.k === 'heart') {
      sp.position.set(o.x0 + Math.sin(o.ph + u * 7) * 0.35 * EM, o.y0 + u * 2.4 * EM, o.z0);
      sp.scale.setScalar(o.size * Math.max(0.01, easeOutBack(Math.min(1, u * 5))));
      m.opacity = 1 - clamp((u - 0.6) / 0.4, 0, 1); m.rotation = 0.25 * Math.sin(o.ph + u * 5);
    } else if (o.k === 'puff') {
      const tau = u * o.dur;
      sp.position.set(o.x0 + Math.cos(o.ph) * 0.5 * tau, o.y0 + o.vy * tau, o.z0);
      sp.scale.setScalar(o.size * (0.5 + 1.1 * Math.min(1, u * 2)));
      m.opacity = 0.9 * (1 - clamp((u - 0.15) / 0.85, 0, 1)); m.rotation = o.ph + tau * 1.5;
    } else if (o.k === 'sweat' || o.k === 'star') {
      const tau = u * o.dur;
      sp.position.set(o.x0 + Math.cos(a.yaw) * o.vx * tau, o.y0 + o.vy * tau - 5 * tau * tau, o.z0 - Math.sin(a.yaw) * o.vx * tau);
      sp.scale.setScalar(o.size * Math.max(0.01, easeOutBack(Math.min(1, u * 6))));
      m.opacity = 1 - clamp((u - 0.55) / 0.45, 0, 1); m.rotation = o.k === 'star' ? tau * 7 : 0;
    } else {
      const side = o.k === 'anger' ? 2.4 * a.s : 0, pul = o.k === 'anger' ? 1 + 0.14 * Math.sin(u * 48) : 1;
      sp.position.set(a.pos.x + Math.cos(a.yaw) * side, a.pos.y + a.s * (a.ch.top + 2.7 + a.body.position.y) + (o.k === 'anger' ? 0.5 : 0.3) * EM, a.pos.z - Math.sin(a.yaw) * side);
      sp.scale.setScalar(o.size * pul * Math.max(0.01, easeOutBack(Math.min(1, u * 7))));
      m.opacity = 1 - clamp((u - 0.7) / 0.3, 0, 1);
    }
  }
}
function pinchCrab(a) {
  const now = nowS(), r = a.re;
  r.pinchT = now; a.mood.pinches++;
  r.pinchTimes.push(now);
  while (r.pinchTimes.length && now - r.pinchTimes[0] > 2) r.pinchTimes.shift();
  spawnRfx('bang', a, 0);
  burst('a:' + a.id, 0xff5577, embed ? 14 : 8);
  if (r.pinchTimes.length >= 3) { // 3 pinches within 2s: grumpy, pinches back
    r.pinchTimes.length = 0;
    r.grumpT = now + 0.3; r.redUntil = now + 2.3;
    spawnRfx('anger', a, 0.3);
  }
}
function keepPet(a, hold) {
  const now = nowS(), r = a.re;
  r.petUntil = now + hold;
  if (!r.session) { r.session = true; r.sessionT = now; a.mood.pets++; if (selected === a.id) fillDetail(); }
}
function reactCrab(a, v, dt, now) {
  const r = a.re, R = RX, fl = v === 'failed' ? 0.3 : 1; // a failed crab flinches but stays flopped
  R.by = 0; R.rx = 0; R.rz = 0; R.sy = 1; R.dA = 0; R.armY = 0; R.squint = false; R.happy = false;
  R.ry = 0; R.ex = 0; R.esy = 1; R.lg[0] = R.lg[1] = R.lg[2] = R.lg[3] = 0;
  R.dL = 0; R.dR = 0; R.dizzy = false; R.orbit = 0; R.headX = 0; R.headY = 0; R.headZ = 0; R.earX = 0; R.earZ = 0; R.tailW = 0; R.mouth = 0;
  const petting = now < r.petUntil;
  if (r.session && !petting) { // stroking stopped: one happy hop
    r.session = false;
    if (now - r.sessionT > 0.5) { r.happyT = now; for (let i = 0; i < 3; i++) spawnRfx('heart', a, i * 0.08); }
  }
  if (petting && now >= r.nextHeart) { r.nextHeart = now + 0.25; spawnRfx('heart', a, 0); }
  r.pet += ((petting ? 1 : 0) - r.pet) * (1 - Math.exp(-dt * (petting ? 10 : 5)));
  r.red += ((now >= r.grumpT && now < r.redUntil ? 1 : 0) - r.red) * (1 - Math.exp(-dt * 7));
  const up = now - r.pinchT;
  if (up >= 0 && up < 1) { // squash and stretch, little hop, squint
    const sq = 1 - (embed ? 0.52 : 0.4) * Math.exp(-5 * up) * Math.cos(13 * up);
    R.sy *= 1 + (sq - 1) * fl;
    R.by += (embed ? 1.9 : 1.3) * fl * Math.sin(Math.PI * clamp((up - 0.1) / 0.42, 0, 1));
    R.rz += 0.1 * fl * Math.sin(up * 30) * Math.exp(-up * 6);
    if (up < 0.8) R.squint = true;
  }
  const ug = now - r.grumpT;
  if (ug >= 0 && ug < 1) { // both claws snap forward twice
    if (ug < 0.8) { const sw = Math.pow(Math.abs(Math.sin(Math.PI * ug / 0.4)), 0.5); R.armY = sw * 1.0 * fl; R.dA = 0.55 * sw * fl; R.rx += 0.12 * sw * fl; }
    R.squint = true;
  }
  if (r.pet > 0.01) { // purr: roll +-8 deg at ~6 Hz
    R.rz += r.pet * (embed ? 0.19 : 0.14) * fl * Math.sin(now * 37.7);
    R.sy *= 1 + 0.035 * r.pet * Math.sin(now * 75.4);
    R.by += 0.12 * r.pet * Math.abs(Math.sin(now * 18.8)) * fl;
    if (r.pet > 0.25) R.happy = true;
  }
  const uh = now - r.happyT;
  if (uh >= 0 && uh < 0.55) {
    const h = Math.sin(Math.PI * uh / 0.55);
    R.by += (embed ? 2.1 : 1.5) * fl * h; R.sy *= 1 + 0.1 * fl * h; R.happy = true;
  }
  if (a.bye) { // dismissed from the pet: waves goodbye with the right claw, then pops away in a puff (updateCrab shrinks it)
    const ub = now - a.bye;
    if (ub >= 0 && ub < 1.0) { R.dR += 1.0 + 0.4 * Math.sin(ub * 22); R.happy = true; R.by += 0.45 * Math.abs(Math.sin(ub * 6)); }
    else if (ub >= 1.0 && !a.byeDone) {
      a.byeDone = true; a.gone = true; a.goneAt = now;
      for (let i = 0; i < 6; i++) spawnRfx('puff', a, i * 0.04);
      burst('a:' + a.id, 0xffffff, 14);
    }
  }
  if (overlay || preview) petCrab(a, v, dt, now, R);
  if (TK) TK.pose(a, R, v, now, dt);
  return R;
}

/* ---------------------------------------------------------------- files */
function makeFile(f) {
  const g = new T.Group(); let mesh; const mats = [];
  const own = (m) => { const c = m.clone(); mats.push(c); return c; }; // each file its own materials: hovering dims the others
  if (f.kind === 'plan') { mesh = new T.Mesh(BOX, own(M.plan)); mesh.scale.setScalar(0.95); }
  else if (f.kind === 'doc') { mesh = new T.Mesh(BOX, own(M.doc)); mesh.scale.set(1.3, 0.07, 1.7); mesh.rotation.x = 0.35; }
  else {
    mesh = new T.Mesh(BOX, own(M.code)); mesh.scale.set(1, 0.26, 1);
    const inner = new T.Mesh(BOX, own(M.codeIn)); inner.position.y = 0.6; inner.scale.set(0.55, 0.4, 0.55); mesh.add(inner);
  }
  g.add(mesh);
  const label = makeLabel(256, 56, 0.42);
  label.sp.position.y = 0.75; g.add(label.sp);
  paintLabel(label, base(f.path), '', null, false);
  scene.add(g);
  return { path: f.path, d: f, g, mesh, mats, dim: 0, hidden: false, owner: null, kind: f.kind, label, pos: new T.Vector3(), tgt: new T.Vector3(), born: nowS(), seq: ++fileSeq, ph: (hash(f.path) % 628) / 100 };
}
function disposeFile(f) { scene.remove(f.g); f.label.tex.dispose(); f.label.mat.dispose(); f.mats.forEach((m) => m.dispose()); }

/* ---------------------------------------------------------------- layout */
const RAD = 8.5;
function layout() {
  const kids = new Map(); let root = agents.get('main') || null;
  for (const a of agents.values()) {
    if (a === root) continue;
    const p = a.d.parentId;
    if (p == null && !root) { root = a; continue; }
    const pid = p != null && agents.has(p) && p !== a.id ? p : (root ? root.id : 'main');
    if (!kids.has(pid)) kids.set(pid, []);
    kids.get(pid).push(a);
  }
  for (const k of kids.values()) k.sort((x, y) => (x.d.startedAt || 0) - (y.d.startedAt || 0) || (x.id < y.id ? -1 : 1));
  const seen = new Set();
  const lv = (n, g) => { if (g > 40) return 1; const k = kids.get(n.id); n.lv = k && k.length ? k.reduce((s, c) => s + lv(c, g + 1), 0) : 1; return n.lv; };
  const place = (n, a0, a1, depth) => {
    seen.add(n.id);
    const ang = (a0 + a1) / 2, r = depth * RAD;
    n.tgt.set(Math.sin(ang) * r, 0, Math.cos(ang) * r); n.depth = depth; n.ang = depth ? ang : Math.PI;
    const k = kids.get(n.id) || []; let tot = 0; k.forEach((c) => { tot += c.lv; });
    let a = a0; k.forEach((c) => { const w = (a1 - a0) * c.lv / tot; place(c, a, a + w, depth + 1); a += w; });
  };
  if (root) { lv(root, 0); place(root, 0.8, 0.8 + Math.PI * 2, 0); }
  let i = 0; const out = [];
  for (const a of agents.values()) if (!seen.has(a.id)) out.push(a);
  out.forEach((a) => { const an = (i++ / out.length) * 6.283; a.tgt.set(Math.sin(an) * RAD * 3, 0, Math.cos(an) * RAD * 3); a.depth = 3; a.ang = an; });
  if (demoLineup) lineupLayout();

  // files: sorted by first-seen so slots stay stable
  if (wire2) layoutFiles2(root);
  else {
  const byOwner = new Map(); const list = [...files.values()].sort((x, y) => x.seq - y.seq);
  for (const f of list) {
    let owner = null; const ids = Object.keys(f.d.by || {});
    for (const id of ids) if (agents.has(id)) { owner = id; break; }
    owner = owner || 'main';
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(f);
  }
  for (const [oid, arr] of byOwner) {
    const o = agents.get(oid) || root; if (!o) continue;
    arr.forEach((f, i) => {
      const ring = Math.floor(i / 7), slot = i % 7;
      const mainOwner = o.depth === 0, spread = mainOwner ? 0.9 : 0.55;
      const ang = o.ang + (slot - 3) * spread, rr = (mainOwner ? 4.6 : 3.6) + ring * 1.7;
      f.tgt.set(o.tgt.x + Math.sin(ang) * rr, 1.9 + ring * 0.5, o.tgt.z + Math.cos(ang) * rr);
      const others = Object.keys(f.d.by || {}).filter((id) => id !== oid && agents.has(id));
      if (others.length) {
        let mx = f.tgt.x, mz = f.tgt.z, n = 1;
        others.forEach((id) => { const q = agents.get(id); mx += q.tgt.x; mz += q.tgt.z; n++; });
        mx = (mx + f.tgt.x) / (n + 1); mz = (mz + f.tgt.z) / (n + 1);
        f.tgt.x = lerp(f.tgt.x, mx, 0.6); f.tgt.z = lerp(f.tgt.z, mz, 0.6); f.tgt.y = 3.1 + ring * 0.5;
      }
    });
  }
  }
  // edges
  edges = [];
  for (const a of agents.values()) {
    const p = a.d.parentId;
    if (p != null && agents.has(p) && p !== a.id) edges.push({ A: agents.get(p), B: a, k: 'tree' });
  }
  for (const f of files.values()) {
    for (const id of Object.keys(f.d.by || {})) {
      const a = agents.get(id); if (!a) continue;
      const m = f.d.by[id];
      edges.push({ A: a, B: f, k: m === 'rw' ? 'rw' : m === 'w' ? 'w' : 'r' });
    }
  }
  if (wire2) { edges = []; syncLinks(); }
}

/* ---------------------------------------------------------------- wiring v2 (the pet and the plain page; ?embed keeps the old lines) */
// Agent -> child is one smooth tube in the child's colour, with dashes running along it while the child works.
// There are no standing agent -> file lines: files sit in a small arc beside the agent that touched them last (five at
// most, "+N" for the rest), a read or write draws a short arc that fades out, and hovering lights up what is related.
const FILE_SLOTS = 5;
const TUBE_R = overlay ? 0.27 : 0.16;
const lastBy = new Map();   // file path -> the agent that touched it last, from the event stream
const links = new Map();    // child id -> { child, parent, mesh, mat, tex, A, B, running }
const arcs = [];            // transient read / write links: { a, b, k, t0 }
const ARC_LIFE = 1.5;
let relatedSet = null;      // hover: the nodes that stay lit ('a:id' / 'f:path'), null when nothing is hovered
const DASH = wire2 ? canvasTex(64, 8, (c, w, h) => { c.fillStyle = 'rgba(255,255,255,1)'; c.fillRect(0, 0, w * 0.45, h); c.fillStyle = 'rgba(255,255,255,.3)'; c.fillRect(w * 0.45, 0, w * 0.55, h); }) : null;
const _lm = new T.Vector3(), _la = new T.Vector3(), _lb = new T.Vector3();

function makeLink(parent, child) {
  const tex = DASH.clone(); tex.wrapS = T.RepeatWrapping; tex.needsUpdate = true;
  const mat = new T.MeshBasicMaterial({ color: child.base.clone(), transparent: true, opacity: 0.5, depthWrite: false });
  const mesh = new T.Mesh(new T.BufferGeometry(), mat); mesh.frustumCulled = false; mesh.renderOrder = 2; mesh.visible = false; scene.add(mesh);
  return { child, parent, mesh, mat, tex, A: new T.Vector3(1e9, 0, 0), B: new T.Vector3(), running: null };
}
function disposeLink(L) { scene.remove(L.mesh); L.mesh.geometry.dispose(); L.mat.dispose(); L.tex.dispose(); }
function syncLinks() {
  if (!wire2) return;
  const want = new Set();
  for (const a of agents.values()) {
    const p = a.d.parentId;
    if (p == null || p === a.id || !agents.has(p)) continue;
    want.add(a.id);
    let L = links.get(a.id);
    if (!L || L.parent !== agents.get(p)) { if (L) disposeLink(L); L = makeLink(agents.get(p), a); links.set(a.id, L); }
  }
  for (const [id, L] of links) if (!want.has(id)) { disposeLink(L); links.delete(id); }
}
function clearLinks() { links.forEach(disposeLink); links.clear(); arcs.length = 0; lastBy.clear(); }
const redC = new T.Color(0xc42f2f);
function updateLinks(dt) {
  const hv = hover && hover.o && hover.o.root ? hover.o : null, hf = !!(hover && hover.o && !hover.o.root);
  links.forEach((L) => {
    anchorOf(L.parent, _la); anchorOf(L.child, _lb);
    if (_la.distanceToSquared(L.A) > 0.0004 || _lb.distanceToSquared(L.B) > 0.0004) { // only when an end moved
      L.A.copy(_la); L.B.copy(_lb);
      const d = L.A.distanceTo(L.B);
      L.mesh.geometry.dispose();
      if (d < 0.3) { L.mesh.geometry = new T.BufferGeometry(); L.mesh.visible = false; }
      else {
        _lm.copy(L.A).add(L.B).multiplyScalar(0.5); _lm.y += d * 0.28 + 1.1; // up and over the crabs, not through them
        L.mesh.geometry = new T.TubeGeometry(new T.QuadraticBezierCurve3(L.A.clone(), _lm.clone(), L.B.clone()), 22, TUBE_R, 5, false);
        L.tex.repeat.x = Math.max(2, d * 0.7); L.mesh.visible = true;
      }
    }
    const st = L.child.d.status, running = st === 'running';
    if (running !== L.running) { L.running = running; L.mat.map = running ? L.tex : null; L.mat.needsUpdate = true; }
    if (running) L.tex.offset.x -= dt * 1.1;
    L.mat.color.copy(L.child.base); if (st === 'failed') L.mat.color.lerp(redC, 0.7);
    const lit = hv ? (L.child === hv || L.parent === hv ? 1 : 0.25) : hf ? 0.3 : 1;
    L.mat.opacity = (running ? 0.9 : 0.3) * lit; // a finished child's link is faint
  });
}
function arc(a, b, k, delay) {
  if (!wire2 || !a || !b) return;
  if (arcs.length >= 14) arcs.shift();
  arcs.push({ a, b, k, t0: nowS() + (delay || 0) });
}
function relatedOf() {
  if (!wire2 || !hover || !hover.o || hover.o.chipOf) return null;
  const o = hover.o, s = new Set();
  if (o.root) {
    s.add('a:' + o.id);
    files.forEach((f) => { if (!f.hidden && f.d.by && f.d.by[o.id]) s.add('f:' + f.path); });
    if (o.d.parentId != null) s.add('a:' + o.d.parentId);
    agents.forEach((a) => { if (a.d.parentId === o.id) s.add('a:' + a.id); });
  } else {
    s.add('f:' + o.path);
    Object.keys(o.d.by || {}).forEach((id) => s.add('a:' + id));
  }
  return s;
}
function updateChip(o) {
  const n = o.hiddenN || 0;
  if (!n) { if (o.chip) o.chip.sp.visible = false; return; }
  if (!o.chip) { o.chip = makeLabel(128, 56, overlay ? 0.9 : 0.6); o.chip.sp.renderOrder = 10; o.chip.n = -1; scene.add(o.chip.sp); }
  if (o.chip.n !== n) { o.chip.n = n; paintLabel(o.chip, '+' + n, '', null, false); }
  o.chip.sp.visible = true;
  if (!o.chipObj) o.chipObj = { chipOf: o, pos: o.chip.sp.position, path: '', d: { by: {}, kind: 'more' } }; // what pick() returns for the chip
  const rr = o.depth === 0 ? 4.4 : 3.5;
  o.chip.sp.position.set(o.tgt.x + Math.sin(o.ang) * (rr + 0.2), 2.9, o.tgt.z + Math.cos(o.ang) * (rr + 0.2));
}
// Files go beside the agent that touched them last: the newest five in an arc, the rest behind a +N chip.
function layoutFiles2(root) {
  const byOwner = new Map();
  for (const f of files.values()) {
    let owner = lastBy.get(f.path);
    if (!owner || !agents.has(owner) || !(f.d.by && f.d.by[owner])) { owner = null; for (const id of Object.keys(f.d.by || {})) if (agents.has(id)) { owner = id; break; } }
    f.owner = owner || (root ? root.id : 'main');
    if (!byOwner.has(f.owner)) byOwner.set(f.owner, []);
    byOwner.get(f.owner).push(f);
  }
  agents.forEach((a) => { a.hiddenN = 0; });
  for (const [oid, arr] of byOwner) {
    const o = agents.get(oid) || root; if (!o) continue;
    arr.sort((x, y) => (y.d.last || 0) - (x.d.last || 0) || x.seq - y.seq);
    const rr = o.depth === 0 ? 4.4 : 3.5, shown = Math.min(arr.length, FILE_SLOTS);
    arr.forEach((f, i) => {
      f.hidden = i >= FILE_SLOTS;
      if (f.hidden) { f.tgt.set(o.tgt.x + Math.sin(o.ang) * (rr + 0.2), 2.9, o.tgt.z + Math.cos(o.ang) * (rr + 0.2)); return; }
      const ang = o.ang + (i - (shown - 1) / 2) * 0.62;
      f.tgt.set(o.tgt.x + Math.sin(ang) * rr, 1.9 + (i % 2) * 0.35, o.tgt.z + Math.cos(ang) * rr);
      const others = Object.keys(f.d.by || {}).filter((id) => id !== o.id && agents.has(id)); // shared: between the agents
      if (others.length) {
        let mx = f.tgt.x, mz = f.tgt.z, n = 1;
        others.forEach((id) => { const q = agents.get(id); mx += q.tgt.x; mz += q.tgt.z; n++; });
        f.tgt.x = lerp(f.tgt.x, mx / n, 0.6); f.tgt.z = lerp(f.tgt.z, mz / n, 0.6); f.tgt.y = 3.1;
      }
    });
    o.hiddenN = Math.max(0, arr.length - FILE_SLOTS);
  }
  agents.forEach(updateChip);
}
// The only lines left: short arcs for a read or a write (they fade), and thin lines to what the hovered node touched.
function updateEdges2(now) {
  let n = 0;
  const put = (A, B, col, k, u0, u1, S) => {
    for (let i = 0; i < S; i++) {
      if (n + 2 > MAXV) return;
      const ua = lerp(u0, u1, i / S), ub = lerp(u0, u1, (i + 1) / S), tail = k * (0.3 + 0.7 * ((i + 1) / S));
      curvePt(A, B, ua, _p); curvePt(A, B, ub, _q);
      const o = n * 3;
      ePos[o] = _p.x; ePos[o + 1] = _p.y; ePos[o + 2] = _p.z; ePos[o + 3] = _q.x; ePos[o + 4] = _q.y; ePos[o + 5] = _q.z;
      eCol[o] = eCol[o + 3] = col.r * tail; eCol[o + 1] = eCol[o + 4] = col.g * tail; eCol[o + 2] = eCol[o + 5] = col.b * tail;
      n += 2;
    }
  };
  for (let i = arcs.length - 1; i >= 0; i--) {
    const r = arcs[i], age = now - r.t0;
    if (age >= ARC_LIFE || !anchor(r.a, _a) || !anchor(r.b, _b)) { if (age >= 0) arcs.splice(i, 1); continue; }
    if (age < 0) continue;
    const head = Math.min(1, age / 0.5), tailU = clamp((age - 0.3) / 0.6, 0, 1) * 0.9, fade = 1 - clamp((age - 0.6) / 0.9, 0, 1);
    if (head > tailU) put(_a, _b, _c.setHex(EDGE[r.k]), fade * (overlay ? 1.6 : 1.25), tailU, head, 12);
  }
  if (hover && hover.o) {
    const o = hover.o;
    if (o.root) files.forEach((f) => { const m = f.hidden ? null : f.d.by && f.d.by[o.id]; if (m) { anchorOf(o, _a); anchorOf(f, _b); put(_a, _b, _c.setHex(EDGE[m === 'rw' ? 'rw' : m === 'w' ? 'w' : 'r']), 1.1, 0, 1, 10); } });
    else Object.keys(o.d.by || {}).forEach((id) => { const a = agents.get(id); if (a) { anchorOf(a, _a); anchorOf(o, _b); put(_a, _b, _c.setHex(EDGE[o.d.by[id] === 'rw' ? 'rw' : o.d.by[id] === 'w' ? 'w' : 'r']), 1.1, 0, 1, 10); } });
  }
  eGeo.setDrawRange(0, n);
  eGeo.attributes.position.needsUpdate = true; eGeo.attributes.color.needsUpdate = true;
}

/* ---------------------------------------------------------------- edges (one LineSegments) */
const SEG = 14, MAXV = 14000;
const ePos = new Float32Array(MAXV * 3), eCol = new Float32Array(MAXV * 3);
const eGeo = new T.BufferGeometry();
eGeo.setAttribute('position', new T.BufferAttribute(ePos, 3).setUsage(T.DynamicDrawUsage));
eGeo.setAttribute('color', new T.BufferAttribute(eCol, 3).setUsage(T.DynamicDrawUsage));
const eLines = new T.LineSegments(eGeo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
eLines.frustumCulled = false; scene.add(eLines);
const _a = new T.Vector3(), _b = new T.Vector3(), _p = new T.Vector3(), _q = new T.Vector3(), _c = new T.Color();

function anchorOf(o, out) {
  if (o.root) out.set(o.pos.x, o.pos.y + o.h, o.pos.z); else out.copy(o.pos);
  return out;
}
function curvePt(A, B, u, out) {
  const lift = A.distanceTo(B) * 0.22 + 0.4, k = 4 * u * (1 - u) * lift;
  out.set(lerp(A.x, B.x, u), lerp(A.y, B.y, u) + k, lerp(A.z, B.z, u));
  return out;
}
function updateEdges() {
  let n = 0;
  const hv = hover ? hover.o : selected ? agents.get(selected) : null;
  for (const e of edges) {
    if (n + SEG * 2 > MAXV) break;
    anchorOf(e.A, _a); anchorOf(e.B, _b);
    _c.setHex(EDGE[e.k]);
    const touch = hv && (e.A === hv || e.B === hv);
    let k = hv ? (touch ? 1.15 : 0.22) : e.k === 'tree' ? 0.6 : 0.75;
    if (overlay) k = hotEdges.has(pairKey(nodeKey(e.A), nodeKey(e.B))) ? 1.8 : Math.max(k, 0.9); // a thin line over a desktop needs to be brighter

    for (let i = 0; i < SEG; i++) {
      curvePt(_a, _b, i / SEG, _p); curvePt(_a, _b, (i + 1) / SEG, _q);
      const o = n * 3;
      ePos[o] = _p.x; ePos[o + 1] = _p.y; ePos[o + 2] = _p.z; ePos[o + 3] = _q.x; ePos[o + 4] = _q.y; ePos[o + 5] = _q.z;
      eCol[o] = eCol[o + 3] = _c.r * k; eCol[o + 1] = eCol[o + 4] = _c.g * k; eCol[o + 2] = eCol[o + 5] = _c.b * k;
      n += 2;
    }
  }
  eGeo.setDrawRange(0, n);
  eGeo.attributes.position.needsUpdate = true; eGeo.attributes.color.needsUpdate = true;
}

/* ---------------------------------------------------------------- particles */
const MAXP = 200, TR = 6, SLOTS = MAXP * TR;
const pPos = new Float32Array(SLOTS * 3), pCol = new Float32Array(SLOTS * 3);
const pGeo = new T.BufferGeometry();
pGeo.setAttribute('position', new T.BufferAttribute(pPos, 3).setUsage(T.DynamicDrawUsage));
pGeo.setAttribute('color', new T.BufferAttribute(pCol, 3).setUsage(T.DynamicDrawUsage));
const pPoints = new T.Points(pGeo, new T.PointsMaterial({ size: overlay ? 1.5 : 0.85, map: radialTex('255,255,255', 1), vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
pPoints.frustumCulled = false; scene.add(pPoints);
let particles = [];
const effects = [];

function anchor(ref, out) {
  if (!ref) return false;
  let r = ref, dy = 0;
  if (typeof ref === 'object') { r = ref.r; dy = ref.dy || 0; }
  if (r.charCodeAt(0) === 97) { const a = agents.get(r.slice(2)); if (!a) return false; anchorOf(a, out); }
  else { const f = files.get(r.slice(2)); if (!f) return false; anchorOf(f, out); }
  out.y += dy; return true;
}
const aref = (id) => (id != null && agents.has(id) ? 'a:' + id : null);
const fref = (p) => (p != null && files.has(p) ? 'f:' + p : null);
const parentRef = (id) => { const a = agents.get(id); return a && a.d.parentId != null ? aref(a.d.parentId) : null; };

function addP(p) { if (PS.reduceMotion && p.k === 'burst') return; if (particles.length >= MAXP) particles.shift(); particles.push(p); }
function path(a, b, color, dur = 0.8, delay = 0) {
  if (!a || !b) return;
  const A = new T.Vector3(), B = new T.Vector3();
  if (!anchor(a, A) || !anchor(b, B)) return;
  addP({ k: 'path', a, b, A, B, t0: nowS() + delay, dur, col: new T.Color(color) });
}
function burst(ref, color, n = 12) {
  const O = new T.Vector3(); if (!anchor(ref, O)) return;
  for (let i = 0; i < n; i++) {
    const an = (i / n) * 6.283 + Math.random(), sp = 3 + Math.random() * 3;
    addP({ k: 'burst', O: O.clone(), v: new T.Vector3(Math.cos(an) * sp, 2 + Math.random() * 3, Math.sin(an) * sp), t0: nowS(), dur: 0.8, col: new T.Color(color) });
  }
}
function fxRing(ref, color, big, gate) {
  if (effects.length > 24) return;
  const O = new T.Vector3(); if (!anchor(ref, O)) return;
  let obj, mat;
  if (gate) { mat = new T.SpriteMaterial({ map: gateTex, transparent: true, depthTest: false, fog: false, color }); obj = new T.Sprite(mat); obj.position.set(O.x, O.y + 1.6, O.z); }
  else { mat = new T.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: T.DoubleSide }); obj = new T.Mesh(RING, mat); obj.position.set(O.x, 0.06, O.z); }
  obj.renderOrder = 8; scene.add(obj);
  effects.push({ obj, mat, t0: nowS(), dur: big ? 1.3 : 0.8, s0: gate ? 1 : 1.5, s1: gate ? 4 : big ? 26 : 9 });
}
const _pp = new T.Vector3();
const PB = overlay ? 1.6 : 1; // particle brightness: they must read over any desktop
const hotEdges = new Set();    // overlay: edges a particle is travelling right now
const refKey = (r) => (typeof r === 'object' ? r.r : r);
const pairKey = (x, y) => (x < y ? x + '>' + y : y + '>' + x);
const nodeKey = (o) => (o.root ? 'a:' + o.id : 'f:' + o.path);
function updateParticles(now) {
  let n = 0; const keep = [];
  hotEdges.clear();
  for (const p of particles) {
    const tau = now - p.t0;
    if (tau < 0) { keep.push(p); continue; }
    if (tau > p.dur + TR * 0.04 + (p.k === 'path' ? 0.1 : 0)) continue;
    keep.push(p);
    if (p.k === 'path') { anchor(p.a, p.A); anchor(p.b, p.B); if (overlay) hotEdges.add(pairKey(refKey(p.a), refKey(p.b))); }
    const fade = 1 - clamp((tau - p.dur) / 0.25, 0, 1);
    for (let k = 0; k < TR && n < SLOTS; k++) {
      const tk = tau - k * 0.04; if (tk < 0) continue;
      if (p.k === 'path') curvePt(p.A, p.B, easeIO(clamp(tk / p.dur, 0, 1)), _pp);
      else { if (tk > p.dur) continue; _pp.set(p.O.x + p.v.x * tk, p.O.y + p.v.y * tk - 6 * tk * tk, p.O.z + p.v.z * tk); }
      const br = Math.pow(1 - k / TR, 1.5) * (p.k === 'path' ? fade : 1 - tk / p.dur);
      const o = n * 3;
      pPos[o] = _pp.x; pPos[o + 1] = _pp.y; pPos[o + 2] = _pp.z;
      pCol[o] = p.col.r * br * PB; pCol[o + 1] = p.col.g * br * PB; pCol[o + 2] = p.col.b * br * PB;
      n++;
    }
  }
  particles = keep;
  pGeo.setDrawRange(0, n);
  pGeo.attributes.position.needsUpdate = true; pGeo.attributes.color.needsUpdate = true;
  for (let i = effects.length - 1; i >= 0; i--) {
    const e = effects[i], f = (now - e.t0) / e.dur;
    if (f >= 1) { scene.remove(e.obj); e.mat.dispose(); effects.splice(i, 1); continue; }
    const sc = lerp(e.s0, e.s1, 1 - Math.pow(1 - f, 3)); e.obj.scale.set(sc, sc, sc); e.mat.opacity = (1 - f) * 0.9;
  }
}

function animateEvent(e, delay) {
  const k = e.kind, from = e.from, to = e.to;
  const A = aref(from) || aref('main');
  switch (k) {
    case 'prompt': path({ r: 'a:main', dy: 11 }, 'a:main', PCOL.prompt, 0.85, delay); break;
    case 'spawn': path(A, aref(to), PCOL.spawn, 0.8, delay); break;
    case 'answer': path(aref(from), aref(to) || parentRef(from), PCOL.answer, 0.8, delay); break;
    case 'done': { const d = aref(to) || parentRef(from); if (d) path(aref(from), d, PCOL.done, 0.8, delay); else fxRing(A, PCOL.done, false); break; }
    case 'read': path(fref(to) || (A && { r: A, dy: 5 }), A, PCOL.read, 0.8, delay); if (fref(to)) arc(fref(to), A, 'r', delay); break;
    case 'write': path(A, fref(to) || (A && { r: A, dy: 5 }), PCOL.write, 0.8, delay); if (fref(to)) arc(A, fref(to), 'w', delay); break;
    case 'tool': if (A) path(A, { r: A, dy: 3.2 }, PCOL.tool, 0.55, delay); break;
    case 'deny': case 'fail': burst(A, PCOL.red); fxRing(A, PCOL.red, false); break;
    case 'check': fxRing('a:main', PCOL.check, false, true); break;
    case 'consult': if (aref(to)) path(A, aref(to), PCOL.consult, 0.9, delay); else if (A) path(A, { r: A, dy: 8 }, PCOL.consult, 0.9, delay); break;
    case 'compact': fxRing('a:main', PCOL.compact, true); break;
    default: break;
  }
}

/* ---------------------------------------------------------------- snapshot -> scene */
function resetScene() {
  for (const a of agents.values()) disposeCrab(a);
  for (const f of files.values()) disposeFile(f);
  clearLinks();
  agents.clear(); files.clear(); edges = []; particles = [];
  if (TK) TK.reset();
  effects.forEach((e) => { scene.remove(e.obj); e.mat.dispose(); }); effects.length = 0;
  selected = null; hover = null; maxSeen = 0; inited = false; fitPending = true;
  setDetail();
}

function syncScene(s) {
  const list = Array.isArray(s.agents) ? s.agents : [];
  const ids = new Set(), prevAgents = agents.size;
  let grew = false;
  for (const d of list) {
    if (!d || d.id == null) continue;
    ids.add(d.id);
    let a = agents.get(d.id);
    if (!a) {
      a = makeCrab(d); agents.set(d.id, a); grew = true;
      const par = d.parentId != null ? agents.get(d.parentId) : null;
      a.pos.copy(par ? par.pos : a.tgt);
    } else {
      a.d = d;
      // Dismissed in the pet but still in the data: the mod has not taken it yet (or never will). Back after 9 s, at once if it works again.
      if (a.gone && (d.status === 'running' || d.status === 'pending' || nowS() - a.goneAt > 9)) unGone(a);
      const arch = !!d.isArchitect; if (a.hat.visible !== arch) a.hat.visible = arch;
      const pk = charPickFor(d); a.pick = pk; if (pk.id !== a.wantId) { a.wantId = pk.id; mountWanted(a); }
    }
    refreshCrabLabel(a);
  }
  for (const [id, a] of agents) if (!ids.has(id)) { disposeCrab(a); agents.delete(id); if (selected === id) selected = null; }
  // The snapshot lists the most recent files first; the pet shows only the latest few, a small window cannot hold sixty.
  const fl = Array.isArray(s.files) ? (overlay ? (PS.show.papers ? s.files.slice(0, 14) : []) : s.files) : [];
  const fids = new Set();
  for (const d of fl) {
    if (!d || d.path == null) continue;
    fids.add(d.path);
    let f = files.get(d.path);
    if (f && f.kind !== d.kind) { disposeFile(f); files.delete(d.path); f = null; }
    if (!f) { f = makeFile(d); files.set(d.path, f); grew = true; f.pos.set(0, 2, 0); }
    else f.d = d;
  }
  for (const [p, f] of files) if (!fids.has(p)) { disposeFile(f); files.delete(p); }
  layout();
  reportSeen();
  for (const f of files.values()) if (f.born > nowS() - 0.01) f.pos.copy(f.tgt).setY(f.tgt.y + 1.5);
  if (grew && agents.size !== prevAgents) autoFit = true;
  if (hover && !(agents.has(hover.id) || files.has(hover.id))) hover = null;
}

// The Settings window lists the agent types in play: tell the main process what this window shows (when it changes).
let seenSig = '';
function unGone(a) {
  a.bye = 0; a.byeDone = false; a.gone = false; a.root.visible = true; a.re.hopT = nowS();
}
function reportSeen() {
  if (!pet || !pet.seen) return;
  const list = [...agents.values()].map((a) => ({ id: a.id, type: typeKeyOf(a), description: a.d.description || '' }));
  const sig = list.map((x) => x.id + '|' + x.type + '|' + x.description).join('\n');
  if (sig !== seenSig) { seenSig = sig; pet.seen(list); }
}

function processEvents(evs, snapNow) {
  const fresh = [];
  let mx = maxSeen, moved = false;
  if (wire2) for (const e of evs) { // the agent that touched a file last owns its place in the arc
    if (e && (e.kind === 'read' || e.kind === 'write') && typeof e.to === 'string' && lastBy.get(e.to) !== e.from) { lastBy.set(e.to, e.from); moved = true; }
  }
  if (moved) layout();
  for (const e of evs) { if (!e || typeof e.id !== 'number') continue; if (e.id > maxSeen) fresh.push(e); if (e.id > mx) mx = e.id; }
  fresh.sort((x, y) => x.id - y.id);
  const first = !inited; inited = true; maxSeen = mx;
  let list = first ? fresh.filter((e) => snapNow - (e.t || 0) < 2500) : fresh;
  list = list.slice(-40);
  list.forEach((e, i) => animateEvent(e, i * 0.09));
  if (overlay) list.slice(-6).forEach(tickerEvent);
}

function applySnapshot(s, fromDemo) {
  if (!s || typeof s !== 'object') return;
  // The pet re-reads data.js every second whether or not it changed: an unchanged file (same write time) costs nothing.
  if (overlay && !fromDemo && lastSnap && s.now === lastSnap.now && (s.session && s.session.id) === sessionId) return;
  if (!fromDemo) {
    gotReal = true;
    if (demoOn) { stopDemo(); if (renderer) resetScene(); sessionId = null; }
  }
  const sid = s.session && s.session.id;
  if (sessionId != null && sid != null && sid !== sessionId && renderer) resetScene();
  if (sid != null) sessionId = sid;
  lastSnap = s; recvAt = performance.now();
  if (!params.get('chars') && !fromDemo) takeRules(s.chars);
  if (renderer) {
    try { syncScene(s); if (TK) TK.sync(s); processEvents(Array.isArray(s.events) ? s.events : [], s.now || Date.now()); }
    catch (err) { if (window.console) console.error('crew-graph scene', err); }
  }
  if (overlay) { noteData(s); noteReply(s); noteAck(s); return; }
  renderHud(s);
}
// The assignment ("main=crab, Explore=bunny, *=random") arrives parsed in the snapshot as [[who, character], ...]
function takeRules(list) {
  const r = Array.isArray(list) ? list.filter((x) => Array.isArray(x) && typeof x[0] === 'string' && typeof x[1] === 'string').slice(0, 64) : [];
  const sig = JSON.stringify(r);
  if (sig === charSig) return;
  charSig = sig; charRules = r;
  if (renderer) reskinAll();
}
window.__crewUpdate = (snap) => applySnapshot(snap, false);

/* ---------------------------------------------------------------- camera */
const cam = { theta: overlay ? 0.3 : params.get('demo') === 'lineup' ? 0.0 : 0.55, phi: overlay ? 1.2 : params.get('demo') === 'lineup' ? 0.9 : 1.0, dist: 24, tx: 0, ty: 1.5, tz: 0, gx: 0, gz: 0, gd: 24 };
let fitPending = true, autoFit = true, lastInteract = -99;
function fitBounds() {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, n = 0;
  const add = (v) => { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); n++; };
  agents.forEach((a) => add(a.tgt)); files.forEach((f) => add(f.tgt));
  if (!n) { cam.gx = 0; cam.gz = 0; cam.gd = 22; return; }
  cam.gx = (x0 + x1) / 2; cam.gz = (z0 + z1) / 2;
  const r = Math.max(x1 - x0, z1 - z0) / 2 + 5;
  const asp = camera.aspect || 1;
  if (demoLineup) { cam.gd = Math.max(((x1 - x0) / 2 + 4.5) / (Math.tan(25 * Math.PI / 180) * asp), ((z1 - z0) / 2 + 4) / Math.tan(25 * Math.PI / 180) * 1.3) * 0.82; return; }
  // Embedded, the crabs must fill the few pixels the pane has: frame tighter.
  cam.gd = clamp(r / Math.tan(25 * Math.PI / 180) * (embed ? 0.62 : overlay ? 0.8 : 0.85) / Math.min(1, asp), embed || overlay ? 9 : 14, 140);
}
function updateCamera(dt, now) {
  if (autoFit) {
    fitBounds();
    const k = 1 - Math.exp(-dt * 2.5);
    cam.tx += (cam.gx - cam.tx) * k; cam.tz += (cam.gz - cam.tz) * k; cam.dist += (cam.gd - cam.dist) * k;
  }
  if (!overlay && !demoLineup && now - lastInteract > 4) cam.theta += dt * 0.07; // the pet sits still: a turning camera is distracting on a desktop
  const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
  camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.theta), cam.ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.theta));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
}

/* ---------------------------------------------------------------- input */
const ptr = { down: false, btn: 0, x: 0, y: 0, sx: 0, sy: 0, moved: 0, mx: -1, my: -1, pet: null, st: null, pick: null, ssx: 0, ssy: 0, fromPlate: false };
function pick(px, py) {
  const W = innerWidth, H = innerHeight; let best = null, bd = 1e9;
  const test = (o, r, bias) => {
    anchorOf(o, _p); _p.project(camera);
    if (_p.z > 1) return;
    const dx = (_p.x * 0.5 + 0.5) * W - px, dy = (-_p.y * 0.5 + 0.5) * H - py, d = Math.hypot(dx, dy) - bias;
    if (d < r && d < bd) { bd = d; best = o; }
  };
  files.forEach((f) => { if (!f.hidden) test(f, 22, 0); });
  agents.forEach((a) => { if (a.chipObj && a.chip && a.chip.sp.visible) test(a.chipObj, 22, 0); });
  agents.forEach((a) => { if (!a.gone) test(a, crabRadius(a), 12); });
  return best;
}
const crabRadius = (a) => clamp(a.s * 160 * a.ch.hitR / Math.max(0.3, (cam.dist / 24)), 24, 70);
const crabAt = (px, py) => { const o = pick(px, py); return o && o.root ? o : null; };
function updateCursor() {
  if (!renderer) return;
  let c = 'default', petting = false;
  agents.forEach((a) => { if (a.re.session) petting = true; });
  if ((ptr.down && ptr.pet) || petting || carry) c = 'grabbing';
  else if (!ptr.down && hover && hover.o.root) c = 'grab';
  const st = renderer.domElement.style;
  if (st.cursor !== c) st.cursor = c;
}
// Hover stroking: >=3 horizontal direction changes within 1.5s over the same crab pets it.
function strokeHover(x, y) {
  const now = nowS(), o = crabAt(x, y);
  if (!o) { ptr.st = null; return; }
  let st = ptr.st;
  if (!st || st.id !== o.id) st = ptr.st = { id: o.id, dir: 0, ext: x, ch: [] };
  const TH = embed ? 3 : 4;
  if (!st.dir) { if (Math.abs(x - st.ext) >= TH) { st.dir = x > st.ext ? 1 : -1; st.ext = x; } }
  else if (st.dir > 0) { if (x > st.ext) st.ext = x; else if (st.ext - x >= TH) { st.dir = -1; st.ext = x; st.ch.push(now); } }
  else if (x < st.ext) st.ext = x; else if (x - st.ext >= TH) { st.dir = 1; st.ext = x; st.ch.push(now); }
  while (st.ch.length && now - st.ch[0] > 1.5) st.ch.shift();
  if (st.ch.length >= 3) keepPet(o, 0.55);
}
function setHoverFromMouse() {
  if (ptr.mx < 0 || ptr.down) { if (overlay) updateCard(null); return; }
  const th = TK ? TK.pickAt(ptr.mx, ptr.my) : null, o = th || pick(ptr.mx, ptr.my); // a task item is small and sits by its owner: it wins over the owner
  hover = o && !th ? { o, id: o.root ? o.id : o.chipOf ? 'chip:' + o.chipOf.id : o.path } : null;
  const tip = $('tip');
  if (o && tip) {
    let txt;
    if (th) txt = TK.tipText(th);
    else if (o.root) { txt = `${o.d.type || o.id}: ${o.d.description || ''}`; const pk = packInfo(o); if (pk) txt += '\n' + packText(pk, 3, '/crew characters').join('\n'); }
    else txt = `${o.path}\n${fileWho(o)}`;
    if (tip.textContent !== txt) tip.textContent = txt; tip.style.whiteSpace = 'pre-wrap'; tip.style.display = 'block';
    tip.style.left = Math.min(ptr.mx + 14, innerWidth - 350) + 'px'; tip.style.top = (ptr.my + 14) + 'px';
  } else if (tip) tip.style.display = 'none';
  if (overlay) updateCard(o);
}
const ago = (ms) => { const s = Math.max(0, Math.round((liveNow() - tsMs(ms)) / 1000)); return s < 5 ? 'just now' : s < 90 ? s + 's ago' : s < 5400 ? Math.round(s / 60) + 'm ago' : Math.round(s / 3600) + 'h ago'; };
// "code · Explore read, main wrote · 2m ago": what the snapshot alone says about a file
function fileWho(o) {
  const by = Object.keys(o.d.by || {}).map((id) => `${agentName(id)} ${o.d.by[id] === 'r' ? 'read' : o.d.by[id] === 'w' ? 'wrote' : 'read+wrote'}`).join(', ');
  return [o.d.kind, by, o.d.last ? ago(o.d.last) : ''].filter(Boolean).join(' · ');
}
function agentName(id) { const a = agents.get(id); return a ? (a.id === 'main' ? 'main' : a.d.type || a.id) : String(id == null ? '?' : id); }
if (renderer) {
  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  const plate = overlay ? $('plate') : null;
  const onDown = (e) => {
    ptr.down = true; ptr.btn = e.button; ptr.x = ptr.sx = e.clientX; ptr.y = ptr.sy = e.clientY; ptr.moved = 0; lastInteract = nowS();
    ptr.ssx = e.screenX; ptr.ssy = e.screenY;
    // a left drag that starts on a crab pets it instead of rotating the camera (in the pet it carries the window)
    ptr.pet = !overlay && e.button === 0 && !e.shiftKey ? crabAt(e.clientX, e.clientY) : null; ptr.st = null;
    ptr.fromPlate = e.currentTarget !== el; // the nameplate: pressing it carries the window, nothing else
    ptr.pick = overlay && !ptr.fromPlate ? pick(e.clientX, e.clientY) : null;
    hideMore();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    if (overlay) { ptr.mx = e.clientX; ptr.my = e.clientY; kick(); }
  };
  const onMove = (e) => {
    ptr.mx = e.clientX; ptr.my = e.clientY;
    if (overlay) noteMove();
    if (!ptr.down) { strokeHover(e.clientX, e.clientY); return; }
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y; ptr.x = e.clientX; ptr.y = e.clientY;
    ptr.moved += Math.abs(dx) + Math.abs(dy); lastInteract = nowS();
    if (overlay) {
      if (carry) return; // the main process moves the window; the cursor stays over the same spot of it
      if (ptr.btn === 2) { cam.theta -= dx * 0.006; cam.phi = clamp(cam.phi - dy * 0.005, 0.12, 1.5); return; }
      if (ptr.btn === 0 && pet) {
        const sdx = e.screenX - ptr.ssx, sdy = e.screenY - ptr.ssy, dist = Math.hypot(sdx, sdy);
        if (dist > 4) beginCarry(sdx, sdy); // pressing a crab and pulling carries the window, always; petting is a stroke with the button up
      }
      return;
    }
    if (ptr.pet) {
      const pa = ptr.pet;
      if (ptr.moved >= 5 && agents.get(pa.id) === pa) {
        anchorOf(pa, _p); _p.project(camera);
        const cx = (_p.x * 0.5 + 0.5) * innerWidth, cy = (-_p.y * 0.5 + 0.5) * innerHeight;
        if (Math.hypot(cx - e.clientX, cy - e.clientY) < crabRadius(pa) * 1.8) keepPet(pa, 0.45);
      }
      return;
    }
    if (ptr.btn === 2 || e.shiftKey) {
      const k = cam.dist * 0.0016; autoFit = false;
      cam.tx += (-Math.cos(cam.theta) * dx + -Math.sin(cam.theta) * dy) * k;
      cam.tz += (Math.sin(cam.theta) * dx + -Math.cos(cam.theta) * dy) * k;
    } else { cam.theta -= dx * 0.006; cam.phi = clamp(cam.phi - dy * 0.005, 0.12, 1.5); }
  };
  const up = (e) => {
    if (!ptr.down) return; ptr.down = false;
    if (overlay) { overlayUp(e); return; }
    if (ptr.pet && ptr.moved >= 5) ptr.pet.re.petUntil = Math.min(ptr.pet.re.petUntil, nowS());
    ptr.pet = null;
    if (ptr.moved < 5 && ptr.btn === 0) {
      const o = pick(e.clientX, e.clientY);
      selected = o && o.root ? o.id : null;
      if (o && o.root) pinchCrab(o);
      setDetail();
    }
  };
  const cancel = () => { ptr.down = false; ptr.pet = null; if (carry) endCarry(); };
  const lost = () => { ptr.down = false; ptr.pick = null; if (carry) endCarry(); };
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove); el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel); el.addEventListener('lostpointercapture', lost);
  if (plate) {
    plate.addEventListener('pointerdown', onDown); plate.addEventListener('pointermove', onMove); plate.addEventListener('pointerup', up);
    plate.addEventListener('pointercancel', cancel); plate.addEventListener('lostpointercapture', lost);
    plate.addEventListener('contextmenu', (e) => e.preventDefault());
    plate.addEventListener('dblclick', () => { if (pet) pet.collapse(!collapsed); }); // double-click the title: fold it away or open it again
  }
  el.addEventListener('pointerleave', () => { ptr.mx = -1; hover = null; ptr.st = null; const t = $('tip'); if (t) t.style.display = 'none'; });
  el.addEventListener('wheel', (e) => {
    e.preventDefault(); lastInteract = nowS();
    if (overlay) {
      kick();
      if (e.ctrlKey) { // Ctrl+wheel resizes the window, a step at most every 120 ms so a trackpad does not run away
        const t = nowS();
        if (pet && t - lastResizeBy > 0.12) { lastResizeBy = t; pet.resizeBy(e.deltaY < 0 ? 1.1 : 1 / 1.1); }
        return;
      }
    }
    autoFit = false;
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 5, 220);
  }, { passive: false });
  el.addEventListener('dblclick', (e) => {
    if (overlay) { const o = pick(e.clientX, e.clientY); if (o && !o.root && !o.chipOf) { fileClick(o, e.shiftKey); return; } if (o) return; }
    autoFit = true; fitPending = true;
  });
}
function resize() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / Math.max(1, innerHeight); camera.updateProjectionMatrix();
  fitPending = true;
  if (overlay) { busyUntil = Math.max(busyUntil, nowS() + 1); needProbe = true; kick(); }
}
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- desktop pet (?overlay) */
// overlay/main.js hosts this page in a transparent, frameless window; window.crewPet (overlay/preload.js) is its only way out.
// The pet draws no world, throttles itself (30 fps while something moves, 12 idle) and asks the main process to let
// clicks through wherever the pixel under the cursor is transparent.
let collapsed = params.get('collapsed') === '1'; // only the title bar: the 3D view is closed until it is expanded again
let carry = null;             // { crab, vx, vy, sx, sy }: the window is being carried by the main process
let sizing = false;           // the corner grip is dragging
let busyUntil = 0;            // something is animating until then (s)
let needProbe = false, overContent = false, sentIgnore = true, missN = 0, hotUntil = 0;
let lastResizeBy = 0, pokedAt = -999, lastChangeAt = nowS(), snapSig = '', dozing = true, wasDozing = false, introDone = false;
let frameTimer = 0;
const mk = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
const clipStr = (t, n) => { t = String(t == null ? '' : t); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const unitsPerPx = (p) => 2 * camera.position.distanceTo(p) * Math.tan(camera.fov * Math.PI / 360) / Math.max(1, innerHeight);
const probeBuf = new Uint8Array(5 * 5 * 4);

/* ---- schedule: rAF alone would wake the page 60 times a second even when nothing moves */
function schedule(ms) {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = setTimeout(() => { frameTimer = 0; requestAnimationFrame(frame); }, Math.max(0, ms));
}
function kick() { if (overlay && frameTimer) schedule(0); }
function isBusy(n) {
  if (n < busyUntil || askIsOpen || n < bubbleUntil || ptr.down || carry || sizing || overContent || particles.length || rfx.length || effects.length || shake.W > 0.03 || (TK && TK.busy())) return true;
  return !dozing && sessionRunning(); // working crabs animate smoothly
}
function sessionRunning() {
  const se = lastSnap && lastSnap.session;
  if (!se) return false;
  if (se.turn && se.turn.running) return true;
  return (lastSnap.agents || []).some((a) => a && a.status === 'running');
}
// Asleep when nothing came in for 2 minutes or the session is not running; a poke (pinch) keeps them up for a while.
const isDozing = (n) => !lastSnap || ended || (n - pokedAt > 20 && (n - lastChangeAt > 120 || !sessionRunning()));
const poke = () => { pokedAt = nowS(); };
function hopAll() { const n = nowS(); let i = 0; agents.forEach((a) => { a.re.hopT = n + i++ * 0.12; }); busyUntil = Math.max(busyUntil, n + 2.5); kick(); }
function wakeAll() { const n = nowS(); let i = 0; agents.forEach((a) => { a.re.stretchT = n + i++ * 0.08; }); busyUntil = Math.max(busyUntil, n + 2); kick(); }
// Called with every new snapshot: has anything actually changed? (poll reloads the same data.js all the time)
function noteData(s) {
  const evs = Array.isArray(s.events) ? s.events : [];
  const sig = (evs.length ? evs[evs.length - 1].id : 0) + '|' + (s.agents || []).map((a) => a.id + ':' + a.status + ':' + a.verb + ':' + a.target).join(',') + '|' + (s.files || []).length;
  const n = nowS();
  if (sig !== snapSig) { snapSig = sig; lastChangeAt = n; busyUntil = Math.max(busyUntil, n + 3); kick(); }
  if (!introDone && agents.size) { introDone = true; hopAll(); }
}
const ENDED_MS = 10 * 60e3;   // a session whose file has not changed for this long is shown as ended
let ended = false, plateText = '';
function updatePlate() {
  const plate = $('plate'); if (!plate) return;
  const se = lastSnap && lastSnap.session ? lastSnap.session : null;
  const name = [se && se.cwd, se && se.title].filter(Boolean);
  const text = name.join(' \u00b7 ') + (ended && name.length ? ' \u00b7 ended' : '');
  if (text === plateText) return;
  plateText = text;
  document.body.classList.toggle('hasplate', !!text);
  plate.textContent = '';
  const dot = mk('i'); dot.style.background = sessionHsl(60); plate.appendChild(dot);
  if (se && se.cwd) plate.appendChild(mk('b', null, se.cwd));
  if (se && se.title) { plate.appendChild(document.createTextNode(' \u00b7 ')); plate.appendChild(mk('span', 't', se.title)); }
  if (ended) plate.appendChild(mk('span', 't', ' \u00b7 ended'));
  needProbe = true;
}
function overlayStep(dt, now) {
  document.body.classList.toggle('collapsed', collapsed);
  ended = !!(lastSnap && lastSnap.now && Date.now() - lastSnap.now > ENDED_MS);
  document.body.classList.toggle('ended', ended);
  updatePlate();
  dozing = isDozing(now);
  if (wasDozing && !dozing) wakeAll();
  wasDozing = dozing;
  if (carry) { const k = 1 - Math.exp(-dt * 10); carry.sx += (carry.vx - carry.sx) * k; carry.sy += (carry.vy - carry.sy) * k; }
  shakeStep(dt, now);
  // The grip is up whenever the pointer is in the window (it moved lately), so it can always be reached.
  document.body.classList.toggle('hot', now < hotUntil || sizing || (ptr.mx >= 0 && now - lastMoveAt < 4));
  placeBubble();
  checkAck();
}

/* ---- shaking the window: the carry velocity (px/s) the main process sends, its direction reversals, and springs that make limbs follow through */
// A shake = 3 or more reversals of the carry velocity within 1.2 s, each from a speed over SHAKE_MIN_V. Its energy E (0..1) grows with the
// count and the speed, so a hard shake looks different from a sway. E feeds the carried character's flail and the dizziness `dz`; the window
// itself, W (= E), knocks the other characters and the files about; they settle as E decays.
const SHAKE_MIN_V = 330, SHAKE_DEAD = 90;
const shake = { revs: [], sgn: [0, 0], pk: [0, 0], lastRev: [0, 0], E: 0, dz: 0, vx: 0, vy: 0, W: 0 };
function noteCarryVelocity(vx, vy) {
  const now = nowS(); shake.vx = vx; shake.vy = vy;
  [vx, vy].forEach((vel, i) => {
    const s = Math.abs(vel) < SHAKE_DEAD ? 0 : vel > 0 ? 1 : -1;
    if (!s) return;
    shake.pk[i] = Math.max(shake.pk[i], Math.abs(vel));
    if (shake.sgn[i] && s !== shake.sgn[i]) {
      if (shake.pk[i] >= SHAKE_MIN_V && now - shake.lastRev[i] > 0.05) { shake.revs.push({ t: now, pk: shake.pk[i] }); shake.lastRev[i] = now; busyUntil = Math.max(busyUntil, now + 1.5); }
      shake.pk[i] = 0;
    }
    shake.sgn[i] = s;
  });
}
function sstep(s, tgt, w, z, dt) { // a damped spring, two sub-steps
  const h = Math.min(dt, 0.05) / 2;
  for (let i = 0; i < 2; i++) { s.v += (w * w * (tgt - s.x) - 2 * z * w * s.v) * h; s.x += s.v * h; }
  return s.x;
}
const newSpring = () => ({ x: 0, v: 0 });
function newSprings() { return { ax: newSpring(), ay: newSpring(), bx: newSpring(), by: newSpring(), ly: newSpring(), ex: newSpring(), ey: newSpring(), tx: newSpring(), hx: newSpring(), hy: newSpring() }; }
function shakeStep(dt, now) {
  const S = shake;
  while (S.revs.length && now - S.revs[0].t > 1.2) S.revs.shift();
  const n = S.revs.length;
  let tgt = 0;
  if (n >= 3) tgt = clamp((n - 2) / 5, 0, 1) * clamp(S.revs.reduce((s, r) => s + r.pk, 0) / n / 1400, 0.35, 1);
  S.E += (tgt - S.E) * (1 - Math.exp(-dt * (tgt > S.E ? 12 : 2.5)));
  if (carry) { S.dz += S.E * dt * 1.0; S.dz *= Math.exp(-dt * 0.12); } else { S.vx *= Math.exp(-dt * 8); S.vy *= Math.exp(-dt * 8); }
  S.W = S.E; // how much the box is being shaken: only a shake agitates the others, a plain carry leaves them be
}
// A shaken crab that is put down: a hard shake sits it down first, then it staggers (stars circle its head) and shakes it off.
function startDizzy(a, dz) {
  const r = a.re, now = nowS(), hard = dz > 1.2; // only a very hard shake sits it down first
  r.sitDur = hard ? 0.9 : 0; r.sitT = now;
  r.dizzyT = now + r.sitDur; r.dizzyDur = 1.4 + 0.8 * clamp(dz / 1.2, 0, 1);
  for (let i = 0; i < 3; i++) spawnRfx('star', a, i * 0.06);
  busyUntil = Math.max(busyUntil, now + r.sitDur + r.dizzyDur + 1);
}
function petMove(v) { if (carry && v) { carry.vx = +v.vx || 0; carry.vy = +v.vy || 0; noteCarryVelocity(carry.vx, carry.vy); } }

/* ---- pet behaviour on top of the verb pose: sleeping, blinking, shuffling, looking, hops, stretch, carry */
function petCrab(a, v, dt, now, R) {
  const r = a.re;
  const carried = carry && carry.crab === a;
  const sleepy = dozing && (v === 'wait' || v === 'done') && !carried;
  r.sleep += ((sleepy ? 1 : 0) - r.sleep) * (1 - Math.exp(-dt * 2.5));
  if (r.sleep > 0.02) { // slow breathing, eyes shut, head drooped
    const br = Math.sin(now * 1.15 + a.ph);
    R.by += r.sleep * (0.1 + 0.14 * br); R.sy *= 1 + r.sleep * 0.04 * br; R.rx += r.sleep * 0.14; R.esy *= 1 - 0.92 * r.sleep;
  }
  if (r.sleep < 0.5) { // blink
    if (now >= r.blinkAt) { r.blinkAt = now + 2.5 + Math.random() * 4.5; r.blinkT = now; }
    const ub = now - r.blinkT;
    if (ub >= 0 && ub < 0.16 && v !== 'failed') R.esy *= 0.12;
  }
  if (v === 'wait' && r.sleep < 0.3 && !carry && !PS.reduceMotion) { // idle shuffle: a small sidestep every now and then
    if (now >= r.shufAt) { r.shufAt = now + 5 + Math.random() * 9; r.shufT = now; }
    const us = now - r.shufT;
    if (us >= 0 && us < 0.7) {
      const k = Math.sin(Math.PI * us / 0.7);
      R.rz += 0.12 * Math.sin(us * 20) * k; R.ry += 0.3 * Math.sin(us * 9) * k; R.by += 0.12 * k;
      for (let i = 0; i < 4; i++) R.lg[i] += 0.35 * Math.max(0, Math.sin(us * 22 + i * 1.7)) * k;
    }
  }
  let want = 0; // eyes and body turn a little toward a cursor that is near
  if (ptr.mx >= 0 && (v === 'wait' || v === 'done' || v === 'think') && r.sleep < 0.4 && !carry) {
    anchorOf(a, _p); _p.project(camera);
    const cx = (_p.x * 0.5 + 0.5) * innerWidth, cy = (-_p.y * 0.5 + 0.5) * innerHeight;
    const d = Math.hypot(ptr.mx - cx, ptr.my - cy);
    want = clamp((ptr.mx - cx) / 90, -1, 1) * clamp(1.4 - d / 180, 0, 1);
  }
  a.look += (want - a.look) * (1 - Math.exp(-dt * 7));
  R.ex += a.look * 0.42; R.ry += a.look * 0.3;
  const uh = now - r.hopT; // hello: two hops and a wave
  if (uh >= 0 && uh < 1.3) {
    const k = 1 - uh / 1.3;
    if (uh < 1) R.by += 1.7 * Math.abs(Math.sin(uh * Math.PI / 0.5));
    R.dA += 0.8 * Math.sin(uh * 22) * k; R.rz += 0.06 * Math.sin(uh * 14) * k; R.happy = true;
  }
  const ut = now - r.stretchT; // waking up: arms up, a long stretch, a squint
  if (ut >= 0 && ut < 1.2) {
    const k = Math.sin(Math.PI * ut / 1.2);
    R.dA += 1.4 * k; R.sy *= 1 + 0.14 * k; R.rx -= 0.18 * k; R.by += 0.5 * k;
    if (ut < 0.5) R.squint = true;
  }
  const ud = now - r.dropT; // set down: squash and bounce
  if (ud >= 0 && ud < 1) {
    R.sy *= 1 - 0.5 * Math.exp(-5 * ud) * Math.cos(14 * ud);
    R.by += 1.6 * Math.sin(Math.PI * clamp((ud - 0.06) / 0.4, 0, 1));
    R.rz += 0.1 * Math.sin(ud * 30) * Math.exp(-ud * 6);
    if (ud < 0.7) R.squint = true;
  }
  const uw = now - r.wobT;
  if (uw >= 0 && uw < 1.3) R.rz += 0.16 * Math.sin(uw * 22) * Math.exp(-uw * 3.2);
  // limbs that follow through: springs chasing the window's velocity, one set per limb group so they lag by different amounts
  const SP = a.sp, vxn = clamp(-shake.vx / 900, -1.4, 1.4), vyn = clamp(shake.vy / 900, -1.4, 1.4);
  sstep(SP.ax, vxn, 17, 0.18, dt); sstep(SP.ay, vyn, 17, 0.18, dt); sstep(SP.bx, vxn, 13, 0.22, dt); sstep(SP.by, vyn, 13, 0.22, dt);
  sstep(SP.ly, vyn, 11, 0.2, dt); sstep(SP.ex, vxn, 10, 0.14, dt); sstep(SP.ey, vyn, 10, 0.14, dt); sstep(SP.tx, vxn, 8, 0.15, dt);
  sstep(SP.hx, vxn, 14, 0.2, dt); sstep(SP.hy, vyn, 14, 0.2, dt);
  const E = shake.E, W = shake.W;
  if (carry) {
    if (carried) { // dangles by the claws: legs swing, the body sways against the window's velocity
      const amp = 0.4 + clamp(Math.hypot(carry.sx, carry.sy) / 900, 0, 0.7);
      R.by += 1.9; R.dA += 0.9;
      R.rz += clamp(-carry.sx / 1100, -0.7, 0.7); R.rx += clamp(carry.sy / 1600, -0.4, 0.4);
      for (let i = 0; i < 4; i++) R.lg[i] += amp * (0.5 + 0.5 * Math.sin(now * 9 + i * 1.5 + carry.sx * 0.002));
      if (E > 0.02) { // shaken: arms, legs, ears and tail flail with lag, the eyes spin, sweat and stars fly
        R.dL += E * (SP.ax.x * 1.5 + SP.ay.x * 1.7); R.dR += E * (-SP.ax.x * 1.5 + SP.ay.x * 1.7);
        R.rz += E * SP.bx.x * 0.8; R.rx -= E * SP.by.x * 0.5; R.ry += E * 0.45 * Math.sin(now * 19 + a.ph);
        for (let i = 0; i < 4; i++) R.lg[i] += E * 1.1 * Math.max(0, Math.sin(now * 17 + i * 1.9 + SP.ly.x * 3));
        R.earZ += E * SP.ex.x * 1.4; R.earX += E * (SP.ey.x * 1.2 + 0.4); R.tailW += E * SP.tx.x * 1.6;
        R.headZ += E * SP.hx.x * 0.9; R.headX += E * SP.hy.x * 0.7; R.headY += E * 0.6 * Math.sin(now * 27);
        R.mouth = Math.max(R.mouth, 0.5 + 0.5 * E); R.sy *= 1 + 0.05 * E * Math.sin(now * 31);
        if (E > 0.2 || shake.dz > 0.4) R.dizzy = true;
        if (now >= r.starAt) { r.starAt = now + 0.2 / (0.4 + E * 1.2); spawnRfx(Math.random() < 0.5 ? 'sweat' : 'star', a, 0); }
      }
    } else R.rz += clamp(-carry.sx / 3000, -0.14, 0.14);
  }
  if (!carried && W > 0.03) { // everyone else in the box is knocked about with it and settles when it stops
    const wk = Math.min(1, W * 1.5);
    R.by += 1.2 * E * Math.abs(Math.sin(now * 12 + a.ph * 3)); R.rz += wk * SP.bx.x * 0.4 + 0.12 * E * Math.sin(now * 21 + a.ph * 2); R.rx += 0.1 * E * Math.sin(now * 17 + a.ph);
    R.dL += wk * (SP.ax.x * 0.7 + SP.ay.x * 0.8); R.dR += wk * (-SP.ax.x * 0.7 + SP.ay.x * 0.8);
    R.earZ += wk * SP.ex.x * 0.8; R.earX += wk * SP.ey.x * 0.6; R.tailW += wk * SP.tx.x; R.headZ += wk * SP.hx.x * 0.5;
    for (let i = 0; i < 4; i++) R.lg[i] += 0.5 * E * Math.max(0, Math.sin(now * 15 + i * 1.7 + a.ph));
  }
  const usit = now - r.sitT; // after a hard shake: down on its bottom for a moment
  if (r.sitDur > 0 && usit >= 0 && usit < r.sitDur) {
    const k = Math.min(1, usit / 0.18) * (1 - clamp((usit - (r.sitDur - 0.25)) / 0.25, 0, 1));
    R.sy *= 1 - 0.22 * k; R.by -= 0.35 * k; R.rx -= 0.12 * k; R.dA -= 0.5 * k; R.dizzy = true; R.orbit = Math.max(R.orbit, k); R.mouth = Math.max(R.mouth, 0.4);
    for (let i = 0; i < 4; i++) R.lg[i] += 0.5 * k;
    R.rz += 0.06 * k * Math.sin(usit * 9);
  }
  const uz = now - r.dizzyT; // the stagger: wobbly sway, circling stars, then shaking it off
  if (uz >= 0 && uz < r.dizzyDur) {
    const k = 1 - uz / r.dizzyDur, off = r.dizzyDur - 0.5;
    if (uz < off) {
      R.dizzy = true; R.orbit = Math.max(R.orbit, 1 - clamp((uz - (off - 0.3)) / 0.3, 0, 1)); R.mouth = Math.max(R.mouth, 0.35);
      R.rz += 0.3 * k * Math.sin(uz * 5.2); R.ry += 0.5 * k * Math.sin(uz * 3.0 + 1); R.rx += 0.1 * k * Math.sin(uz * 4.1);
      R.by += 0.15 * k * (0.5 + 0.5 * Math.sin(uz * 9)); R.headZ += 0.3 * k * Math.sin(uz * 5.2 + 1);
      R.dL += 0.3 * k * Math.sin(uz * 6); R.dR -= 0.3 * k * Math.sin(uz * 6);
      for (let i = 0; i < 4; i++) R.lg[i] += 0.3 * k * Math.max(0, Math.sin(uz * 8 + i * 1.7));
    } else { // a little head shake
      const w = (uz - off) / 0.5, sw = Math.sin(w * Math.PI * 5) * (1 - w);
      R.ry += 0.8 * sw; R.headY += 0.8 * sw; R.earZ += 0.6 * sw; R.squint = true; R.sy *= 1 + 0.05 * Math.sin(w * Math.PI);
    }
  }
}

/* ---- speech bubbles: what a working crab is doing, a canvas sprite with its own dark background so it reads on any desktop */
const BUB = { read: ['▤', '#4aa3ff'], edit: ['✎', '#ff9340'], search: ['?', '#ffe08a'], run: ['»', '#c3cadb'], web: ['@', '#7ee0ff'], spawn: ['+', '#7ee0ff'], plan: ['☰', '#c08cff'], think: ['…', '#bcd0ff'] };
const BUB_TASK = ['☰', '#c08cff'];
function makeBubble() {
  const cv = document.createElement('canvas'); cv.width = 480; cv.height = 84;
  const tex = new T.CanvasTexture(cv); tex.colorSpace = T.SRGBColorSpace;
  const mat = new T.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false, opacity: 0 });
  const sp = new T.Sprite(mat); sp.center.set(0.5, 0); sp.renderOrder = 12; sp.visible = false; scene.add(sp);
  return { cv, tex, mat, sp, key: '', o: 0 };
}
function paintBubble(B, glyph, text, col) {
  const c = B.cv.getContext('2d'), w = B.cv.width, h = B.cv.height, bh = h - 16;
  c.clearRect(0, 0, w, h);
  c.textBaseline = 'middle'; c.textAlign = 'left';
  c.font = `700 40px ${FONT}`; const gw = c.measureText(glyph).width;
  c.font = `600 34px ${FONT}`;
  const t = text ? fit(c, text, w - 40 - gw - 24) : '', tw = t ? c.measureText(t).width : 0;
  const bw = Math.min(w - 8, gw + (t ? 12 + tw : 0) + 32), x0 = (w - bw) / 2;
  c.fillStyle = 'rgba(14,16,24,.94)'; c.strokeStyle = col; c.lineWidth = 4;
  c.beginPath(); c.roundRect ? c.roundRect(x0, 4, bw, bh, bh * 0.3) : c.rect(x0, 4, bw, bh); c.fill(); c.stroke();
  c.beginPath(); c.moveTo(w / 2 - 11, 4 + bh - 1); c.lineTo(w / 2 + 11, 4 + bh - 1); c.lineTo(w / 2, h - 3); c.closePath(); c.fillStyle = 'rgba(14,16,24,.94)'; c.fill();
  c.strokeStyle = col; c.beginPath(); c.moveTo(w / 2 - 11, 4 + bh); c.lineTo(w / 2, h - 3); c.lineTo(w / 2 + 11, 4 + bh); c.stroke();
  const ty = 4 + bh / 2 + 1;
  c.font = `700 40px ${FONT}`; c.fillStyle = col; c.fillText(glyph, x0 + 16, ty);
  if (t) { c.font = `600 34px ${FONT}`; c.fillStyle = '#f3f5fb'; c.fillText(t, x0 + 16 + gw + 12, ty); }
  B.tex.needsUpdate = true;
}
function updateBubble(a, v, dt) {
  const act = TK && PS.show.bubbles ? TK.activeText(a) : ''; // the task in hand says what it is doing ("Running tests")
  const B = a.bub, g = PS.show.bubbles ? BUB[v] || (act ? BUB_TASK : null) : null;
  if (g) {
    const tgt = act ? clipStr(act, 22) : a.d.target ? clipStr(v === 'read' || v === 'edit' ? base(a.d.target) : String(a.d.target), 18) : '';
    const key = v + '|' + tgt;
    if (key !== B.key) { B.key = key; paintBubble(B, g[0], tgt, g[1]); }
  }
  B.o += ((g ? 1 : 0) - B.o) * (1 - Math.exp(-dt * 6)); // idle and done crabs let it fade
  const vis = B.o > 0.03; B.sp.visible = vis;
  if (!vis) return;
  B.mat.opacity = B.o * (1 - 0.6 * a.dim);
  const upp = unitsPerPx(a.root.position), H = 20;
  B.sp.scale.set(H * upp * B.cv.width / B.cv.height, H * upp, 1);
  B.sp.position.set(a.pos.x, (a.s * (a.ch.top + 3.7) + a.body.position.y * a.s + 0.2), a.pos.z);
}

/* ---- hover card: the snapshot says who touched a file; the main process adds a summary of the file itself */
const card = overlay ? $('hcard') : null;
let cardKey = '';
const sumCache = new Map();
function summaryFor(f) {
  if (!pet || !pet.summary || !f.d.abs) return null;
  const k = f.d.abs + '|' + (f.d.last || 0), hit = sumCache.get(k);
  if (hit === undefined) {
    if (sumCache.size > 200) sumCache.clear();
    sumCache.set(k, 'wait');
    pet.summary(f.d.abs).then((r) => { sumCache.set(k, r || { error: 'none' }); cardKey = ''; }, () => { sumCache.set(k, { error: 'failed' }); cardKey = ''; });
    return null;
  }
  return hit === 'wait' ? null : hit;
}
function fillCrabCard(a) {
  const d = a.d, now = liveNow();
  const head = mk('div'); head.appendChild(mk('b', null, d.id === 'main' ? 'main' : d.type || d.id)); head.appendChild(document.createTextNode(' · ' + (d.status || '-')));
  card.appendChild(head);
  if (d.description && d.id !== 'main') card.appendChild(mk('div', 's', clipStr(d.description, 120)));
  card.appendChild(mk('div', 'p', (d.verb || '-') + (d.target ? ' ' + d.target : '')));
  card.appendChild(mk('div', 'p', `${a.chId || a.wantId} \u00b7 ${PC.explain(a.pick)}`));
  const pk = packInfo(a); // the card lists problems whatever show.packWarnings says: that setting only hides the amber badge
  if (pk) {
    const tx = packText(pk, 3, 'Settings\u2026');
    card.appendChild(mk('div', 's', clipStr(tx[0], 60)));
    tx.slice(1).forEach((t) => { const r = mk('div', 'h', clipStr(t, 120)); if (t.charAt(0) === '\u25cf' || t.charAt(0) === '\u25b2') r.style.color = t.charAt(0) === '\u25cf' ? '#ff8f93' : '#ffc261'; card.appendChild(r); });
  }
  card.appendChild(mk('div', 'p', `${d.steps != null ? d.steps : '-'} steps · ${d.calls != null ? d.calls : '-'} calls · ${d.startedAt ? fmtDur((d.endedAt || now) - d.startedAt) : '-'}`));
  const evs = lastSnap && Array.isArray(lastSnap.events) ? lastSnap.events.filter((e) => e.from === a.id).slice(-3) : [];
  evs.forEach((e) => card.appendChild(mk('div', 'h', '· ' + clipStr(e.text || e.tool || e.kind, 56))));
}
function fillFileCard(f, sm) {
  const head = mk('div'); head.appendChild(mk('b', null, base(f.path))); card.appendChild(head);
  card.appendChild(mk('div', 'p', clipStr(f.path, 70)));
  card.appendChild(mk('div', 'p', fileWho(f)));
  if (!f.d.abs) card.appendChild(mk('div', 'h', 'No absolute path in this data: /reload-plugins updates crew-graph, then it opens on click.'));
  if (!sm || sm.error) return;
  if (sm.title) card.appendChild(mk('div', 's', clipStr(sm.title, 80)));
  if (sm.lead) card.appendChild(mk('div', 'h', clipStr(sm.lead, 200)));
  if (sm.heads && sm.heads.length) card.appendChild(mk('div', 'h', sm.heads.slice(0, 6).map((h) => '# ' + clipStr(h, 24)).join('  ')));
  if (sm.decls && sm.decls.length) card.appendChild(mk('div', 'h', sm.decls.slice(0, 8).join('  ·  ')));
}
function updateCard(o) {
  if (!card) return;
  if (!o || carry || sizing || ptr.down || !o.d || collapsed) { if (cardKey) { card.style.display = 'none'; cardKey = ''; } return; }
  if (o.chipOf) { // the folded files of an agent: a hint, the list opens on a click
    const n = o.chipOf.hiddenN || 0, key = 'chip|' + o.chipOf.id + '|' + n;
    if (key !== cardKey) { cardKey = key; card.textContent = ''; card.appendChild(mk('b', null, '+' + n + ' more files')); card.appendChild(mk('div', 'p', 'of ' + agentName(o.chipOf.id) + ': click for the list')); card.style.display = 'block'; }
    const w = card.offsetWidth, h = card.offsetHeight;
    card.style.left = clamp(ptr.mx + 12, 4, Math.max(4, innerWidth - w - 4)) + 'px'; card.style.top = clamp(ptr.my + 14, 4, Math.max(4, innerHeight - h - 4)) + 'px';
    return;
  }
  const sm = o.root || o.tk ? null : summaryFor(o), sec = Math.floor(liveNow() / 1000);
  const key = o.tk ? TK.cardKey(o) : o.root ? ['a', o.id, o.d.status, o.d.verb, o.d.target, o.d.steps, o.d.calls, o.chId, o.pick && o.pick.how, packVer, sec].join('|') : ['f', o.path, o.d.last, sm ? 1 : 0, Math.floor(sec / 5)].join('|');
  if (key !== cardKey) {
    cardKey = key; card.textContent = '';
    if (o.tk) TK.fillCard(o, card, mk); else if (o.root) fillCrabCard(o); else fillFileCard(o, sm);
    card.style.display = 'block';
  }
  card.style.maxWidth = Math.max(120, Math.min(300, innerWidth - 12)) + 'px';
  const w = card.offsetWidth, h = card.offsetHeight;
  let x = ptr.mx + 12, y = ptr.my + 14;
  if (x + w > innerWidth - 4) x = ptr.mx - w - 12;
  if (y + h > innerHeight - 4) y = ptr.my - h - 10;
  card.style.left = clamp(x, 4, Math.max(4, innerWidth - w - 4)) + 'px';
  card.style.top = clamp(y, 4, Math.max(4, innerHeight - h - 4)) + 'px';
}

/* ---- activity ticker: the last few events, each fading after about 6 s */
const tickEl = overlay ? $('ticker') : null;
function tickerPush(text, col) {
  if (!tickEl || !text) return;
  const d = mk('div', null, text);
  if (col) d.style.borderLeft = '3px solid ' + col;
  tickEl.appendChild(d);
  while (tickEl.childNodes.length > 3) tickEl.removeChild(tickEl.firstChild);
  setTimeout(() => { d.className = 'old'; }, 6000);
  setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); needProbe = true; }, 7200);
  needProbe = true;
}
function tickerEvent(e) {
  if (!e) return;
  const f = agentName(e.from), to = e.to != null && agents.has(e.to) ? agentName(e.to) : null;
  let t = null;
  switch (e.kind) {
    case 'spawn': t = `${f} → ${to || '?'} spawn`; break;
    case 'answer': t = `${f} → ${to || 'main'} answer`; break;
    case 'done': t = `${f} → ${to || 'main'} done`; break;
    case 'read': t = `${f} ▤ ${base(e.to)}`; break;
    case 'write': t = `${f} ✎ ${base(e.to)}`; break;
    case 'tool': t = `${f} » ${clipStr(e.text, 40)}`; break;
    case 'deny': case 'fail': t = `${f} ✗ ${clipStr(e.text, 40)}`; break;
    case 'consult': t = `${f} → ${to || 'architect'} consult`; break;
    default: break;
  }
  if (t) tickerPush(clipStr(t, 60), KCOL[e.kind]);
}

/* ---- ask Claude from the pet: the ask card, the "sent" / reply bubble over the main character, the reply card.
   The card is where the keyboard goes: while it is open the page tells the main process (pet.askFocus), which makes the window focusable. */
const askEl = overlay ? $('ask') : null, askTa = overlay ? $('askTa') : null, rbub = overlay ? $('rbub') : null, replyEl = overlay ? $('reply') : null;
let askIsOpen = false, askAgent = '', askText = '', bubbleUntil = 0, bubbleKind = '', replyFull = '', replySeen = -1;
function openAsk(id) {
  if (!askEl || !pet || !pet.ask) return;
  askAgent = id ? String(id) : '';
  const a = askAgent ? agents.get(askAgent) : null;
  $('askT').textContent = askAgent ? 'Ask Claude about ' + (a ? (a.id === 'main' ? 'main' : a.d.type || a.id) : clipStr(askAgent, 24)) : 'Ask Claude';
  $('askS').textContent = a && a.d.description && a.id !== 'main' ? clipStr(a.d.description, 70) : askAgent ? '' : 'about the session';
  askTa.value = askText;
  askEl.style.display = 'block'; askIsOpen = true;
  closeReply(); hideMore();
  if (card) { card.style.display = 'none'; cardKey = ''; }
  pet.askFocus(true);
  setOver(true); needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 1); kick();
  setTimeout(() => { if (askIsOpen) askTa.focus(); }, 30);
}
function closeAsk() {
  if (!askIsOpen) return;
  askText = askTa.value;
  askEl.style.display = 'none'; askIsOpen = false;
  try { askTa.blur(); } catch (x) { /* ignore */ }
  if (pet) pet.askFocus(false);
  needProbe = true; kick();
}
function sendAsk(mode) {
  const text = askTa.value.trim();
  if (!text || text.length > 4000) return;
  pet.ask({ mode, text, agentId: askAgent });
  askText = ''; askTa.value = '';
  closeAsk();
  showBubble('sent', mode === 'draft' ? '\u270e in the prompt box' : '\u2709 sent', ACK_WAIT);
}
/* A request (ask, dismiss, stop) is delivered when the snapshot's petAck reaches its seq. Without that within ACK_WAIT seconds there is no live
   mod behind this window (a reload, an older mod): say so instead of leaving "sent" up. */
const ACK_WAIT = 8;
const unacked = [];
function noteWrote(ev) { unacked.push({ seq: ev.seq, kind: ev.kind, t: nowS() }); busyUntil = Math.max(busyUntil, nowS() + ACK_WAIT); kick(); }
function noteAck(s) {
  const ack = Number(s.petAck) || 0, n = nowS();
  for (let i = unacked.length - 1; i >= 0; i--) {
    if (unacked[i].seq > ack) continue;
    unacked.splice(i, 1);
    if (bubbleKind === 'sent') bubbleUntil = Math.min(bubbleUntil, n + 2.5); // delivered: the "sent" bubble can go soon
  }
}
function checkAck() {
  const n = nowS();
  for (let i = unacked.length - 1; i >= 0; i--) {
    if (n - unacked[i].t < ACK_WAIT) continue;
    const kind = unacked[i].kind;
    unacked.length = 0;
    showBubble('fail', '\u2709 not delivered: run /crew pet', 14);
    tickerPush('not delivered (' + kind + '): run /crew pet in this session', '#ff5c5c');
    return;
  }
}
function showBubble(kind, text, secs) {
  if (!rbub) return;
  bubbleKind = kind; bubbleUntil = nowS() + secs;
  rbub.textContent = text; rbub.className = kind;
  rbub.style.display = 'block';
  busyUntil = Math.max(busyUntil, bubbleUntil); needProbe = true; kick();
}
function hideBubble() { if (!rbub || rbub.style.display === 'none') return; rbub.style.display = 'none'; bubbleKind = ''; bubbleUntil = 0; needProbe = true; }
function openReply() {
  if (!replyEl || !replyFull) return;
  $('replyT').textContent = replyFull;
  replyEl.style.display = 'block'; hideBubble(); closeAsk(); needProbe = true; kick();
}
function closeReply() { if (replyEl && replyEl.style.display === 'block') { replyEl.style.display = 'none'; needProbe = true; } }
/** The mod put an answer to a question from the pet in the snapshot: a bubble from the main character for 12 s, a line in the ticker. */
function noteReply(s) {
  const r = s.lastReply;
  if (!rbub || !r || typeof r.text !== 'string' || typeof r.at !== 'number' || r.at === replySeen) return;
  replySeen = r.at;
  if ((s.now || Date.now()) - r.at > 45000) return; // an old one, seen when the window opened
  replyFull = r.text;
  showBubble('reply', clipStr(r.text, 120), 12);
  tickerPush('\u2709 ' + clipStr(r.text, 56), '#4de3c1');
}
/** The bubble sits over the main character's head (over the middle when there is none) and goes when its time is up. */
function placeBubble() {
  if (!rbub || rbub.style.display === 'none') return;
  if (nowS() > bubbleUntil) { hideBubble(); return; }
  const a = agents.get('main');
  let x = innerWidth / 2, y = innerHeight * 0.45;
  if (a) { _p.set(a.pos.x, a.pos.y + a.s * (a.ch.top + 2.2), a.pos.z).project(camera); x = (_p.x * 0.5 + 0.5) * innerWidth; y = (-_p.y * 0.5 + 0.5) * innerHeight; }
  const w = rbub.offsetWidth, h = rbub.offsetHeight;
  rbub.style.left = clamp(x - w / 2, 4, Math.max(4, innerWidth - w - 4)) + 'px';
  rbub.style.top = clamp(y - h - 8, 24, Math.max(24, innerHeight - h - 4)) + 'px';
}
if (overlay && askEl) {
  $('askX').addEventListener('click', closeAsk);
  $('askSend').addEventListener('click', () => sendAsk('send'));
  $('askDraft').addEventListener('click', () => sendAsk('draft'));
  $('replyX').addEventListener('click', closeReply);
  rbub.addEventListener('click', () => { if (bubbleKind === 'reply') openReply(); });
  askTa.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); closeAsk(); }
    else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendAsk('send'); }
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (askIsOpen) closeAsk(); else closeReply(); } });
}

/* ---- click-through: the page tells the main process whether the pixel under the cursor is content */
let lastMoveAt = -99;
function noteMove() { lastMoveAt = nowS(); needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 0.8); kick(); }
function setOver(v) {
  overContent = v;
  if (v) hotUntil = nowS() + 1.5; // the grip stays up long enough to reach it
  const ignore = !(v || carry || sizing);
  if (ignore !== sentIgnore) { sentIgnore = ignore; if (pet) pet.setIgnore(ignore); }
}
function glHit(x, y) {
  const gl = renderer.getContext(), dpr = renderer.getPixelRatio(), bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
  const x0 = clamp(Math.round(x * dpr) - 2, 0, Math.max(0, bw - 5)), y0 = clamp(Math.round(bh - y * dpr - 1) - 2, 0, Math.max(0, bh - 5)); // GL's y runs up
  gl.readPixels(x0, y0, 5, 5, gl.RGBA, gl.UNSIGNED_BYTE, probeBuf);
  for (let i = 3; i < probeBuf.length; i += 4) if (probeBuf[i] > 40) return true;
  return false;
}
function domHit(x, y) {
  const el = document.elementFromPoint(x, y);
  if (el && el.closest && (el.closest('#plate') || el.closest('#more') || el.closest('#ask') || el.closest('#reply') || el.closest('#rbub'))) return true;
  if (el && el.closest && el.closest('#grip') && document.body.classList.contains('hot')) return true;
  if (tickEl && tickEl.offsetParent !== null) {
    for (const d of tickEl.childNodes) {
      if (d.className === 'old') continue;
      const r = d.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
    }
  }
  return false;
}
// After render(), in a frame where the pointer moved: two misses in a row before it counts as "not over content".
function probeHit() {
  if (!needProbe || !pet) return;
  needProbe = false;
  if (carry || sizing) { setOver(true); return; }
  if (ptr.mx < 0) { missN = 2; setOver(false); return; }
  if (domHit(ptr.mx, ptr.my) || (!collapsed && glHit(ptr.mx, ptr.my))) { missN = 0; setOver(true); return; }
  if (++missN >= 2) setOver(false); else needProbe = true;
}

/* ---- carrying the window, the corner grip, clicks on files */
function beginCarry(dx, dy) {
  carry = { crab: ptr.pick && ptr.pick.root ? ptr.pick : null, vx: 0, vy: 0, sx: 0, sy: 0 };
  // The pull since the press is handed over, so the window catches up and the grabbed spot stays under the pointer.
  hover = null; setOver(true); pet.dragStart(dx || 0, dy || 0); busyUntil = Math.max(busyUntil, nowS() + 1); kick();
}
function endCarry() {
  const c = carry; if (!c) return;
  if (pet) pet.dragEnd();
  carry = null;
  const n = nowS(); let i = 0;
  const dz = shake.dz; shake.dz = 0; shake.revs.length = 0;
  if (c.crab && agents.get(c.crab.id) === c.crab) {
    if (dz > 0.3) startDizzy(c.crab, dz); // shaken: sits down if it was hard, then staggers
    else { c.crab.re.dropT = n; spawnRfx('bang', c.crab, 0.05); }
  }
  agents.forEach((a) => { if (a !== c.crab) a.re.wobT = n + 0.08 * ++i; });
  needProbe = true; busyUntil = Math.max(busyUntil, n + 2); kick();
}
function overlayUp(e) {
  if (carry) { endCarry(); ptr.pick = null; return; }
  if (ptr.fromPlate) { if (e.button === 2 && ptr.moved < 5 && pet) pet.menu({ kind: 'plate' }); return; }
  const o = pick(e.clientX, e.clientY);
  if (o && o.chipOf) { if (e.button === 0 && ptr.moved < 8) showMore(o.chipOf); else if (e.button === 2 && ptr.moved < 5 && pet) pet.menu({}); return; }
  if (e.button === 2) { // right click without a drag: the menu (a file gets its own entries)
    if (ptr.moved < 5 && pet) pet.menu(o && o.root ? { kind: 'crab', id: o.id, type: typeKeyOf(o), cur: o.chId, chars: charChoices(), pack: packInfo(o) && { id: o.pk.id, level: o.pk.level, n: o.pk.problems.length } } : o ? { kind: 'file', abs: o.d.abs || '' } : {});
    return;
  }
  if (e.button === 0 && ptr.moved < 8) {
    if (o && o.root) { pinchCrab(o); poke(); } else if (o) fileClick(o, e.shiftKey);
  }
}
const charChoices = () => charIds.map((id) => ({ id, name: (CHARS.get(id) || {}).name || id }));
/** The pet settings came in (or changed): what is shown, motion, and who is which character. */
function applyPet(s) {
  if (!s || typeof s !== 'object') return;
  const prev = PS;
  PS = PC.sanitize(s); packVer++;
  const cl = document.body.classList;
  cl.toggle('noticker', !PS.show.ticker); cl.toggle('noplate', !PS.show.nameplate);
  if (renderer) {
    reskinAll();
    if (lastSnap && prev.show.papers !== PS.show.papers) syncScene(lastSnap);
  }
  needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 1.5); kick();
}
/** Forget a press, a carry and a resize in flight: nothing is held, whatever the last events said. */
function resetInput() {
  ptr.down = false; ptr.pet = null; ptr.pick = null; ptr.st = null; ptr.fromPlate = false;
  if (carry) endCarry();
  if (sizing) { sizing = false; document.body.classList.remove('sizing'); if (pet) pet.resizeEnd(); }
  hover = null; needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 0.5); kick();
}
let lastOpen = { path: '', t: -9 };
function fileClick(f, shift) {
  burst('f:' + f.path, 0xffffff, 6);
  if (!pet) return;
  if (!f.d.abs) { tickerPush('no path recorded for ' + base(f.path) + ': /reload-plugins', '#ff5c5c'); return; }
  // A double-click is two clicks and a dblclick: it opens the file once.
  if (lastOpen.path === f.path + (shift ? '|s' : '') && nowS() - lastOpen.t < 0.8) return;
  lastOpen = { path: f.path + (shift ? '|s' : ''), t: nowS() };
  if (shift) pet.revealFile(f.d.abs); else pet.openFile(f.d.abs);
}
const more = overlay ? $('more') : null;
let moreTimer = 0;
function hideMore() {
  if (!more || more.style.display === 'none' || !more.style.display) return;
  more.style.display = 'none'; clearTimeout(moreTimer); needProbe = true;
}
function showMore(a) {
  if (!more) return;
  const list = [...files.values()].filter((f) => f.owner === a.id && f.hidden).sort((x, y) => (y.d.last || 0) - (x.d.last || 0));
  more.textContent = '';
  more.appendChild(mk('div', 'mh', list.length + ' more files of ' + agentName(a.id)));
  list.slice(0, 14).forEach((f) => {
    const row = mk('div', 'mr' + (f.d.abs ? '' : ' off')); row.appendChild(mk('b', null, base(f.path))); row.appendChild(mk('span', 'p', ' ' + clipStr(f.path, 34)));
    row.title = f.d.abs ? 'click: open \u00b7 shift+click: show in folder' : 'no absolute path in this data';
    row.addEventListener('click', (ev) => { fileClick(f, ev.shiftKey); if (f.d.abs) hideMore(); });
    more.appendChild(row);
  });
  if (list.length > 14) more.appendChild(mk('div', 'mh', '+' + (list.length - 14) + ' older ones'));
  more.style.display = 'block';
  anchorOf(a.chipObj, _p); _p.project(camera);
  const x = (_p.x * 0.5 + 0.5) * innerWidth, y = (-_p.y * 0.5 + 0.5) * innerHeight, w = more.offsetWidth, hh = more.offsetHeight;
  more.style.left = clamp(x - w / 2, 4, Math.max(4, innerWidth - w - 4)) + 'px'; more.style.top = clamp(y - hh - 8, 4, Math.max(4, innerHeight - hh - 4)) + 'px';
  clearTimeout(moreTimer); moreTimer = setTimeout(hideMore, 9000);
  hover = null; needProbe = true; kick();
}
if (overlay) {
  window.addEventListener('mousemove', (e) => { ptr.mx = e.clientX; ptr.my = e.clientY; noteMove(); }, true);
  document.documentElement.addEventListener('mouseleave', () => { if (carry || sizing) return; ptr.mx = -1; ptr.my = -1; hover = null; needProbe = true; kick(); });
  const grip = $('grip');
  if (grip && pet) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      try { grip.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      sizing = true; hover = null; document.body.classList.add('sizing'); setOver(true); pet.resizeStart(); kick();
    });
    const end = () => {
      if (!sizing) return;
      sizing = false; document.body.classList.remove('sizing'); pet.resizeEnd(); needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 1); kick();
    };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end); grip.addEventListener('lostpointercapture', end);
    // Whatever the pointer is over when the button comes up, the resize ends (capture can fail; a stuck resize would hold the window).
    window.addEventListener('pointerup', end); window.addEventListener('mouseup', end);
  }
  // Another app can come to the front between a press and its release (a file was just opened): the release never arrives.
  // Whatever the page believes about the pointer is dropped on the events that say the window lost it.
  window.addEventListener('blur', () => resetInput());
  window.addEventListener('focus', () => resetInput());
  window.addEventListener('pointercancel', () => resetInput(), true);
  document.addEventListener('visibilitychange', () => resetInput());
  window.addEventListener('pointerup', () => { if (carry) endCarry(); });
  if (pet) {
    pet.onMove(petMove);
    if (pet.onSettings) pet.onSettings(applyPet);
    pet.onEvent((ev) => {
      if (!ev) return;
      if (ev.type === 'hop') hopAll();
      else if (ev.type === 'ask') openAsk(ev.id);
      else if (ev.type === 'sent') showBubble('sent', '\u2709 sent', ACK_WAIT);
      else if (ev.type === 'wrote') noteWrote(ev);
      else if (ev.type === 'dismiss') { const n = nowS(); (Array.isArray(ev.ids) ? ev.ids : []).forEach((id, i) => { const a = agents.get(id); if (a && !a.bye) a.bye = n + i * 0.12; }); busyUntil = Math.max(busyUntil, n + 2.5 + (Array.isArray(ev.ids) ? ev.ids.length : 0) * 0.12); kick(); }
      else if (ev.type === 'reset-input') resetInput();
      else if (ev.type === 'reset') { autoFit = true; fitPending = true; busyUntil = Math.max(busyUntil, nowS() + 1); kick(); }
      else if (ev.type === 'ticker') document.body.classList.toggle('noticker', !ev.on);
      else if (ev.type === 'collapse') { collapsed = !!ev.on; hideMore(); needProbe = true; busyUntil = Math.max(busyUntil, nowS() + 1); kick(); }
      else if (ev.type === 'cursor') { // the main process watches the cursor too, in case forwarded moves do not arrive
        if (ev.x >= 0) { ptr.mx = ev.x; ptr.my = ev.y; noteMove(); } else if (ptr.mx >= 0 && !carry && !sizing) { ptr.mx = -1; needProbe = true; kick(); }
      }
    });
  }
}

/* ---------------------------------------------------------------- main loop */
let lastT = nowS(), clockT = 0;
// All animation / pose / particle / reaction / hover work. Embedded there is no rAF loop: __crewGrab() calls this once per grab.
function step(dt) {
  const now = nowS(); clockT += dt;
  if (overlay) overlayStep(dt, now);
  if (renderer) {
    updateCamera(dt, now);
    camera.updateMatrixWorld();
    relatedSet = relatedOf();
    agents.forEach((a) => updateCrab(a, dt, clockT, camera.position));
    if (TK) TK.update(dt, now);
    updateRfx(now);
    files.forEach((f) => {
      if (wire2) { // folded-away files stay out of sight; a hovered node dims the files it has nothing to do with
        f.g.visible = !f.hidden;
        f.dim += ((relatedSet && !relatedSet.has('f:' + f.path) ? 1 : 0) - f.dim) * (1 - Math.exp(-dt * 8));
        const tr = f.dim > 0.02;
        f.mats.forEach((m) => { if (m.transparent !== tr) m.transparent = tr; m.opacity = 1 - 0.65 * f.dim; });
      }
      f.pos.lerp(f.tgt, 1 - Math.exp(-dt * 3));
      f.g.position.set(f.pos.x, f.pos.y + 0.18 * Math.sin(clockT * 1.5 + f.ph), f.pos.z);
      f.mesh.rotation.y = clockT * 0.6 + f.ph;
      if (overlay && shake.W > 0.03) { const w = shake.W; f.g.position.x += 0.12 * w * Math.sin(clockT * 41 + f.ph * 3); f.g.position.y += 0.1 * w * Math.abs(Math.sin(clockT * 33 + f.ph)); f.mesh.rotation.z = 0.25 * w * Math.sin(clockT * 37 + f.ph); } else if (f.mesh.rotation.z) f.mesh.rotation.z = 0;
      f.g.scale.setScalar(Math.max(0.001, easeOutBack((now - f.born) / 0.5)));
    });
    if (wire2) { updateLinks(dt); updateEdges2(now); } else updateEdges();
    updateParticles(now);
    setHoverFromMouse();
    updateCursor();
  }
}
function frame() {
  const now = nowS(), dt = Math.min(overlay ? 0.12 : 0.05, now - lastT); lastT = now;
  if (overlay && collapsed) { overlayStep(0.1, now); if (needProbe) probeHit(); schedule(400); return; } // title bar only: nothing to draw
  if (renderer) { step(dt); renderer.render(scene, camera); if (overlay) probeHit(); }
  // The pet paces itself: about 30 fps while something moves, 12 when idle (a timer, so an idle page does not wake 60 times a second).
  if (overlay) schedule((PS.reduceMotion ? (isBusy(now) ? 66 : 166) : (isBusy(now) ? 33 : 83)) - (nowS() - now) * 1000 - 3);
  else requestAnimationFrame(frame);
}

/* ---------------------------------------------------------------- HUD */
const txt = (id, v) => { const e = $(id); if (e && e.textContent !== v) e.textContent = v; };
const fmtK = (n) => (n == null || isNaN(n) ? '-' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'k' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(Math.round(n)));
const fmtDur = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return m + 'm ' + (s % 60) + 's'; return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; };
const liveNow = () => (lastSnap ? (lastSnap.now || Date.now()) + (performance.now() - recvAt) : Date.now());
const tsMs = (v) => (v < 1e11 ? v * 1000 : v); // accept epoch seconds or ms
function countdown(at) {
  const ms = tsMs(at) - liveNow(); if (ms <= 0) return 'now';
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? d + 'd ' + (h % 24) + 'h' : h ? h + 'h ' + (m % 60) + 'm' : Math.max(1, m) + 'm';
}
const gcol = (p) => (p > 90 ? '#ff5c5c' : p > 70 ? '#ffb84d' : '#5ee08a');
let rateRows = [];
function renderRates(rate) {
  const box = $('rates'); if (!box) return;
  rate = Array.isArray(rate) ? rate : [];
  if (rateRows.length !== rate.length) {
    box.textContent = ''; rateRows = [];
    rate.forEach(() => {
      const w = document.createElement('div'); w.className = 'rt';
      const r = document.createElement('div'); r.className = 'row';
      const l = document.createElement('span'); l.className = 'dim';
      const v = document.createElement('span'); v.className = 'mono';
      r.appendChild(l); r.appendChild(v);
      const b = document.createElement('div'); b.className = 'bar'; const i = document.createElement('i'); b.appendChild(i);
      w.appendChild(r); w.appendChild(b); box.appendChild(w);
      rateRows.push({ l, v, i, at: null });
    });
  }
  rate.forEach((x, k) => {
    const R = rateRows[k], p = clamp(Number(x && x.pct) || 0, 0, 100);
    R.l.textContent = x && x.label ? x.label : 'limit'; R.at = x && x.resetsAt;
    R.p = p; R.i.style.width = p + '%'; R.i.style.background = gcol(p);
    R.v.textContent = Math.round(p) + '%' + (R.at ? ' · ' + countdown(R.at) : '');
  });
}
function renderHud(s) {
  const se = s.session || {};
  $('sDot') && $('sDot').classList.toggle('on', !!(se.turn && se.turn.running));
  txt('sModel', se.model || 'unknown model');
  const cwd = $('sCwd'); if (cwd) { cwd.style.display = se.cwd ? '' : 'none'; txt('sCwd', se.cwd || ''); }
  txt('sEffort', [se.effort, se.mode].filter(Boolean).join(' / ') || '-');
  txt('sReq', String(se.requests != null ? se.requests : 0));
  const cx = se.ctx;
  if (cx && cx.max > 0) {
    const p = clamp(cx.used / cx.max * 100, 0, 100);
    txt('sCtx', `${fmtK(cx.used)} / ${fmtK(cx.max)} (${Math.round(p)}%)`);
    const b = $('sBar'); if (b) { b.style.width = p + '%'; b.style.background = gcol(p); }
  } else { txt('sCtx', '-'); const b = $('sBar'); if (b) b.style.width = '0'; }
  txt('sComp', String(se.compactions || 0));
  txt('sCost', se.costUsd != null ? '$' + Number(se.costUsd).toFixed(se.costUsd < 10 ? 3 : 2) : '-');
  txt('sSpeed', (se.ttftMs != null ? Math.round(se.ttftMs) + ' ms' : '-') + ' / ' + (se.tokPerSec != null ? Number(se.tokPerSec).toFixed(1) + ' tok/s' : '-'));
  renderRates(se.rate);
  const g = s.gate || {};
  txt('gA', String(g.allowed || 0)); txt('gQ', String(g.asked || 0)); txt('gD', String(g.denied || 0)); txt('gP', String(g.pending || 0));
  const ar = s.architect;
  txt('aN', String(ar ? ar.consults || 0 : 0));
  txt('aState', ar ? (ar.running ? '· thinking...' : ar.lastMs != null ? '· last ' + fmtDur(ar.lastMs) : '') : '');
  renderLog(Array.isArray(s.events) ? s.events : []);
  tickHud();
  setChip();
}
let logMax = 0;
function renderLog(evs) {
  const box = $('log'); if (!box) return;
  const last = evs.length ? evs[evs.length - 1].id : 0;
  if (last === logMax && box.childNodes.length) return;
  const prev = logMax; logMax = last;
  box.textContent = '';
  for (let i = evs.length - 1, n = 0; i >= 0 && n < 30; i--, n++) {
    const e = evs[i]; if (!e) continue;
    const r = document.createElement('div'); r.className = 'ev' + (e.id > prev && prev ? ' new' : '');
    const t = document.createElement('span'); t.className = 't'; t.textContent = e.t ? new Date(e.t).toLocaleTimeString([], { hour12: false }) : '';
    const dot = document.createElement('i'); dot.style.background = KCOL[e.kind] || '#8b93a7';
    const k = document.createElement('b'); k.textContent = e.kind || ''; k.style.color = KCOL[e.kind] || '#cfd4e4';
    const x = document.createElement('span'); x.className = 'x';
    const fa = agents.get(e.from); x.textContent = (fa ? (fa.d.id === 'main' ? 'main' : fa.d.type) : e.from || '') + ': ' + (e.text || e.tool || '');
    x.title = e.text || '';
    r.appendChild(t); r.appendChild(dot); r.appendChild(k); r.appendChild(x); box.appendChild(r);
  }
}
function tickHud() {
  const s = lastSnap; if (!s) return;
  const now = liveNow(), tu = (s.session || {}).turn;
  const dot = $('tDot');
  if (tu) {
    dot && dot.classList.toggle('on', !!tu.running);
    txt('tTitle', tu.running ? 'turn running' : 'last turn');
    txt('tDur', fmtDur((tu.running ? now : tu.endedAt || now) - tu.startedAt));
    txt('tStats', `${tu.agents || 0} / ${tu.edits || 0} / ${tu.errors || 0}`);
  } else { dot && dot.classList.remove('on'); txt('tTitle', 'no turn yet'); txt('tDur', '-'); txt('tStats', '-'); }
  rateRows.forEach((R) => { if (R.at) R.v.textContent = Math.round(R.p) + '% · ' + countdown(R.at); });
  if (selected) fillDetail();
}
function setDetail() {
  const c = $('detail'); if (!c) return;
  c.style.display = selected && agents.has(selected) ? 'block' : 'none';
  if (selected) fillDetail();
}
function fillDetail() {
  const a = agents.get(selected); if (!a) { selected = null; setDetail(); return; }
  const d = a.d, now = liveNow();
  txt('dType', d.id === 'main' ? 'main' : d.type || d.id);
  const st = $('dStatus'); if (st) { st.textContent = d.status || '-'; st.style.color = SCOL[d.status] || '#cfd4e4'; }
  txt('dDesc', d.description || '');
  txt('dVerb', (d.verb || '-') + (d.target ? ' ' + d.target : ''));
  txt('dSteps', `${d.steps != null ? d.steps : '-'} / ${d.calls != null ? d.calls : '-'}`);
  txt('dTok', `${fmtK(d.ctxTokens)} / ${fmtK(d.outTokens)}`);
  txt('dTime', d.startedAt ? fmtDur((d.endedAt || now) - d.startedAt) : '-');
  txt('dMood', '\u2665 ' + a.mood.pets + ' \u00b7 \uaf2c\uc9d1\ud798 ' + a.mood.pinches);
  const pk = packInfo(a), pd = $('dPack');
  if (pd) { pd.style.display = pk ? 'block' : 'none'; txt('dPack', pk ? packText(pk, 99, '').join('\n') + '\n' + pk.problems.map((p) => 'fix: ' + p.fix).join('\n') : ''); }
}
const closeBtn = $('dClose'); if (closeBtn) closeBtn.addEventListener('click', () => { selected = null; setDetail(); });
function setChip() {
  const c = $('chip'); if (!c) return;
  let m = '';
  if (!renderer) m = 'WebGL unavailable: showing HUD only';
  else if (demoOn) m = 'demo mode: no live data';
  else if (!lastSnap) m = 'waiting for data...';
  c.textContent = m; c.style.display = m ? 'block' : 'none';
}

/* ---------------------------------------------------------------- data polling */
let pollTag = null;
function poll() {
  if (forceDemo) return;
  const old = pollTag;
  const sc = document.createElement('script');
  const done = () => { if (sc.parentNode) sc.parentNode.removeChild(sc); };
  sc.onload = done; sc.onerror = done;
  sc.src = (petSession ? 'sessions/' + petSession + '.js' : 'data.js') + '?t=' + Date.now();
  document.head.appendChild(sc);
  pollTag = sc;
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

/* ---- user characters: characters-user.js is rewritten by the mod (startWeb, /crew characters reload); look again now and then */
let userRev = String(window.__crewUserRev || '');
function pollChars() {
  const sc = document.createElement('script');
  const done = () => {
    if (sc.parentNode) sc.parentNode.removeChild(sc);
    const rev = String(window.__crewUserRev || '');
    if (rev === userRev) return;
    userRev = rev;
    loadCharacters();
    agents.forEach((a) => { a.chId = ''; }); // content may have changed under the same id
    reskinAll();
  };
  sc.onload = done; sc.onerror = done;
  sc.src = 'characters-user.js?t=' + Date.now();
  document.head.appendChild(sc);
}

/* ---------------------------------------------------------------- demo generator */
// ?demoRoot=<repo dir>: three demo files point at real files, so the pet's hover summary and click can be tried
const demoRoot = (params.get('demoRoot') || '').replace(/\\/g, '/').replace(/\/$/, '');
const DEMO_ABS = demoRoot ? { 'plans/settings-refactor.md': demoRoot + '/docs/DATA_CONTRACT.md', 'src/settings/load.ts': demoRoot + '/plugins/crew-graph/hooks/crew.ts', 'docs/README.md': demoRoot + '/README.md',
  // the busy demo's files: more names for the same three real files
  'plans/loader.md': demoRoot + '/docs/DATA_CONTRACT.md', 'docs/API.md': demoRoot + '/docs/DATA_CONTRACT.md', 'CHANGELOG.md': demoRoot + '/README.md', 'docs/MIGRATION.md': demoRoot + '/README.md',
  'src/load.ts': demoRoot + '/plugins/crew-graph/hooks/crew.ts', 'src/schema.ts': demoRoot + '/plugins/crew-graph/hooks/crew.ts', 'src/merge.ts': demoRoot + '/plugins/crew-graph/hooks/crew.ts', 'src/util.ts': demoRoot + '/plugins/crew-graph/hooks/crew.ts' } : {};
const demo = { id: 0, ev: [], ag: [], fl: [], t0: 0, step: 0, g: null, se: null, timer: null, ar: null };
function stopDemo() { demoOn = false; if (demo.timer) { clearInterval(demo.timer); demo.timer = null; } setChip(); }
function startDemo() {
  if (demoOn) return;
  demoOn = true; demo.t0 = nowS(); demo.step = -1;
  demo.timer = setInterval(demoTick, 500);
  demoReset(); demo.t0 -= Number(params.get('skip')) || 0; demoTick(); setChip();
}
function demoReset() {
  const now = Date.now();
  demo.ag = []; demo.fl = []; demo.ev = []; demo.step = 0; demo.t0 = nowS(); if (DK) DK.reset();
  demo.g = { allowed: 0, asked: 0, denied: 0, pending: 0 };
  demo.ar = { consults: 0, running: false };
  demo.se = { id: 'demo', cwd: 'my-project', title: 'Refactor the settings loader', model: 'claude-opus-5-5', effort: 'high', mode: 'default', requests: 0, ctx: { used: 38000, max: 200000 }, compactions: 0, costUsd: 0.04,
    rate: [{ label: '5h', pct: 34, resetsAt: now + 2.2 * 3600e3 }, { label: '7d', pct: 12, resetsAt: now + 3.1 * 86400e3 }], ttftMs: 820, tokPerSec: 61.3,
    turn: { running: true, startedAt: now, edits: 0, errors: 0, agents: 0 } };
  dAgent('main', null, 'main', 'Refactor the settings loader', 'think', 'reading prompt');
}
function dAgent(id, parent, type, desc, verb, target, extra) {
  const now = Date.now();
  demo.ag.push(Object.assign({ id, parentId: parent, type, description: desc, status: 'running', verb, target: target || '', since: now, steps: 1, calls: 0, ctxTokens: 8000, outTokens: 300, startedAt: now }, extra || {}));
  if (id !== 'main') demo.se.turn.agents++;
}
const dA = (id) => demo.ag.find((a) => a.id === id);
function dVerb(id, v, target) { const a = dA(id); if (!a) return; a.verb = v; a.target = target || ''; a.since = Date.now(); a.calls++; }
function dEv(kind, from, to, tool, text) { demo.ev.push({ id: ++demo.id, t: Date.now(), kind, from, to, tool, text }); if (demo.ev.length > 200) demo.ev.shift(); }
function dFile(path, kind, id, m) {
  let f = demo.fl.find((x) => x.path === path);
  if (!f) { f = { path, kind, by: {}, last: 0 }; if (DEMO_ABS[path]) f.abs = DEMO_ABS[path]; demo.fl.unshift(f); }
  f.by[id] = f.by[id] && f.by[id] !== m ? 'rw' : m; f.last = Date.now();
}
function dRead(id, p, kind) { dVerb(id, 'read', p); dFile(p, kind, id, 'r'); dEv('read', id, p, 'Read', 'Read ' + p); demo.g.allowed++; }
function dWrite(id, p, kind) { dVerb(id, 'edit', p); dFile(p, kind, id, 'w'); dEv('write', id, p, 'Edit', 'Edit ' + p); demo.g.allowed++; demo.se.turn.edits++; }
function dFinish(id, ok, text) {
  const a = dA(id); if (!a) return;
  a.status = ok ? 'completed' : 'failed'; a.verb = ok ? 'done' : 'failed'; a.endedAt = Date.now();
  if (ok) { dEv('done', id, a.parentId, null, text || 'finished'); dEv('answer', id, a.parentId, null, text || 'result returned'); }
  else { dEv('fail', id, null, null, text || 'failed'); demo.se.turn.errors++; }
}
const DK = window.CrewTasks ? window.CrewTasks.demo({ agents: () => demo.ag, dAgent: (...a) => dAgent(...a), dEv: (...a) => dEv(...a), dVerb: (...a) => dVerb(...a), dA: (id) => dA(id), reset: () => demoReset() }) : null; // the demo's tasks live in tasks.js
const SCRIPT = [
  [0.5, () => { dEv('prompt', 'main', null, null, 'Refactor the settings loader + update docs / 문서도 업데이트'); demo.se.requests++; }],
  [2, () => { dVerb('main', 'plan', 'plans/settings-refactor.md'); dFile('plans/settings-refactor.md', 'plan', 'main', 'w'); dEv('write', 'main', 'plans/settings-refactor.md', 'Write', 'Write plan'); }],
  [4, () => { dVerb('main', 'spawn', 'Explore'); dAgent('a1', 'main', 'Explore', 'map settings usage', 'search', 'loadSettings('); dEv('spawn', 'main', 'a1', 'Task', 'spawn Explore'); }],
  [4.8, () => { dAgent('a2', 'main', 'sonnet-coder', 'implement loader change', 'think', ''); dEv('spawn', 'main', 'a2', 'Task', 'spawn sonnet-coder'); }],
  [5.6, () => { dAgent('a3', 'main', 'doc-writer', '마이그레이션 문서 작성', 'think', ''); dEv('spawn', 'main', 'a3', 'Task', 'spawn doc-writer'); dVerb('main', 'wait', 'waiting for agents'); }],
  [6.5, () => { dEv('tool', 'a1', null, 'Grep', 'Grep loadSettings'); demo.g.allowed++; }],
  [8, () => dRead('a1', 'src/settings/load.ts', 'code')],
  [9, () => dRead('a3', 'docs/README.md', 'doc')],
  [9.8, () => dRead('a1', 'src/settings/schema.ts', 'code')],
  [10.5, () => dRead('a2', 'src/settings/load.ts', 'code')],
  [12, () => dWrite('a2', 'src/settings/load.ts', 'code')],
  [13, () => { dEv('check', 'main', null, 'Bash', 'permission check: Bash(npm test)'); demo.g.asked++; demo.g.pending++; }],
  [14, () => { demo.g.pending = 0; dVerb('a2', 'run', 'npm test'); dEv('tool', 'a2', null, 'Bash', 'npm test'); demo.g.allowed++; }],
  [15.5, () => { dEv('deny', 'a2', null, 'Bash', 'denied: rm -rf dist'); demo.g.denied++; }],
  [16.5, () => dFinish('a2', false, 'tests failed: 3')],
  [17, () => { dVerb('main', 'think', 'a2 failed, retrying'); }],
  [18.5, () => dFinish('a1', true, 'found 12 usages')],
  [19, () => { dAgent('a4', 'main', 'sonnet-coder', 'retry loader fix', 'read', 'src/settings/load.ts'); dEv('spawn', 'main', 'a4', 'Task', 'spawn retry'); }],
  [20, () => dWrite('a3', 'docs/MIGRATION.md', 'doc')],
  [21.5, () => { dVerb('a3', 'web', 'zod migration guide'); dEv('tool', 'a3', null, 'WebSearch', 'zod migration guide'); }],
  [22.5, () => { dAgent('a5', 'main', 'architect', 'review loader design', 'think', '', { isArchitect: true }); demo.ar.consults++; demo.ar.running = true; dEv('consult', 'main', 'a5', null, 'ask architect'); }],
  [23.5, () => dWrite('a4', 'src/settings/load.ts', 'code')],
  [24.5, () => dRead('a5', 'src/settings/load.ts', 'code')],
  [26, () => { demo.ar.running = false; demo.ar.lastMs = 3400; dFinish('a5', true, 'approve with nits'); }],
  [27, () => { dVerb('a4', 'run', 'npm test'); dEv('tool', 'a4', null, 'Bash', 'npm test'); demo.g.allowed++; }],
  [28.5, () => dWrite('a3', 'docs/MIGRATION.md', 'doc')],
  [29.5, () => dFinish('a4', true, 'tests pass')],
  [30.5, () => dFinish('a3', true, 'docs written')],
  [31.5, () => dWrite('main', 'CHANGELOG.md', 'doc')],
  [33, () => { dVerb('main', 'run', 'npm run build'); dEv('tool', 'main', null, 'Bash', 'npm run build'); demo.g.allowed++; }],
  [35, () => { dEv('compact', 'main', null, null, 'context compacted'); demo.se.compactions++; demo.se.ctx.used = 26000; }],
  [37, () => { dVerb('main', 'think', 'summarizing'); }],
  [40, () => { const a = dA('main'); a.status = 'idle'; a.verb = 'wait'; dEv('done', 'main', null, null, 'turn complete'); demo.se.turn.running = false; demo.se.turn.endedAt = Date.now(); }],
  [52, () => demoReset()],
];
if (DK) { SCRIPT.push(...DK.steps); SCRIPT.sort((x, y) => x[0] - y[0]); } // the to-do list of the default demo, merged in by time
const demoTasks = params.get('demo') === 'tasks';
// ?demo=busy: six agents in a tree and eighteen files, with reads and writes going on all the time
const demoBusy = params.get('demo') === 'busy';
// ?demo=lineup: every character in a row, each doing the verbs of ?verbs= (default think,edit,run); ?chars= still decides who is who for the types it names
const demoLineup = params.get('demo') === 'lineup';
const LINE_VERBS = (params.get('verbs') || 'think,edit,run').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6);
const lineupSlots = new Map();
function demoLineupInit() {
  demo.ag = [];
  const ids = charIds.length ? charIds : ['crab'];
  ids.forEach((cid, ci) => LINE_VERBS.forEach((vb, vi) => {
    const id = 'lu-' + cid + '-' + vb;
    dAgent(id, null, cid, vb, vb, vb === 'edit' ? 'app.js' : vb === 'run' ? 'npm test' : '', { status: vb === 'failed' ? 'failed' : vb === 'done' ? 'completed' : vb === 'wait' ? 'idle' : 'running' });
    lineupSlots.set(id, [ci, vi, ids.length]);
  }));
}
function lineupLayout() {
  const rows = LINE_VERBS.length;
  agents.forEach((a) => {
    const s = lineupSlots.get(a.id); if (!s) return;
    a.tgt.set((s[0] - (s[2] - 1) / 2) * 8.6, 0, (s[1] - (rows - 1) / 2) * 7.6);
    a.depth = 1; a.ang = 0;
  });
}
const BUSY_AGENTS = [['a1', 'main', 'Explore', 'map the loader', 'search'], ['a2', 'main', 'sonnet-coder', 'rewrite loader', 'edit'], ['a3', 'main', 'doc-writer', 'update the docs', 'read'],
  ['a4', 'a2', 'sonnet-coder', 'fix the tests', 'run'], ['a5', 'a2', 'Explore', 'check callers', 'read'], ['a6', 'a3', 'architect', 'review the design', 'think']];
const BUSY_FILES = [['plans/loader.md', 'plan'], ['plans/docs.md', 'plan'], ['docs/README.md', 'doc'], ['docs/MIGRATION.md', 'doc'], ['docs/API.md', 'doc'], ['CHANGELOG.md', 'doc'],
  ['src/load.ts', 'code'], ['src/schema.ts', 'code'], ['src/merge.ts', 'code'], ['src/watch.ts', 'code'], ['src/cli.ts', 'code'], ['src/util.ts', 'code'],
  ['test/load.test.ts', 'code'], ['test/schema.test.ts', 'code'], ['test/merge.test.ts', 'code'], ['src/types.ts', 'code'], ['src/index.ts', 'code'], ['package.json', 'code']];
function demoBusyInit() {
  BUSY_AGENTS.forEach((a) => dAgent(a[0], a[1], a[2], a[3], a[4], '', a[2] === 'architect' ? { isArchitect: true } : {}));
  dEv('prompt', 'main', null, null, 'Refactor the loader, fix the tests, update the docs');
  BUSY_FILES.forEach((f, i) => {
    const ids = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'main'], who = ids[i % ids.length];
    dFile(f[0], f[1], who, i % 3 === 0 ? 'w' : 'r');
    if (i % 5 === 0) dFile(f[0], f[1], ids[(i + 2) % ids.length], 'r');
  });
  demo.ag.forEach((a) => { const f = BUSY_FILES[(hash(a.id) % BUSY_FILES.length)]; a.target = base(f[0]); });
}
function demoBusyEvent() {
  const a = demo.ag[1 + Math.floor(Math.random() * (demo.ag.length - 1))], f = BUSY_FILES[Math.floor(Math.random() * BUSY_FILES.length)];
  if (Math.random() < 0.45) dWrite(a.id, f[0], f[1]); else dRead(a.id, f[0], f[1]);
  if (Math.random() < 0.2) { const b = demo.ag[Math.floor(Math.random() * demo.ag.length)]; dEv('spawn', b.parentId || 'main', b.id, 'Task', 'spawn ' + b.type); }
}
function demoTick() {
  const t = nowS() - demo.t0;
  if (demoLineup) { if (!demo.lineInit) { demo.lineInit = true; demoLineupInit(); } }
  else if (demoBusy) { if (!demo.busyInit) { demo.busyInit = true; demoBusyInit(); } if (Math.random() < 0.7) demoBusyEvent(); }
  else { const script = demoTasks && DK ? DK.script : SCRIPT; while (demo.step < script.length && script[demo.step][0] <= t) { const i = demo.step++; script[i][1](); if (demo.step <= i) break; } } // a step that restarts the demo (demoReset) sets step back to 0: stop here, the next tick plays the script from the new t0 (it used to replay it at once, reach the reset again and never return)
  const now = Date.now(), se = demo.se;
  demo.ag.forEach((a) => { if (a.status === 'running') { a.steps += Math.random() < 0.35 ? 1 : 0; a.calls += Math.random() < 0.4 ? 1 : 0; a.ctxTokens += Math.round(Math.random() * 600); a.outTokens += Math.round(Math.random() * 90); } });
  if (se.turn.running) { se.ctx.used += Math.round(300 + Math.random() * 700); se.costUsd += 0.0015 + Math.random() * 0.002; se.requests += Math.random() < 0.3 ? 1 : 0; }
  applySnapshot({ v: 1, now, session: JSON.parse(JSON.stringify(se)), agents: JSON.parse(JSON.stringify(demo.ag)), files: JSON.parse(JSON.stringify(demo.fl)).slice(0, 60),
    events: demo.ev.slice(), gate: Object.assign({}, demo.g), architect: Object.assign({}, demo.ar),
    tasks: DK && !demoLineup ? DK.tasks() : [], eaten: DK && !demoLineup ? DK.eaten() : {} }, true); // the lineup shows the characters, not their tasks
}

/* ---------------------------------------------------------------- embed grab */
// Renders one frame and returns it shrunk to w x h as base64 RGB, for the terminal Raster.
let grabCanvas = null;
window.__crewGrab = (w, h) => {
  if (!renderer) return '';
  const now = nowS(), dt = clamp(now - lastT, 0, 0.25); lastT = now;
  step(dt);
  renderer.render(scene, camera);
  if (!grabCanvas) grabCanvas = document.createElement('canvas');
  grabCanvas.width = w; grabCanvas.height = h;
  const g = grabCanvas.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.drawImage(renderer.domElement, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) { out[j] = d[i]; out[j + 1] = d[i + 1]; out[j + 2] = d[i + 2]; }
  let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(bin);
};

/* ---------------------------------------------------------------- test hooks (?hooks): for the scripts that drive the page */
if (params.has('hooks')) {
  window.__crewTest = {
    agents, files, CHARS, camera, cam, shake, THREE: T, renderer, rfx, makeCrab, updateCrab, scene, get tasks() { return TK; }, demoT: () => nowS() - demo.t0,
    anchorOf, noteCarryVelocity, petMove, openAsk, closeAsk, noteReply, showBubble, askOpen: () => askIsOpen,
    dismissAgents: (ids) => { const n = nowS(); ids.forEach((id, i) => { const a = agents.get(id); if (a && !a.bye) a.bye = n + i * 0.12; }); busyUntil = n + 4; kick(); }, pinchCrab, keepPet, setRules: (spec) => { charRules = CC.parseRules(spec); reskinAll(); },
    ids: () => charIds.slice(), settings: () => PS, pack: (id) => { const a = agents.get(id); return a ? packInfo(a) : null; }, problemsOf, picks: () => [...agents.values()].map((a) => [a.id, a.chId, a.pick && a.pick.how, a.pick && a.pick.mode, typeKeyOf(a)]),
    // carry without the main process: the same state beginCarry makes, minus the window move
    carryStart: (id) => { carry = { crab: agents.get(id) || null, vx: 0, vy: 0, sx: 0, sy: 0 }; busyUntil = nowS() + 30; },
    carryEnd: () => endCarry(),
    isCarrying: () => !!carry, setAutoFit: (b) => { autoFit = !!b; },
    screenOf: (id) => { const a = agents.get(id), v = new T.Vector3(); anchorOf(a, v); v.project(camera); return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight }; },
    info: (id) => { const a = agents.get(id); return a ? { char: a.chId, want: a.wantId, s: a.s, top: a.ch.top, hitR: a.ch.hitR, bones: Object.keys(a.bn), glb: a.ch.glb, via: (CHARS.get(a.chId) || {}).via } : null; },
  };
}

/* ---------------------------------------------------------------- the Settings window's previews (?preview) */
// settings.html lays out one element per character; setTiles() hands those elements over and every frame this draws the character into
// the rectangle of its element, with the same build and the same idle animation the pet uses. One canvas on top of the page, one viewport
// and scissor per tile (clipped to the scrolling list), so any number of tiles costs one WebGL context.
const pv = { tiles: new Map(), clip: null };
function initPreview() {
  dozing = false; // the idle loop, not asleep
  pPoints.visible = false; eLines.visible = false; // their buffers start as a thousand black points at the origin (the pet's frame sets the draw range)
  document.documentElement.classList.add('preview');
  agents.forEach(disposeCrab); agents.clear();
  window.__crewPreview = {
    list: () => charIds.map((id) => { const c = CHARS.get(id) || {}; return { id, name: c.name || id, user: !!c.user, traits: c.traits || [], problems: problemsOf(id) }; }),
    // every file of the user's folder, also those that did not load: { file, id, kind, loaded, problems } (the scan's problems plus the page's own)
    packs: () => (window.__crewUserPacks || []).map((p) => ({ file: p.file, id: p.id, kind: p.kind, loaded: PACKS.has(p.id), problems: PACKS.has(p.id) ? problemsOf(p.id) : CC.sortProblems(p.problems || []) })),
    scanned: () => +window.__crewUserScanned || 0,
    sig: () => charIds.join(',') + '|' + userRev,
    setClip: (el) => { pv.clip = el || null; },
    setTiles: (list) => {
      const want = new Map((Array.isArray(list) ? list : []).map((x) => [x.id, x.el]));
      pv.tiles.forEach((tl, id) => { if (!want.has(id)) { disposeCrab(tl.a); agents.delete(tl.a.id); pv.tiles.delete(id); } });
      want.forEach((el, id) => {
        const old = pv.tiles.get(id);
        if (old) { old.el = el; return; }
        if (!CHARS.has(id)) return;
        const a = makeCrab({ id: 'pv:' + id, type: 'preview', description: '', status: 'running', verb: 'wait', pvChar: id });
        agents.set(a.id, a); a.root.visible = false; a.shadow.visible = false; // the tile draws its own ground
        pv.tiles.set(id, { el, a, nextHop: nowS() + 0.6 + pv.tiles.size * 0.35 });
      });
    },
    poke: (id) => { const tl = pv.tiles.get(id); if (tl) tl.a.re.hopT = nowS(); },
  };
  setInterval(pollChars, 3000);
  const loop = () => { try { previewFrame(); } catch (err) { if (window.console) console.error('crew-graph preview', err); } requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
function previewFrame() {
  if (!renderer) return;
  const now = nowS(), dt = Math.min(0.1, now - lastT), W = innerWidth, H = innerHeight;
  lastT = now; clockT += dt;
  renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H); renderer.clear();
  renderer.setScissorTest(true);
  const clip = pv.clip ? pv.clip.getBoundingClientRect() : { left: 0, top: 0, right: W, bottom: H };
  pv.tiles.forEach((tl) => {
    agents.forEach((q) => { q.root.visible = false; });
    const r = tl.el.getBoundingClientRect();
    const x0 = Math.max(r.left, clip.left), y0 = Math.max(r.top, clip.top), x1 = Math.min(r.right, clip.right), y1 = Math.min(r.bottom, clip.bottom);
    if (x1 - x0 < 2 || y1 - y0 < 2 || r.width < 8 || r.height < 8) return;
    const a = tl.a, ch = a.ch;
    if (!ch) return;
    if (now >= tl.nextHop) { a.re.hopT = now; tl.nextHop = now + 4 + (hash(a.id) % 30) / 10; } // a little hello now and then
    // frame the character: its height and width decide the distance, the aspect of the tile decides which of the two rules
    const half = Math.tan(camera.fov * Math.PI / 360), aspect = r.width / r.height;
    const h = Math.max(a.s * ch.top, 0.9), w = Math.max(a.s * ch.bw * 1.5, a.s * ch.shadow[0] * 1.35, 1.2);
    const dist = Math.max((h * 1.75) / 2 / half, (w * 1.15) / 2 / (half * aspect));
    const ty = a.s * ch.top * 0.45;
    camera.aspect = aspect; camera.updateProjectionMatrix();
    camera.position.set(Math.sin(0.5) * dist, ty + dist * 0.26, Math.cos(0.5) * dist); camera.lookAt(0, ty, 0); camera.updateMatrixWorld();
    a.root.visible = true;
    updateCrab(a, dt, clockT, camera.position);
    renderer.setViewport(r.left, H - r.bottom, r.width, r.height);
    renderer.setScissor(x0, H - y1, x1 - x0, y1 - y0);
    renderer.render(scene, camera);
    a.root.visible = false;
  });
}

/* ---------------------------------------------------------------- boot */
if (overlay) {
  document.documentElement.classList.add('overlay'); document.body.classList.add('overlay');
  if (params.get('ticker') === '0') document.body.classList.add('noticker');
}
loadCharacters();
resize();
if (renderer && !embed && !preview && window.CrewTasks) {
  TK = window.CrewTasks.create({
    T, scene, agents, camera, FONT, overlay, clamp, lerp, easeIO, easeOutBack, nowS, spawnRfx, SMOKE_TEX, anchorOf,
    ps: () => PS, size: () => [innerWidth, innerHeight],
    calm: () => (overlay && dozing) || PS.reduceMotion,   // asleep, or asked to hold still: nobody works on its food
    running: () => (overlay ? sessionRunning() : true),
    pulse: (ms) => { busyUntil = Math.max(busyUntil, nowS() + ms / 1000); kick(); },
  });
}
if (preview) initPreview();
else {
  if (!embed) requestAnimationFrame(frame); // embedded: rendering is driven by __crewGrab, never by a continuous loop
  if (!overlay) setInterval(tickHud, 250);
  setChip();
  if (embed || params.has('nohud')) document.body.classList.add('embed'); // ?nohud: no side cards (shots of the characters)
  const startData = () => {
    if (forceDemo) startDemo();
    else {
      poll(); setInterval(poll, overlay ? 1000 : 500);
      setInterval(pollChars, 6000);
      if (!embed && !overlay) setTimeout(() => { if (!gotReal) startDemo(); }, 3000); // the pet has no demo fallback: no data, no show
    }
  };
  // The pet reads its settings before it draws anyone: nobody is drawn as one character and swapped for another a moment later.
  if (overlay && pet && pet.getSettings) Promise.race([pet.getSettings().then(applyPet).catch(() => {}), new Promise((r) => setTimeout(r, 700))]).then(startData);
  else startData();
}
})();
