/* =====================================================
   RITUALS — Fête des Mères 2026
   Interactions vanilla pour les 4 formats publicitaires.
   Couleurs limitées à la palette du style guide :
   #1A1919 #242222 #EFEDEA #B58C6E #796F63
   #F4C7D0 #E8A6B3 #D4A574 #8B5A3C #F7F3EE
   ===================================================== */

(function () {
  'use strict';

  // ---------- AD 1 — Pluie de pétales ----------
  function initPetalsAd1() {
    var stage = document.getElementById('a1-petals');
    if (!stage) return;
    var count = 22;
    for (var i = 0; i < count; i++) {
      var p = document.createElement('span');
      p.className = 'petal';
      p.style.left = (Math.random() * 100) + '%';
      var dur = 6 + Math.random() * 6;
      p.style.animationDuration = dur.toFixed(2) + 's';
      p.style.animationDelay = (-Math.random() * dur).toFixed(2) + 's';
      var scale = 0.5 + Math.random() * 0.9;
      var drift = Math.round(Math.random() * 80 - 40) + 'px';
      p.style.setProperty('--drift', drift);
      p.style.transform = 'scale(' + scale.toFixed(2) + ')';
      // Variations tonales (uniquement des couleurs de la palette)
      var r = Math.random();
      if (r < 0.18) {
        p.style.background = 'radial-gradient(ellipse at 30% 30%, #F7F3EE 0%, #D4A574 55%, #B58C6E 100%)';
      } else if (r < 0.30) {
        p.style.background = 'radial-gradient(ellipse at 30% 30%, #F7F3EE 0%, #F4C7D0 45%, #E8A6B3 80%, #8B5A3C 100%)';
      }
      stage.appendChild(p);
    }
  }

  // ---------- AD 2 — Coffret révélation ----------
  function initGiftBoxAd2() {
    var ad = document.querySelector('.ad-2');
    var box = document.getElementById('a2-box');
    var confetti = document.getElementById('a2-confetti');
    var sparks = document.getElementById('a2-sparks');
    if (!ad || !box) return;

    // Pré-création des pétales du burst (une seule fois)
    if (confetti) {
      var N = 20;
      for (var i = 0; i < N; i++) {
        var p = document.createElement('span');
        p.className = 'petal-burst';
        var angle = (Math.PI * 2 * i) / N + (Math.random() * 0.5 - 0.25);
        var dist = 80 + Math.random() * 80;
        p.style.setProperty('--bx', Math.round(Math.cos(angle) * dist) + 'px');
        p.style.setProperty('--by', Math.round(Math.sin(angle) * dist - 30) + 'px');
        p.style.setProperty('--br', Math.round(Math.random() * 720 - 360) + 'deg');
        p.style.animationDelay = (Math.random() * 0.15).toFixed(2) + 's';
        confetti.appendChild(p);
      }
    }

    // Étincelles d'arrière-plan
    if (sparks) {
      var paletteSparks = ['#F4C7D0', '#D4A574'];
      for (var j = 0; j < 26; j++) {
        var s = document.createElement('span');
        s.className = 'spark';
        s.style.left = (Math.random() * 100) + '%';
        s.style.top = (Math.random() * 100) + '%';
        s.style.setProperty('--dur', (2 + Math.random() * 4).toFixed(2) + 's');
        s.style.animationDelay = (-Math.random() * 4).toFixed(2) + 's';
        var c = paletteSparks[Math.random() < 0.4 ? 0 : 1];
        s.style.background = c;
        s.style.boxShadow = '0 0 8px ' + c;
        sparks.appendChild(s);
      }
    }

    function replayBurst() {
      if (!confetti) return;
      var items = confetti.querySelectorAll('.petal-burst');
      items.forEach(function (el) {
        el.style.animation = 'none';
        void el.offsetWidth; // force reflow
        el.style.animation = '';
      });
    }

    box.addEventListener('click', function () {
      var willOpen = !ad.classList.contains('is-open');
      ad.classList.toggle('is-open', willOpen);
      box.setAttribute('aria-expanded', String(willOpen));
      box.setAttribute('aria-label', willOpen ? 'Refermer le coffret' : 'Ouvrir le coffret');
      if (willOpen) replayBurst();
    });
  }

  // ---------- AD 3 — Sélecteur de rituels ----------
  function initRitualsAd3() {
    var ad = document.querySelector('.ad-3');
    if (!ad) return;
    var tabs = Array.prototype.slice.call(ad.querySelectorAll('.a3-tab'));
    var panels = Array.prototype.slice.call(ad.querySelectorAll('.a3-panel'));
    var ids = tabs.map(function (t) { return t.dataset.ritual; });
    var idx = ids.indexOf(ad.dataset.active || 'sakura');
    var timer = null;

    function activate(targetIdx) {
      idx = (targetIdx + ids.length) % ids.length;
      var id = ids[idx];
      ad.dataset.active = id;
      tabs.forEach(function (t, i) {
        t.classList.toggle('is-active', i === idx);
        t.setAttribute('aria-selected', i === idx ? 'true' : 'false');
      });
      panels.forEach(function (p) {
        p.classList.toggle('is-active', p.dataset.ritual === id);
      });
    }

    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { activate(i); restart(); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowRight') { activate(idx + 1); restart(); }
        if (e.key === 'ArrowLeft')  { activate(idx - 1); restart(); }
      });
    });

    function tick() { activate(idx + 1); }
    function start() { stop(); timer = setInterval(tick, 5200); }
    function stop()  { if (timer) { clearInterval(timer); timer = null; } }
    function restart() { start(); }

    ad.addEventListener('mouseenter', stop);
    ad.addEventListener('mouseleave', start);
    ad.addEventListener('focusin', stop);
    ad.addEventListener('focusout', start);

    setTimeout(start, 1200);
  }

  // ---------- AD 4 — Lettre & message qui défile ----------
  function initLetterAd4() {
    var ad = document.querySelector('.ad-4');
    if (!ad) return;
    var msgs = Array.prototype.slice.call(ad.querySelectorAll('.a4-msg'));
    if (msgs.length) {
      var i = 0;
      setInterval(function () {
        msgs[i].classList.remove('is-active');
        i = (i + 1) % msgs.length;
        msgs[i].classList.add('is-active');
      }, 3800);
    }

    // Pétales décoratives, plus rares, plus lentes
    var petals = document.getElementById('a4-petals');
    if (petals) {
      for (var k = 0; k < 12; k++) {
        var p = document.createElement('span');
        p.className = 'petal';
        p.style.left = (Math.random() * 100) + '%';
        var dur = 9 + Math.random() * 8;
        p.style.animationDuration = dur.toFixed(2) + 's';
        p.style.animationDelay = (-Math.random() * dur).toFixed(2) + 's';
        p.style.transform = 'scale(' + (0.4 + Math.random() * 0.6).toFixed(2) + ')';
        p.style.setProperty('--drift', Math.round(Math.random() * 60 - 30) + 'px');
        p.style.opacity = '0.6';
        petals.appendChild(p);
      }
    }
  }

  // ---------- Boot ----------
  function boot() {
    initPetalsAd1();
    initGiftBoxAd2();
    initRitualsAd3();
    initLetterAd4();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
