/**
 * celio* x McLaren Racing — 320×480 Ad Creative
 * Vanilla JS · version switching · V2 counter · V3 carousel · V4 3D tilt
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {

    /* ------------------------------------------------------------------ */
    /*  REFERENCES                                                         */
    /* ------------------------------------------------------------------ */
    var versions = document.querySelectorAll('.ad-v');
    var buttons  = document.querySelectorAll('.fmt-btn');
    var current  = 1;
    var v2Timer      = null;
    var v3Auto       = null;
    var v3Idx        = 0;
    var v4Bound      = false;
    var TOTAL_SLIDES = 4;

    /* ------------------------------------------------------------------ */
    /*  VERSION SWITCHING                                                   */
    /* ------------------------------------------------------------------ */
    function switchTo(num) {
      if (num === current) return;
      teardown(current);
      current = num;

      versions.forEach(function (v) { v.classList.remove('active', 'ready'); });
      buttons.forEach(function (b) {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      });

      var el = document.getElementById('v' + num);
      el.classList.add('active');
      buttons[num - 1].classList.add('active');
      buttons[num - 1].setAttribute('aria-pressed', 'true');

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          el.classList.add('ready');
          setup(num);
        });
      });
    }

    function teardown(n) {
      if (n === 2 && v2Timer) { clearInterval(v2Timer); v2Timer = null; }
      if (n === 3 && v3Auto)  { clearInterval(v3Auto);  v3Auto  = null; }
    }

    function setup(n) {
      if (n === 2) runCounter();
      if (n === 3) runCarousel();
      if (n === 4) bindTilt();
    }

    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        switchTo(parseInt(b.getAttribute('data-v'), 10));
      });
    });

    /* ------------------------------------------------------------------ */
    /*  V2 — POSITION COUNTER  (20 → 1)                                    */
    /* ------------------------------------------------------------------ */
    function runCounter() {
      var el  = document.getElementById('v2Counter');
      var n   = 20;
      el.textContent    = n;
      el.style.transform = 'scale(1)';

      v2Timer = setInterval(function () {
        n--;
        el.textContent = n;
        if (n <= 1) {
          clearInterval(v2Timer);
          v2Timer = null;
          el.textContent = '1';
          el.style.transform = 'scale(1.25)';
          setTimeout(function () { el.style.transform = 'scale(1)'; }, 250);
          var cta = document.querySelector('#v2 .cta-outline');
          if (cta) cta.style.animation = 'pulseGlow 1.4s ease-in-out 3';
        }
      }, 95);
    }

    /* ------------------------------------------------------------------ */
    /*  V3 — SWIPEABLE CAROUSEL                                            */
    /* ------------------------------------------------------------------ */
    var track  = document.getElementById('v3Track');
    var dots   = document.querySelectorAll('.v3-dot');
    var numEl  = document.getElementById('v3Num');

    function goTo(i) {
      v3Idx = Math.max(0, Math.min(i, TOTAL_SLIDES - 1));
      track.style.transform = 'translateX(-' + (v3Idx * 100) + '%)';
      dots.forEach(function (d, j) { d.classList.toggle('active', j === v3Idx); });
      numEl.textContent = String(v3Idx + 1).padStart(2, '0');
    }

    function runCarousel() {
      v3Idx = 0;
      goTo(0);
      v3Auto = setInterval(function () { goTo((v3Idx + 1) % TOTAL_SLIDES); }, 3200);
    }

    function resetAuto() {
      if (v3Auto) clearInterval(v3Auto);
      v3Auto = setInterval(function () { goTo((v3Idx + 1) % TOTAL_SLIDES); }, 3200);
    }

    /* dot clicks */
    dots.forEach(function (d) {
      d.addEventListener('click', function () {
        goTo(parseInt(d.getAttribute('data-idx'), 10));
        resetAuto();
      });
    });

    /* touch swipe */
    var tx0 = 0, tt0 = 0;
    track.addEventListener('touchstart', function (e) {
      tx0 = e.touches[0].clientX; tt0 = Date.now();
      if (v3Auto) clearInterval(v3Auto);
    }, { passive: true });

    track.addEventListener('touchend', function (e) {
      var dx = tx0 - e.changedTouches[0].clientX;
      if (Math.abs(dx) > 30 && Date.now() - tt0 < 600) {
        if (dx > 0 && v3Idx < TOTAL_SLIDES - 1) goTo(v3Idx + 1);
        else if (dx < 0 && v3Idx > 0) goTo(v3Idx - 1);
      }
      resetAuto();
    }, { passive: true });

    /* mouse drag */
    var mDown = false, mx0 = 0;
    track.addEventListener('mousedown', function (e) {
      mDown = true; mx0 = e.clientX;
      if (v3Auto) clearInterval(v3Auto);
    });
    track.addEventListener('mouseup', function (e) {
      if (!mDown) return; mDown = false;
      var dx = mx0 - e.clientX;
      if (Math.abs(dx) > 30) {
        if (dx > 0 && v3Idx < TOTAL_SLIDES - 1) goTo(v3Idx + 1);
        else if (dx < 0 && v3Idx > 0) goTo(v3Idx - 1);
      }
      resetAuto();
    });
    track.addEventListener('mouseleave', function () {
      if (mDown) { mDown = false; resetAuto(); }
    });

    /* ------------------------------------------------------------------ */
    /*  V4 — 3-D TILT                                                      */
    /* ------------------------------------------------------------------ */
    function bindTilt() {
      if (v4Bound) return;
      v4Bound = true;
      var card = document.getElementById('v4Tilt');

      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width  - 0.5;
        var y = (e.clientY - r.top)  / r.height - 0.5;
        card.style.transform =
          'perspective(600px) rotateY(' + (x * 14) + 'deg) rotateX(' + (-y * 14) + 'deg) scale(1.03)';
      });

      card.addEventListener('mouseleave', function () {
        card.style.transition = 'transform .45s ease-out';
        card.style.transform  = 'perspective(600px) rotateY(0) rotateX(0) scale(1)';
        setTimeout(function () { card.style.transition = 'transform .12s ease-out'; }, 460);
      });

      card.addEventListener('touchmove', function (e) {
        var t = e.touches[0], r = card.getBoundingClientRect();
        var x = (t.clientX - r.left) / r.width  - 0.5;
        var y = (t.clientY - r.top)  / r.height - 0.5;
        card.style.transform =
          'perspective(600px) rotateY(' + (x * 14) + 'deg) rotateX(' + (-y * 14) + 'deg) scale(1.03)';
      }, { passive: true });

      card.addEventListener('touchend', function () {
        card.style.transition = 'transform .45s ease-out';
        card.style.transform  = 'perspective(600px) rotateY(0) rotateX(0) scale(1)';
        setTimeout(function () { card.style.transition = 'transform .12s ease-out'; }, 460);
      });
    }

    /* ------------------------------------------------------------------ */
    /*  KEYBOARD NAV                                                        */
    /* ------------------------------------------------------------------ */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault(); switchTo(current < 4 ? current + 1 : 1);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault(); switchTo(current > 1 ? current - 1 : 4);
      }
    });

    /* ------------------------------------------------------------------ */
    /*  BOOT V1                                                             */
    /* ------------------------------------------------------------------ */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.getElementById('v1').classList.add('ready');
      });
    });
  });
})();
