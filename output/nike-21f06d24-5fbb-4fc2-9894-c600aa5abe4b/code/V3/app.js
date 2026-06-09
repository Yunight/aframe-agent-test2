(function () {
  'use strict';

  var SLIDE_COUNT = 4;
  var AUTO_INTERVAL = 3200; // ms per slide
  var currentSlide = 0;
  var autoTimer = null;
  var barTimer = null;

  var track = document.getElementById('slideTrack');
  var dots = document.querySelectorAll('.dot');
  var accentBar = document.getElementById('accentBar');
  var ad = document.getElementById('ad-300x600');

  function goToSlide(index) {
    currentSlide = (index + SLIDE_COUNT) % SLIDE_COUNT;
    // Move track
    track.style.transform = 'translateX(-' + (currentSlide * 300) + 'px)';
    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === currentSlide);
    });
    // Re-trigger float animation on product image in current slide
    var imgs = track.querySelectorAll('.product-img');
    imgs.forEach(function (img, i) {
      if (i === currentSlide) {
        img.style.animation = 'none';
        void img.offsetWidth; // reflow
        img.style.animation = '';
      }
    });
    // Reset accent bar
    startAccentBar();
  }

  function startAccentBar() {
    accentBar.style.transition = 'none';
    accentBar.style.width = '0%';
    // Force reflow
    void accentBar.offsetWidth;
    accentBar.style.transition = 'width ' + AUTO_INTERVAL + 'ms linear';
    accentBar.style.width = '100%';
  }

  function nextSlide() {
    goToSlide(currentSlide + 1);
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(nextSlide, AUTO_INTERVAL);
    startAccentBar();
  }

  function stopAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
    // Freeze accent bar
    var computed = getComputedStyle(accentBar).width;
    accentBar.style.transition = 'none';
    accentBar.style.width = computed;
  }

  // Dot click
  dots.forEach(function (dot) {
    dot.addEventListener('click', function (e) {
      e.stopPropagation();
      var idx = parseInt(dot.getAttribute('data-dot'), 10);
      goToSlide(idx);
      stopAuto();
      startAuto();
    });
  });

  // Pause on hover
  ad.addEventListener('mouseenter', function () {
    stopAuto();
  });

  ad.addEventListener('mouseleave', function () {
    startAuto();
  });

  // Touch/swipe support
  var touchStartX = 0;
  var touchEndX = 0;

  ad.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
    stopAuto();
  }, { passive: true });

  ad.addEventListener('touchend', function (e) {
    touchEndX = e.changedTouches[0].clientX;
    var diff = touchStartX - touchEndX;
    if (Math.abs(diff) > 30) {
      if (diff > 0) {
        goToSlide(currentSlide + 1);
      } else {
        goToSlide(currentSlide - 1);
      }
    }
    startAuto();
  }, { passive: true });

  // CTA click — open Nike new arrivals page
  var cta = document.querySelector('.cta-btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      e.stopPropagation();
    });
  }

  // Clicking on ad body (not CTA/dots) advances slide
  ad.addEventListener('click', function (e) {
    if (
      !e.target.classList.contains('dot') &&
      !e.target.classList.contains('cta-btn')
    ) {
      nextSlide();
      stopAuto();
      startAuto();
    }
  });

  // Init
  goToSlide(0);
  startAuto();

  // Respect prefers-reduced-motion: disable auto on reduced-motion
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    stopAuto();
    accentBar.style.display = 'none';
  }

})();
