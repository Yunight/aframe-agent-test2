(function () {
  'use strict';

  const track = document.getElementById('carouselTrack');
  const slides = Array.from(track.querySelectorAll('.carousel-slide'));
  const dots = Array.from(document.getElementById('carouselDots').querySelectorAll('.dot'));
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const labelEl = document.getElementById('productLabel');

  let current = 0;
  let autoTimer = null;
  const INTERVAL = 3200;

  function goTo(index, direction) {
    const prev = current;
    current = (index + slides.length) % slides.length;

    if (prev === current) return;

    // Remove active, add exit class
    slides[prev].classList.remove('active');
    slides[prev].classList.add(direction === 'next' ? 'exit-left' : 'exit-right');

    // Activate new
    slides[current].classList.add('active');

    // Clean up exit class after transition
    const exitSlide = slides[prev];
    const onEnd = function () {
      exitSlide.classList.remove('exit-left', 'exit-right');
      exitSlide.removeEventListener('transitionend', onEnd);
    };
    exitSlide.addEventListener('transitionend', onEnd);

    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });

    // Update label
    labelEl.style.opacity = '0';
    setTimeout(function () {
      labelEl.textContent = slides[current].getAttribute('data-label');
      labelEl.style.opacity = '1';
    }, 220);
  }

  function next() { goTo(current + 1, 'next'); }
  function prev() { goTo(current - 1, 'prev'); }

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

  // Arrow buttons
  nextBtn.addEventListener('click', function () {
    next();
    stopAuto();
    startAuto();
  });

  prevBtn.addEventListener('click', function () {
    prev();
    stopAuto();
    startAuto();
  });

  // Dot buttons
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      goTo(i, i > current ? 'next' : 'prev');
      stopAuto();
      startAuto();
    });
  });

  // Touch / swipe support
  var touchStartX = 0;
  var touchEndX = 0;

  track.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].screenX;
    stopAuto();
  }, { passive: true });

  track.addEventListener('touchend', function (e) {
    touchEndX = e.changedTouches[0].screenX;
    var diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 30) {
      if (diff > 0) next(); else prev();
    }
    startAuto();
  }, { passive: true });

  // Pause on hover
  var wrapper = document.querySelector('.carousel-wrapper');
  wrapper.addEventListener('mouseenter', stopAuto);
  wrapper.addEventListener('mouseleave', startAuto);

  // Initial label
  labelEl.textContent = slides[0].getAttribute('data-label');

  // Start autoplay
  startAuto();

  // Respect reduced motion
  var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq && mq.matches) {
    stopAuto();
  }

})();
