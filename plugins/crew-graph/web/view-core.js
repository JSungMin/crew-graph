/* crew-graph viewer: the pure part of the browser view that decides which session it shows when several Claude sessions write the
   shared data.js (follow*). A classic script that sets window.CrewViewCore; the tests require() it. No THREE and no DOM in here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CrewViewCore = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
'use strict';

/* ---- following one session
   data.js is whoever wrote last. With two sessions writing, a page reading it would swap between them on every poll, and swapping
   rebuilds the whole scene. So the page sticks to the session it showed and reads that session's own file (sessions/<id>.js) while
   it keeps moving; a session whose snapshot has not changed for FOLLOW_STALE_MS is let go, and the page reads data.js again. */
const FOLLOW_STALE_MS = 30000;
const SAFE_ID = /^[A-Za-z0-9._-]{1,80}$/;

const newFollow = () => ({ sid: null, snapNow: null, at: 0 });
const fresh = (f, now) => f.sid != null && now - f.at < FOLLOW_STALE_MS;

// The file to poll: the followed session's own, else the shared data.js.
function followSource(f, now) {
  return fresh(f, now) && SAFE_ID.test(f.sid) ? 'sessions/' + f.sid + '.js' : 'data.js';
}

// Whether a snapshot of session sid is shown: not when it is another session than the one that is still moving.
function followAccepts(f, sid, now) {
  return !(fresh(f, now) && sid != null && sid !== f.sid);
}

// A snapshot was shown: it is "moving" when its own clock (snapNow) changed or it is another session.
function followNote(f, sid, snapNow, now) {
  if (sid == null) return;
  if (sid !== f.sid || snapNow !== f.snapNow) { f.sid = sid; f.snapNow = snapNow; f.at = now; }
}

return { FOLLOW_STALE_MS, newFollow, followSource, followAccepts, followNote };
});
