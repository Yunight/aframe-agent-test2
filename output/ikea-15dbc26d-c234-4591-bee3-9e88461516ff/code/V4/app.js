/* =============================================
   IKEA SÖDERHAMN – 300×250 Ad – app.js
   Vanilla JS carousel + copy rotation
   ============================================= */

(function () {
  'use strict';

  // Slide copy per slide index
  var slideCopy = [
    { headline: 'Vivez le confort\u00A0<br>à votre façon', sub: 'Canapés modulables – Configurez, changez, profitez.' },
    { headline: 'Osez la couleur<br>chez vous', sub: 'La série SÖDERHAMN en teintes audacieuses.' },
    { headline: 'Modulable<br>à l\u2019infini', sub: 'Ajoutez, combinez, transformez votre salon.' },
    { headline: 'Détente absolue<br>au quotidien', sub: 'Méridienne et chaise longue pour un confort total.' }
  ];

  var slides = document.querySelectorAll('.carousel-slide');
  var dots   = document.querySelectorAll('.dot');
  var headline = document.getElementById('adHeadline');
  var sub      = document.getElementById('adSub');

  var current  = 0;
  var total    = slides.length;
  var timer    = null;
  var INTERVAL = 3200;

  function goTo(idx) {
    // Remove active from current
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');

    current = (idx + total) % total;

    slides[current].classList.add('active');
    dots[current].classList.add('active');

    // Update copy with fade animation trick
    if (headline && sub) {
      headline.style.animation = 'none';
      sub.style.animation      = 'none';
      // Force reflow
      void headline.offsetWidth;
      void sub.offsetWidth;
      headline.innerHTML = slideCopy[current].headline;
      sub.textContent    = slideCopy[current].sub;
      headline.style.animation = 'fadeUp 0.55s ease both';
      sub.style.animation      = 'fadeUp 0.75s ease both';
    }
  }

  function next() {
    goTo(current + 1);
  }

  function startTimer() {
    timer = setInterval(next, INTERVAL);
  }

  function resetTimer() {
    clearInterval(timer);
    startTimer();
  }

  // Dot click navigation
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-idx'), 10);
      if (idx !== current) {
        goTo(idx);
        resetTimer();
      }
    });
  });

  // Pause on hover
  var ad = document.getElementById('ad-300x250');
  if (ad) {
    ad.addEventListener('mouseenter', function () {
      clearInterval(timer);
    });
    ad.addEventListener('mouseleave', function () {
      startTimer();
    });
  }

  // Respect reduced-motion
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    startTimer();
  }

  // Init first slide image ken-burns
  if (slides[0]) {
    slides[0].classList.add('active');
  }
}());
