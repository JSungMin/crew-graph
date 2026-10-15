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
const params = new URLSearchParams(location.search || '');
const forceDemo = params.has('demo');

/* ---------------------------------------------------------------- scene */
const host = $('stage');
let renderer = null;
try {
  renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  host.appendChild(renderer.domElement);
} catch (err) { renderer = null; }

const scene = new T.Scene();
scene.background = new T.Color(0x12141c);
scene.fog = new T.Fog(0x12141c, 50, 150);
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
scene.add(grid);
const disc = new T.Mesh(new T.CircleGeometry(46, 48).rotateX(-Math.PI / 2),
  new T.MeshBasicMaterial({ map: radialTex('90,100,160', 0.38), transparent: true, depthWrite: false, fog: false }));
disc.position.y = -0.02; scene.add(disc);

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

function makeCrab(d) {
  const isMain = d.id === 'main';
  const s = isMain ? 0.42 : d.isArchitect ? 0.3 : 0.28;
  const root = new T.Group(), body = new T.Group();
  body.rotation.order = 'YXZ'; root.add(body);
  const col = new T.Color();
  const h = isMain ? 14.8 / 360 : (14.8 + ((hash(d.type) % 31) - 15)) / 360;
  col.setHSL(h, 0.68, 0.56);
  const mat = new T.MeshLambertMaterial({ color: col.clone(), flatShading: true });
  const V = (w, hh, dd, x, y, z, m, p) => { const o = new T.Mesh(BOX, m || mat); o.scale.set(w, hh, dd); o.position.set(x, y, z); (p || body).add(o); return o; };
  V(7, 2.2, 4, 0, 2.3, 0);
  V(5, 1.3, 4, 0, 4.05, 0);
  const eyes = [], eyeM = [], xeyes = [];
  [-1.5, 1.5].forEach((x) => {
    const g = new T.Group(); g.position.set(x, 3.6, 2.05); body.add(g);
    eyeM.push(V(1, 1.3, 0.3, 0, 0, 0, M.eye, g));
    const xe = new T.Group(); xe.visible = false; g.add(xe);
    [0.785, -0.785].forEach((r) => { const b = V(1.5, 0.32, 0.3, 0, 0, 0.05, M.xeye, xe); b.rotation.z = r; });
    eyes.push({ g, x, xe });
  });
  const arms = [-1, 1].map((sg) => {
    const piv = new T.Group(); piv.position.set(sg * 3.5, 2.6, 0); body.add(piv);
    V(1.7, 1.3, 1.5, sg * 0.85, 0, 0, mat, piv);
    V(1.0, 0.9, 1.5, sg * 1.6, 0.85, 0, mat, piv);
    return piv;
  });
  const legs = [-2.7, -1.1, 1.1, 2.7].map((x) => V(0.9, 1.2, 0.9, x, 0.6, 0));
  const tipMat = new T.MeshBasicMaterial({ color: 0x66e6ff });
  const anten = new T.Group(); anten.visible = false; body.add(anten);
  [-1.5, 1.5].forEach((x) => { V(0.3, 1.8, 0.3, x, 5.9, 0, mat, anten); V(0.7, 0.7, 0.7, x, 7, 0, tipMat, anten); });
  const hat = new T.Group(); hat.visible = !!d.isArchitect; body.add(hat);
  V(3.2, 0.7, 3.2, 0, 5.05, 0, M.hat, hat); V(2, 0.9, 2, 0, 5.8, 0, M.hat, hat); V(0.9, 0.7, 0.9, 0, 6.5, 0, M.hat, hat);
  const page = new T.Group(); page.position.set(0, 2.5, 3.2); page.rotation.x = -0.35; page.visible = false; body.add(page);
  const pageMat = M.page.clone();
  V(2.6, 3.2, 0.15, 0, 0, 0, pageMat, page);
  [0.9, 0.3, -0.3, -0.9].forEach((y) => V(1.8, 0.14, 0.05, 0, y, 0.1, M.ink, page));
  const shadow = new T.Mesh(FLAT, M.shadow); shadow.scale.set(8.5, 1, 6.5); shadow.position.y = 0.03; shadow.renderOrder = 1; root.add(shadow);
  const ring = new T.Mesh(RING, M.sel); ring.scale.setScalar(6.8); ring.position.y = 0.06; ring.visible = false; root.add(ring);
  const spr = (g) => { const m = new T.SpriteMaterial({ map: g, transparent: true, depthTest: false, fog: false }); const sp = new T.Sprite(m); sp.visible = false; sp.renderOrder = 9; root.add(sp); return sp; };
  const fx = { z: [spr(GLYPH.z), spr(GLYPH.z), spr(GLYPH.z)], q: spr(GLYPH.q), bang: spr(GLYPH.bang) };
  const label = makeLabel(512, 128, isMain ? 1.05 : 0.85);
  scene.add(label.sp);
  root.scale.setScalar(0.001);
  scene.add(root);
  const cur = {}; POSE_KEYS.forEach((k) => { cur[k] = 0; }); cur.eyeSY = 1; cur.sq = 1; cur.aL = cur.aR = -0.25;
  return { id: d.id, d, s, h: 2.7 * s, root, body, mat, base: col, eyes, eyeM, arms, legs, anten, tipMat, hat, page, pageMat, ring, fx, label, labelKey: '',
    pos: new T.Vector3(), tgt: new T.Vector3(), cur, enterT: nowS(), born: nowS(), lastVerb: '', tintF: 0, yaw: 0, ph: (hash(d.id) % 628) / 100, depth: 0, ang: 0, lv: 1 };
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

function updateCrab(a, dt, t, camPos) {
  const now = nowS();
  const v = effVerb(a.d);
  if (v !== a.lastVerb) { a.lastVerb = v; a.enterT = now; }
  const lt = now - a.enterT, tt = t + a.ph;
  poseTarget(v, tt, lt);
  const rate = 1 - Math.exp(-dt * (v === 'failed' ? 5 : 11)), c = a.cur;
  for (const k of POSE_KEYS) c[k] += (P[k] - c[k]) * rate;
  a.body.position.y = c.by;
  a.body.rotation.set(c.rx, c.ry, c.rz);
  a.body.scale.set(1, c.sq, 1);
  a.arms[0].rotation.set(c.aLx, 0, -c.aL);
  a.arms[1].rotation.set(c.aRx, 0, c.aR);
  for (let i = 0; i < 4; i++) a.legs[i].position.y = 0.6 + c['l' + i];
  const xe = v === 'failed';
  for (let i = 0; i < 2; i++) {
    const e = a.eyes[i];
    e.g.position.x = e.x + c.eyeX * 0.45;
    a.eyeM[i].visible = !xe; e.xe.visible = xe;
    a.eyeM[i].scale.y = 1.3 * Math.max(0.05, c.eyeSY);
  }
  a.page.visible = v === 'read' || v === 'plan';
  if (a.page.visible) a.pageMat.color.setHex(v === 'plan' ? 0xe3d6ff : 0xf4f1e8);
  a.anten.visible = v === 'web';
  if (a.anten.visible) a.tipMat.color.setRGB(0.4, 0.9, 1).multiplyScalar(s01(Math.sin(t * 7)) * 0.9 + 0.1);
  // glyph sprites
  const F = a.fx;
  for (let i = 0; i < 3; i++) {
    const sp = F.z[i], life = (t * 0.45 + i / 3) % 1;
    sp.visible = v === 'think';
    if (sp.visible) { sp.position.set(1.8 + life * 1.6, 5.6 + life * 3.4, 0.5); sp.scale.setScalar(1.2 + life * 1.4); sp.material.opacity = Math.sin(life * Math.PI) * 0.95; }
  }
  F.q.visible = v === 'search';
  if (F.q.visible) { F.q.position.set(2.2, 6.6 + 0.3 * Math.sin(t * 3), 0.5); F.q.scale.setScalar(2.4); F.q.material.rotation = 0.2 * Math.sin(t * 2); }
  F.bang.visible = v === 'spawn';
  if (F.bang.visible) { F.bang.position.set(0, 7 + c.by, 0.5); F.bang.scale.setScalar(2.4); }
  // tint
  const tf = v === 'failed' ? 0.75 : v === 'done' ? (lt > 1.5 ? 0.5 : 0.15) : a.d.status === 'killed' ? 0.7 : (a.d.status === 'idle' || a.d.status === 'pending') ? 0.12 : 0;
  a.tintF += (tf - a.tintF) * (1 - Math.exp(-dt * 4));
  const tc = v === 'failed' ? TINT.failed : a.d.status === 'killed' ? TINT.killed : v === 'done' ? TINT.done : TINT.dim;
  a.mat.color.copy(a.base).lerp(tc, a.tintF);
  // placement
  a.pos.lerp(a.tgt, 1 - Math.exp(-dt * 3));
  a.root.position.copy(a.pos);
  const want = Math.atan2(camPos.x - a.pos.x, camPos.z - a.pos.z);
  let dy = want - a.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
  a.yaw += dy * (1 - Math.exp(-dt * 4));
  a.root.rotation.y = a.yaw;
  const age = now - a.born;
  a.root.scale.setScalar(a.s * Math.max(0.001, easeOutBack(age / 0.55)));
  a.label.sp.position.set(a.pos.x, a.s * 10.5 + 0.4, a.pos.z);
  a.ring.visible = !!(selected === a.id || (hover && hover.o === a));
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
  a.mat.dispose(); a.pageMat.dispose(); a.tipMat.dispose();
  a.label.tex.dispose(); a.label.mat.dispose();
  a.fx.z.forEach((s) => s.material.dispose()); a.fx.q.material.dispose(); a.fx.bang.material.dispose();
}

/* ---------------------------------------------------------------- files */
function makeFile(f) {
  const g = new T.Group(); let mesh;
  if (f.kind === 'plan') { mesh = new T.Mesh(BOX, M.plan); mesh.scale.setScalar(0.95); }
  else if (f.kind === 'doc') { mesh = new T.Mesh(BOX, M.doc); mesh.scale.set(1.3, 0.07, 1.7); mesh.rotation.x = 0.35; }
  else {
    mesh = new T.Mesh(BOX, M.code); mesh.scale.set(1, 0.26, 1);
    const inner = new T.Mesh(BOX, M.codeIn); inner.position.y = 0.6; inner.scale.set(0.55, 0.4, 0.55); mesh.add(inner);
  }
  g.add(mesh);
  const label = makeLabel(256, 56, 0.42);
  label.sp.position.y = 0.75; g.add(label.sp);
  paintLabel(label, base(f.path), '', null, false);
  scene.add(g);
  return { path: f.path, d: f, g, mesh, kind: f.kind, label, pos: new T.Vector3(), tgt: new T.Vector3(), born: nowS(), seq: ++fileSeq, ph: (hash(f.path) % 628) / 100 };
}
function disposeFile(f) { scene.remove(f.g); f.label.tex.dispose(); f.label.mat.dispose(); }

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

  // files: sorted by first-seen so slots stay stable
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
    const k = hv ? (touch ? 1.15 : 0.22) : e.k === 'tree' ? 0.6 : 0.75;
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
const pPoints = new T.Points(pGeo, new T.PointsMaterial({ size: 0.85, map: radialTex('255,255,255', 1), vertexColors: true, transparent: true, blending: T.AdditiveBlending, depthWrite: false, fog: false }));
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

function addP(p) { if (particles.length >= MAXP) particles.shift(); particles.push(p); }
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
function updateParticles(now) {
  let n = 0; const keep = [];
  for (const p of particles) {
    const tau = now - p.t0;
    if (tau < 0) { keep.push(p); continue; }
    if (tau > p.dur + TR * 0.04 + (p.k === 'path' ? 0.1 : 0)) continue;
    keep.push(p);
    if (p.k === 'path') { anchor(p.a, p.A); anchor(p.b, p.B); }
    const fade = 1 - clamp((tau - p.dur) / 0.25, 0, 1);
    for (let k = 0; k < TR && n < SLOTS; k++) {
      const tk = tau - k * 0.04; if (tk < 0) continue;
      if (p.k === 'path') curvePt(p.A, p.B, easeIO(clamp(tk / p.dur, 0, 1)), _pp);
      else { if (tk > p.dur) continue; _pp.set(p.O.x + p.v.x * tk, p.O.y + p.v.y * tk - 6 * tk * tk, p.O.z + p.v.z * tk); }
      const br = Math.pow(1 - k / TR, 1.5) * (p.k === 'path' ? fade : 1 - tk / p.dur);
      const o = n * 3;
      pPos[o] = _pp.x; pPos[o + 1] = _pp.y; pPos[o + 2] = _pp.z;
      pCol[o] = p.col.r * br; pCol[o + 1] = p.col.g * br; pCol[o + 2] = p.col.b * br;
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
    case 'read': path(fref(to) || (A && { r: A, dy: 5 }), A, PCOL.read, 0.8, delay); break;
    case 'write': path(A, fref(to) || (A && { r: A, dy: 5 }), PCOL.write, 0.8, delay); break;
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
  agents.clear(); files.clear(); edges = []; particles = [];
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
      const arch = !!d.isArchitect; if (a.hat.visible !== arch) a.hat.visible = arch;
    }
    refreshCrabLabel(a);
  }
  for (const [id, a] of agents) if (!ids.has(id)) { disposeCrab(a); agents.delete(id); if (selected === id) selected = null; }
  const fl = Array.isArray(s.files) ? s.files : [];
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
  for (const f of files.values()) if (f.born > nowS() - 0.01) f.pos.copy(f.tgt).setY(f.tgt.y + 1.5);
  if (grew && agents.size !== prevAgents) autoFit = true;
  if (hover && !(agents.has(hover.id) || files.has(hover.id))) hover = null;
}

function processEvents(evs, snapNow) {
  const fresh = [];
  let mx = maxSeen;
  for (const e of evs) { if (!e || typeof e.id !== 'number') continue; if (e.id > maxSeen) fresh.push(e); if (e.id > mx) mx = e.id; }
  fresh.sort((x, y) => x.id - y.id);
  const first = !inited; inited = true; maxSeen = mx;
  let list = first ? fresh.filter((e) => snapNow - (e.t || 0) < 2500) : fresh;
  list = list.slice(-40);
  list.forEach((e, i) => animateEvent(e, i * 0.09));
}

function applySnapshot(s, fromDemo) {
  if (!s || typeof s !== 'object') return;
  if (!fromDemo) {
    gotReal = true;
    if (demoOn) { stopDemo(); if (renderer) resetScene(); sessionId = null; }
  }
  const sid = s.session && s.session.id;
  if (sessionId != null && sid != null && sid !== sessionId && renderer) resetScene();
  if (sid != null) sessionId = sid;
  lastSnap = s; recvAt = performance.now();
  if (renderer) {
    try { syncScene(s); processEvents(Array.isArray(s.events) ? s.events : [], s.now || Date.now()); }
    catch (err) { if (window.console) console.error('crew-graph scene', err); }
  }
  renderHud(s);
}
window.__crewUpdate = (snap) => applySnapshot(snap, false);

/* ---------------------------------------------------------------- camera */
const cam = { theta: 0.55, phi: 1.0, dist: 24, tx: 0, ty: 1.5, tz: 0, gx: 0, gz: 0, gd: 24 };
let fitPending = true, autoFit = true, lastInteract = -99;
function fitBounds() {
  let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9, n = 0;
  const add = (v) => { x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z); n++; };
  agents.forEach((a) => add(a.tgt)); files.forEach((f) => add(f.tgt));
  if (!n) { cam.gx = 0; cam.gz = 0; cam.gd = 22; return; }
  cam.gx = (x0 + x1) / 2; cam.gz = (z0 + z1) / 2;
  const r = Math.max(x1 - x0, z1 - z0) / 2 + 5;
  const asp = camera.aspect || 1;
  cam.gd = clamp(r / Math.tan(25 * Math.PI / 180) * 0.85 / Math.min(1, asp), 14, 140);
}
function updateCamera(dt, now) {
  if (autoFit) {
    fitBounds();
    const k = 1 - Math.exp(-dt * 2.5);
    cam.tx += (cam.gx - cam.tx) * k; cam.tz += (cam.gz - cam.tz) * k; cam.dist += (cam.gd - cam.dist) * k;
  }
  if (now - lastInteract > 4) cam.theta += dt * 0.07;
  const sp = Math.sin(cam.phi), cp = Math.cos(cam.phi);
  camera.position.set(cam.tx + cam.dist * sp * Math.sin(cam.theta), cam.ty + cam.dist * cp, cam.tz + cam.dist * sp * Math.cos(cam.theta));
  camera.lookAt(cam.tx, cam.ty, cam.tz);
}

