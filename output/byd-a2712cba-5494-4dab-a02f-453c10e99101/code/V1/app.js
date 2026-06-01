/**
 * BYD Sealion 5 DM-i — 320×480
 * Carousel auto-rotation, dot navigation, swipe, CTA ripple
 */
(function () {
  'use strict';

  var TOTAL    = 3;
  var current  = 0;
  var isPaused = false;
  var timer    = null;

  var track    = document.getElementById('heroTrack');
  var dotsWrap = document.getElementById('carouselDots');
  var dots     = dotsWrap ? Array.prototype.slice.call(dotsWrap.querySelectorAll('.dot')) : [];

  /* ---- go to slide ---- */
  function goTo(index) {
    if (!track) return;
    current = ((index % TOTAL) + TOTAL) % TOTAL;
    // track is 300% wide; each slide occupies 1/3 → shift by (100/3)%
    track.style.transform = 'translateX(-' + (current * (100 / 3)) + '%)';
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });
  }

  /* ---- auto timer ---- */
  function startTimer() {
    timer = setInterval(function () {
      if (!isPaused) goTo(current + 1);
    }, 2800);
  }

  function stopTimer() {
    clearInterval(timer);
    timer = null;
  }

  /* ---- dot clicks ---- */
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      goTo(parseInt(dot.getAttribute('data-index'), 10));
      stopTimer();
      startTimer();
    });
  });

  /* ---- pause on hover ---- */
  var heroWrap = track ? track.closest('.hero-wrap') : null;
  if (heroWrap) {
    heroWrap.addEventListener('mouseenter', function () { isPaused = true; });
    heroWrap.addEventListener('mouseleave', function () { isPaused = false; });
    heroWrap.addEventListener('focusin',    function () { isPaused = true; });
    heroWrap.addEventListener('focusout',   function () { isPaused = false; });
  }

  /* ---- touch swipe ---- */
  var touchStartX = null;
  if (heroWrap) {
    heroWrap.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    heroWrap.addEventListener('touchend', function (e) {
      if (touchStartX === null) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 28) {
        goTo(dx < 0 ? current + 1 : current - 1);
        stopTimer();
        startTimer();
      }
      touchStartX = null;
    }, { passive: true });
  }

  /* ---- CTA ripple ---- */
  var ctaBtn = document.getElementById('ctaBtn');
  if (ctaBtn) {
    /* inject ripple keyframe once */
    var styleTag = document.createElement('style');
    styleTag.textContent = '@keyframes rippleOut{to{transform:scale(2.8);opacity:0;}}';
    document.head.appendChild(styleTag);

    ctaBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var rect   = ctaBtn.getBoundingClientRect();
      var ripple = document.createElement('span');
      var size   = 72;
      ripple.style.cssText = [
        'position:absolute',
        'border-radius:50%',
        'background:rgba(255,255,255,0.3)',
        'width:'  + size + 'px',
        'height:' + size + 'px',
        'top:'  + (e.clientY - rect.top  - size / 2) + 'px',
        'left:' + (e.clientX - rect.left - size / 2) + 'px',
        'transform:scale(0)',
        'animation:rippleOut 0.55s ease forwards',
        'pointer-events:none'
      ].join(';');
      ctaBtn.appendChild(ripple);
      setTimeout(function () {
        ripple.remove();
        window.open('https://www.byd.com/fr/vehicules-hybrides/sealion-5-dm-i', '_blank', 'noopener');
      }, 560);
    });
  }

  /* ---- init ---- */
  var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  goTo(0);
  if (!reducedMotion) startTimer();

}());
