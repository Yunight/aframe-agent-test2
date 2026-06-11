(function () {
  'use strict';

  var slides = document.querySelectorAll('#slideshow .slide');
  var dots = document.querySelectorAll('#slideDots .dot');
  var current = 0;
  var total = slides.length;
  var timer = null;
  var INTERVAL = 3200;

  function goTo(index) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (index + total) % total;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function startAuto() {
    timer = setInterval(function () {
      goTo(current + 1);
    }, INTERVAL);
  }

  function stopAuto() {
    clearInterval(timer);
  }

  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-idx'), 10);
      stopAuto();
      goTo(idx);
      startAuto();
    });
  });

  // Pause on hover
  var adRoot = document.getElementById('ad-300x250');
  if (adRoot) {
    adRoot.addEventListener('mouseenter', stopAuto);
    adRoot.addEventListener('mouseleave', startAuto);
  }

  // Respect reduced motion
  var prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!prefersReduced) {
    startAuto();
  }

  // Subtle pulse animation on CTA
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn && !prefersReduced) {
    var pulsing = false;
    function pulseCta() {
      if (pulsing) return;
      pulsing = true;
      ctaBtn.style.transition = 'transform 0.22s ease, box-shadow 0.22s ease, background 0.18s';
      ctaBtn.style.transform = 'scale(1.06)';
      ctaBtn.style.boxShadow = '3px 5px 0 rgba(0,0,0,0.4)';
      setTimeout(function () {
        ctaBtn.style.transform = '';
        ctaBtn.style.boxShadow = '';
        pulsing = false;
      }, 320);
    }
    // Pulse every ~5s after initial delay
    setTimeout(function () {
      pulseCta();
      setInterval(pulseCta, 5000);
    }, 2000);
  }
})();
