(function () {
  'use strict';

  const track = document.getElementById('carouselTrack');
  const slides = track ? Array.from(track.querySelectorAll('.slide')) : [];
  const dotsContainer = document.getElementById('carouselDots');
  const dots = dotsContainer ? Array.from(dotsContainer.querySelectorAll('.dot')) : [];
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');

  let current = 0;
  let autoTimer = null;
  const TOTAL = slides.length;
  const AUTO_DELAY = 3000;

  function goTo(index) {
    if (!slides.length) return;
    slides[current].classList.remove('active');
    dots[current] && dots[current].classList.remove('active');

    current = (index + TOTAL) % TOTAL;

    slides[current].classList.add('active');
    dots[current] && dots[current].classList.add('active');
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

  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      stopAuto();
      next();
      startAuto();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      stopAuto();
      prev();
      startAuto();
    });
  }

  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      stopAuto();
      goTo(parseInt(dot.getAttribute('data-dot'), 10));
      startAuto();
    });
  });

  // Touch / swipe support
  var touchStartX = null;
  var touchStartY = null;

  var frame = document.getElementById('ad-320x480');
  if (frame) {
    frame.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
      touchStartY = e.touches[0].clientY;
    }, { passive: true });

    frame.addEventListener('touchend', function (e) {
      if (touchStartX === null) return;
      var dx = e.changedTouches[0].clientX - touchStartX;
      var dy = e.changedTouches[0].clientY - touchStartY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
        stopAuto();
        if (dx < 0) next();
        else prev();
        startAuto();
      }
      touchStartX = null;
      touchStartY = null;
    }, { passive: true });
  }

  // Pause auto on hover
  if (frame) {
    frame.addEventListener('mouseenter', stopAuto);
    frame.addEventListener('mouseleave', startAuto);
  }

  // Init
  goTo(0);
  startAuto();

  // Entrance animation: stagger slides label fade-in
  slides.forEach(function (slide, i) {
    var label = slide.querySelector('.product-label');
    if (label) {
      label.style.opacity = '0';
      label.style.transition = 'opacity 0.4s ease ' + (0.3 + i * 0.05) + 's';
      setTimeout(function () {
        label.style.opacity = '1';
      }, 100);
    }
  });

}());