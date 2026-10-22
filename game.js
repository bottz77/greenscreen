'use strict';
// v5 gameplay: 3-lane dodge. Pure drawing/logic; app.js feeds it the player's
// screen-space x (0..1, already mirrored) and presence each frame.
window.Game = (function () {
  const HORIZON = 0.55, PLAYER_P = 0.86, LIVES = 3;
  let state = 'wait', t0 = 0, last = 0, lives = LIVES, score = 0, elapsed = 0;
  let obstacles = [], nextSpawn = 0, presentSince = 0, flashUntil = 0;
  let lane = 1, sx = 0.5, forcedLane = null;

  // Track geometry: p = 0 at horizon, 1 at bottom of screen.
  function edges(w, p) {
    const hx = w / 2;
    return [hx - w * 0.04 + (w * 0.15 - (hx - w * 0.04)) * p,
      hx + w * 0.04 + (w * 0.85 - (hx + w * 0.04)) * p];
  }
  function yAt(h, p) { return h * HORIZON + h * (1 - HORIZON) * p; }
  function laneX(w, p, i) { const e = edges(w, p); return e[0] + (e[1] - e[0]) * (i + 0.5) / 3; }

  function updateLane(x) {
    sx += (x - sx) * 0.35;
    const m = 0.05; // hysteresis margin
    if (lane === 0 && sx > 1 / 3 + m) lane = 1;
    if (lane === 2 && sx < 2 / 3 - m) lane = 1;
    if (lane === 1 && sx < 1 / 3 - m) lane = 0;
    if (lane === 1 && sx > 2 / 3 + m) lane = 2;
    if (lane === 0 && sx > 2 / 3 + m) lane = 2;
    if (lane === 2 && sx < 1 / 3 - m) lane = 0;
  }

  function reset(now) { state = 'wait'; lives = LIVES; score = 0; elapsed = 0; obstacles = []; presentSince = 0; t0 = now; }

  function update(now, present, x) {
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    if (forcedLane !== null) lane = forcedLane; else if (present) updateLane(x);
    if (state === 'wait') {
      if (present) { if (!presentSince) presentSince = now; } else presentSince = 0;
      if (presentSince && now - presentSince > 800) { state = 'countdown'; t0 = now; }
    } else if (state === 'countdown') {
      if (now - t0 > 3000) { state = 'play'; t0 = now; nextSpawn = now + 500; }
    } else if (state === 'play') {
      elapsed += dt;
      const speed = Math.min(1.1, 0.35 + elapsed * 0.012); // depth units / s
      if (now > nextSpawn) {
        obstacles.push({ lane: Math.floor(Math.random() * 3), z: 0, done: false });
        nextSpawn = now + Math.max(650, 1800 - elapsed * 25) * (0.7 + Math.random() * 0.6);
      }
      obstacles.forEach(function (o) {
        const before = o.z;
        o.z += speed * dt * (0.4 + o.z); // accelerate as it gets closer (perspective feel)
        if (!o.done && before < PLAYER_P && o.z >= PLAYER_P) {
          o.done = true;
          if (o.lane === lane) { lives--; o.hit = true; flashUntil = now + 400; } else score++;
        }
      });
      obstacles = obstacles.filter(function (o) { return o.z < 1.15; });
      if (lives <= 0) { state = 'over'; t0 = now; }
    }
  }

  function drawObstacle(ctx, w, h, o) {
    const p = Math.min(o.z, 1.15);
    const e = edges(w, p), lw = (e[1] - e[0]) / 3;
    const bw = lw * 0.8, bh = lw * 0.45, x = laneX(w, p, o.lane), y = yAt(h, p);
    ctx.fillStyle = o.hit ? '#7f1d1d' : '#ef4444';
    ctx.fillRect(x - bw / 2, y - bh, bw, bh);
    ctx.fillStyle = '#fde047';
    for (let k = 0; k < 3; k++) ctx.fillRect(x - bw / 2 + bw * (k * 2 + 0.5) / 6, y - bh * 0.7, bw / 9, bh * 0.4);
  }

  // Obstacles still behind the player (drawn before the person cut-out).
  function drawBehind(ctx, w, h) {
    obstacles.filter(function (o) { return o.z < PLAYER_P; }).forEach(function (o) { drawObstacle(ctx, w, h, o); });
  }

  function text(ctx, s, x, y, size, align) {
    ctx.font = '800 ' + size + 'px -apple-system, system-ui, sans-serif';
    ctx.textAlign = align || 'center';
    ctx.lineWidth = size / 8; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.fillStyle = '#fff';
    ctx.strokeText(s, x, y); ctx.fillText(s, x, y);
  }

  function drawFront(ctx, w, h, now) {
    obstacles.filter(function (o) { return o.z >= PLAYER_P; }).forEach(function (o) { drawObstacle(ctx, w, h, o); });
    if (now < flashUntil) { ctx.fillStyle = 'rgba(239,68,68,.35)'; ctx.fillRect(0, 0, w, h); }
    const s = Math.min(w, h * 1.6);
    ctx.textBaseline = 'middle';
    // Lane indicator: three boxes at the bottom, current lane lit.
    for (let i = 0; i < 3; i++) {
      const bw = s * 0.09, x = w / 2 + (i - 1) * bw * 1.25;
      ctx.fillStyle = i === lane ? '#facc15' : 'rgba(0,0,0,.45)';
      ctx.fillRect(x - bw / 2, h - s * 0.07, bw, s * 0.04);
    }
    text(ctx, 'Score ' + score, s * 0.03, h * 0.08, s * 0.06, 'left');
    text(ctx, '♥'.repeat(Math.max(0, lives)), w - s * 0.03, h * 0.08, s * 0.06, 'right');
    if (state === 'wait') text(ctx, 'Step into frame', w / 2, h * 0.35, s * 0.09);
    if (state === 'countdown') text(ctx, String(3 - Math.floor((now - t0) / 1000)), w / 2, h * 0.35, s * 0.2);
    if (state === 'over') {
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fillRect(0, 0, w, h);
      text(ctx, 'Game over', w / 2, h * 0.3, s * 0.11);
      text(ctx, 'Score ' + score, w / 2, h * 0.5, s * 0.08);
      text(ctx, 'Tap to play again', w / 2, h * 0.7, s * 0.06);
    }
  }

  function tap(now) { if (state === 'over' && now - t0 > 800) reset(now); }
  function setForcedLane(l) { forcedLane = l; }
  function getForcedLane() { return forcedLane; }
  function info() { return { state: state, lane: lane, score: score, lives: lives, obstacles: obstacles.length, sx: sx }; }

  return { update: update, drawBehind: drawBehind, drawFront: drawFront, tap: tap, setForcedLane: setForcedLane, getForcedLane: getForcedLane, info: info };
})();
