/**
 * BYD Sealion 5 DM-i — Habillage Arche 1600×960 + Companions
 * Vanilla JS — no build step, no dependencies
 */
(function () {
  'use strict';

  /* ----------------------------------------------------------
     Tracking helpers
  ---------------------------------------------------------- */
  function fireImpression(eventName) {
    // Pixel de comptage 1×1 — remplacer data: par l'URL de comptage réelle en prod
    var px = new Image(1, 1);
    px.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    px.setAttribute('data-track-fired', eventName);
    if (window.console && console.debug) {
      console.debug('[BYD Track] impression:', eventName);
    }
  }

  function fireClick(clickId) {
    // Commande de clic — remplacer par l'URL réelle de tracking clic en prod
    if (window.console && console.debug) {
      console.debug('[BYD Track] click:', clickId);
    }
  }

  /* ----------------------------------------------------------
     Fire impressions on load
  ---------------------------------------------------------- */
  ['arche-1600x960', '300x250', '300x600'].forEach(function (f) {
    fireImpression('impression-' + f);
  });

  /* ----------------------------------------------------------
     Click tracking — CTA links
  ---------------------------------------------------------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-click-id]');
    if (el) {
      fireClick(el.getAttribute('data-click-id'));
    }
  });

  /* ----------------------------------------------------------
     Click zones — entire gutters & header open campaign URL
  ---------------------------------------------------------- */
  var CAMPAIGN_URL = 'https://www.byd.com/fr/vehicules-hybrides/sealion-5-dm-i';

  document.querySelectorAll('[data-click-zone]').forEach(function (zone) {
    zone.style.cursor = 'pointer';
    zone.addEventListener('click', function (e) {
      // Let <a> tags handle themselves
      if (e.target.closest('a')) return;
      var zone_id = zone.getAttribute('data-click-zone');
      fireClick('zone-' + zone_id);
      window.open(CAMPAIGN_URL, '_blank', 'noopener,noreferrer');
    });
  });

  /* ----------------------------------------------------------
     Counter animation helper
  ---------------------------------------------------------- */
  function animateCount(el, target, isFloat, delay) {
    var duration = 1300;
    var startTime = null;

    setTimeout(function () {
      function step(ts) {
        if (!startTime) startTime = ts;
        var p = Math.min((ts - startTime) / duration, 1);
        var eased = 1 - Math.pow(1 - p, 3); // ease-out-cubic
        var val = eased * target;
        el.textContent = isFloat
          ? val.toFixed(1).replace('.', ',')
          : Math.round(val).toString();
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = isFloat
          ? target.toFixed(1).replace('.', ',')
          : String(target);
      }
      requestAnimationFrame(step);
    }, delay);
  }

  /* ----------------------------------------------------------
     Animate gutter spec values
  ---------------------------------------------------------- */
  document.querySelectorAll('.sv').forEach(function (el, i) {
    var isFloat = el.hasAttribute('data-target-float');
    var target  = isFloat
      ? parseFloat(el.getAttribute('data-target-float'))
      : parseInt(el.getAttribute('data-target'), 10);
    if (!isNaN(target)) animateCount(el, target, isFloat, 700 + i * 180);
  });

  /* ----------------------------------------------------------
     Animate companion 300×600 spec values
  ---------------------------------------------------------- */
  document.querySelectorAll('.csv').forEach(function (el, i) {
    var isFloat = el.hasAttribute('data-target-float');
    var target  = isFloat
      ? parseFloat(el.getAttribute('data-target-float'))
      : parseInt(el.getAttribute('data-target'), 10);
    if (!isNaN(target)) animateCount(el, target, isFloat, 900 + i * 180);
  });

  /* ----------------------------------------------------------
     Left gutter product image rotation — consistent front-view
     Both images use the front/face angle for a smooth crossfade.
     Fade is handled by CSS opacity transition on the element.
  ---------------------------------------------------------- */
  var leftGutterImg = document.getElementById('gutter-left-img');
  if (leftGutterImg) {
    // Keep only front-angle assets so the settled state matches the initial state.
    var rotationImages = [
      './byd-sealion5-dmi-exterior-02-xl.webp',
      './byd-sealion5-dmi-exterior-02-xl.webp'
    ];
    var rotIdx = 0;

    // Ensure a smooth opacity crossfade is always applied
    leftGutterImg.style.transition = 'opacity 0.5s ease';

    setInterval(function () {
      rotIdx = (rotIdx + 1) % rotationImages.length;
      leftGutterImg.style.opacity = '0';
      setTimeout(function () {
        leftGutterImg.src = rotationImages[rotIdx];
        leftGutterImg.style.opacity = '0.85';
      }, 520);
    }, 5000);
  }

  /* ----------------------------------------------------------
     Gutter hover — accent bar brightness boost
  ---------------------------------------------------------- */
  document.querySelectorAll('.arche-gutter').forEach(function (g) {
    var bar = g.querySelector('.g-bar');
    if (!bar) return;
    g.addEventListener('mouseenter', function () {
      bar.style.opacity = '1';
      bar.style.transform = 'scaleY(1)';
    });
    g.addEventListener('mouseleave', function () {
      bar.style.opacity = '';
      bar.style.transform = '';
    });
  });

})();
