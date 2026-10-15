/* crew-graph built-in characters: plain data on the shared rig (see docs and README "Characters").
   Every bone is optional; `at` is relative to the parent bone (default: body); `mirror` copies another bone
   with x flipped. Original designs: no character here is taken from anywhere. Units are voxels of the crab (7 wide). */
(function () {
'use strict';
// b(w,h,d, x,y,z, color, extra): one box
const b = (w, h, d, x, y, z, color, extra) => Object.assign({ size: [w, h, d], at: [x, y, z], color }, extra || {});
const rz = (a) => ({ rot: [0, 0, a] });

/* ---- crab: the original Clawd crab, kept as it was drawn before characters existed */
const crab = {
  id: 'crab', traits: ['lead', 'main', 'generalist'], name: 'Clawd crab', scale: 1,
  base: { h: 14.8, s: 0.68, l: 0.56, spread: 15 },
  hit: { y: 2.7, r: 1 }, shadow: [8.5, 6.5],
  props: { page: { at: [0, 2.5, 3.2] }, hat: { at: [0, 5.05, 0] }, anten: { at: [0, 5.9, 0], spread: 1.5 } },
  bones: {
    body: { boxes: [b(7, 2.2, 4, 0, 2.3, 0, '@base'), b(5, 1.3, 4, 0, 4.05, 0, '@base')] },
    eyeL: { at: [-1.5, 3.6, 2.05], boxes: [b(1, 1.3, 0.3, 0, 0, 0, '#1b1410')] },
    eyeR: { mirror: 'eyeL' },
    armL: { at: [-3.5, 2.6, 0], boxes: [b(1.7, 1.3, 1.5, -0.85, 0, 0, '@base'), b(1, 0.9, 1.5, -1.6, 0.85, 0, '@base')] },
    armR: { mirror: 'armL' },
    legL1: { at: [-2.7, 0.6, 0], gait: 0, boxes: [b(0.9, 1.2, 0.9, 0, 0, 0, '@base')] },
    legL2: { at: [-1.1, 0.6, 0], gait: 1, boxes: [b(0.9, 1.2, 0.9, 0, 0, 0, '@base')] },
    legR2: { at: [1.1, 0.6, 0], gait: 2, boxes: [b(0.9, 1.2, 0.9, 0, 0, 0, '@base')] },
    legR1: { at: [2.7, 0.6, 0], gait: 3, boxes: [b(0.9, 1.2, 0.9, 0, 0, 0, '@base')] },
  },
  eyes: { // for the left eye; the right one is mirrored
    x: [b(1.5, 0.32, 0.3, 0, 0, 0.05, '#3a0d0d', rz(0.785)), b(1.5, 0.32, 0.3, 0, 0, 0.05, '#3a0d0d', rz(-0.785))],
    squint: [b(1.2, 0.42, 0.3, -0.1, -0.32, 0.05, '#1b1410', rz(0.55)), b(1.2, 0.42, 0.3, -0.1, 0.32, 0.05, '#1b1410', rz(-0.55))],
    happy: [b(1, 0.42, 0.3, -0.38, -0.05, 0.05, '#1b1410', rz(0.7)), b(1, 0.42, 0.3, 0.38, -0.05, 0.05, '#1b1410', rz(-0.7))],
  },
};

/* ---- bunny: a round lilac blob with long ears */
const bunnyFur = '#f3ecff', bunnyDome = '#ebe1fb', bunnyShade = '#e2d6f7', pink = '#ffb3cf', ink = '#2b2140';
const bunny = {
  id: 'bunny', traits: ['docs', 'write', 'summarize', 'quick', 'web'], name: 'Mochi bunny', scale: 0.85,
  props: { page: { at: [0, 3.2, 3.4] } },
  bones: {
    body: { boxes: [b(5.6, 2.0, 4.6, 0, 1.7, 0, bunnyFur), b(3.0, 1.4, 0.2, 0, 1.5, 2.35, '#fff8fc')] },
    head: { at: [0, 2.7, 0], boxes: [b(6.0, 1.8, 4.8, 0, 0.9, 0, bunnyFur), b(5.0, 0.9, 4.0, 0, 2.25, 0, bunnyDome), b(3.2, 0.6, 3.0, 0, 2.9, 0, bunnyDome),
      b(0.9, 0.55, 0.2, -2.2, 0.45, 2.45, pink), b(0.9, 0.55, 0.2, 2.2, 0.45, 2.45, pink), b(0.55, 0.4, 0.2, 0, 0.8, 2.45, '#ff8fb5')] },
    eyeL: { parent: 'head', at: [-1.6, 1.1, 2.55], boxes: [b(0.75, 1.0, 0.3, 0, 0, 0, ink), b(0.28, 0.28, 0.2, 0.12, 0.25, 0.12, '#ffffff')] },
    eyeR: { mirror: 'eyeL' },
    mouth: { parent: 'head', at: [0, 0.35, 2.45], boxes: [b(0.7, 0.22, 0.2, 0, 0, 0, '#c24a77')] },
    earL: { parent: 'head', at: [-1.5, 2.5, -0.2], rot: [0, 0, 0.12], boxes: [b(1.0, 2.8, 0.8, 0, 1.4, 0, bunnyFur), b(0.5, 2.0, 0.2, 0, 1.3, 0.45, pink)] },
    earR: { mirror: 'earL' },
    armL: { at: [-2.85, 1.7, 0.4], boxes: [b(0.9, 1.1, 1.1, -0.35, 0, 0, bunnyFur)] },
    handL: { parent: 'armL', at: [-0.8, -0.05, 0], boxes: [b(0.7, 0.7, 0.9, -0.1, 0, 0.05, pink)] },
    armR: { mirror: 'armL' },
    handR: { mirror: 'handL' },
    legL1: { at: [-1.5, 0.35, 0.5], gait: 0, boxes: [b(1.5, 0.7, 2.2, 0, 0, 0.4, bunnyShade)] },
    legR1: { mirror: 'legL1', gait: 2 },
    tail: { at: [0, 1.3, -2.4], boxes: [b(1.5, 1.5, 1.3, 0, 0, -0.5, '#ffffff')] },
  },
  eyes: { sleepy: [b(0.9, 0.2, 0.3, 0, -0.15, 0.05, ink)] },
};

/* ---- cat: a ginger loaf with a big head, pointed ears and a curled tail */
const gin = '#f4a85c', stripe = '#d98a3d', cream = '#ffe6bf', cink = '#33261e';
const cat = {
  id: 'cat', traits: ['explore', 'search', 'investigate', 'review', 'locate'], name: 'Loaf cat', scale: 0.9,
  props: { page: { at: [0, 2.8, 3.8] } },
  bones: {
    body: { boxes: [b(6.6, 3.0, 5.4, 0, 1.5, -0.5, gin), b(3.4, 1.6, 0.2, 0, 1.1, 2.25, cream),
      b(0.6, 0.2, 3.0, -1.5, 3.05, -1, stripe), b(0.6, 0.2, 3.0, 0, 3.05, -1, stripe), b(0.6, 0.2, 3.0, 1.5, 3.05, -1, stripe)] },
    head: { at: [0, 2.3, 1.3], boxes: [b(5.4, 2.7, 3.8, 0, 1.35, 0, gin), b(2.4, 1.0, 0.2, 0, 0.45, 1.95, cream),
      b(0.35, 0.7, 0.2, -0.6, 2.15, 1.95, stripe), b(0.35, 0.8, 0.2, 0, 2.2, 1.95, stripe), b(0.35, 0.7, 0.2, 0.6, 2.15, 1.95, stripe),
      b(1.6, 0.1, 0.1, -3.0, 0.7, 1.7, cream), b(1.6, 0.1, 0.1, 3.0, 0.7, 1.7, cream, rz(0.12)), b(1.6, 0.1, 0.1, -3.0, 0.4, 1.7, cream, rz(-0.12)), b(1.6, 0.1, 0.1, 3.0, 0.4, 1.7, cream),
      b(0.55, 0.4, 0.2, 0, 0.95, 1.95, '#ff9aa8')] },
    eyeL: { parent: 'head', at: [-1.45, 1.5, 1.95], boxes: [b(0.8, 1.1, 0.3, 0, 0, 0, cink), b(0.3, 0.3, 0.2, 0.12, 0.28, 0.12, '#ffffff')] },
    eyeR: { mirror: 'eyeL' },
    mouth: { parent: 'head', at: [0, 0.5, 1.95], boxes: [b(1.0, 0.22, 0.2, 0, -0.1, 0, '#7a3b2a')] },
    earL: { parent: 'head', at: [-1.8, 2.5, -0.2], rot: [0, 0, 0.05], boxes: [b(1.5, 1.1, 1.0, 0, 0.55, 0, gin), b(0.8, 0.7, 0.8, 0, 1.4, 0, gin), b(0.7, 0.7, 0.2, 0, 0.6, 0.5, '#ff9aa8')] },
    earR: { mirror: 'earL' },
    armL: { at: [-3.2, 1.2, 1.4], boxes: [b(1.0, 1.1, 1.5, -0.35, 0, 0.2, cream)] },
    handL: { parent: 'armL', at: [-0.7, -0.1, 0.3], boxes: [b(0.8, 0.8, 1.0, 0, 0, 0.1, '#fff3de')] },
    armR: { mirror: 'armL' },
    handR: { mirror: 'handL' },
    legL1: { at: [-2.0, 0.3, 1.6], gait: 0, boxes: [b(1.4, 0.6, 1.6, 0, 0, 0.4, cream)] },
    legR1: { mirror: 'legL1', gait: 2 },
    legL2: { at: [-2.0, 0.3, -2.2], gait: 2, boxes: [b(1.5, 0.6, 1.8, 0, 0, 0, cream)] },
    legR2: { mirror: 'legL2', gait: 0 },
    tail: { at: [0, 1.2, -3.2], boxes: [b(0.9, 0.9, 1.6, 0, 0, -0.6, gin), b(0.9, 1.8, 0.9, 0, 0.9, -1.3, gin), b(0.9, 0.7, 0.9, 0, 2.1, -1.3, stripe)] },
  },
  eyes: { sleepy: [b(0.9, 0.2, 0.3, 0, -0.1, 0.05, cink)] },
};

/* ---- mochi: a hamster-ish ball with a brown cap and pink cheeks */
const mCream = '#fff1dc', mBrown = '#c98a55', mInk = '#2e2018', mPink = '#ffb0b8';
const mochi = {
  id: 'mochi', traits: ['plan', 'architect', 'design', 'think', 'advisor'], name: 'Mochi hamster', scale: 0.95,
  props: { page: { at: [0, 2.6, 3.4] } },
  bones: {
    body: { boxes: [b(5.4, 1.8, 4.6, 0, 1.5, 0, mCream)] },
    head: { at: [0, 2.4, 0], boxes: [b(6.2, 2.0, 5.0, 0, 1.0, 0, mCream), b(5.2, 1.0, 4.2, 0, 2.5, 0, mBrown), b(3.0, 0.5, 3.0, 0, 3.15, 0, mBrown),
      b(4.0, 1.6, 0.2, 0, 0.9, 2.55, '#fffaf0'), b(1.0, 0.7, 0.2, -2.4, 0.5, 2.55, mPink), b(1.0, 0.7, 0.2, 2.4, 0.5, 2.55, mPink), b(0.45, 0.35, 0.2, 0, 0.8, 2.65, '#ff8f9c')] },
    eyeL: { parent: 'head', at: [-1.7, 1.2, 2.65], boxes: [b(0.7, 0.8, 0.3, 0, 0, 0, mInk), b(0.25, 0.25, 0.2, 0.1, 0.2, 0.12, '#ffffff')] },
    eyeR: { mirror: 'eyeL' },
    mouth: { parent: 'head', at: [0, 0.4, 2.6], boxes: [b(0.6, 0.2, 0.2, 0, 0, 0, '#7a4a3a')] },
    earL: { parent: 'head', at: [-2.3, 2.5, -0.2], rot: [0, 0, 0.2], boxes: [b(1.3, 1.3, 0.9, 0, 0.5, 0, mBrown), b(0.7, 0.7, 0.2, 0, 0.45, 0.45, mPink)] },
    earR: { mirror: 'earL' },
    armL: { at: [-2.8, 1.5, 0.6], boxes: [b(0.8, 0.9, 0.9, -0.3, 0, 0, '#ffd9b0')] },
    handL: { parent: 'armL', at: [-0.55, -0.1, 0.1], boxes: [b(0.6, 0.6, 0.7, 0, 0, 0, mPink)] },
    armR: { mirror: 'armL' },
    handR: { mirror: 'handL' },
    legL1: { at: [-1.3, 0.3, 0.8], gait: 0, boxes: [b(1.3, 0.6, 1.6, 0, 0, 0.3, '#ffd9b0')] },
    legR1: { mirror: 'legL1', gait: 2 },
    tail: { at: [0, 1.1, -2.4], boxes: [b(0.9, 0.9, 0.7, 0, 0, -0.3, mBrown)] },
  },
  eyes: { sleepy: [b(0.8, 0.18, 0.3, 0, -0.1, 0.05, mInk)] },
};

/* ---- robot: a little steel box with LED eyes and an antenna */
const steel = '#9db7d5', dark = '#2a3447', led = '#5df2ff';
const robot = {
  id: 'robot', traits: ['code', 'build', 'fix', 'test', 'implement'], name: 'Boxbot', scale: 0.78, travel: 0.7,
  props: { page: { at: [0, 2.6, 3.0] }, anten: { at: [0, 7.2, 0], spread: 1.0 } },
  bones: {
    body: { boxes: [b(4.8, 2.8, 3.6, 0, 2.4, 0, steel), b(3.0, 1.5, 0.2, 0, 2.5, 1.85, dark),
      b(0.5, 0.5, 0.2, -0.8, 2.5, 1.95, '#ff9f43', { unlit: true }), b(0.5, 0.5, 0.2, 0, 2.5, 1.95, led, { unlit: true }), b(0.5, 0.5, 0.2, 0.8, 2.5, 1.95, '#8aff8a', { unlit: true })] },
    head: { at: [0, 3.8, 0], boxes: [b(5.4, 2.9, 4.2, 0, 1.45, 0, steel), b(4.5, 2.0, 0.2, 0, 1.5, 2.15, '#1d2433'), b(3.0, 0.4, 3.0, 0, 3.1, 0, '#eef4fb')] },
    eyeL: { parent: 'head', at: [-1.2, 1.75, 2.3], boxes: [b(0.95, 0.8, 0.25, 0, 0, 0, led, { unlit: true })] },
    eyeR: { mirror: 'eyeL' },
    mouth: { parent: 'head', at: [0, 0.85, 2.3], boxes: [b(1.6, 0.22, 0.2, 0, 0, 0, led, { unlit: true })] },
    earL: { parent: 'head', at: [-2.8, 1.5, 0], boxes: [b(0.5, 1.3, 1.3, 0, 0, 0, '#eef4fb'), b(0.3, 0.5, 0.5, -0.3, 0, 0, '#ff9f43')] },
    earR: { mirror: 'earL' },
    armL: { at: [-2.9, 2.9, 0], boxes: [b(1.0, 1.0, 1.0, -0.4, 0, 0, steel), b(1.8, 0.8, 0.8, -1.2, 0, 0, steel)] },
    handL: { parent: 'armL', at: [-2.1, 0, 0], boxes: [b(1.0, 1.2, 1.0, -0.3, 0, 0, '#ff9f43')] },
    armR: { mirror: 'armL' },
    handR: { mirror: 'handL' },
    legL1: { at: [-1.3, 0.5, 0], gait: 0, boxes: [b(1.7, 0.9, 2.4, 0, 0, 0.2, '#46536a')] },
    legR1: { mirror: 'legL1', gait: 2 },
    tail: { parent: 'head', at: [0, 3.1, 0], boxes: [b(0.3, 1.3, 0.3, 0, 0.65, 0, '#46536a'), b(0.8, 0.8, 0.8, 0, 1.5, 0, '#ff5c5c')] },
  },
  eyes: {
    x: [b(1.2, 0.3, 0.25, 0, 0, 0.02, '#ff5c5c', Object.assign({ unlit: true }, rz(0.785))), b(1.2, 0.3, 0.25, 0, 0, 0.02, '#ff5c5c', Object.assign({ unlit: true }, rz(-0.785)))],
    squint: [b(0.9, 0.3, 0.25, -0.1, -0.28, 0.02, led, Object.assign({ unlit: true }, rz(0.55))), b(0.9, 0.3, 0.25, -0.1, 0.28, 0.02, led, Object.assign({ unlit: true }, rz(-0.55)))],
    happy: [b(0.75, 0.3, 0.25, -0.3, -0.05, 0.02, led, Object.assign({ unlit: true }, rz(0.7))), b(0.75, 0.3, 0.25, 0.3, -0.05, 0.02, led, Object.assign({ unlit: true }, rz(-0.7)))],
    sleepy: [b(1.0, 0.18, 0.25, 0, -0.2, 0.02, led, { unlit: true })],
  },
};



(typeof window !== 'undefined' ? window : globalThis).__crewCharacters = [crab, bunny, cat, mochi, robot]; // globalThis: the tests load this file too
})();
