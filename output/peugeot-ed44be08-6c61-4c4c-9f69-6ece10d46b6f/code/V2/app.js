(function () {
  'use strict';

  var DURATION = 3500;
  var current  = 0;
  var timer    = null;

  var slides = document.querySelectorAll('.carousel-img');
  var dots   = document.querySelectorAll('.dot');
  var fill   = document.getElementById('barFill');
  var total  = slides.length;

  /* Activate slide by index */
  function go(idx) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = ((idx % total) + total) % total;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    animateBar();
  }

  /* Reset and replay the progress bar */
  function animateBar() {
    fill.style.transition = 'none';
    fill.style.width      = '0%';
    /* force reflow so the reset is applied before the transition re-starts */
    void fill.offsetWidth;
    fill.style.transition = 'width ' + DURATION + 'ms linear';
    fill.style.width      = '100%';
  }

  /* Auto-advance */
  function play() {
    timer = setInterval(function () {
      go(current + 1);
    }, DURATION);
  }

  function pause() {
    clearInterval(timer);
    timer = null;
  }

  /* Dot navigation */
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      pause();
      go(parseInt(dot.getAttribute('data-idx'), 10));
      play();
    });
  });

  /* Touch / swipe support */
  var touchStartX = 0;
  var wrap = document.getElementById('carousel');

  wrap.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  wrap.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) {
      pause();
      go(dx < 0 ? current + 1 : current - 1);
      play();
    }
  }, { passive: true });

  /* Boot */
  animateBar();
  play();

}());
