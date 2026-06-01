/* ======================================================
   Lidl 320×480 — Carousel logic
   Autoplay · Dot navigation · Touch swipe
   ====================================================== */
(function () {
  'use strict';

  var TOTAL    = 4;
  var DURATION = 3800;   /* ms per slide */

  var current  = 0;
  var timer    = null;

  var slides   = document.querySelectorAll('.slide');
  var dots     = document.querySelectorAll('.dot');
  var fill     = document.getElementById('progFill');
  var carousel = document.getElementById('carousel');
  var ctaLink  = document.getElementById('ctaLink');

  /* ── Activate slide at index n ── */
  function go(n) {
    var idx = ((n % TOTAL) + TOTAL) % TOTAL;
    if (idx === current) return;

    /* deactivate current */
    slides[current].classList.remove('active');
    dots[current].classList.remove('dot-on');

    current = idx;

    /* activate new */
    slides[current].classList.add('active');
    dots[current].classList.add('dot-on');
  }

  /* ── Reset and start progress bar ── */
  function startBar() {
    if (!fill) return;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    /* force reflow so transition applies on next frame */
    void fill.offsetWidth;
    fill.style.transition = 'width ' + DURATION + 'ms linear';
    fill.style.width = '100%';
  }

  /* ── Start autoplay ── */
  function startAuto() {
    stopAuto();
    startBar();
    timer = setInterval(function () {
      go(current + 1);
      startBar();
    }, DURATION);
  }

  /* ── Stop autoplay ── */
  function stopAuto() {
    clearInterval(timer);
    timer = null;
  }

  /* ── Dot navigation ── */
  Array.prototype.forEach.call(dots, function (dot, i) {
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      go(i);
      startAuto();
    });
  });

  /* ── Touch swipe ── */
  var swipeX = 0;

  carousel.addEventListener('touchstart', function (e) {
    swipeX = e.touches[0].clientX;
  }, { passive: true });

  carousel.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - swipeX;
    if (Math.abs(dx) > 40) {
      go(dx < 0 ? current + 1 : current - 1);
      startAuto();
    }
  }, { passive: true });

  /* ── Click on carousel to advance ── */
  carousel.addEventListener('click', function () {
    go(current + 1);
    startAuto();
  });

  /* ── CTA click must not advance carousel ── */
  if (ctaLink) {
    ctaLink.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  /* ── Pause on hover, resume on leave ── */
  var adRoot = document.getElementById('ad-320x480');
  if (adRoot) {
    adRoot.addEventListener('mouseenter', function () {
      stopAuto();
    });
    adRoot.addEventListener('mouseleave', function () {
      startAuto();
    });
  }

  /* ── Initialise ── */
  startAuto();

}());
