// ---------------------------------------------------------------------------
// samples.js — procedurally drawn 2D sample art so the converter can be tried
// without preparing any images. Each returns a PNG dataURL (transparent bg).
// ---------------------------------------------------------------------------
import { makeCanvas } from './imageproc.js';

const OUT = '#2a2230';

function draw(w, h, fn) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  fn(ctx, w, h);
  return c.toDataURL('image/png');
}
function shape(ctx, path, fill, line = 8) {
  ctx.beginPath(); path(ctx); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  if (line) { ctx.lineWidth = line; ctx.strokeStyle = OUT; ctx.stroke(); }
}
const ellipse = (x, y, rx, ry) => (c) => c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
const rrect = (x, y, w, h, r) => (c) => c.roundRect(x, y, w, h, r);

const HAIR = '#6b4a3a', SKIN = '#ffd9bf', SHIRT = '#4f7cff', SHIRT_D = '#3b5fd1', PANTS = '#3a3f58';

export function sampleHeadFront() {
  return draw(512, 512, (c) => {
    shape(c, ellipse(256, 262, 222, 222), HAIR);
    shape(c, ellipse(256, 300, 182, 168), SKIN, 0);
    // bangs
    shape(c, (p) => {
      p.moveTo(52, 250); p.bezierCurveTo(70, 90, 430, 80, 460, 250);
      p.quadraticCurveTo(410, 205, 360, 215); p.quadraticCurveTo(320, 170, 256, 205);
      p.quadraticCurveTo(190, 170, 150, 215); p.quadraticCurveTo(100, 205, 52, 250);
    }, HAIR, 0);
    for (const x of [185, 327]) {
      shape(c, ellipse(x, 318, 30, 42), '#2b2236', 0);
      shape(c, ellipse(x + 9, 302, 11, 13), '#ffffff', 0);
      shape(c, ellipse(x, 355, 30, 10), 'rgba(255,140,150,0.0)', 0);
    }
    for (const x of [150, 362]) shape(c, ellipse(x, 372, 26, 13), '#ffaab0', 0);
    c.beginPath(); c.arc(256, 380, 22, 0.15 * Math.PI, 0.85 * Math.PI); c.lineWidth = 7; c.strokeStyle = '#7a3a3a'; c.stroke();
    c.beginPath(); c.ellipse(256, 262, 222, 222, 0, 0, Math.PI * 2); c.lineWidth = 8; c.strokeStyle = OUT; c.stroke();
  });
}
export function sampleHeadBack() {
  return draw(512, 512, (c) => {
    shape(c, ellipse(256, 262, 222, 222), HAIR);
    c.strokeStyle = '#563a2d'; c.lineWidth = 6;
    for (let i = -3; i <= 3; i++) { c.beginPath(); c.moveTo(256 + i * 18, 70); c.quadraticCurveTo(256 + i * 50, 260, 256 + i * 60, 470); c.stroke(); }
  });
}
export function sampleTorso(back = false) {
  return draw(420, 480, (c) => {
    shape(c, (p) => {
      p.moveTo(110, 30); p.lineTo(310, 30); p.quadraticCurveTo(380, 40, 390, 120);
      p.lineTo(375, 450); p.quadraticCurveTo(210, 470, 45, 450); p.lineTo(30, 120); p.quadraticCurveTo(40, 40, 110, 30);
    }, SHIRT);
    if (!back) {
      shape(c, (p) => { p.moveTo(150, 30); p.lineTo(210, 120); p.lineTo(270, 30); }, '#ffffff', 6);
      shape(c, (p) => { p.moveTo(190, 92); p.lineTo(230, 92); p.lineTo(220, 140); p.lineTo(200, 140); }, '#ff5a6e', 5);
      for (const y of [210, 280, 350]) shape(c, ellipse(210, y, 12, 12), '#ffd54f', 4);
      c.fillStyle = SHIRT_D; c.fillRect(60, 400, 300, 14);
    } else {
      c.fillStyle = SHIRT_D; c.fillRect(60, 400, 300, 14);
      shape(c, rrect(170, 30, 80, 26, 10), '#ffffff', 5);
    }
  });
}
export function sampleArm() {
  return draw(170, 460, (c) => {
    shape(c, rrect(25, 20, 120, 300, 55), SHIRT);
    c.fillStyle = SHIRT_D; c.fillRect(30, 285, 110, 22);
    shape(c, ellipse(85, 380, 58, 62), SKIN);
  });
}
export function sampleLegs() {
  return draw(420, 480, (c) => {
    shape(c, (p) => {
      p.moveTo(40, 20); p.lineTo(380, 20); p.lineTo(370, 450); p.lineTo(232, 450); p.lineTo(220, 170);
      p.lineTo(200, 170); p.lineTo(188, 450); p.lineTo(50, 450);
    }, PANTS);
    c.fillStyle = '#2b2f44'; c.fillRect(46, 22, 328, 30);
    c.strokeStyle = '#555b7a'; c.lineWidth = 5;
    c.beginPath(); c.moveTo(118, 70); c.lineTo(118, 440); c.moveTo(302, 70); c.lineTo(302, 440); c.stroke();
  });
}
export function sampleHat() {
  return draw(512, 470, (c) => {
    shape(c, (p) => { p.moveTo(256, 18); p.quadraticCurveTo(300, 200, 380, 390); p.lineTo(132, 390); p.quadraticCurveTo(212, 200, 256, 18); }, '#7c4dff');
    shape(c, (p) => { p.moveTo(155, 330); p.lineTo(357, 330); p.lineTo(372, 380); p.lineTo(140, 380); }, '#ffca28', 6);
    shape(c, ellipse(256, 400, 246, 34), '#6a3de8');
  });
}
export function sampleSword() {
  return draw(200, 620, (c) => {
    shape(c, (p) => { p.moveTo(100, 14); p.lineTo(132, 70); p.lineTo(130, 420); p.lineTo(70, 420); p.lineTo(68, 70); }, '#dfe7f2');
    c.strokeStyle = '#a9b6c8'; c.lineWidth = 6; c.beginPath(); c.moveTo(100, 60); c.lineTo(100, 410); c.stroke();
    shape(c, rrect(16, 414, 168, 34, 14), '#ffc93c', 7);
    shape(c, rrect(80, 446, 40, 120, 10), '#8d5a3b', 7);
    shape(c, ellipse(100, 584, 26, 22), '#ffc93c', 7);
  });
}
export function sampleShield() {
  return draw(460, 500, (c) => {
    shape(c, (p) => { p.moveTo(230, 18); p.lineTo(440, 80); p.quadraticCurveTo(440, 360, 230, 482); p.quadraticCurveTo(20, 360, 20, 80); }, '#ffc93c');
    shape(c, (p) => { p.moveTo(230, 50); p.lineTo(405, 102); p.quadraticCurveTo(400, 340, 230, 446); p.quadraticCurveTo(60, 340, 55, 102); }, '#e53950', 5);
    shape(c, (p) => {
      const cx = 230, cy = 230, R = 85, r = 36;
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? r : R; p.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    }, '#fff3c4', 5);
  });
}
export function sampleWings() {
  return draw(640, 400, (c) => {
    for (const s of [-1, 1]) {
      c.save(); c.translate(320, 0); c.scale(s, 1);
      shape(c, (p) => {
        p.moveTo(20, 150); p.bezierCurveTo(80, 20, 230, 0, 300, 30); p.quadraticCurveTo(270, 90, 290, 110);
        p.quadraticCurveTo(250, 160, 270, 190); p.quadraticCurveTo(220, 230, 235, 270); p.quadraticCurveTo(160, 300, 150, 340);
        p.quadraticCurveTo(70, 300, 20, 240);
      }, '#f4f8ff');
      c.strokeStyle = '#b9c8ea'; c.lineWidth = 5;
      for (const [a, b, d] of [[60, 90, 270], [70, 140, 240], [70, 190, 200]]) { c.beginPath(); c.moveTo(a, b); c.quadraticCurveTo(150, b - 30, d, b - 10); c.stroke(); }
      c.restore();
    }
  });
}
export function sampleShoe() {
  return draw(260, 200, (c) => {
    shape(c, (p) => { p.moveTo(30, 170); p.quadraticCurveTo(20, 40, 130, 30); p.quadraticCurveTo(240, 40, 230, 170); }, '#8b5a3c');
    c.fillStyle = '#5c3a26'; c.fillRect(28, 150, 204, 24);
    shape(c, rrect(90, 60, 80, 22, 8), '#ffffff', 4);
  });
}
export function sampleShoeSide() {
  return draw(300, 200, (c) => {
    shape(c, (p) => { p.moveTo(20, 170); p.lineTo(22, 70); p.quadraticCurveTo(30, 32, 120, 34); p.quadraticCurveTo(200, 50, 262, 100); p.quadraticCurveTo(290, 130, 282, 170); }, '#8b5a3c');
    c.fillStyle = '#5c3a26'; c.fillRect(22, 150, 258, 24);
  });
}
export function sampleGlasses() {
  return draw(520, 180, (c) => {
    c.lineWidth = 26; c.strokeStyle = '#33343d';
    c.beginPath(); c.arc(140, 95, 72, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(380, 95, 72, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(212, 85); c.quadraticCurveTo(260, 55, 308, 85); c.stroke();
  });
}
export function samplePotion() {
  return draw(400, 520, (c) => {
    shape(c, rrect(160, 20, 80, 60, 12), '#a0765a');
    shape(c, (p) => { p.moveTo(170, 80); p.lineTo(230, 80); p.lineTo(232, 190); p.bezierCurveTo(390, 220, 400, 500, 200, 500); p.bezierCurveTo(0, 500, 10, 220, 168, 190); }, '#b6e3ff');
    shape(c, (p) => { p.moveTo(60, 330); p.bezierCurveTo(120, 300, 280, 360, 340, 330); p.bezierCurveTo(350, 470, 260, 496, 200, 496); p.bezierCurveTo(140, 496, 50, 470, 60, 330); }, '#ff5fa2', 0);
    shape(c, ellipse(140, 280, 18, 34), 'rgba(255,255,255,0.9)', 0);
  });
}

/** slotId → { front, side?, back?, top? } */
export function characterSamples() {
  return {
    head: { front: sampleHeadFront(), back: sampleHeadBack() },
    torso: { front: sampleTorso(false), back: sampleTorso(true) },
    arms: { front: sampleArm() },
    legs: { front: sampleLegs() },
    hat: { front: sampleHat() },
    handR: { front: sampleSword() },
    handL: { front: sampleShield() },
    back: { front: sampleWings() },
    shoes: { front: sampleShoe(), side: sampleShoeSide() },
  };
}
export function objectSample() {
  return { object: { front: samplePotion() } };
}
export function glassesSample() { return sampleGlasses(); }
