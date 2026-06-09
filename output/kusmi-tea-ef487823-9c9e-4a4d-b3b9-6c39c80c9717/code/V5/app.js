(function () {
  'use strict';

  const ad = document.getElementById('ad-300x250');
  if (!ad) return;

  /* ── Accent stripe ───────────────────────────────────────── */
  const stripe = document.createElement('div');
  stripe.className = 'accent-stripe';
  ad.appendChild(stripe);

  /* ── Bubble pearls animation (canvas layer) ──────────────── */
  const canvas = document.createElement('canvas');
  canvas.width  = 300;
  canvas.height = 250;
  canvas.style.cssText = [
    'position:absolute',
    'inset:0',
    'z-index:2',
    'pointer-events:none',
    'opacity:0.55'
  ].join(';');
  ad.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // palette-safe pearl colors (rgba from palette hex)
  const PEARL_COLORS = [
    'rgba(200,16,46,0.55)',
    'rgba(247,197,72,0.6)',
    'rgba(249,160,63,0.55)',
    'rgba(200,162,200,0.5)',
    'rgba(139,195,74,0.45)',
    'rgba(255,111,97,0.5)'
  ];

  const PEARL_COUNT = 14;
  const pearls = [];

  function randomBetween(a, b) {
    return a + Math.random() * (b - a);
  }

  function createPearl(overrideY) {
    return {
      x:      randomBetween(10, 290),
      y:      overrideY !== undefined ? overrideY : randomBetween(0, 250),
      r:      randomBetween(4, 9),
      speed:  randomBetween(0.3, 0.9),
      color:  PEARL_COLORS[Math.floor(Math.random() * PEARL_COLORS.length)],
      drift:  randomBetween(-0.3, 0.3),
      alpha:  randomBetween(0.5, 1)
    };
  }

  for (let i = 0; i < PEARL_COUNT; i++) {
    pearls.push(createPearl());
  }

  let rafId;
  let lastTime = 0;
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawPearl(p) {
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fillStyle = p.color;
    ctx.fill();
    // subtle highlight
    ctx.beginPath();
    ctx.arc(p.x - p.r * 0.3, p.y - p.r * 0.3, p.r * 0.35, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();
    ctx.restore();
  }

  function tick(timestamp) {
    if (REDUCED) return;
    const dt = Math.min((timestamp - lastTime) / 16.67, 3);
    lastTime = timestamp;

    ctx.clearRect(0, 0, 300, 250);

    pearls.forEach(function (p) {
      p.y -= p.speed * dt;
      p.x += p.drift * dt;

      // reset when out of frame
      if (p.y + p.r < 0 || p.x < -p.r * 2 || p.x > 302 + p.r * 2) {
        const fresh = createPearl(260 + p.r);
        Object.assign(p, fresh);
      }

      drawPearl(p);
    });

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  /* ── Click through entire ad ─────────────────────────────── */
  ad.addEventListener('click', function (e) {
    if (e.target.closest('.cta-btn')) return; // let anchor handle it
    window.open(
      'https://www.kusmitea.com/collections/bubble-tea',
      '_blank',
      'noopener,noreferrer'
    );
  });

  /* ── Pause animation when tab hidden ────────────────────── */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      cancelAnimationFrame(rafId);
    } else {
      lastTime = performance.now();
      rafId = requestAnimationFrame(tick);
    }
  });

}());
