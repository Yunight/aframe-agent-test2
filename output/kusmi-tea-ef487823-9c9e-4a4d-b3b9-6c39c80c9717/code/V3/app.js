(function () {
  'use strict';

  // CTA hover ripple effect
  const ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mouseenter', function () {
      this.style.transform = 'translateY(-2px)';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      this.style.transform = 'translateY(0)';
    });
  }

  // Stagger bubble entrance
  const bubbles = document.querySelectorAll('.bubble');
  bubbles.forEach(function (b, i) {
    b.style.opacity = '0';
    setTimeout(function () {
      b.style.transition = 'opacity 0.6s ease';
      b.style.opacity = '0.22';
    }, 200 + i * 120);
  });

  // Reduced motion check
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (mq.matches) {
    bubbles.forEach(function (b) {
      b.style.animation = 'none';
    });
    const heroImg = document.querySelector('.hero-img');
    if (heroImg) heroImg.style.animation = 'none';
  }

  // Auto intro animation: fade-in left panel text
  const leftItems = document.querySelectorAll('.eyebrow, .headline, .subhead, .body-copy, .cta-btn');
  leftItems.forEach(function (el, i) {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-14px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    setTimeout(function () {
      el.style.opacity = '1';
      el.style.transform = 'translateX(0)';
    }, 150 + i * 100);
  });

  // Logo fade-in
  const logo = document.querySelector('.logo');
  if (logo) {
    logo.style.opacity = '0';
    logo.style.transition = 'opacity 0.6s ease';
    setTimeout(function () {
      logo.style.opacity = '1';
    }, 80);
  }
})();
