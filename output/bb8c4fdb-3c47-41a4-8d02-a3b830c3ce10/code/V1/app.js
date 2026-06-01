(function () {
  'use strict';

  /* ========== Configuration ========== */
  var AD_W = 320;
  var AD_H = 480;
  var REVEAL_THRESHOLD = 0.32;
  var SCRATCH_RADIUS = 24;
  var AUTO_REVEAL_MS = 10000;

  /* ========== DOM ========== */
  var adFrame = document.getElementById('adFrame');
  var scratchCanvas = document.getElementById('scratchCanvas');
  var sCtx = scratchCanvas.getContext('2d');
  var particleCanvas = document.getElementById('particleCanvas');
  var pCtx = particleCanvas.getContext('2d');
  var scratchUI = document.getElementById('scratchUI');

  var adHeader = document.getElementById('adHeader');
  var adHero = document.getElementById('adHero');
  var adCopy = document.getElementById('adCopy');
  var adFooter = document.getElementById('adFooter');
  var goldDivider = document.getElementById('goldDivider');
  var productImage = document.getElementById('productImage');
  var nanoCount = document.getElementById('nanoCount');
  var ctaButton = document.getElementById('ctaButton');
  var ctaShimmer = document.querySelector('.cta-shimmer');

  /* ========== State ========== */
  var isRevealed = false;
  var isScratching = false;
  var hasScratched = false;
  var lastPos = null;
  var reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ========== Canvas DPR Setup ========== */
  var dpr = Math.min(window.devicePixelRatio || 1, 2);

  function setupCanvas(canvas, ctx) {
    canvas.width = AD_W * dpr;
    canvas.height = AD_H * dpr;
    canvas.style.width = AD_W + 'px';
    canvas.style.height = AD_H + 'px';
    ctx.scale(dpr, dpr);
  }

  setupCanvas(scratchCanvas, sCtx);
  setupCanvas(particleCanvas, pCtx);

  /* ========== Draw Gold Scratch Surface ========== */
  function drawGoldSurface() {
    var ctx = sCtx;

    /* Base gold fill */
    ctx.fillStyle = '#C9A66B';
    ctx.fillRect(0, 0, AD_W, AD_H);

    /* Depth gradient overlay */
    var grd = ctx.createLinearGradient(0, 0, 0, AD_H);
    grd.addColorStop(0, 'rgba(212, 185, 140, 0.30)');
    grd.addColorStop(0.45, 'rgba(139, 106, 63, 0.08)');
    grd.addColorStop(1, 'rgba(212, 185, 140, 0.25)');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, AD_W, AD_H);

    /* Brushed texture */
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.025)';
    ctx.lineWidth = 0.5;
    for (var y = 0; y < AD_H; y += 3) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(AD_W, y);
      ctx.stroke();
    }

    /* Inner decorative double border */
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(15, 15, AD_W - 30, AD_H - 30);
    ctx.strokeRect(19, 19, AD_W - 38, AD_H - 38);

    /* Diamond ornament at top */
    ctx.save();
    ctx.translate(AD_W / 2, 48);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(-5, -5, 10, 10);
    ctx.restore();

    /* LANCÔME brand name */
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '400 26px "Baskerville Old Face", serif';
    ctx.fillText('LANC\u00D4ME', AD_W / 2, 96);

    /* PARIS subtitle */
    ctx.font = '600 9px "Agatho Regular Caps", sans-serif';
    ctx.fillText('P A R I S', AD_W / 2, 118);

    /* Decorative line */
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.30)';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(AD_W / 2 - 28, 132);
    ctx.lineTo(AD_W / 2 + 28, 132);
    ctx.stroke();

    /* Rose emblem */
    drawRoseEmblem(ctx, AD_W / 2, AD_H / 2 - 24, 38);

    /* Product name teaser */
    ctx.fillStyle = 'rgba(255, 255, 255, 0.70)';
    ctx.font = 'italic 400 14px "Didot", serif';
    ctx.fillText('R\u00E9nergie', AD_W / 2, AD_H / 2 + 46);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.font = '500 9px "Futura", sans-serif';
    ctx.fillText('NANO-RESURFACER \u00B7 400 BOOSTER', AD_W / 2, AD_H / 2 + 66);
  }

  function drawRoseEmblem(ctx, cx, cy, size) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
    ctx.lineWidth = 0.7;

    var petals = 5;
    for (var i = 0; i < petals; i++) {
      var angle = (i / petals) * Math.PI * 2;
      ctx.save();
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.ellipse(0, -size * 0.22, size * 0.13, size * 0.38, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.beginPath();
    ctx.arc(0, 0, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.20)';
    ctx.fill();

    ctx.restore();
  }

  /* ========== Scratch Interaction ========== */
  function getPos(e) {
    var rect = scratchCanvas.getBoundingClientRect();
    var sx = AD_W / rect.width;
    var sy = AD_H / rect.height;
    if (e.touches && e.touches.length) {
      return { x: (e.touches[0].clientX - rect.left) * sx, y: (e.touches[0].clientY - rect.top) * sy };
    }
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
  }

  function doScratch(pos) {
    if (isRevealed) return;
    hasScratched = true;

    sCtx.save();
    sCtx.globalCompositeOperation = 'destination-out';

    if (lastPos) {
      sCtx.lineWidth = SCRATCH_RADIUS * 2;
      sCtx.lineCap = 'round';
      sCtx.lineJoin = 'round';
      sCtx.strokeStyle = 'rgba(0,0,0,1)';
      sCtx.beginPath();
      sCtx.moveTo(lastPos.x, lastPos.y);
      sCtx.lineTo(pos.x, pos.y);
      sCtx.stroke();
    }

    sCtx.beginPath();
    sCtx.arc(pos.x, pos.y, SCRATCH_RADIUS, 0, Math.PI * 2);
    sCtx.fill();

    sCtx.restore();

    lastPos = { x: pos.x, y: pos.y };

    if (Math.random() > 0.4) {
      addParticle(pos.x, pos.y, 'burst');
    }

    if (Math.random() > 0.65) {
      checkThreshold();
    }
  }

  function checkThreshold() {
    if (isRevealed) return;
    var imgData = sCtx.getImageData(0, 0, scratchCanvas.width, scratchCanvas.height);
    var px = imgData.data;
    var transparent = 0;
    var step = 48;
    var sampled = 0;
    for (var i = 3; i < px.length; i += step) {
      sampled++;
      if (px[i] < 128) transparent++;
    }
    if (sampled > 0 && (transparent / sampled) > REVEAL_THRESHOLD) {
      triggerReveal();
    }
  }

  /* ========== Reveal ========== */
  function triggerReveal() {
    if (isRevealed) return;
    isRevealed = true;

    scratchCanvas.style.transition = 'opacity 0.75s ease-out';
    scratchCanvas.style.opacity = '0';
    scratchUI.style.transition = 'opacity 0.75s ease-out';
    scratchUI.style.opacity = '0';

    for (var i = 0; i < 35; i++) {
      addParticle(Math.random() * AD_W, Math.random() * AD_H, 'celebration');
    }

    setTimeout(function () {
      scratchCanvas.style.display = 'none';
      scratchUI.style.display = 'none';
    }, 800);

    setTimeout(function () { adHeader.classList.add('revealed'); }, 350);
    setTimeout(function () { goldDivider.classList.add('active'); }, 750);
    setTimeout(function () { adHero.classList.add('revealed'); }, 550);
    setTimeout(function () {
      adCopy.classList.add('revealed');
      animateCounter();
    }, 850);
    setTimeout(function () {
      adFooter.classList.add('revealed');
    }, 1150);
    setTimeout(function () {
      productImage.classList.add('breathing');
      ctaShimmer.classList.add('animate');
    }, 1800);
  }

  /* ========== Counter Animation ========== */
  function animateCounter() {
    var target = 484;
    var duration = 1300;
    var start = performance.now();

    function tick(now) {
      var elapsed = now - start;
      var t = Math.min(elapsed / duration, 1);
      var eased = 1 - Math.pow(1 - t, 3);
      nanoCount.textContent = Math.round(target * eased);
      if (t < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ========== Particle System ========== */
  var particles = [];

  function addParticle(x, y, type) {
    var colors = ['#C9A66B', '#D4B98C', '#E8C7C0', '#8B6A3F'];
    var isCeleb = type === 'celebration';
    particles.push({
      x: x,
      y: y,
      vx: (Math.random() - 0.5) * (isCeleb ? 5 : 2.5),
      vy: isCeleb ? (Math.random() - 0.5) * 5 : -(Math.random() * 2.2 + 0.6),
      size: isCeleb ? Math.random() * 4 + 1.5 : Math.random() * 2.5 + 0.8,
      opacity: 1,
      life: isCeleb ? 75 : 45,
      maxLife: isCeleb ? 75 : 45,
      color: colors[Math.floor(Math.random() * colors.length)],
      gravity: isCeleb ? 0.06 : 0.025
    });
  }

  function tickParticles() {
    pCtx.clearRect(0, 0, AD_W, AD_H);

    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += p.gravity;
      p.life--;
      p.opacity = Math.max(0, p.life / p.maxLife);

      if (p.life <= 0) {
        particles.splice(i, 1);
        continue;
      }

      pCtx.globalAlpha = p.opacity;
      pCtx.fillStyle = p.color;
      pCtx.beginPath();
      pCtx.arc(p.x, p.y, p.size * p.opacity, 0, Math.PI * 2);
      pCtx.fill();
    }

    pCtx.globalAlpha = 1;
    requestAnimationFrame(tickParticles);
  }

  /* ========== Event Listeners ========== */
  scratchCanvas.addEventListener('mousedown', function (e) {
    isScratching = true;
    lastPos = null;
    doScratch(getPos(e));
  });
  scratchCanvas.addEventListener('mousemove', function (e) {
    if (isScratching) doScratch(getPos(e));
  });
  scratchCanvas.addEventListener('mouseup', function () {
    isScratching = false;
    lastPos = null;
  });
  scratchCanvas.addEventListener('mouseleave', function () {
    isScratching = false;
    lastPos = null;
  });

  scratchCanvas.addEventListener('touchstart', function (e) {
    e.preventDefault();
    isScratching = true;
    lastPos = null;
    doScratch(getPos(e));
  }, { passive: false });
  scratchCanvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    if (isScratching) doScratch(getPos(e));
  }, { passive: false });
  scratchCanvas.addEventListener('touchend', function () {
    isScratching = false;
    lastPos = null;
  });
  scratchCanvas.addEventListener('touchcancel', function () {
    isScratching = false;
    lastPos = null;
  });

  ctaButton.addEventListener('click', function () {
    var rect = ctaButton.getBoundingClientRect();
    var adRect = adFrame.getBoundingClientRect();
    var cx = (rect.left + rect.width / 2) - adRect.left;
    var cy = (rect.top + rect.height / 2) - adRect.top;
    for (var j = 0; j < 18; j++) {
      addParticle(cx, cy, 'celebration');
    }
  });

  /* ========== Auto-reveal Fallback ========== */
  setTimeout(function () {
    if (!isRevealed) triggerReveal();
  }, AUTO_REVEAL_MS);

  /* ========== Reduced Motion ========== */
  if (reducedMotion) {
    scratchCanvas.style.display = 'none';
    scratchUI.style.display = 'none';
    isRevealed = true;

    adHeader.style.opacity = '1';
    adHeader.style.transform = 'none';
    adHero.style.opacity = '1';
    adHero.style.transform = 'none';
    adCopy.style.opacity = '1';
    adCopy.style.transform = 'none';
    adFooter.style.opacity = '1';
    adFooter.style.transform = 'none';
    goldDivider.classList.add('active');
    ctaShimmer.classList.add('animate');
  }

  /* ========== Init ========== */
  if (!reducedMotion) {
    drawGoldSurface();
  }
  tickParticles();

})();