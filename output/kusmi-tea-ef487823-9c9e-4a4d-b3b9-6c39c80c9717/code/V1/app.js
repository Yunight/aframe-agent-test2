(function () {
  'use strict';

  // ---- Pill carousel / hero swap ----
  var pills = document.querySelectorAll('.pill');
  var heroImg = document.querySelector('.hero-img');
  var currentActive = 0;

  // Map of pill data-img values to verified local paths
  var imgMap = {
    './Capture_d_ecran_2026-04-15_093136.png': './Capture_d_ecran_2026-04-15_093136.png',
    './MENU_vp_the_fr_ete_26.jpg': './MENU_vp_the_fr_ete_26.jpg',
    './MENU_vp_coffret_fr_ete_26.jpg': './MENU_vp_coffret_fr_ete_26.jpg',
    './MENU_vp_access_fr_ete_26.jpg': './MENU_vp_access_fr_ete_26.jpg'
  };

  function activatePill(pill) {
    pills.forEach(function (p) { p.classList.remove('active'); });
    pill.classList.add('active');

    var rawSrc = pill.getAttribute('data-img');
    var newSrc = imgMap[rawSrc] || rawSrc;

    if (heroImg.getAttribute('src') !== newSrc) {
      heroImg.classList.add('fading');
      setTimeout(function () {
        heroImg.setAttribute('src', newSrc);
        heroImg.onload = function () {
          heroImg.classList.remove('fading');
        };
        // Fallback if image already cached
        if (heroImg.complete) {
          heroImg.classList.remove('fading');
        }
      }, 350);
    }
  }

  pills.forEach(function (pill, idx) {
    pill.addEventListener('click', function () {
      currentActive = idx;
      activatePill(pill);
    });
  });

  // ---- Auto-rotate pills every 3.5s ----
  var autoInterval = setInterval(function () {
    currentActive = (currentActive + 1) % pills.length;
    activatePill(pills[currentActive]);
  }, 3500);

  // Pause auto-rotate on user interaction
  var track = document.getElementById('pillsTrack');
  track.addEventListener('click', function () {
    clearInterval(autoInterval);
  });

  // ---- Drag-to-scroll pills track ----
  var isDragging = false;
  var startX = 0;
  var scrollStart = 0;

  track.addEventListener('mousedown', function (e) {
    isDragging = true;
    startX = e.pageX;
    scrollStart = track.scrollLeft;
    track.style.cursor = 'grabbing';
  });
  document.addEventListener('mousemove', function (e) {
    if (!isDragging) return;
    track.scrollLeft = scrollStart - (e.pageX - startX);
  });
  document.addEventListener('mouseup', function () {
    isDragging = false;
    track.style.cursor = 'grab';
  });

  // Touch support
  var touchStartX = 0;
  var touchScrollStart = 0;
  track.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].pageX;
    touchScrollStart = track.scrollLeft;
  }, { passive: true });
  track.addEventListener('touchmove', function (e) {
    track.scrollLeft = touchScrollStart - (e.touches[0].pageX - touchStartX);
  }, { passive: true });

  // ---- CTA click tracking (no-op, placeholder) ----
  var cta = document.querySelector('.cta-btn');
  if (cta) {
    cta.addEventListener('click', function () {
      // Analytics hook placeholder
    });
  }

  // ---- Bubble stagger: randomise start offsets ----
  var bubbles = document.querySelectorAll('.bubble');
  bubbles.forEach(function (b) {
    var delay = (Math.random() * 4).toFixed(2);
    var dur   = (6 + Math.random() * 5).toFixed(2);
    b.style.animationDelay    = delay + 's';
    b.style.animationDuration = dur   + 's';
    b.style.left = (5 + Math.random() * 85).toFixed(1) + '%';
  });
}());
