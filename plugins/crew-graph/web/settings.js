/* crew-graph pet settings window: the controls. The 3D previews are drawn by app.js (?preview) into the boxes this file lays out. */
(() => {
'use strict';
const pet = window.crewPet, PC = window.CrewPetCore, CC = window.CrewCharCore, PV = window.__crewPreview;
const $ = (id) => document.getElementById(id);
const mk = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
const AUTO = 'Match role (auto)';

let S = PC.sanitize(null);   // the settings in force
let ctx = { windows: [] };   // the sessions and agents the pet windows show
let chars = [];              // [{ id, name, user, traits, problems }]
let packs = [];              // [{ file, id, kind, loaded, problems }]: every file of the user's folder, also those that did not load
let scanned = 0;             // when the mod last scanned the folder (ms), 0: not yet
let shown = '';                // the character id whose pack problems are shown under the tiles
let rescanning = null;       // { from: the scan time it started from, until } while a Rescan is under way
let canRescan = false;       // a pet window of a session with a token is there: the mod can be asked
let tilesSig = '', typesSig = '', agentsSig = '', packsSig = '', detailSig = '';

const push = (patch) => { if (pet) pet.setSettings(patch).then(take).catch(() => {}); };
function take(s) { if (!s) return; S = PC.sanitize(s); paint(); }

/* ---------------------------------------------------------------- one select of characters */
function charSelect(value, followLabel, onChange) {
  const sel = mk('select');
  const add = (v, label) => { const o = mk('option', null, label); o.value = v; sel.appendChild(o); };
  add('', followLabel); add('auto', AUTO); add('random', 'Random');
  chars.forEach((c) => add(c.id, c.name && c.name !== c.id ? c.name + ' (' + c.id + ')' : c.id));
  if (value && !Array.prototype.some.call(sel.options, (o) => o.value.toLowerCase() === value.toLowerCase())) add(value, value + ' (not loaded)');
  sel.value = value || '';
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

/* ---------------------------------------------------------------- the tiles: Auto, Random, every character with a live preview */
function paintTiles() {
  const box = $('tiles');
  const sig = chars.map((c) => c.id + ':' + c.name + ':' + (c.traits || []).join('+') + ':' + (c.problems || []).map((p) => p.code).join('+')).join('|');
  if (sig !== tilesSig) {
    tilesSig = sig;
    box.textContent = '';
    const tiles = [];
    const tile = (id, name, glyph, traits, badge, problems) => {
      const t = mk('div', 'tile'); t.dataset.id = id; t.title = 'Use for every agent that nothing else decides';
      const pv = mk('div', glyph ? 'pv glyph' : 'pv', glyph || '');
      t.appendChild(pv); t.appendChild(mk('b', null, name)); t.appendChild(mk('div', 'tr', traits));
      if (badge) t.appendChild(mk('span', 'badge', badge));
      if (problems && problems.length) {
        const lv = CC.statusOf(problems), pb = mk('button', 'pbadge ' + lv, '!');
        pb.title = problems.length + (problems.length === 1 ? ' problem' : ' problems') + ' in this pack: click to see them';
        pb.addEventListener('click', (e) => { e.stopPropagation(); select(id); });
        t.appendChild(pb);
      }
      t.addEventListener('click', () => { push({ default: id }); if (problems && problems.length) select(id); });
      if (!glyph) { t.addEventListener('mouseenter', () => PV && PV.poke(id)); tiles.push({ id, el: pv }); }
      box.appendChild(t);
    };
    tile('auto', 'Match role', 'A', 'by what each agent does: code, explore, docs, plan...');
    tile('random', 'Random', '?', 'a stable pick per agent');
    chars.forEach((c) => tile(c.id, c.name || c.id, '', (c.traits || []).join(', ') || 'no traits', c.user ? 'yours' : '', c.problems));
    if (PV) { PV.setClip($('scroll')); PV.setTiles(tiles); }
  }
  Array.prototype.forEach.call(box.children, (t) => { t.classList.toggle('on', !!S.default && t.dataset.id.toLowerCase() === S.default.toLowerCase()); t.classList.toggle('sel', !!shown && t.dataset.id === shown); });
  const sel = $('selDefault');
  const dsig = chars.map((c) => c.id).join(',') + '|' + (S.default || '');
  if (sel.dataset.sig !== dsig) {
    sel.dataset.sig = dsig; sel.textContent = '';
    const fresh = charSelect(S.default || '', 'Characters option, else crab', () => {});
    Array.prototype.slice.call(fresh.options).forEach((o) => sel.appendChild(o));
  }
  sel.value = S.default || '';
}

/* ---------------------------------------------------------------- pack problems */
const STATUS_WORD = { ok: 'ok', warn: 'warnings', error: 'error' };
const RANK = { error: 0, warn: 1, ok: 2 };
/* one pack as a block: its file, a status pill, and each problem with what to change */
function packBlock(p, selected) {
  const st = CC.statusOf(p.problems || []), b = mk('div', 'pp' + (selected ? ' sel' : ''));
  b.dataset.id = p.id;
  const h = mk('h3', null, p.file || p.id);
  h.appendChild(mk('span', 'pill ' + st, STATUS_WORD[st]));
  h.appendChild(mk('small', null, p.loaded === false ? 'not loaded \u00b7 would be "' + p.id + '"' : p.id));
  b.appendChild(h);
  if (!(p.problems || []).length) b.appendChild(mk('div', 'hint', 'Nothing to change.'));
  (p.problems || []).forEach((q) => {
    const w = mk('div', 'why ' + q.level, q.text);
    w.appendChild(mk('span', 'fix', 'Fix: ' + q.fix));
    b.appendChild(w);
  });
  return b;
}
const packOf = (id) => packs.find((p) => p.id === id) || null;
function select(id) { shown = id; paintDetail(); paintTiles(); const t = $('pdetail'); if (t && t.firstChild) t.scrollIntoView({ block: 'nearest' }); }
/* Under the tiles: the problems of the character that was clicked */
function paintDetail() {
  const box = $('pdetail'), c = chars.find((x) => x.id === shown), p = packOf(shown);
  const item = c && (c.problems || []).length ? { file: p ? p.file : '', id: c.id, loaded: true, problems: c.problems } : p && !p.loaded ? p : null;
  const sig = item ? JSON.stringify(item) : '';
  if (sig === detailSig) return;
  detailSig = sig; box.textContent = '';
  if (item) box.appendChild(packBlock(item, false));
}
/* The Character packs section: every file, ok or not */
function paintPacks() {
  const box = $('packs'), sig = JSON.stringify(packs) + '|' + shown;
  if (sig !== packsSig) {
    packsSig = sig; box.textContent = '';
    if (!packs.length) box.appendChild(mk('div', 'none', 'No packs yet. Put *.json (voxel) or *.glb (skinned) files in the characters folder (README.txt there says how), then Rescan.'));
    packs.slice().sort((a, b) => (RANK[CC.statusOf(a.problems || [])] - RANK[CC.statusOf(b.problems || [])]) || (a.file < b.file ? -1 : 1)).forEach((p) => box.appendChild(packBlock(p, p.id === shown)));
  }
  const n = packs.filter((p) => (p.problems || []).length).length, note = $('packsNote');
  const age = scanned ? Math.max(0, Math.round((Date.now() - scanned) / 1000)) : -1;
  let msg = packs.length ? packs.length + (packs.length === 1 ? ' pack, ' : ' packs, ') + (n ? n + ' with problems' : 'all ok') : 'Your own characters in the characters folder.';
  if (rescanning) msg = 'Rescanning\u2026';
  else if (age >= 0) msg += ' \u00b7 scanned ' + (age < 5 ? 'just now' : age < 90 ? age + ' s ago' : Math.round(age / 60) + ' min ago');
  if (note.textContent !== msg) note.textContent = msg;
  const btn = $('rescan');
  btn.disabled = !(pet && canRescan && !rescanning);
  btn.title = canRescan ? 'Same as /crew characters reload' : 'Needs a pet window of a Claude Code session (the mod does the scan); or run /crew characters reload there';
}
function focusPack(id) {
  shown = id; detailSig = ''; packsSig = ''; paintDetail(); paintPacks(); paintTiles();
  const row = Array.prototype.find.call($('packs').children, (r) => r.dataset && r.dataset.id === id);
  (row || $('packsH')).scrollIntoView({ block: 'center' });
}
$('rescan').addEventListener('click', () => {
  if (!pet || !pet.rescanCharacters) return;
  rescanning = { from: scanned, until: Date.now() + 8000 };
  paintPacks();
  pet.rescanCharacters().then((r) => {
    if (r && r.ok) return;
    rescanning = null; packsSig = ''; paintPacks();
    $('packsNote').textContent = 'Could not ask for a rescan: ' + ((r && r.why) || 'no answer') + '. Run /crew characters reload in Claude Code instead.';
  }).catch(() => { rescanning = null; });
});

/* ---------------------------------------------------------------- by type, per agent */
function typeKeys() {
  const seen = [];
  ctx.windows.forEach((w) => w.agents.forEach((a) => { if (a.type && seen.indexOf(a.type) < 0) seen.push(a.type); }));
  const keys = ['main'];
  seen.concat(Object.keys(S.types)).forEach((k) => { if (k !== '*' && keys.indexOf(k) < 0) keys.push(k); });
  keys.push('*');
  return keys;
}
function paintTypes() {
  const keys = typeKeys(), box = $('types');
  const sig = keys.join('|') + '#' + chars.map((c) => c.id).join(',');
  if (sig !== typesSig) {
    typesSig = sig; box.textContent = '';
    keys.forEach((k) => {
      const row = mk('div', 'row'), lbl = mk('span', 'lbl', k === '*' ? 'Any other type (*)' : k);
      if (k !== '*' && k !== 'main') lbl.appendChild(mk('small', null, 'seen in a session'));
      row.appendChild(lbl);
      const sel = charSelect(S.types[k] || '', 'Follow the rules', (v) => push({ types: { [k]: v || null } }));
      sel.dataset.key = k; row.appendChild(sel); box.appendChild(row);
    });
  }
  Array.prototype.forEach.call(box.querySelectorAll('select'), (sel) => { const v = S.types[sel.dataset.key] || ''; if (sel.value !== v && document.activeElement !== sel) sel.value = v; });
}
function paintAgents() {
  const box = $('agents'), rows = [];
  ctx.windows.forEach((w) => {
    const list = w.agents.filter((a) => a.id !== undefined);
    if (!list.length) return;
    rows.push({ group: w.name || w.session || 'session' });
    list.forEach((a) => rows.push({ key: PC.agentKey(w.session, a.id), label: a.id === 'main' ? 'main' : (a.type || a.id), sub: a.id === 'main' ? '' : a.description }));
  });
  const live = new Set(rows.filter((r) => r.key).map((r) => r.key));
  const gone = Object.keys(S.agents).filter((k) => !live.has(k));
  if (gone.length) { rows.push({ group: 'Saved for agents that are not on show' }); gone.forEach((k) => rows.push({ key: k, label: k.split('|').pop().slice(0, 28), sub: 'not on show' })); }
  const sig = rows.map((r) => r.group || r.key + r.label + r.sub).join('|') + '#' + chars.map((c) => c.id).join(',');
  if (sig !== agentsSig) {
    agentsSig = sig; box.textContent = '';
    if (!rows.length) box.appendChild(mk('div', 'none', 'No agents on show yet. Open a pet window for a session and they will be listed here.'));
    rows.forEach((r) => {
      if (r.group) { box.appendChild(mk('div', 'row')).appendChild(mk('span', 'grp', r.group)); return; }
      const row = mk('div', 'row'), lbl = mk('span', 'lbl', r.label);
      if (r.sub) lbl.appendChild(mk('small', null, r.sub));
      row.appendChild(lbl);
      const sel = charSelect(S.agents[r.key] || '', 'Follow the rules', (v) => push({ agents: { [r.key]: v || null } }));
      sel.dataset.key = r.key; row.appendChild(sel); box.appendChild(row);
    });
  }
  Array.prototype.forEach.call(box.querySelectorAll('select'), (sel) => { const v = S.agents[sel.dataset.key] || ''; if (sel.value !== v && document.activeElement !== sel) sel.value = v; });
}

/* ---------------------------------------------------------------- toggles, opacity, size */
function paintPlain() {
  Array.prototype.forEach.call(document.querySelectorAll('[data-show]'), (i) => { i.checked = !!S.show[i.dataset.show]; });
  $('reduce').checked = S.reduceMotion; $('onTop').checked = S.alwaysOnTop;
  if (document.activeElement !== $('opacity')) $('opacity').value = String(S.opacity);
  $('opacityV').textContent = S.opacity + '%';
  Array.prototype.forEach.call($('size').children, (b) => b.classList.toggle('on', b.dataset.size === S.size));
  Array.prototype.forEach.call($('autoDismiss').children, (b) => b.classList.toggle('on', Number(b.dataset.min) === S.autoDismiss));
  Array.prototype.forEach.call($('food').children, (b) => b.classList.toggle('on', b.dataset.food === S.food));
}
function paint() { paintPlain(); paintTiles(); paintDetail(); paintPacks(); paintTypes(); paintAgents(); }

Array.prototype.forEach.call(document.querySelectorAll('[data-show]'), (i) => i.addEventListener('change', () => push({ show: { [i.dataset.show]: i.checked } })));
$('selDefault').addEventListener('change', (e) => push({ default: e.target.value || null }));
$('reduce').addEventListener('change', (e) => push({ reduceMotion: e.target.checked }));
$('onTop').addEventListener('change', (e) => push({ alwaysOnTop: e.target.checked }));
$('opacity').addEventListener('input', (e) => { $('opacityV').textContent = e.target.value + '%'; push({ opacity: Number(e.target.value) }); });
Array.prototype.forEach.call($('size').children, (b) => b.addEventListener('click', () => push({ size: b.dataset.size })));
Array.prototype.forEach.call($('autoDismiss').children, (b) => b.addEventListener('click', () => push({ autoDismiss: Number(b.dataset.min) })));
Array.prototype.forEach.call($('food').children, (b) => b.addEventListener('click', () => push({ food: b.dataset.food })));
$('reset').addEventListener('click', () => { if (pet) pet.resetSettings(); });
$('close').addEventListener('click', () => { if (pet) pet.closeSettings(); });
$('done').addEventListener('click', () => { if (pet) pet.closeSettings(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pet) pet.closeSettings(); });

/* ---------------------------------------------------------------- feeds: the settings, the characters, the agents */
function refreshChars() {
  if (!PV) return;
  const next = PV.list(), nextPacks = PV.packs ? PV.packs() : [], at = PV.scanned ? PV.scanned() : 0;
  if (rescanning && (at !== rescanning.from || Date.now() > rescanning.until)) rescanning = null; // the manifest came back (or nothing changed)
  if (JSON.stringify(next) === JSON.stringify(chars) && JSON.stringify(nextPacks) === JSON.stringify(packs) && at === scanned) { paintPacks(); return; }
  chars = next; packs = nextPacks; scanned = at; paint();
}
function refreshContext() {
  if (!pet || !pet.settingsContext) return;
  pet.settingsContext().then((c) => {
    if (!c || !Array.isArray(c.windows)) return;
    ctx = c; canRescan = c.windows.some((w) => w.canRescan); paintTypes(); paintAgents(); paintPacks();
    if (c.focus) focusPack(c.focus); // "Pack problems…" in a character's right-click menu
  }).catch(() => {});
}
if (pet) {
  pet.onSettings(take);
  pet.getSettings().then(take).catch(() => {});
}
refreshChars(); paint();
refreshContext();
setInterval(refreshChars, 800);
setInterval(refreshContext, 1500);
})();
