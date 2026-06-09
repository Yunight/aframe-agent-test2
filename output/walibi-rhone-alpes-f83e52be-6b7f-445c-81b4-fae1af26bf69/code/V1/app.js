(function () {
  'use strict';

  var SLIDE_DURATION = 5000; // ms per slide
  var currentSlide = 0;

  var ad = document.getElementById('ad-320x480');
  if (!ad) return;

  var slides = ad.querySelectorAll('.bg-slides .slide');
  var SLIDE_COUNT = slides.length;
  var dotsEl = null;

  if (SLIDE_COUNT > 1) {
    dotsEl = document.createElement('div');
    dotsEl.className = 'slide-dots';
    dotsEl.setAttribute('aria-hidden', 'true');

    for (var i = 0; i < SLIDE_COUNT; i++) {
      var dot = document.createElement('span');
      dot.className = 'dot' + (i === 0 ? ' active' : '');
      dotsEl.appendChild(dot);
    }
    ad.appendChild(dotsEl);
  }

  /* ---- Promo badge ---- */
  var badge = document.createElement('div');
  badge.className = 'badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.innerHTML =
    '<span class="badge-line1">Dès</span>' +
    '<span class="badge-line2">29€</span>';
  ad.appendChild(badge);

  /* ---- Sync dot with CSS animation ---- */
  function updateDots(index) {
    if (dotsEl === null) return;
    var dots = dotsEl.querySelectorAll('.dot');
    dots.forEach(function (d, idx) {
      d.classList.toggle('active', idx === index);
    });
  }

  /* ---- Slide ticker (mirrors CSS 5s per slide) ---- */
  var ticker = null;
  if (SLIDE_COUNT > 1) {
    ticker = setInterval(function () {
      currentSlide = (currentSlide + 1) % SLIDE_COUNT;
      updateDots(currentSlide);
    }, SLIDE_DURATION);
  }

  /* ---- Respect reduced-motion: stop ticker & pause CSS animations ---- */
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches && ticker !== null) {
    clearInterval(ticker);
    currentSlide = 0;
    updateDots(0);
  }

  /* ---- CTA click tracking stub ---- */
  var cta = ad.querySelector('.cta-btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      // Stub: send tracking event if ad server macro present
      if (typeof window.trackAdClick === 'function') {
        window.trackAdClick('cta_walibi_ete2026_320x480');
      }
    });
  }

}());
