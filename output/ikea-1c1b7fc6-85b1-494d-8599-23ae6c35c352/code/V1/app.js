(function () {
  'use strict';

  var slides = Array.from(document.querySelectorAll('#carouselTrack .slide'));
  var dots = Array.from(document.querySelectorAll('#carouselDots .dot'));
  var thumbBtns = Array.from(document.querySelectorAll('#thumbStrip .thumb-btn'));
  var current = 0;
  var autoTimer = null;
  var AUTO_INTERVAL = 3200;

  function goTo(index) {
    if (index === current) return;
    // Remove active from current
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    thumbBtns[current].classList.remove('active');

    current = (index + slides.length) % slides.length;

    // Add active to new
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    thumbBtns[current].classList.add('active');

    // Re-trigger float animation on the active slide image
    var img = slides[current].querySelector('.product-img');
    if (img) {
      img.style.animation = 'none';
      // Force reflow
      void img.offsetWidth;
      img.style.animation = '';
    }
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(function () {
      goTo(current + 1);
    }, AUTO_INTERVAL);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Dot clicks
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      goTo(parseInt(dot.getAttribute('data-index'), 10));
      stopAuto();
      startAuto();
    });
  });

  // Thumbnail clicks
  thumbBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      goTo(parseInt(btn.getAttribute('data-index'), 10));
      stopAuto();
      startAuto();
    });
  });

  // Touch/swipe on hero
  var heroArea = document.querySelector('.hero-area');
  var touchStartX = 0;
  var touchEndX = 0;

  if (heroArea) {
    heroArea.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].screenX;
    }, { passive: true });

    heroArea.addEventListener('touchend', function (e) {
      touchEndX = e.changedTouches[0].screenX;
      var diff = touchStartX - touchEndX;
      if (Math.abs(diff) > 30) {
        goTo(diff > 0 ? current + 1 : current - 1);
        stopAuto();
        startAuto();
      }
    }, { passive: true });
  }

  // CTA pulse animation on hover
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mouseenter', function () {
      ctaBtn.style.boxShadow = '0 4px 16px rgba(0, 88, 171, 0.35)';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      ctaBtn.style.boxShadow = '';
    });
  }

  // Init
  startAuto();

  // Pause auto when tab not visible
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAuto();
    } else {
      startAuto();
    }
  });

})();
