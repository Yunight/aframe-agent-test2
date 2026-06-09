/* ============================================
   app.js — Walibi Rhône-Alpes 320x480 ad
   ============================================ */
(function () {
  'use strict';

  var slides   = document.querySelectorAll('#ad-320x480 .carousel-slide');
  var dots     = document.querySelectorAll('#ad-320x480 .dot');
  var ad       = document.getElementById('ad-320x480');
  var count    = slides.length;
  var current  = 0;
  var timerId  = null;
  var INTERVAL = 4000; // ms per slide

  /* ─── Navigate to slide at index i ─── */
  function goTo(i) {
    if (count === 0) return;

    // Deactivate current
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');

    // Clamp to valid index
    current = ((i % count) + count) % count;

    var slide = slides[current];

    // Force Ken Burns animation to restart
    slide.style.animation = 'none';
    void slide.offsetWidth; // trigger reflow
    slide.style.animation  = '';

    // Activate new slide
    slide.classList.add('active');
    dots[current].classList.add('active');
  }

  /* ─── Auto-advance ─── */
  function next() {
    goTo(current + 1);
  }

  function startAuto() {
    clearInterval(timerId);
    timerId = setInterval(next, INTERVAL);
  }

  function stopAuto() {
    clearInterval(timerId);
    timerId = null;
  }

  /* ─── Dot navigation ─── */
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(this.getAttribute('data-index'), 10);
      stopAuto();
      goTo(idx);
      startAuto();
    });
  });

  /* ─── Touch swipe support ─── */
  var touchStartX = 0;

  ad.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  ad.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 28) {
      stopAuto();
      goTo(dx < 0 ? current + 1 : current - 1);
      startAuto();
    }
  }, { passive: true });

  /* ─── Mouse drag support (desktop preview) ─── */
  var mouseActive = false;
  var mouseStartX = 0;

  ad.addEventListener('mousedown', function (e) {
    mouseActive = true;
    mouseStartX = e.clientX;
  });

  window.addEventListener('mouseup', function (e) {
    if (!mouseActive) return;
    mouseActive = false;
    var dx = e.clientX - mouseStartX;
    if (Math.abs(dx) > 28) {
      stopAuto();
      goTo(dx < 0 ? current + 1 : current - 1);
      startAuto();
    }
  });

  /* ─── Pause on hover, resume on leave ─── */
  ad.addEventListener('mouseenter', function () {
    stopAuto();
  });

  ad.addEventListener('mouseleave', function () {
    mouseActive = false;
    startAuto();
  });

  /* ─── Kick off auto-play ─── */
  startAuto();

}());
