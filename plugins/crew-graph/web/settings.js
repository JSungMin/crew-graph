/* crew-graph pet settings window: the controls. The 3D previews are drawn by app.js (?preview) into the boxes this file lays out. */
(() => {
'use strict';
const pet = window.crewPet, PC = window.CrewPetCore, PV = window.__crewPreview;
const $ = (id) => document.getElementById(id);
const mk = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
const AUTO = 'Match role (auto)';

let S = PC.sanitize(null);   // the settings in force
let ctx = { windows: [] };   // the sessions and agents the pet windows show
let chars = [];              // [{ id, name, user, traits }]
let tilesSig = '', typesSig = '', agentsSig = '';

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
  const sig = chars.map((c) => c.id + ':' + c.name + ':' + (c.traits || []).join('+')).join('|');
  if (sig !== tilesSig) {
    tilesSig = sig;
    box.textContent = '';
    const tiles = [];
    const tile = (id, name, glyph, traits, badge) => {
      const t = mk('div', 'tile'); t.dataset.id = id; t.title = 'Use for every agent that nothing else decides';
      const pv = mk('div', glyph ? 'pv glyph' : 'pv', glyph || '');
      t.appendChild(pv); t.appendChild(mk('b', null, name)); t.appendChild(mk('div', 'tr', traits));
      if (badge) t.appendChild(mk('span', 'badge', badge));
      t.addEventListener('click', () => push({ default: id }));
      if (!glyph) { t.addEventListener('mouseenter', () => PV && PV.poke(id)); tiles.push({ id, el: pv }); }
      box.appendChild(t);
    };
    tile('auto', 'Match role', 'A', 'by what each agent does: code, explore, docs, plan...');
    tile('random', 'Random', '?', 'a stable pick per agent');
    chars.forEach((c) => tile(c.id, c.name || c.id, '', (c.traits || []).join(', ') || 'no traits', c.user ? 'yours' : ''));
    if (PV) { PV.setClip($('scroll')); PV.setTiles(tiles); }
  }
  Array.prototype.forEach.call(box.children, (t) => t.classList.toggle('on', !!S.default && t.dataset.id.toLowerCase() === S.default.toLowerCase()));
  const sel = $('selDefault');
  const dsig = chars.map((c) => c.id).join(',') + '|' + (S.default || '');
  if (sel.dataset.sig !== dsig) {
    sel.dataset.sig = dsig; sel.textContent = '';
    const fresh = charSelect(S.default || '', 'Characters option, else crab', () => {});
    Array.prototype.slice.call(fresh.options).forEach((o) => sel.appendChild(o));
  }
  sel.value = S.default || '';
}

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
}
function paint() { paintPlain(); paintTiles(); paintTypes(); paintAgents(); }

Array.prototype.forEach.call(document.querySelectorAll('[data-show]'), (i) => i.addEventListener('change', () => push({ show: { [i.dataset.show]: i.checked } })));
$('selDefault').addEventListener('change', (e) => push({ default: e.target.value || null }));
$('reduce').addEventListener('change', (e) => push({ reduceMotion: e.target.checked }));
$('onTop').addEventListener('change', (e) => push({ alwaysOnTop: e.target.checked }));
$('opacity').addEventListener('input', (e) => { $('opacityV').textContent = e.target.value + '%'; push({ opacity: Number(e.target.value) }); });
Array.prototype.forEach.call($('size').children, (b) => b.addEventListener('click', () => push({ size: b.dataset.size })));
Array.prototype.forEach.call($('autoDismiss').children, (b) => b.addEventListener('click', () => push({ autoDismiss: Number(b.dataset.min) })));
$('reset').addEventListener('click', () => { if (pet) pet.resetSettings(); });
$('close').addEventListener('click', () => { if (pet) pet.closeSettings(); });
$('done').addEventListener('click', () => { if (pet) pet.closeSettings(); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pet) pet.closeSettings(); });

/* ---------------------------------------------------------------- feeds: the settings, the characters, the agents */
function refreshChars() {
  if (!PV) return;
  const next = PV.list();
  if (JSON.stringify(next) === JSON.stringify(chars)) return;
  chars = next; paint();
}
function refreshContext() {
  if (!pet || !pet.settingsContext) return;
  pet.settingsContext().then((c) => { if (c && Array.isArray(c.windows)) { ctx = c; paintTypes(); paintAgents(); } }).catch(() => {});
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
