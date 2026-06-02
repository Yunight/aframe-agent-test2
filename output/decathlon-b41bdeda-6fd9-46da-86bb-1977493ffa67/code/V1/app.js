(function () {
  'use strict';

  const track = document.getElementById('carouselTrack');
  const slides = track ? Array.from(track.querySelectorAll('.slide')) : [];
  const dots   = Array.from(document.querySelectorAll('.dot'));
  const labelEl = document.getElementById('slideLabel');
  const priceEl = document.getElementById('slidePrice');
  const ctaBtn  = document.getElementById('ctaBtn');

  let currentIndex = 0;
  let autoTimer = null;
  const AUTO_INTERVAL = 3200;

  function goToSlide(index) {
    if (!slides.length) return;
    const prev = currentIndex;
    currentIndex = (index + slides.length) % slides.length;

    // Swap active class on slides
    slides[prev].classList.remove('active');
    slides[currentIndex].classList.add('active');

    // Swap active dot
    dots[prev].classList.remove('active');
    dots[prev].setAttribute('aria-selected', 'false');
    dots[currentIndex].classList.add('active');
    dots[currentIndex].setAttribute('aria-selected', 'true');

    // Update info overlay
    const activeSlide = slides[currentIndex];
    if (labelEl) {
      labelEl.textContent = activeSlide.dataset.label || '';
      labelEl.style.animation = 'none';
      void labelEl.offsetWidth; // reflow to restart animation
      labelEl.style.animation = '';
    }
    if (priceEl) {
      priceEl.textContent = activeSlide.dataset.price || '';
    }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(function () {
      goToSlide(currentIndex + 1);
    }, AUTO_INTERVAL);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Dot click
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      const idx = parseInt(dot.dataset.index, 10);
      goToSlide(idx);
      stopAuto();
      startAuto(); // restart timer after manual nav
    });
  });

  // Touch/swipe support
  var touchStartX = 0;
  var touchEndX   = 0;
  var swipeThreshold = 40;

  if (track) {
    track.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].clientX;
    }, { passive: true });

    track.addEventListener('touchend', function (e) {
      touchEndX = e.changedTouches[0].clientX;
      var diff = touchStartX - touchEndX;
      if (Math.abs(diff) > swipeThreshold) {
        goToSlide(diff > 0 ? currentIndex + 1 : currentIndex - 1);
        stopAuto();
        startAuto();
      }
    }, { passive: true });
  }

  // CTA click feedback
  if (ctaBtn) {
    ctaBtn.addEventListener('click', function () {
      ctaBtn.style.transform = 'scale(0.96)';
      setTimeout(function () {
        ctaBtn.style.transform = '';
      }, 180);
      // In production this would navigate; for demo, log.
      console.log('CTA clicked — Decathlon Bons plans été 2026');
    });
  }

  // Respect reduced motion
  var prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    // Keep slides still; user can click dots
    return;
  }

  // Kick off auto-rotation
  startAuto();

}());
