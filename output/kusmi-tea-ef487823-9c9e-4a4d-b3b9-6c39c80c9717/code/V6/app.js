/**
 * Kusmi Tea – Bubble Tea 320×480
 * Vanilla JS — no dependencies
 */

(function () {
  'use strict';

  /* ---------------------------------------------------
   * 1. Build the kit product strip dynamically
   * --------------------------------------------------- */
  const PRODUCTS = [
    {
      src: './KITBBTEAPECHEPASSION-10FR_packshot.png',
      alt: 'Kit Bubble Tea Pêche Passion'
    },
    {
      src: './92d6dada4e776c41b1c71a9d3159183552f75d15_SIROPPASSION25CL_packshot_b2cweb.png',
      alt: 'Sirop Monin Fruit de la Passion'
    },
    {
      src: './b3746a4e4d761d3e8be9f8a6b79752d016c57976_SIROPPASSION25CL_lifestyle_principal_b2cweb.png',
      alt: 'Sirop Monin – action'
    }
  ];

  function buildKitStrip () {
    const ad = document.getElementById('ad-320x480');
    if (!ad) return;

    const ctaWrap = ad.querySelector('.cta-wrap');
    if (!ctaWrap) return;

    const strip = document.createElement('div');
    strip.className = 'kit-strip';

    PRODUCTS.forEach(function (p) {
      const img = document.createElement('img');
      img.src = p.src;
      img.alt = p.alt;
      img.className = 'kit-img';
      strip.appendChild(img);
    });

    ad.insertBefore(strip, ctaWrap);
  }

  /* ---------------------------------------------------
   * 2. Entrance animation — stagger copy elements
   * --------------------------------------------------- */
  function runEntranceAnimation () {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const targets = document.querySelectorAll(
      '#ad-320x480 .ad-header, #ad-320x480 .hero-wrap, #ad-320x480 .copy-block, #ad-320x480 .kit-strip, #ad-320x480 .cta-wrap, #ad-320x480 .ad-footer'
    );

    targets.forEach(function (el, i) {
      el.style.opacity = '0';
      el.style.transform = 'translateY(14px)';
      el.style.transition = 'opacity 0.45s ease ' + (i * 0.1) + 's, transform 0.45s ease ' + (i * 0.1) + 's';
    });

    /* Trigger after one frame so initial style applies */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        targets.forEach(function (el) {
          el.style.opacity = '1';
          el.style.transform = 'translateY(0)';
        });
      });
    });
  }

  /* ---------------------------------------------------
   * 3. CTA click tracking (no-op stub — fire real pixel here)
   * --------------------------------------------------- */
  function bindCTA () {
    var btn = document.querySelector('#ad-320x480 .cta-btn');
    if (!btn) return;
    btn.addEventListener('click', function () {
      /* analytics stub */
      if (window.console) console.log('[Kusmi Ad] CTA clicked – Bubble Tea 320x480');
    });
  }

  /* ---------------------------------------------------
   * 4. Hero image carousel (swap between lifestyle images)
   * --------------------------------------------------- */
  var HERO_IMAGES = [
    { src: './00-BUBBLETEA_26_BILLESLITCKUSMI450_POR_01.jpg', alt: 'Bubble Tea lifestyle Kusmi Tea' },
    { src: './b3746a4e4d761d3e8be9f8a6b79752d016c57976_SIROPPASSION25CL_lifestyle_principal_b2cweb.png', alt: 'Sirop Monin – action lifestyle' }
  ];
  var heroIdx = 0;
  var heroEl = null;

  function cycleHero () {
    if (!heroEl) return;
    heroIdx = (heroIdx + 1) % HERO_IMAGES.length;
    heroEl.style.opacity = '0';
    heroEl.style.transform = 'scale(1.06)';
    setTimeout(function () {
      heroEl.src = HERO_IMAGES[heroIdx].src;
      heroEl.alt = HERO_IMAGES[heroIdx].alt;
      heroEl.style.opacity = '1';
      heroEl.style.transform = 'scale(1)';
    }, 350);
  }

  function initHeroCarousel () {
    heroEl = document.getElementById('heroImg');
    if (!heroEl) return;
    heroEl.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
    setInterval(cycleHero, 4000);
  }

  /* ---------------------------------------------------
   * Boot
   * --------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    buildKitStrip();
    runEntranceAnimation();
    bindCTA();
    initHeroCarousel();
  });
}());
