(function () {
  'use strict';

  // Inject accent stripe
  const ad = document.getElementById('ad-300x250');
  if (!ad) return;

  const stripe = document.createElement('div');
  stripe.className = 'accent-stripe';
  ad.appendChild(stripe);

  // Inject discount badge dynamically
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = '-10%';
  ad.appendChild(badge);

  // CTA pulse on hover with JS reinforcement
  const ctaBtn = ad.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mouseenter', function () {
      this.style.letterSpacing = '0.12em';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      this.style.letterSpacing = '';
    });
  }

  // Staggered bubble entrance
  const bubbles = ad.querySelectorAll('.bubble');
  bubbles.forEach(function (b, i) {
    b.style.opacity = '0';
    setTimeout(function () {
      b.style.transition = 'opacity 0.5s ease';
      b.style.opacity = '0.55';
    }, 300 + i * 120);
  });

  // Accessibility: reduce motion check
  const prefersReduced = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReduced) {
    bubbles.forEach(function (b) {
      b.style.opacity = '0.55';
      b.style.animation = 'none';
    });
  }

  // Track CTA click (console placeholder for analytics)
  if (ctaBtn) {
    ctaBtn.addEventListener('click', function (e) {
      console.log('[Kusmi Bubble Tea Ad] CTA clicked — navigating to collection page.');
    });
  }
})();
