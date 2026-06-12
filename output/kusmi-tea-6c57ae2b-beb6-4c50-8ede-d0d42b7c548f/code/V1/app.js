(function () {
  'use strict';

  /* ── Headline kinetic stagger ── */
  var words = [
    { id: 'word1', text: 'MATCHA' },
    { id: 'word2', text: 'PREMIUM' }
  ];

  var globalDelay = 0.1;   // seconds before first letter
  var letterGap   = 0.058; // seconds between letters
  var wordGap     = 0.20;  // extra gap between words

  words.forEach(function (wordDef) {
    var el = document.getElementById(wordDef.id);
    if (!el) return;

    wordDef.text.split('').forEach(function (ch) {
      var span = document.createElement('span');
      span.classList.add('headline-letter');
      span.textContent = ch === ' ' ? '\u00A0' : ch;
      span.style.animationDelay = globalDelay.toFixed(3) + 's';
      el.appendChild(span);
      globalDelay += letterGap;
    });

    globalDelay += wordGap;
  });

  /* ── Ambient particles ── */
  var container = document.getElementById('particlesContainer');
  var PARTICLE_COUNT = 30;

  var particleColors = [
    '#8FB73E',
    '#C9D89A',
    '#3F6B2A'
  ];

  function randomBetween(a, b) {
    return a + Math.random() * (b - a);
  }

  function createParticle() {
    var p = document.createElement('div');
    p.classList.add('particle');

    var size = randomBetween(2.5, 7.5);
    p.style.width  = size + 'px';
    p.style.height = size + 'px';

    // Cluster around the product hero zone
    var startX = randomBetween(50, 270);
    var startY = randomBetween(110, 310);
    p.style.left = startX + 'px';
    p.style.top  = startY + 'px';

    // Drift vectors
    var tx = randomBetween(-90, 90);
    var ty = randomBetween(-120, -20);
    p.style.setProperty('--tx', tx + 'px');
    p.style.setProperty('--ty', ty + 'px');

    // Color
    var col = particleColors[Math.floor(Math.random() * particleColors.length)];
    p.style.background = col;

    var duration = randomBetween(4.5, 9.5);
    var delay    = randomBetween(0, 8);
    p.style.animationDuration = duration + 's';
    p.style.animationDelay   = delay + 's';

    container.appendChild(p);
  }

  for (var i = 0; i < PARTICLE_COUNT; i++) {
    createParticle();
  }

  /* ── Product hero tap / hover feedback ── */
  var hero = document.getElementById('productHero');
  if (hero) {
    function onTap() {
      hero.classList.add('tapped');
      setTimeout(function () {
        hero.classList.remove('tapped');
      }, 500);
    }
    hero.addEventListener('click',      onTap);
    hero.addEventListener('touchstart', onTap, { passive: true });
  }

}());
