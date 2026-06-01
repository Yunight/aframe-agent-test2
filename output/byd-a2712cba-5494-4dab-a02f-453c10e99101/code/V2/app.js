/* app.js — BYD SEALION 5 DM-i Interactive Ad (320×480) */
(function () {
  'use strict';

  /* ═══════════════════════════════════════
     1. Image Carousel
  ═══════════════════════════════════════ */
  var slides  = Array.from(document.querySelectorAll('.slide'));
  var dots    = Array.from(document.querySelectorAll('.dot'));
  var cur     = 0;
  var autoTmr = null;

  function goTo(n) {
    var next = ((n % slides.length) + slides.length) % slides.length;
    if (next === cur) return;
    slides[cur].classList.remove('is-active');
    dots[cur].classList.remove('is-active');
    cur = next;
    slides[cur].classList.add('is-active');
    dots[cur].classList.add('is-active');
  }

  function restartAuto() {
    clearInterval(autoTmr);
    autoTmr = setInterval(function () { goTo(cur + 1); }, 3500);
  }

  /* Dot clicks */
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      goTo(i);
      restartAuto();
    });
  });

  /* Touch swipe support */
  var heroEl = document.getElementById('heroCarousel');
  var swipeX = 0;

  heroEl.addEventListener('touchstart', function (e) {
    swipeX = e.changedTouches[0].clientX;
  }, { passive: true });

  heroEl.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - swipeX;
    if (Math.abs(dx) > 28) {
      goTo(dx < 0 ? cur + 1 : cur - 1);
      restartAuto();
    }
  }, { passive: true });

  restartAuto();


  /* ═══════════════════════════════════════
     2. Animated Counters
  ═══════════════════════════════════════ */
  var counters = Array.from(document.querySelectorAll('.counter[data-to]'));

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function runCounter(el) {
    var target = parseInt(el.getAttribute('data-to'), 10);
    var dur    = 1300;
    var t0     = performance.now();

    function tick(now) {
      var p = Math.min((now - t0) / dur, 1);
      el.textContent = Math.round(easeOutCubic(p) * target);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* Fire counters after specs panel animates in (~1.3 s from page load) */
  setTimeout(function () {
    counters.forEach(runCounter);
  }, 1300);


  /* ═══════════════════════════════════════
     3. CTA Ripple on Click
  ═══════════════════════════════════════ */
  var ctaEl = document.querySelector('.cta');

  if (ctaEl) {
    ctaEl.addEventListener('click', function (e) {
      var rect   = ctaEl.getBoundingClientRect();
      var bubble = document.createElement('span');
      var size   = 64;

      Object.assign(bubble.style, {
        position:      'absolute',
        width:         size + 'px',
        height:        size + 'px',
        left:          (e.clientX - rect.left - size / 2) + 'px',
        top:           (e.clientY - rect.top  - size / 2) + 'px',
        borderRadius:  '50%',
        background:    'rgba(255, 255, 255, 0.28)',
        pointerEvents: 'none',
        animation:     'rippleAnim 0.55s ease forwards'
      });

      ctaEl.appendChild(bubble);
      setTimeout(function () { bubble.remove(); }, 620);
    });
  }

})();
