/* crew-graph pet input diagnostics: the pure parts. A ring buffer of what happened to a pet window's click-through and pointer state, the
   name and pruning of the files it is written to, and the rule for when one is written on its own. A classic script that sets
   window.CrewInputDiag; overlay/main.js and the tests require() it. No DOM, no Electron and no clock of its own in here (the caller
   passes the time), so the tests need neither.

   The pet writes one of these files when a window is folded to its title bar (before anything is reset) and from the tray item
   "Save input diagnostics": ~/.claude/crew-graph/overlay/pet-input-<timestamp>-<session>.log, the newest five kept. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewInputDiag = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

const RING_CAP = 300;
const DUMP_KEEP = 5;
const DUMP_GAP_MS = 10000; // an automatic dump of one window at most this often: a flurry of folds must not push the one that matters out of the five
const TEXT_MAX = 160;

/* A ring of the last `cap` entries, oldest dropped first. add(kind, text, at) keeps { t, k, s }; the caller gives `at` (ms), so a test can
   stand in for the clock. */
function makeRing(cap) {
  const max = Math.max(1, cap | 0 || RING_CAP);
  const buf = [];
  let dropped = 0;
  return {
    add(kind, text, at) {
      buf.push({ t: Number.isFinite(at) ? at : Date.now(), k: String(kind).slice(0, 24), s: text == null ? '' : String(text).slice(0, TEXT_MAX) });
      if (buf.length > max) { buf.shift(); dropped += 1; }
    },
    list() { return buf.slice(); },
    size() { return buf.length; },
    dropped() { return dropped; },
    last(kind) { for (let i = buf.length - 1; i >= 0; i--) if (buf[i].k === kind) return buf[i]; return null; },
  };
}

const pad = (n, w) => String(n).padStart(w, '0');
/* 2026-10-15T14:03:09.042 style, local time as the user reads their clock; sortable as text */
function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}T${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}${pad(d.getMilliseconds(), 3)}`;
}
const clock = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
};

/* One ring entry as a line: "-12.345s 14:03:09.042 kind text" (seconds before `now`, then the clock). */
function line(e, now) {
  const ago = ((e.t - now) / 1000).toFixed(3);
  return `${ago.padStart(9)}s ${clock(e.t)} ${e.k.padEnd(10)} ${e.s}`;
}

/* The file name of a dump: sorts by time as text. The session id is clipped to the characters a file name may hold. */
function dumpName(at, sessionId) {
  const id = String(sessionId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  return `pet-input-${stamp(at)}${id ? '-' + id : ''}.log`;
}
const isDumpName = (n) => /^pet-input-\d{8}T\d{9}(-[A-Za-z0-9]{1,8})?\.log$/.test(String(n));

/* Of the names in the folder, the ones to delete so the newest `keep` dumps stay (other files are never named). */
function pruneNames(names, keep) {
  const mine = (Array.isArray(names) ? names : []).filter(isDumpName).sort();
  const n = Math.max(0, (keep == null ? DUMP_KEEP : keep) | 0);
  return mine.slice(0, Math.max(0, mine.length - n));
}

/* When may a dump be written? A manual one (the tray) always; an automatic one (a fold) unless this window had one `gap` ms ago. */
function makeDumpGate(gap) {
  const last = new Map();
  const g = Number.isFinite(gap) ? gap : DUMP_GAP_MS;
  return {
    allow(key, now, manual) {
      const prev = last.get(key);
      if (!manual && prev != null && now - prev < g) return false;
      last.set(key, now);
      return true;
    },
    forget(key) { last.delete(key); },
  };
}

/* The text of a dump: a header, each state block as "key: value" lines, then the rings (oldest first), each with its own title.
   `blocks`: [{ title, rows: [[key, value], ...] }]; `rings`: [{ title, entries }]. Values are written as JSON when they are objects. */
function render(now, blocks, rings) {
  const out = [`# crew pet input diagnostics, written ${new Date(now).toISOString()} (${clock(now)} local)`];
  for (const b of blocks) {
    out.push('', `## ${b.title}`);
    for (const [k, v] of b.rows) out.push(`${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  for (const r of rings) {
    out.push('', `## ${r.title} (${r.entries.length} entries, oldest first; time is seconds before this dump, then the local clock)`);
    for (const e of r.entries) out.push(line(e, now));
  }
  return out.join('\n') + '\n';
}

