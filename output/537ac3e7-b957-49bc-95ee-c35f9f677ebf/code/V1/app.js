(function () {
  'use strict';

  /* ===========================================================
     320x480 — CONFETTI PARTICLE SYSTEM
     Animated confetti pieces float down the festival-ticket ad.
     Only uses palette hex colours.
     =========================================================== */
  function initConfetti() {
    var canvas = document.querySelector('#ad-320x480 .confetti-canvas');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = 320;
    var H = 480;
    var colors = ['#F39200', '#FFD500', '#009FE3', '#E30613', '#00A551', '#FFFFFF'];
    var particles = [];
    var i;

    for (i = 0; i < 35; i++) {
      particles.push({
        x: Math.random() * W,
        y: Math.random() * H,
        w: Math.random() * 5 + 2,
        h: Math.random() * 3 + 1.5,
        vx: (Math.random() - 0.5) * 0.6,
        vy: Math.random() * 0.7 + 0.25,
        color: colors[Math.floor(Math.random() * colors.length)],
        rot: Math.random() * 360,
        rv: (Math.random() - 0.5) * 5,
        alpha: Math.random() * 0.4 + 0.4
      });
    }

    function tick() {
      ctx.clearRect(0, 0, W, H);
      for (var j = 0; j < particles.length; j++) {
        var p = particles[j];
        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot * Math.PI / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rv;
        if (p.y > H + 12) { p.y = -12; p.x = Math.random() * W; }
        if (p.x > W + 12) p.x = -12;
        if (p.x < -12) p.x = W + 12;
      }
      requestAnimationFrame(tick);
    }
    tick();
  }

  /* ===========================================================
     300x250 — IMAGE CAROUSEL
     Auto-crossfade between two attraction images every 3.5 s.
     Dot navigation is also clickable.
     =========================================================== */
  function initCarousel() {
    var frame = document.getElementById('ad-300x250');
    if (!frame) return;
    var slides = frame.querySelectorAll('.carousel-slide');
    var dots = frame.querySelectorAll('.dot');
    var current = 0;

    function goTo(idx) {
      slides[current].classList.remove('active');
      dots[current].classList.remove('active');
      current = idx % slides.length;
      slides[current].classList.add('active');
      dots[current].classList.add('active');
    }

    for (var d = 0; d < dots.length; d++) {
      (function (index) {
        dots[index].addEventListener('click', function () {
          goTo(index);
        });
      })(d);
    }

    setInterval(function () {
      goTo(current + 1);
    }, 3500);
  }

  /* ===========================================================
     336x280 — FLIP CARD
     Click anywhere except the CTA button to flip between
     the hero image front and the offer details back.
     =========================================================== */
  function initFlip() {
    var container = document.querySelector('[data-flip]');
    if (!container) return;
    container.addEventListener('click', function (e) {
      if (e.target.tagName === 'BUTTON') return;
      container.classList.toggle('flipped');
    });
  }

  /* ===========================================================
     970x250 — PARALLAX
     Mouse-tracking parallax shifts left image, right image
     and centre content at different depths.
     =========================================================== */
  function initParallax() {
    var frame = document.querySelector('[data-parallax]');
    if (!frame) return;
    var layers = frame.querySelectorAll('[data-depth]');

    frame.addEventListener('mousemove', function (e) {
      var rect = frame.getBoundingClientRect();
      var nx = (e.clientX - rect.left - rect.width / 2) / rect.width;
      var ny = (e.clientY - rect.top - rect.height / 2) / rect.height;

      for (var i = 0; i < layers.length; i++) {
        var depth = parseFloat(layers[i].getAttribute('data-depth'));
        var mx = nx * depth * 200;
        var my = ny * depth * 100;
        if (layers[i].classList.contains('pano-center')) {
          layers[i].style.transform =
            'translate(calc(-50% + ' + mx + 'px), calc(-50% + ' + my + 'px))';
        } else {
          layers[i].style.transform = 'translate(' + mx + 'px, ' + my + 'px)';
        }
      }
    });

    frame.addEventListener('mouseleave', function () {
      for (var i = 0; i < layers.length; i++) {
        if (layers[i].classList.contains('pano-center')) {
          layers[i].style.transform = 'translate(-50%, -50%)';
        } else {
          layers[i].style.transform = 'translate(0, 0)';
        }
      }
    });
  }

  /* ===========================================================
     160x600 — DROP TOWER
     Staggered gravity-drop entrance: each element falls into
     place with a bouncy ease when the ad enters the viewport.
     =========================================================== */
  function initDropTower() {
    var items = document.querySelectorAll('.tower-drop');
    if (!items.length) return;
    var triggered = false;

    function dropAll() {
      if (triggered) return;
      triggered = true;
      for (var i = 0; i < items.length; i++) {
        (function (el, delay) {
          setTimeout(function () {
            el.classList.add('dropped');
          }, delay);
        })(items[i], 250 + i * 160);
      }
    }

    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          dropAll();
          obs.disconnect();
        }
      }, { threshold: 0.2 });
      obs.observe(document.getElementById('ad-160x600'));
    } else {
      dropAll();
    }
  }

  /* ===========================================================
     320x50 — TEXT ROTATOR
     Cycles through four short messages with slide-up transition
     every 2.5 seconds.
     =========================================================== */
  function initRotator() {
    var rotator = document.querySelector('[data-rotator]');
    if (!rotator) return;
    var texts = rotator.querySelectorAll('.mini-text');
    var current = 0;

    setInterval(function () {
      texts[current].classList.remove('active');
      current = (current + 1) % texts.length;
      texts[current].classList.add('active');
    }, 2500);
  }

  /* ===========================================================
     GLOBAL — CTA CLICK HANDLER
     Any element with data-href opens the target URL.
     =========================================================== */
  function initCTAs() {
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-href]');
      if (btn) {
        window.open(btn.getAttribute('data-href'), '_blank');
      }
    });
  }

  /* ===========================================================
     GLOBAL — ENTRANCE FADE
     Each ad-wrapper fades and slides up when it enters view.
     =========================================================== */
  function initEntranceAnimations() {
    var wrappers = document.querySelectorAll('.ad-wrapper');
    var i;
    for (i = 0; i < wrappers.length; i++) {
      wrappers[i].style.opacity = '0';
      wrappers[i].style.transform = 'translateY(30px)';
      wrappers[i].style.transition = 'opacity 0.6s ease-out, transform 0.6s ease-out';
    }

    function reveal(entries) {
      for (var j = 0; j < entries.length; j++) {
        if (entries[j].isIntersecting) {
          entries[j].target.style.opacity = '1';
          entries[j].target.style.transform = 'translateY(0)';
        }
      }
    }

    if ('IntersectionObserver' in window) {
      var obs = new IntersectionObserver(reveal, { threshold: 0.1 });
      for (i = 0; i < wrappers.length; i++) {
        obs.observe(wrappers[i]);
      }
    } else {
      for (i = 0; i < wrappers.length; i++) {
        wrappers[i].style.opacity = '1';
        wrappers[i].style.transform = 'translateY(0)';
      }
    }
  }

  /* ===========================================================
     BOOT
     =========================================================== */
  initEntranceAnimations();
  initConfetti();
  initCarousel();
  initFlip();
  initParallax();
  initDropTower();
  initRotator();
  initCTAs();
})();
