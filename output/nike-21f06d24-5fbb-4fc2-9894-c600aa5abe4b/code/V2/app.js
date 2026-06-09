(function () {
  'use strict';

  const slides = Array.from(document.querySelectorAll('.slide'));
  const dots   = Array.from(document.querySelectorAll('.dot'));
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const label   = document.getElementById('productLabel');

  const labels = [
    'Nike Mind 001',
    'Nike Mind 001 – Femme',
    'Studio Fleece – Short',
    'Studio Fleece – Pantalon',
    'Studio Fleece – Hoodie'
  ];

  let current = 0;
  let autoTimer = null;
  const INTERVAL = 3000;

  function goTo(index, direction) {
    const prev = current;
    current = (index + slides.length) % slides.length;

    // Exit old slide
    slides[prev].classList.remove('active');
    slides[prev].classList.add('exit');

    // Prepare new slide (reset exit if needed)
    slides[current].classList.remove('exit');

    // Small timeout to let CSS transition pick up
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        slides[current].classList.add('active');
      });
    });

    // Clean up exit class after transition
    setTimeout(function () {
      slides[prev].classList.remove('exit');
    }, 500);

    // Dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });

    // Label
    if (label) {
      label.textContent = labels[current] || '';
    }
  }

  function next() { goTo(current + 1); }
  function prev() { goTo(current - 1); }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(next, INTERVAL);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Nav buttons
  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      stopAuto();
      prev();
      startAuto();
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      stopAuto();
      next();
      startAuto();
    });
  }

  // Dots
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-dot'), 10);
      stopAuto();
      goTo(idx);
      startAuto();
    });
  });

  // Touch / swipe
  var touchStartX = 0;
  var touchEndX   = 0;
  var carousel    = document.getElementById('carousel');

  if (carousel) {
    carousel.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].clientX;
    }, { passive: true });

    carousel.addEventListener('touchend', function (e) {
      touchEndX = e.changedTouches[0].clientX;
      var diff  = touchStartX - touchEndX;
      if (Math.abs(diff) > 30) {
        stopAuto();
        if (diff > 0) { next(); } else { prev(); }
        startAuto();
      }
    }, { passive: true });
  }

  // Start
  startAuto();
})();