/* ---- the pulse: the main process asks each page, every PULSE_EVERY_MS, how it is doing, and acts on the answer. The page's own timers cannot be
   trusted for this (a page Chromium counts as hidden gets its timers and animation frames slowed or stopped), a request from outside can. */
const PULSE_EVERY_MS = 3000;
const PULSE_WAIT_MS = 1500;     // a page that has not answered by then is logged, not restarted: a hung renderer cannot run a restart
const FRAME_STALL_MS = 2500;    // the longest a frame may be late: the slowest legitimate gap is the folded window's 400 ms plus a wait for an animation frame
const RESTART_GAP_MS = 5000;    // restarts of one page's frame loop at most this often
const MOVE_LAG_MS = 1500;       // the page's last mouse move may be this much older than the cursor's last move over the window before the forwarding counts as lost
const RENEW_GAP_MS = 30000;     // the mouse forwarding is renewed at most this often

/* What the window's click-through should be, given what the page last asked for and whether a gesture holds the window (a drag or a resize
   needs the clicks). `apply`: the real state differs (or was never set), so the call must be made again. Used wherever a gesture ends in
   any way, and by the pulse. */
function ignoreFix(s) {
  const effective = !!s.pageWants && !s.gesture;
  return { effective, apply: s.realIgnore == null || s.realIgnore !== effective };
}

/* The pulse's answer `p` (null: none came in time) and what the main process knows `c` give the things to do, as a list of { do, ... }:
     note          nothing to fix, but worth a line in the ring
     restart-frame run the page's frame loop again, now (it stopped, or runs far too late)
     adopt-ignore  the page believes it asked for click-through `value`; the main process has something else: take the page's word
     renew-hook    the cursor moves over the window but the page gets no forwarded mouse moves: set the forwarding up again
   p: { frameAgeMs (-1 none yet), frames, upMs, sentIgnore, mouseAgeMs (-1 none yet) }
   c: { now, ignoring (what the page last asked for, as the main process has it), gesture, lastRestartAt, lastRenewAt, cursorMovedInsideAt (0 never),
        mismatchBefore (the previous pulse saw the same disagreement: one pulse can catch a request still on its way) } */
function pulseVerdict(p, c) {
  if (!p) return [{ do: 'note', why: 'the page did not answer the pulse' }];
  const out = [];
  const stalled = p.frameAgeMs >= 0 ? p.frameAgeMs > FRAME_STALL_MS : p.frames === 0 && p.upMs > FRAME_STALL_MS * 2;
  if (stalled && c.now - c.lastRestartAt >= RESTART_GAP_MS) {
    out.push({ do: 'restart-frame', why: p.frameAgeMs >= 0 ? `no frame for ${p.frameAgeMs} ms` : `no frame at all in ${p.upMs} ms` });
  }
  if (typeof p.sentIgnore === 'boolean' && !c.gesture && p.sentIgnore !== c.ignoring && c.mismatchBefore) {
    out.push({ do: 'adopt-ignore', value: p.sentIgnore, why: `the page asked for ${p.sentIgnore}, the main process had ${c.ignoring}` });
  }
  const sinceInside = c.cursorMovedInsideAt ? c.now - c.cursorMovedInsideAt : Infinity;
  const lost = p.mouseAgeMs < 0 || p.mouseAgeMs > sinceInside + MOVE_LAG_MS;
  if (c.ignoring && !c.gesture && sinceInside < MOVE_LAG_MS && lost && c.now - c.lastRenewAt >= RENEW_GAP_MS) {
    out.push({ do: 'renew-hook', why: `the cursor moved over the window ${sinceInside} ms ago, the page's last mouse move is ${p.mouseAgeMs} ms old` });
  }
  return out;
}

/* ---- who gets the mouse: the decision the page makes about the pet's click-through */
const HALO_PX = 14;         // the pointer this close to a drawn pixel counts as over it: a rotation is easier to start, and the empty areas stay click-through
const HALO_ALPHA = 40;      // a pixel this opaque is drawn content
const PRESS_STUCK_S = 15;   // a button held this long without the pointer moving is taken as a release the page never heard

