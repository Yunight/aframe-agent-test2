'use strict';

// ── Kinetic headline: reveal one character at a time ───────────────────────
(function initHeadline() {
  var TEXT = 'MATCHA\u00A0PREMIUM';
  var el = document.getElementById('kinetic-headline');
  if (!el) return;

  var idx = 0;

  function tick() {
    if (idx >= TEXT.length) return;
    var ch = TEXT[idx++];
    var span = document.createElement('span');
    span.className = 'char';
    span.textContent = ch; // \u00A0 renders as a visible space
    el.appendChild(span);
    setTimeout(tick, 80);
  }

  // Small initial pause so the ad settles, then type
  setTimeout(tick, 500);
}());

// ── Ambient matcha-powder particles drifting upward ────────────────────────
(function initParticles() {
  var container = document.getElementById('particles');
  if (!container) return;

  var COUNT = 18;
  // Palette-derived colors only
  var palette = [
    { color: '#8FB73E', op: 0.70 },
    { color: '#8FB73E', op: 0.50 },
    { color: '#C9D89A', op: 0.62 },
    { color: '#C9D89A', op: 0.42 }
  ];

  for (var i = 0; i < COUNT; i++) {
    var c    = palette[Math.floor(Math.random() * palette.length)];
    var size = 2 + Math.random() * 3.5;           // 2 – 5.5 px
    var left = 5  + Math.random() * 310;          // spread across ad width
    var top  = Math.random() * 480;               // full height so stagger works
    var dur  = 7  + Math.random() * 9;            // 7 – 16 s per cycle
    var del  = -(Math.random() * dur);            // negative = already in flight
    var dx   = (Math.random() - 0.5) * 50;       // ±25 px horizontal drift

    var p = document.createElement('div');
    p.className = 'particle';

    // Build cssText; CSS custom props set inline are valid in modern browsers
    p.style.cssText =
      'width:'              + size.toFixed(1) + 'px;' +
      'height:'             + size.toFixed(1) + 'px;' +
      'left:'               + left.toFixed(1) + 'px;' +
      'top:'                + top.toFixed(1)  + 'px;' +
      'background:'         + c.color         + ';'   +
      '--p-op:'             + c.op            + ';'   +
      '--p-dx:'             + dx.toFixed(1)   + 'px;' +
      'animation-duration:' + dur.toFixed(2)  + 's;'  +
      'animation-delay:'    + del.toFixed(2)  + 's';

    container.appendChild(p);
  }
}());
