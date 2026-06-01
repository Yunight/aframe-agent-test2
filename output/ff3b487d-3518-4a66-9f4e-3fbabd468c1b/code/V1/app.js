(function () {
  'use strict';

  var ad = document.getElementById('ad-320x480');
  if (!ad) return;

  var slides = ad.querySelectorAll('.slide');
  var dots = ad.querySelectorAll('.dot');
  var numSlides = slides.length;
  var current = 0;
  var timer = null;
  var paused = false;
  var INTERVAL = 6000;

  /* Theme per slide: yellow for trophy intro, red for settled states */
  var themes = ['yellow', 'red', 'red', 'red'];

  /* ---- Core Navigation ---- */
  function goTo(idx) {
    if (idx === current && slides[idx].classList.contains('active')) return;

    /* Deactivate current */
    slides[current].classList.remove('active', 'animating');
    dots[current].classList.remove('active');
    dots[current].setAttribute('aria-selected', 'false');

    current = idx;

    /* Update theme for smooth bg-color transition and dot colours */
    ad.setAttribute('data-theme', themes[current]);

    /* Activate new slide */
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    dots[current].setAttribute('aria-selected', 'true');

    /* Force reflow so child CSS animations re-trigger */
    void slides[current].offsetWidth;
    slides[current].classList.add('animating');
  }

  function next() { goTo((current + 1) % numSlides); }
  function prev() { goTo((current - 1 + numSlides) % numSlides); }

  /* ---- Autoplay ---- */
  function start() {
    stop();
    timer = setInterval(function () {
      if (!paused) next();
    }, INTERVAL);
  }
  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  /* ---- Dot Click / Keyboard ---- */
  Array.prototype.forEach.call(dots, function (dot, i) {
    dot.addEventListener('click', function () {
      goTo(i);
      start();
    });
    dot.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        goTo(i);
        start();
      }
    });
  });

  /* ---- Hover Pause ---- */
  ad.addEventListener('mouseenter', function () { paused = true; });
  ad.addEventListener('mouseleave', function () { paused = false; });

  /* ---- Touch Swipe ---- */
  var sx = 0;
  var sy = 0;

  ad.addEventListener('touchstart', function (e) {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
    paused = true;
  }, { passive: true });

  ad.addEventListener('touchend', function (e) {
    var dx = sx - e.changedTouches[0].clientX;
    var dy = sy - e.changedTouches[0].clientY;

    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      if (dx > 0) { next(); } else { prev(); }
      start();
    }

    setTimeout(function () { paused = false; }, 3000);
  }, { passive: true });

  /* ---- CTA Press Feedback ---- */
  Array.prototype.forEach.call(ad.querySelectorAll('.cta'), function (btn) {
    btn.addEventListener('mousedown', function () {
      this.style.transform = 'scale(0.93)';
    });
    btn.addEventListener('mouseup', function () {
      this.style.transform = '';
    });
    btn.addEventListener('mouseleave', function () {
      this.style.transform = '';
    });
  });

  /* ---- Initialise ---- */
  start();
})();
