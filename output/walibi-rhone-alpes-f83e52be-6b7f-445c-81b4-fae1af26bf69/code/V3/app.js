(function () {
  'use strict';

  var INTERVAL = 3200;
  var PROGRESS_DURATION = INTERVAL;

  var slides = document.querySelectorAll('#ad-300x250 .slide');
  var dots   = document.querySelectorAll('#ad-300x250 .dot');
  var adRoot = document.getElementById('ad-300x250');

  // Inject progress bar
  var bar = document.createElement('div');
  bar.className = 'progress-bar';
  adRoot.appendChild(bar);

  var current = 0;
  var timer   = null;
  var paused  = false;

  function goTo(idx) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (idx + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    resetProgress();
  }

  function next() {
    goTo(current + 1);
  }

  function resetProgress() {
    // Reset bar
    bar.style.transition = 'none';
    bar.style.width = '0%';
    // Force reflow
    void bar.offsetWidth;
    bar.style.transition = 'width ' + PROGRESS_DURATION + 'ms linear';
    bar.style.width = '100%';
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (!paused) next();
    }, INTERVAL);
  }

  // Dot click
  dots.forEach(function (dot) {
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      goTo(parseInt(dot.getAttribute('data-idx'), 10));
      startAuto();
    });
  });

  // Pause on hover
  adRoot.addEventListener('mouseenter', function () { paused = true; });
  adRoot.addEventListener('mouseleave', function () { paused = false; });

  // Init
  resetProgress();
  startAuto();

  // CTA click tracking stub
  var cta = document.querySelector('#ad-300x250 .cta-btn');
  if (cta) {
    cta.addEventListener('click', function () {
      // Analytics hook placeholder
      if (window.console) console.log('CTA clicked – Walibi Été 2026');
    });
  }
}());
