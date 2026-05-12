/* ============================================================
   Peugeot E-208 GTi – "Velocity Reveal" Ad Controller
   Vanilla JS · No dependencies
   ============================================================ */
(function () {
  'use strict';

  /* ---- DOM refs ---- */
  var ad       = document.getElementById('ad');
  var slides   = [].slice.call(ad.querySelectorAll('.slide'));
  var dots     = [].slice.call(ad.querySelectorAll('.dot'));
  var splBox   = ad.querySelector('.speed-lines');

  /* ---- State ---- */
  var cur        = 0;
  var total      = slides.length;
  var busy       = false;
  var specsDone  = false;
  var autoId     = null;
  var sx = 0, sy = 0;
  var durations  = [3200, 4200, 4800, 5200, 4200];

  /* ---- Init ---- */
  scheduleAuto();

  /* ==== TOUCH ==== */
  ad.addEventListener('touchstart', function (e) {
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });

  ad.addEventListener('touchend', function (e) {
    var dx = sx - e.changedTouches[0].clientX;
    var dy = sy - e.changedTouches[0].clientY;
    attemptSwipe(dx, dy);
    killAuto();
  }, { passive: true });

  /* ==== MOUSE ==== */
  var mdown = false;
  ad.addEventListener('mousedown', function (e) {
    mdown = true; sx = e.clientX; sy = e.clientY;
  });
  ad.addEventListener('mouseup', function (e) {
    if (!mdown) return;
    mdown = false;
    attemptSwipe(sx - e.clientX, sy - e.clientY);
    killAuto();
  });
  ad.addEventListener('dragstart', function (e) { e.preventDefault(); });

  /* ==== DOTS ==== */
  dots.forEach(function (d) {
    d.addEventListener('click', function (e) {
      e.stopPropagation();
      goTo(+this.getAttribute('data-go'));
      killAuto();
    });
  });

  /* ==== SWIPE LOGIC ==== */
  function attemptSwipe(dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax < 25 && ay < 25) return;
    var next;
    if (ay >= ax) { next = dy > 0 ? cur + 1 : cur - 1; }
    else           { next = dx > 0 ? cur + 1 : cur - 1; }
    goTo(next);
  }

  /* ==== SLIDE TRANSITION ==== */
  function goTo(idx) {
    if (busy || idx === cur || idx < 0 || idx >= total) return;
    busy = true;

    var forward = idx > cur;
    if (forward) fireSpeedLines();

    slides[cur].classList.remove('slide--active');
    cur = idx;
    slides[cur].classList.add('slide--active');

    dots.forEach(function (d, i) {
      d.classList.toggle('dot--on', i === cur);
    });

    if (cur === 3 && !specsDone) {
      specsDone = true;
      setTimeout(animateSpecs, 620);
    }

    setTimeout(function () { busy = false; }, 580);
  }

  /* ==== SPEED LINES (transition FX) ==== */
  function fireSpeedLines() {
    var count = 5 + Math.floor(Math.random() * 8);
    for (var i = 0; i < count; i++) createLine(i * 28);
  }

  function createLine(delay) {
    var el = document.createElement('div');
    el.className = 'speed-line';
    var y = Math.random() * 480;
    var w = 30 + Math.random() * 130;
    el.style.cssText = 'top:' + y + 'px;width:' + w + 'px;left:-' + w + 'px';
    splBox.appendChild(el);

    setTimeout(function () {
      el.style.transition = 'transform .32s ease-out, opacity .32s ease-out';
      el.style.opacity = '' + (0.35 + Math.random() * 0.45);
      el.style.transform = 'translateX(' + (340 + w) + 'px)';

      setTimeout(function () {
        el.style.opacity = '0';
        setTimeout(function () {
          if (el.parentNode) el.parentNode.removeChild(el);
        }, 160);
      }, 260);
    }, delay);
  }

  /* ==== SPEC COUNTER ANIMATION ==== */
  function animateSpecs() {
    var els = document.querySelectorAll('.spec-val');
    for (var i = 0; i < els.length; i++) {
      animateOneSpec(els[i]);
    }
  }

  function animateOneSpec(el) {
    var target = parseFloat(el.getAttribute('data-to'));
    var dec    = parseInt(el.getAttribute('data-dec') || '0', 10);
    var dur    = 1250;
    var t0     = performance.now();

    function tick(now) {
      var p = Math.min((now - t0) / dur, 1);
      var e = 1 - Math.pow(1 - p, 3);
      var v = target * e;
      el.textContent = dec > 0
        ? v.toFixed(dec).replace('.', ',')
        : '' + Math.round(v);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  /* ==== AUTO-ADVANCE ==== */
  function scheduleAuto() {
    if (cur >= total - 1) return;
    autoId = setTimeout(function () {
      goTo(cur + 1);
      scheduleAuto();
    }, durations[cur] || 4000);
  }

  function killAuto() {
    if (autoId) { clearTimeout(autoId); autoId = null; }
  }

})();
