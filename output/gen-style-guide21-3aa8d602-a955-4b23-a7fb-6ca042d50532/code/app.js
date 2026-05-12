(function () {
  'use strict';

  /* ============================================
     EMBER PARTICLE SYSTEM
     Rising embers with sinusoidal drift, palette-
     accurate glow colours, and shadow bloom.
     ============================================ */
  var canvas = document.getElementById('emberCanvas');
  var ctx    = canvas.getContext('2d');
  var MAX    = 32;
  var embers = [];
  var palette = ['#F1592A', '#B11116', '#D4AF37', '#8A2B1F', '#B8860B'];

  function createEmber(scattered) {
    return {
      x: Math.random() * 320,
      y: scattered ? Math.random() * 480 : 480 + Math.random() * 30,
      r: Math.random() * 2.2 + 0.4,
      vx: (Math.random() - 0.5) * 0.35,
      vy: -(Math.random() * 0.9 + 0.25),
      life: 1,
      decay: Math.random() * 0.004 + 0.0014,
      color: palette[Math.floor(Math.random() * palette.length)]
    };
  }

  var i;
  for (i = 0; i < MAX; i++) embers.push(createEmber(true));

  function renderEmbers() {
    ctx.clearRect(0, 0, 320, 480);
    var t = Date.now() * 0.001;
    for (var idx = 0; idx < embers.length; idx++) {
      var e = embers[idx];
      e.x += e.vx + Math.sin(e.y * 0.012 + t * 0.8) * 0.22;
      e.y += e.vy;
      e.life -= e.decay;
      if (e.life <= 0 || e.y < -12) {
        embers[idx] = createEmber(false);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = e.life * 0.6;
      ctx.shadowColor = e.color;
      ctx.shadowBlur  = e.r * 5;
      ctx.fillStyle   = e.color;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    requestAnimationFrame(renderEmbers);
  }
  renderEmbers();

  /* ============================================
     PARALLAX
     Mouse / touch movement shifts hero images
     within the 15 px bleed buffer.
     ============================================ */
  var adFrame = document.getElementById('adFrame');
  var allBgs  = document.querySelectorAll('.parallax-bg');

  function applyParallax(nx, ny) {
    for (var j = 0; j < allBgs.length; j++) {
      allBgs[j].style.transform =
        'translate(' + (nx * -10) + 'px,' + (ny * -10) + 'px)';
    }
  }

  adFrame.addEventListener('mousemove', function (ev) {
    var r = adFrame.getBoundingClientRect();
    applyParallax(
      (ev.clientX - r.left) / 320 - 0.5,
      (ev.clientY - r.top)  / 480 - 0.5
    );
  });

  adFrame.addEventListener('mouseleave', function () {
    for (var j = 0; j < allBgs.length; j++) {
      allBgs[j].style.transition = 'transform 0.55s ease-out';
      allBgs[j].style.transform  = 'translate(0,0)';
    }
    setTimeout(function () {
      for (var k = 0; k < allBgs.length; k++) allBgs[k].style.transition = '';
    }, 560);
  });

  adFrame.addEventListener('touchmove', function (ev) {
    if (!ev.touches.length) return;
    var touch = ev.touches[0];
    var r = adFrame.getBoundingClientRect();
    applyParallax(
      (touch.clientX - r.left) / 320 - 0.5,
      (touch.clientY - r.top)  / 480 - 0.5
    );
  }, { passive: true });

  /* ============================================
     INTRO ANIMATION SEQUENCE
     Elements stagger in via data-delay attrs.
     ============================================ */
  var animItems = document.querySelectorAll('.anim-item');
  for (i = 0; i < animItems.length; i++) {
    (function (el) {
      var delay = parseInt(el.getAttribute('data-delay'), 10) || 0;
      setTimeout(function () { el.classList.add('show'); }, delay);
    })(animItems[i]);
  }

  /* ============================================
     SCENE CYCLING
     Auto-advances every 4.2 s; dots & swipe
     allow manual navigation.
     ============================================ */
  var current  = 0;
  var total    = 3;
  var sceneBgs = document.querySelectorAll('.scene-bg');
  var taglines = document.querySelectorAll('.tagline');
  var dots     = document.querySelectorAll('.dot');

  function goScene(idx) {
    for (var s = 0; s < total; s++) {
      var isActive = s === idx;
      sceneBgs[s].classList.toggle('active', isActive);
      taglines[s].classList.toggle('active', isActive);
      dots[s].classList.toggle('active', isActive);
    }
    current = idx;
  }

  for (i = 0; i < dots.length; i++) {
    dots[i].addEventListener('click', (function (idx) {
      return function () { goScene(idx); resetAuto(); };
    })(i));
  }

  var autoTimer = setInterval(function () {
    goScene((current + 1) % total);
  }, 4200);

  function resetAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      goScene((current + 1) % total);
    }, 4200);
  }

  /* ============================================
     SWIPE SUPPORT
     ============================================ */
  var touchStartX = 0;
  adFrame.addEventListener('touchstart', function (ev) {
    touchStartX = ev.touches[0].clientX;
  }, { passive: true });

  adFrame.addEventListener('touchend', function (ev) {
    var dx = ev.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 40) {
      if (dx < 0) goScene((current + 1) % total);
      else goScene((current - 1 + total) % total);
      resetAuto();
    }
  }, { passive: true });

  /* ============================================
     CTA INTERACTIONS
     Hover burst spawns extra embers near the
     button; pulse restarts on mouse leave.
     ============================================ */
  var ctaBtn = document.getElementById('ctaBtn');

  setTimeout(function () { ctaBtn.classList.add('pulse'); }, 2400);

  ctaBtn.addEventListener('mouseenter', function () {
    ctaBtn.classList.remove('pulse');
    for (var b = 0; b < 14; b++) {
      var e   = createEmber(false);
      e.x     = 90  + Math.random() * 140;
      e.y     = 410 + Math.random() * 20;
      e.vy    = -(Math.random() * 2.5 + 0.8);
      e.vx    = (Math.random() - 0.5) * 2.2;
      e.r     = Math.random() * 2.5 + 0.8;
      embers.push(e);
    }
    setTimeout(function () {
      while (embers.length > MAX) embers.shift();
    }, 2200);
  });

  ctaBtn.addEventListener('mouseleave', function () {
    ctaBtn.classList.add('pulse');
  });

  /* ============================================
     PRODUCT STRIP HOVER
     ============================================ */
  var strip = document.querySelector('.product-strip');
  if (strip) {
    strip.addEventListener('mouseenter', function () {
      for (var p = 0; p < 6; p++) {
        var e = createEmber(false);
        e.x   = 60  + Math.random() * 200;
        e.y   = 350 + Math.random() * 10;
        e.vy  = -(Math.random() * 1.5 + 0.5);
        e.r   = Math.random() * 1.5 + 0.5;
        embers.push(e);
      }
      setTimeout(function () {
        while (embers.length > MAX) embers.shift();
      }, 1800);
    });
  }

})();