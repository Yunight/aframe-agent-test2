(function () {
  'use strict';

  const track = document.getElementById('carouselTrack');
  const dotsContainer = document.getElementById('carouselDots');
  const arrowLeft = document.getElementById('arrowLeft');
  const arrowRight = document.getElementById('arrowRight');

  if (!track) return;

  const slides = Array.from(track.querySelectorAll('.product-slide'));
  const dots = Array.from(dotsContainer.querySelectorAll('.dot'));
  let current = 0;
  let autoTimer = null;
  const AUTO_DELAY = 2800;

  function goTo(index, direction) {
    const prev = current;
    current = (index + slides.length) % slides.length;

    // Remove active/exit from all
    slides.forEach(function (s) {
      s.classList.remove('active', 'exit');
    });

    // Mark previous as exit
    slides[prev].classList.add('exit');

    // Small delay to allow CSS transition
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        slides[current].classList.add('active');
        // Clean up exit after transition
        setTimeout(function () {
          slides[prev].classList.remove('exit');
        }, 480);
      });
    });

    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });
  }

  function next() {
    goTo(current + 1);
  }

  function prev() {
    goTo(current - 1);
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(next, AUTO_DELAY);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Arrow clicks
  arrowLeft.addEventListener('click', function () {
    stopAuto();
    prev();
    startAuto();
  });

  arrowRight.addEventListener('click', function () {
    stopAuto();
    next();
    startAuto();
  });

  // Dot clicks
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      stopAuto();
      goTo(i);
      startAuto();
    });
  });

  // Touch / swipe support
  var touchStartX = 0;
  var touchEndX = 0;

  track.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
  }, { passive: true });

  track.addEventListener('touchend', function (e) {
    touchEndX = e.changedTouches[0].clientX;
    var diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 30) {
      stopAuto();
      if (diff > 0) {
        next();
      } else {
        prev();
      }
      startAuto();
    }
  }, { passive: true });

  // Pause on hover/focus
  var adRoot = document.getElementById('ad-320x480');
  if (adRoot) {
    adRoot.addEventListener('mouseenter', stopAuto);
    adRoot.addEventListener('mouseleave', startAuto);
  }

  // Reduced motion check
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    startAuto();
  }

  // Keyboard arrow support
  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowLeft') {
      stopAuto();
      prev();
      startAuto();
    } else if (e.key === 'ArrowRight') {
      stopAuto();
      next();
      startAuto();
    }
  });

}());
