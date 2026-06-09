(function () {
  'use strict';

  var slideshow = document.getElementById('slideshow');
  var slides = slideshow ? slideshow.querySelectorAll('.slide') : [];
  var dotsContainer = document.getElementById('slideDots');
  var current = 0;
  var total = slides.length;
  var autoplayInterval = null;
  var AUTOPLAY_DELAY = 2800;

  if (!slideshow || total === 0) return;

  // Build dots
  var dots = [];
  for (var i = 0; i < total; i++) {
    var btn = document.createElement('button');
    btn.className = 'dot' + (i === 0 ? ' active' : '');
    btn.setAttribute('aria-label', 'Slide ' + (i + 1));
    btn.setAttribute('data-index', i);
    dotsContainer.appendChild(btn);
    dots.push(btn);
  }

  // Hide dots if only one slide
  if (total <= 1) {
    dotsContainer.classList.add('hidden');
  }

  function goTo(index) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (index + total) % total;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function next() {
    goTo(current + 1);
  }

  function startAutoplay() {
    if (autoplayInterval) return;
    autoplayInterval = setInterval(next, AUTOPLAY_DELAY);
  }

  function stopAutoplay() {
    clearInterval(autoplayInterval);
    autoplayInterval = null;
  }

  // Dot click handlers
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-index'), 10);
      stopAutoplay();
      goTo(idx);
      startAutoplay();
    });
  });

  // Touch/swipe support
  var touchStartX = 0;
  var touchStartY = 0;

  slideshow.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });

  slideshow.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 30) {
      stopAutoplay();
      if (dx < 0) {
        goTo(current + 1);
      } else {
        goTo(current - 1);
      }
      startAutoplay();
    }
  }, { passive: true });

  // Pause on hover
  slideshow.addEventListener('mouseenter', stopAutoplay);
  slideshow.addEventListener('mouseleave', startAutoplay);

  // Respect reduced motion
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    startAutoplay();
  }

}());