/* ---------------------------------------------------------------- input */
const ptr = { down: false, btn: 0, x: 0, y: 0, sx: 0, sy: 0, moved: 0, mx: -1, my: -1 };
function pick(px, py) {
  const W = innerWidth, H = innerHeight; let best = null, bd = 1e9;
  const test = (o, r, bias) => {
    anchorOf(o, _p); _p.project(camera);
    if (_p.z > 1) return;
    const dx = (_p.x * 0.5 + 0.5) * W - px, dy = (-_p.y * 0.5 + 0.5) * H - py, d = Math.hypot(dx, dy) - bias;
    if (d < r && d < bd) { bd = d; best = o; }
  };
  files.forEach((f) => test(f, 22, 0));
  agents.forEach((a) => { const r = clamp(a.s * 160 / Math.max(0.3, (cam.dist / 24)), 24, 70); test(a, r, 12); });
  return best;
}
function setHoverFromMouse() {
  if (ptr.mx < 0 || ptr.down) return;
  const o = pick(ptr.mx, ptr.my);
  hover = o ? { o, id: o.root ? o.id : o.path } : null;
  const tip = $('tip');
  if (o && tip) {
    let txt;
    if (o.root) txt = `${o.d.type || o.id}: ${o.d.description || ''}`;
    else txt = `${o.path}\n` + Object.keys(o.d.by || {}).map((id) => `${(agents.get(id) || { d: { type: id } }).d.type || id} ${o.d.by[id]}`).join(', ');
    if (tip.textContent !== txt) tip.textContent = txt; tip.style.whiteSpace = 'pre-wrap'; tip.style.display = 'block';
    tip.style.left = Math.min(ptr.mx + 14, innerWidth - 350) + 'px'; tip.style.top = (ptr.my + 14) + 'px';
  } else if (tip) tip.style.display = 'none';
  if (renderer) renderer.domElement.style.cursor = o && o.root ? 'pointer' : 'default';
}
if (renderer) {
  const el = renderer.domElement;
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('pointerdown', (e) => {
    ptr.down = true; ptr.btn = e.button; ptr.x = ptr.sx = e.clientX; ptr.y = ptr.sy = e.clientY; ptr.moved = 0; lastInteract = nowS();
    try { el.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
  });
  el.addEventListener('pointermove', (e) => {
    ptr.mx = e.clientX; ptr.my = e.clientY;
    if (!ptr.down) return;
    const dx = e.clientX - ptr.x, dy = e.clientY - ptr.y; ptr.x = e.clientX; ptr.y = e.clientY;
    ptr.moved += Math.abs(dx) + Math.abs(dy); lastInteract = nowS();
    if (ptr.btn === 2 || e.shiftKey) {
      const k = cam.dist * 0.0016; autoFit = false;
      cam.tx += (-Math.cos(cam.theta) * dx + -Math.sin(cam.theta) * dy) * k;
      cam.tz += (Math.sin(cam.theta) * dx + -Math.cos(cam.theta) * dy) * k;
    } else { cam.theta -= dx * 0.006; cam.phi = clamp(cam.phi - dy * 0.005, 0.12, 1.5); }
  });
  const up = (e) => {
    if (!ptr.down) return; ptr.down = false;
    if (ptr.moved < 5 && ptr.btn === 0) {
      const o = pick(e.clientX, e.clientY);
      selected = o && o.root ? o.id : null; setDetail();
    }
  };
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', () => { ptr.down = false; });
  el.addEventListener('pointerleave', () => { ptr.mx = -1; hover = null; const t = $('tip'); if (t) t.style.display = 'none'; });
  el.addEventListener('wheel', (e) => {
    e.preventDefault(); autoFit = false; lastInteract = nowS();
    cam.dist = clamp(cam.dist * Math.exp(e.deltaY * 0.0012), 5, 220);
  }, { passive: false });
  el.addEventListener('dblclick', () => { autoFit = true; fitPending = true; });
}
function resize() {
  if (!renderer) return;
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / Math.max(1, innerHeight); camera.updateProjectionMatrix();
  fitPending = true;
}
window.addEventListener('resize', resize);

/* ---------------------------------------------------------------- main loop */
let lastT = nowS(), clockT = 0;
function frame() {
  const now = nowS(), dt = Math.min(0.05, now - lastT); lastT = now; clockT += dt;
  if (renderer) {
    updateCamera(dt, now);
    camera.updateMatrixWorld();
    agents.forEach((a) => updateCrab(a, dt, clockT, camera.position));
    files.forEach((f) => {
      f.pos.lerp(f.tgt, 1 - Math.exp(-dt * 3));
      f.g.position.set(f.pos.x, f.pos.y + 0.18 * Math.sin(clockT * 1.5 + f.ph), f.pos.z);
      f.mesh.rotation.y = clockT * 0.6 + f.ph;
      f.g.scale.setScalar(Math.max(0.001, easeOutBack((now - f.born) / 0.5)));
    });
    updateEdges();
    updateParticles(now);
    setHoverFromMouse();
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
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
  sc.src = 'data.js?t=' + Date.now();
  document.head.appendChild(sc);
  pollTag = sc;
  if (old && old.parentNode) old.parentNode.removeChild(old);
}

/* ---------------------------------------------------------------- demo generator */
const demo = { id: 0, ev: [], ag: [], fl: [], t0: 0, step: 0, g: null, se: null, timer: null, ar: null };
function stopDemo() { demoOn = false; if (demo.timer) { clearInterval(demo.timer); demo.timer = null; } setChip(); }
function startDemo() {
  if (demoOn) return;
  demoOn = true; demo.t0 = nowS(); demo.step = -1;
  demo.timer = setInterval(demoTick, 500);
  demoReset(); demoTick(); setChip();
}
function demoReset() {
  const now = Date.now();
  demo.ag = []; demo.fl = []; demo.ev = []; demo.step = 0; demo.t0 = nowS();
  demo.g = { allowed: 0, asked: 0, denied: 0, pending: 0 };
  demo.ar = { consults: 0, running: false };
  demo.se = { id: 'demo', cwd: 'my-project', model: 'claude-opus-5-5', effort: 'high', mode: 'default', requests: 0, ctx: { used: 38000, max: 200000 }, compactions: 0, costUsd: 0.04,
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
  if (!f) { f = { path, kind, by: {}, last: 0 }; demo.fl.unshift(f); }
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
function demoTick() {
  const t = nowS() - demo.t0;
  while (demo.step < SCRIPT.length && SCRIPT[demo.step][0] <= t) { const i = demo.step++; SCRIPT[i][1](); }
  const now = Date.now(), se = demo.se;
  demo.ag.forEach((a) => { if (a.status === 'running') { a.steps += Math.random() < 0.35 ? 1 : 0; a.calls += Math.random() < 0.4 ? 1 : 0; a.ctxTokens += Math.round(Math.random() * 600); a.outTokens += Math.round(Math.random() * 90); } });
  if (se.turn.running) { se.ctx.used += Math.round(300 + Math.random() * 700); se.costUsd += 0.0015 + Math.random() * 0.002; se.requests += Math.random() < 0.3 ? 1 : 0; }
  applySnapshot({ v: 1, now, session: JSON.parse(JSON.stringify(se)), agents: JSON.parse(JSON.stringify(demo.ag)), files: JSON.parse(JSON.stringify(demo.fl)).slice(0, 60),
    events: demo.ev.slice(), gate: Object.assign({}, demo.g), architect: Object.assign({}, demo.ar) }, true);
}

/* ---------------------------------------------------------------- boot */
resize();
requestAnimationFrame(frame);
setInterval(tickHud, 250);
setChip();
if (forceDemo) startDemo();
else {
  poll(); setInterval(poll, 500);
  setTimeout(() => { if (!gotReal) startDemo(); }, 3000);
}
})();
