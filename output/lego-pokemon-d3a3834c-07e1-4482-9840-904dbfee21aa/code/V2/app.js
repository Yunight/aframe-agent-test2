(function () {
  'use strict';

  /* ────────────────────────────────────────────
     CONFIG
  ──────────────────────────────────────────── */
  var SLIDE_MS = 3200;

  /* ────────────────────────────────────────────
     DOM REFS
  ──────────────────────────────────────────── */
  var track   = document.getElementById('carouselTrack');
  var dots    = document.querySelectorAll('.carousel-dots .dot');
  var pFill   = document.getElementById('progressFill');
  var lbl     = document.getElementById('slideLabel');
  var subhead = document.getElementById('dynamicSubhead');
  var wrapper = document.querySelector('.carousel-wrapper');

  /* ────────────────────────────────────────────
     SLIDE DATA
  ──────────────────────────────────────────── */
  var slideData = [
    {
      label : 'Pikachu & Pok\u00e9 Ball',
      sub   : 'Pikachu en briques LEGO !'
    },
    {
      label : 'SMART Play \u2014 Pikachu',
      sub   : 'Lumi\u00e8re, son & mouvement'
    },
    {
      label : 'SMART Play \u2014 Charizard',
      sub   : 'Charizard d\u00e9barque en 2026 !'
    }
  ];

  var current = 0;
  var timer   = null;

  /* ────────────────────────────────────────────
     GO TO SLIDE
  ──────────────────────────────────────────── */
  function goToSlide(n) {
    current = ((n % slideData.length) + slideData.length) % slideData.length;

    // Move track
    if (track) {
      track.style.transform = 'translateX(' + (-current * 320) + 'px)';
    }

    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });

    // Update slide label (instant)
    if (lbl) {
      lbl.textContent = slideData[current].label;
    }

    // Fade-update dynamic subhead
    if (subhead) {
      subhead.style.opacity = '0';
      setTimeout(function () {
        subhead.textContent  = slideData[current].sub;
        subhead.style.opacity = '1';
      }, 230);
    }

    startProgress();
  }

  /* ────────────────────────────────────────────
     PROGRESS BAR
  ──────────────────────────────────────────── */
  function startProgress() {
    clearTimeout(timer);

    if (pFill) {
      pFill.style.transition = 'none';
      pFill.style.width      = '0%';
      void pFill.offsetWidth;                                       // force reflow
      pFill.style.transition = 'width ' + SLIDE_MS + 'ms linear';
      pFill.style.width      = '100%';
    }

    timer = setTimeout(function () {
      goToSlide(current + 1);
    }, SLIDE_MS);
  }

  /* ────────────────────────────────────────────
     DOT CLICKS
  ──────────────────────────────────────────── */
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      goToSlide(i);
    });
  });

  /* ────────────────────────────────────────────
     HOVER PAUSE / RESUME
  ──────────────────────────────────────────── */
  if (wrapper) {
    wrapper.addEventListener('mouseenter', function () {
      clearTimeout(timer);
      if (pFill) {
        var w  = pFill.getBoundingClientRect().width;
        var pw = pFill.parentElement.getBoundingClientRect().width;
        pFill.style.transition = 'none';
        pFill.style.width      = (pw > 0 ? (w / pw * 100).toFixed(1) : '0') + '%';
      }
    });

    wrapper.addEventListener('mouseleave', function () {
      startProgress();
    });
  }

  /* ────────────────────────────────────────────
     TOUCH SWIPE
  ──────────────────────────────────────────── */
  var touchX = 0;
  if (wrapper) {
    wrapper.addEventListener('touchstart', function (e) {
      touchX = e.touches[0].clientX;
    }, { passive: true });

    wrapper.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - touchX;
      if (Math.abs(dx) > 40) {
        goToSlide(current + (dx < 0 ? 1 : -1));
      }
    }, { passive: true });
  }

  /* ────────────────────────────────────────────
     BOOT
  ──────────────────────────────────────────── */
  goToSlide(0);

}());
