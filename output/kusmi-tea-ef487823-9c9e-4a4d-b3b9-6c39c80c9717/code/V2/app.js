(function () {
  'use strict';

  /* ── Slideshow ── */
  var slides   = document.querySelectorAll('#ad-300x600 .slide');
  var dots     = document.querySelectorAll('#ad-300x600 .dot');
  var current  = 0;
  var total    = slides.length;
  var timer    = null;
  var INTERVAL = 3200; // ms between slides

  function goTo(idx) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    dots[current].setAttribute('aria-selected', 'false');

    current = (idx + total) % total;

    slides[current].classList.add('active');
    dots[current].classList.add('active');
    dots[current].setAttribute('aria-selected', 'true');
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      goTo(current + 1);
    }, INTERVAL);
  }

  /* Dot click handler */
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-idx'), 10);
      goTo(idx);
      startAuto(); // reset auto-play on manual nav
    });
  });

  /* Keyboard: left/right arrows when dot is focused */
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft')  { goTo(current - 1); startAuto(); }
    if (e.key === 'ArrowRight') { goTo(current + 1); startAuto(); }
  });

  /* Touch swipe on hero */
  var heroWrap  = document.querySelector('#ad-300x600 .hero-wrap');
  var touchStartX = 0;

  if (heroWrap) {
    heroWrap.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    heroWrap.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 30) {
        goTo(dx < 0 ? current + 1 : current - 1);
        startAuto();
      }
    }, { passive: true });
  }

  /* Pause auto-play when user hovers the hero */
  if (heroWrap) {
    heroWrap.addEventListener('mouseenter', function () {
      if (timer) clearInterval(timer);
    });
    heroWrap.addEventListener('mouseleave', function () {
      startAuto();
    });
  }

  /* Respect reduced-motion: no auto-advance */
  var prefersReduced = window.matchMedia &&
                       window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (!prefersReduced) {
    startAuto();
  }

  /* ── CTA click tracking stub ── */
  var cta = document.querySelector('#ad-300x600 .cta-btn');
  if (cta) {
    cta.addEventListener('click', function () {
      // Analytics hook — replace with real tracking
      if (window.console && console.log) {
        console.log('[KusmiTea Ad] CTA clicked – Bubble Tea');
      }
    });
  }

}());
