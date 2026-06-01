(function () {
  'use strict';

  const slides = Array.from(document.querySelectorAll('.slide'));
  const dots   = Array.from(document.querySelectorAll('.dot'));
  let current  = 0;
  let timer    = null;
  const INTERVAL = 3200;

  function goTo(index) {
    const prev = current;
    if (index === prev) return;

    // Remove active, add exit on old slide
    slides[prev].classList.remove('active');
    slides[prev].classList.add('exit');

    // Clean up exit class after transition
    setTimeout(function () {
      slides[prev].classList.remove('exit');
    }, 600);

    // Activate new slide
    current = index;
    slides[current].classList.add('active');

    // Re-trigger badge animation by toggling class
    const badge = slides[current].querySelector('.discount-badge');
    if (badge) {
      badge.style.animation = 'none';
      // Force reflow
      void badge.offsetWidth;
      badge.style.animation = '';
    }

    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });
  }

  function nextSlide() {
    goTo((current + 1) % slides.length);
  }

  function startTimer() {
    timer = setInterval(nextSlide, INTERVAL);
  }

  function resetTimer() {
    clearInterval(timer);
    startTimer();
  }

  // Dot click
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      goTo(i);
      resetTimer();
    });
  });

  // Swipe support
  var touchStartX = 0;
  var adEl = document.getElementById('ad-300x250');

  adEl.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });

  adEl.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 30) {
      if (dx < 0) {
        goTo((current + 1) % slides.length);
      } else {
        goTo((current - 1 + slides.length) % slides.length);
      }
      resetTimer();
    }
  }, { passive: true });

  // Pause on hover
  adEl.addEventListener('mouseenter', function () {
    clearInterval(timer);
  });
  adEl.addEventListener('mouseleave', function () {
    startTimer();
  });

  // CTA click tracking stub
  var cta = document.querySelector('.cta-btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      // Analytics hook placeholder
      // e.g. gtag('event', 'cta_click', { ad: 'bonnes-affaires-300x250' });
    });
  }

  // Start
  startTimer();
}());
