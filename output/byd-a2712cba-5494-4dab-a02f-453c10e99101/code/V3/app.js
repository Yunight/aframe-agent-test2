(function () {
  'use strict';

  const SLIDE_INTERVAL = 3200;
  const TRANSITION_DURATION = 850;

  const images = document.querySelectorAll('#ad-300x250 .hero-img');
  const dots   = document.querySelectorAll('#ad-300x250 .dot');
  let current  = 0;
  let timer    = null;
  let running  = true;

  function goTo(index) {
    if (index === current) return;

    // Remove active from old
    images[current].classList.remove('active');
    dots[current].classList.remove('active');

    current = (index + images.length) % images.length;

    images[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function next() {
    goTo((current + 1) % images.length);
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(next, SLIDE_INTERVAL);
  }

  function stopAuto() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  // Dot clicks
  dots.forEach(function (dot) {
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      const idx = parseInt(dot.getAttribute('data-dot'), 10);
      goTo(idx);
      // Reset auto timer on manual interaction
      stopAuto();
      startAuto();
    });
  });

  // Pause on hover
  const ad = document.getElementById('ad-300x250');
  if (ad) {
    ad.addEventListener('mouseenter', function () {
      running = false;
      stopAuto();
    });
    ad.addEventListener('mouseleave', function () {
      running = true;
      startAuto();
    });

    // Click on ad (not CTA / dots) advances slide
    ad.addEventListener('click', function (e) {
      // Allow CTA link default
      if (e.target.classList.contains('ad-cta')) return;
      if (e.target.classList.contains('dot')) return;
      next();
      stopAuto();
      startAuto();
    });
  }

  // Respect reduced motion preference — no auto-play
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq && mq.matches) {
    running = false;
    return; // Do not start auto-rotation
  }

  // Kick off after initial entrance animation settles
  setTimeout(startAuto, SLIDE_INTERVAL);

})();
