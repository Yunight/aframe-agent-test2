(function () {
  'use strict';

  var slides = document.querySelectorAll('#carousel .slide');
  var dots = document.querySelectorAll('#dots .dot');
  var current = 0;
  var total = slides.length;
  var timer = null;
  var isAnimating = false;

  function goTo(index, direction) {
    if (isAnimating || index === current) return;
    isAnimating = true;

    var prev = current;
    current = (index + total) % total;

    // Mark leaving
    slides[prev].classList.remove('active');
    slides[prev].classList.add('leaving');

    // Prepare incoming (instant reset so transition plays correctly)
    slides[current].style.transition = 'none';
    slides[current].style.opacity = '0';
    slides[current].style.transform = direction === 'prev' ? 'translateX(-18px)' : 'translateX(18px)';
    slides[current].classList.remove('leaving');

    // Force reflow
    void slides[current].offsetWidth;

    // Restore transition
    slides[current].style.transition = '';
    slides[current].style.opacity = '';
    slides[current].style.transform = '';
    slides[current].classList.add('active');

    // Update dots
    dots.forEach(function (d) { d.classList.remove('active'); });
    dots[current].classList.add('active');

    setTimeout(function () {
      slides[prev].classList.remove('leaving');
      isAnimating = false;
    }, 580);
  }

  function next() {
    goTo((current + 1) % total, 'next');
  }

  function startAuto() {
    timer = setInterval(next, 2600);
  }

  function stopAuto() {
    clearInterval(timer);
  }

  // Dots click
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(this.getAttribute('data-dot'), 10);
      var dir = idx > current ? 'next' : 'prev';
      stopAuto();
      goTo(idx, dir);
      startAuto();
    });
  });

  // Pause on hover
  var ad = document.getElementById('ad-300x250');
  if (ad) {
    ad.addEventListener('mouseenter', stopAuto);
    ad.addEventListener('mouseleave', startAuto);
  }

  // Touch swipe support
  var touchStartX = null;
  var carousel = document.getElementById('carousel');
  if (carousel) {
    carousel.addEventListener('touchstart', function (e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    carousel.addEventListener('touchend', function (e) {
      if (touchStartX === null) return;
      var delta = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(delta) > 30) {
        stopAuto();
        goTo(delta < 0 ? (current + 1) % total : (current - 1 + total) % total, delta < 0 ? 'next' : 'prev');
        startAuto();
      }
      touchStartX = null;
    }, { passive: true });
  }

  // Entrance animation for headline
  var headline = document.querySelector('.headline-block');
  if (headline) {
    headline.style.opacity = '0';
    headline.style.transform = 'translateY(8px)';
    headline.style.transition = 'opacity 0.6s ease 0.2s, transform 0.6s ease 0.2s';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        headline.style.opacity = '1';
        headline.style.transform = 'translateY(0)';
      });
    });
  }

  startAuto();
}());
