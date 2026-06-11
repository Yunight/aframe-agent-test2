(function () {
  'use strict';

  var SLIDE_COUNT = 3;
  var AUTO_INTERVAL = 3200;
  var currentSlide = 0;
  var autoTimer = null;

  var track = document.getElementById('carouselTrack');
  var dotsContainer = document.getElementById('carouselDots');
  var dots = document.querySelectorAll('.dot');
  var thumbBtns = document.querySelectorAll('.thumb-btn');

  // Show dots only when carousel has >= 2 slides
  if (SLIDE_COUNT < 2) {
    dotsContainer.style.display = 'none';
  }

  // Extra product images for thumbnails 3 and 4 (not in main carousel)
  var extraImages = [
    './sideboards-buffets-10412.jpg',
    './console-tables-16246.jpg'
  ];

  function goToSlide(index) {
    // Clamp to main carousel slides
    var carouselIndex = Math.min(index, SLIDE_COUNT - 1);
    currentSlide = carouselIndex;
    track.style.transform = 'translateX(-' + (carouselIndex * 320) + 'px)';

    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === carouselIndex);
    });

    thumbBtns.forEach(function (btn, i) {
      btn.classList.toggle('active', i === index);
    });
  }

  function nextSlide() {
    var next = (currentSlide + 1) % SLIDE_COUNT;
    goToSlide(next);
  }

  function startAuto() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = setInterval(nextSlide, AUTO_INTERVAL);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  // Dot navigation
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(this.getAttribute('data-index'), 10);
      goToSlide(idx);
      stopAuto();
      startAuto();
    });
  });

  // Thumbnail navigation
  thumbBtns.forEach(function (btn, i) {
    btn.addEventListener('click', function () {
      var slideIdx = parseInt(this.getAttribute('data-slide'), 10);
      var isExtra = this.getAttribute('data-extra') === 'true';

      if (isExtra) {
        // Show extra image as overlay on current carousel frame
        showExtraOverlay(extraImages[slideIdx - SLIDE_COUNT], i);
        thumbBtns.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        stopAuto();
      } else {
        hideExtraOverlay();
        goToSlide(slideIdx);
        stopAuto();
        startAuto();
      }
    });
  });

  // Extra overlay
  var overlay = null;

  function showExtraOverlay(src, thumbIndex) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.style.position = 'absolute';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '320px';
      overlay.style.height = '188px';
      overlay.style.background = '#F5F5F5';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '20';
      overlay.style.opacity = '0';
      overlay.style.transition = 'opacity 0.35s ease';

      var oImg = document.createElement('img');
      oImg.style.maxWidth = '90%';
      oImg.style.maxHeight = '90%';
      oImg.style.objectFit = 'contain';
      oImg.alt = 'Produit';
      overlay.appendChild(oImg);

      var carouselWrapper = document.querySelector('.carousel-wrapper');
      carouselWrapper.appendChild(overlay);
    }

    overlay.querySelector('img').src = src;
    // Trigger reflow then fade in
    overlay.style.opacity = '0';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        overlay.style.opacity = '1';
      });
    });
  }

  function hideExtraOverlay() {
    if (overlay) {
      overlay.style.opacity = '0';
    }
  }

  // Swipe support
  var touchStartX = 0;
  var carouselWrapper = document.querySelector('.carousel-wrapper');

  carouselWrapper.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
    stopAuto();
  }, { passive: true });

  carouselWrapper.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) {
      if (dx < 0) {
        goToSlide((currentSlide + 1) % SLIDE_COUNT);
      } else {
        goToSlide((currentSlide - 1 + SLIDE_COUNT) % SLIDE_COUNT);
      }
    }
    startAuto();
  }, { passive: true });

  // Pause on hover
  carouselWrapper.addEventListener('mouseenter', stopAuto);
  carouselWrapper.addEventListener('mouseleave', startAuto);

  // Init
  goToSlide(0);
  startAuto();

  // Subtle CTA pulse
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    var pulseStyle = document.createElement('style');
    pulseStyle.textContent = [
      '@keyframes ctaPulse {',
      '  0%   { box-shadow: 0 0 0 0 rgba(0,88,171,0.55); }',
      '  60%  { box-shadow: 0 0 0 7px rgba(0,88,171,0); }',
      '  100% { box-shadow: 0 0 0 0 rgba(0,88,171,0); }',
      '}',
      '.cta-btn { animation: ctaPulse 2.4s ease-out 1.5s 3; }'
    ].join('');
    document.head.appendChild(pulseStyle);
  }

}());