/* Does the window take clicks right now? Over content, or while the pointer is held by something: a carry, a resize, or a button pressed on
   content. A right-drag that rotates the camera is the last one and has no flag of its own: without it the pointer leaving content
   mid-drag turned the click-through back on and handed the rest of the drag, and the release, to whatever was under the pet. */
function wantsClicks(s) { return !!(s.over || s.carry || s.sizing || s.down); }

/* A press the page never heard the release of (another app took the pointer): held this long without a move, it is let go. now, lastActivity: seconds. */
function pressStuck(s) { return !!s.down && s.now - s.lastActivity > PRESS_STUCK_S; }

/* The highest alpha within `r` px of (cx, cy) in an n x n block of RGBA bytes; the centre is the block's middle unless a block pushed in from
   the edge of the canvas says otherwise. */
function haloAlpha(buf, n, r, cx, cy) {
  let a = 0;
  const r2 = r * r;
  const mx = Number.isFinite(cx) ? cx : (n - 1) / 2;
  const my = Number.isFinite(cy) ? cy : (n - 1) / 2;
  for (let y = 0; y < n; y++) {
    const dy = y - my;
    for (let x = 0; x < n; x++) {
      const dx = x - mx;
      if (dx * dx + dy * dy > r2) continue;
      const v = buf[(y * n + x) * 4 + 3];
      if (v > a) a = v;
    }
  }
  return a;
}

/* ---- a decision the main process can make without the page: the cursor has sat over drawn content while click-through was on */
const COVER_HOLD_MS = 800;   // the cursor over content with click-through on for this long, and the page has not opened the window: the main process does
const COVER_SHRINK = 0.75;   // a crab's circle counts at this fraction of its radius: the main process knows shapes, not pixels

/* Is the client point (x, y) in one of the shapes the page last reported? hits: { circles: [[cx, cy, r]], rects: [[left, top, width, height]] } */
function overShape(hits, x, y) {
  if (!hits) return false;
  for (const c of hits.circles || []) {
    const r = c[2] * COVER_SHRINK;
    if ((x - c[0]) * (x - c[0]) + (y - c[1]) * (y - c[1]) <= r * r) return true;
  }
  for (const r of hits.rects || []) if (x >= r[0] && y >= r[1] && x < r[0] + r[2] && y < r[1] + r[3]) return true;
  return false;
}

/* Called for every look at the cursor (the main process takes one about 8 times a second). A page whose probe loop is stalled, or that gets no
   mouse moves, never opens the window, so the pet and its name pill are dead to the click. The page's last report of its shapes (up to a pulse
   old) and the cursor are enough to tell: after COVER_HOLD_MS over a shape with click-through still on, the window is opened, once per visit
   (the next visit needs the cursor to leave all shapes first), and the page is told where the cursor is and decides again.
   s: { x, y (client px, or null when the cursor is outside the window), hits, ignoring, gesture, since, forced, now }
   -> { since, forced, force }: keep `since` and `forced` for the next call. */
function coverVerdict(s) {
  const inside = s.x != null && overShape(s.hits, s.x, s.y);
  if (!inside) return { since: 0, forced: false, force: false };
  if (!s.ignoring || s.gesture) return { since: 0, forced: !!s.forced, force: false }; // the window already takes the clicks, or a gesture has them
  const since = s.since || s.now;
  const force = !s.forced && s.now - since >= COVER_HOLD_MS;
  return { since, forced: !!s.forced || force, force };
}

return { COVER_HOLD_MS, COVER_SHRINK, overShape, coverVerdict, HALO_PX, HALO_ALPHA, PRESS_STUCK_S, wantsClicks, pressStuck, haloAlpha, RING_CAP, DUMP_KEEP, DUMP_GAP_MS, PULSE_EVERY_MS, PULSE_WAIT_MS, FRAME_STALL_MS, RESTART_GAP_MS, MOVE_LAG_MS, RENEW_GAP_MS, makeRing, stamp, clock, line, dumpName, isDumpName, pruneNames, makeDumpGate, render, ignoreFix, pulseVerdict };
});
