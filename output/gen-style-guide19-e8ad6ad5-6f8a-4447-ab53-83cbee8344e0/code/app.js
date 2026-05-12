(function () {
  'use strict';

  /* ──────────────────────────────────────────────
     CAROUSEL — auto-rotating hero images
     with touch-swipe and dot navigation
     ────────────────────────────────────────────── */
  var imgs  = document.querySelectorAll('.ad__hero-img');
  var dots  = document.querySelectorAll('.ad__dot');
  var hero  = document.getElementById('hero');
  var cur   = 0;
  var total = imgs.length;
  var timer;

  function go(i) {
    imgs[cur].classList.remove('is-active');
    dots[cur].classList.remove('is-active');
    cur = ((i % total) + total) % total;
    imgs[cur].classList.add('is-active');
    dots[cur].classList.add('is-active');
  }

  function startAuto() {
    timer = setInterval(function () { go(cur + 1); }, 3800);
  }

  function resetAuto() {
    clearInterval(timer);
    startAuto();
  }

  /* Dot click navigation */
  dots.forEach(function (d) {
    d.addEventListener('click', function () {
      go(+this.dataset.i);
      resetAuto();
    });
  });

  /* Touch swipe on hero */
  var x0 = 0;
  hero.addEventListener('touchstart', function (e) {
    x0 = e.touches[0].clientX;
  }, { passive: true });

  hero.addEventListener('touchend', function (e) {
    var dx = x0 - e.changedTouches[0].clientX;
    if (Math.abs(dx) > 35) {
      go(dx > 0 ? cur + 1 : cur - 1);
      resetAuto();
    }
  }, { passive: true });

  startAuto();

  /* ──────────────────────────────────────────────
     3-D TILT — parallax card effect on mousemove
     ────────────────────────────────────────────── */
  var ad    = document.getElementById('ad');
  var inner = document.getElementById('adInner');

  ad.addEventListener('mousemove', function (e) {
    var r  = ad.getBoundingClientRect();
    var nx = (e.clientX - r.left) / r.width  - 0.5;
    var ny = (e.clientY - r.top)  / r.height - 0.5;
    inner.style.transform =
      'rotateY(' + (nx * 5).toFixed(2) + 'deg) rotateX(' + (-ny * 5).toFixed(2) + 'deg)';
  });

  ad.addEventListener('mouseleave', function () {
    inner.style.transform = 'rotateY(0deg) rotateX(0deg)';
  });

  /* ──────────────────────────────────────────────
     CTA — ripple click feedback
     ────────────────────────────────────────────── */
  var cta = document.getElementById('cta');

  cta.addEventListener('click', function (e) {
    var rect = cta.getBoundingClientRect();
    var rip  = document.createElement('span');
    rip.className = 'ripple';
    var sz = Math.max(rect.width, rect.height) * 2;
    rip.style.width  = sz + 'px';
    rip.style.height = sz + 'px';
    rip.style.left   = (e.clientX - rect.left - sz / 2) + 'px';
    rip.style.top    = (e.clientY - rect.top  - sz / 2) + 'px';
    cta.appendChild(rip);
    rip.addEventListener('animationend', function () { rip.remove(); });
  });

  /* Delayed CTA pulse to attract attention */
  setTimeout(function () {
    cta.style.animation = 'anim-pulse 2s ease-in-out infinite';
  }, 3000);

  /* ──────────────────────────────────────────────
     OFFER BADGE — hover glow micro-interaction
     ────────────────────────────────────────────── */
  var offer = document.getElementById('offer');

  offer.addEventListener('mouseenter', function () {
    offer.style.borderColor = '#FFFFFF';
    offer.style.boxShadow   = '0 0 24px rgba(255, 213, 0, 0.3)';
  });

  offer.addEventListener('mouseleave', function () {
    offer.style.borderColor = '#FFD500';
    offer.style.boxShadow   = 'none';
  });

})();
