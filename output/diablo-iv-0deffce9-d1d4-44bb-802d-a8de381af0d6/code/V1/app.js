(function () {
  'use strict';

  // ─── EMBER PARTICLES ─────────────────────────────────────────
  const container = document.getElementById('emberContainer');
  const EMBER_COUNT = 22;

  function randomBetween(min, max) {
    return Math.random() * (max - min) + min;
  }

  function createEmber() {
    const el = document.createElement('span');
    el.classList.add('ember');

    const size = randomBetween(2, 5);
    const startX = randomBetween(10, 310);
    const startY = randomBetween(260, 480);
    const drift = randomBetween(-40, 40);
    const duration = randomBetween(4.5, 9);
    const delay = randomBetween(0, 8);

    const colors = ['#C84B11', '#D9A441', '#8B0000', '#A88E5A'];
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = [
      `width:${size}px`,
      `height:${size}px`,
      `left:${startX}px`,
      `top:${startY}px`,
      `background:${color}`,
      `box-shadow: 0 0 ${size * 2}px ${color}`,
      `--drift:${drift}px`,
      `animation-duration:${duration}s`,
      `animation-delay:${delay}s`,
    ].join(';');

    container.appendChild(el);
  }

  // Only create embers if reduced motion is not preferred
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    for (let i = 0; i < EMBER_COUNT; i++) {
      createEmber();
    }
  }

  // ─── HERO CAROUSEL ───────────────────────────────────────────
  const slides = document.querySelectorAll('.hero-slide');
  const dots   = document.querySelectorAll('.dot');
  let current  = 0;
  let autoTimer = null;

  function goToSlide(index) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (index + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function nextSlide() {
    goToSlide(current + 1);
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(nextSlide, 3200);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Dot click
  dots.forEach(function (dot) {
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      const idx = parseInt(dot.dataset.index, 10);
      goToSlide(idx);
      startAuto(); // restart timer on manual interaction
    });
  });

  // Touch/swipe support
  const adRoot = document.getElementById('ad-320x480');
  let touchStartX = 0;
  let touchStartY = 0;

  adRoot.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  adRoot.addEventListener('touchend', function (e) {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
      if (dx < 0) {
        goToSlide(current + 1);
      } else {
        goToSlide(current - 1);
      }
      startAuto();
    }
  }, { passive: true });

  // Start auto-rotation
  if (!prefersReduced) {
    startAuto();
  } else {
    // Static first slide only
    goToSlide(0);
  }

  // ─── CTA HOVER SOUND (visual only – no audio) ─────────────────
  // Ripple effect on CTA click
  const cta = document.querySelector('.cta-button');
  if (cta) {
    cta.addEventListener('mouseenter', function () {
      cta.style.backgroundImage = 'linear-gradient(135deg, #C84B11 0%, #8B0000 50%, #C84B11 100%)';
    });
    cta.addEventListener('mouseleave', function () {
      cta.style.backgroundImage = 'linear-gradient(135deg, #8B0000 0%, #C84B11 50%, #8B0000 100%)';
    });
  }

})();
