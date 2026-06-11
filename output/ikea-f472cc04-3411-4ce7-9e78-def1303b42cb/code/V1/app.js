(function () {
  'use strict';

  // ── Slideshow ──
  const slides = document.querySelectorAll('.slide');
  const dots   = document.querySelectorAll('.dot');
  let current  = 0;
  let timer    = null;

  function goToSlide(index) {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (index + slides.length) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
  }

  function startAutoplay() {
    timer = setInterval(function () {
      goToSlide(current + 1);
    }, 3200);
  }

  function resetAutoplay() {
    clearInterval(timer);
    startAutoplay();
  }

  // Dot navigation
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      const target = parseInt(dot.getAttribute('data-dot'), 10);
      goToSlide(target);
      resetAutoplay();
    });
  });

  // ── Thumbnail cards: click syncs to slide ──
  const thumbCards = document.querySelectorAll('.thumb-card');

  thumbCards.forEach(function (card) {
    card.addEventListener('click', function () {
      const target = parseInt(card.getAttribute('data-target'), 10);
      thumbCards.forEach(function (c) { c.classList.remove('active-thumb'); });
      card.classList.add('active-thumb');
      goToSlide(target);
      resetAutoplay();
    });

    card.addEventListener('mouseenter', function () {
      const target = parseInt(card.getAttribute('data-target'), 10);
      goToSlide(target);
      resetAutoplay();
    });
  });

  // Sync thumb highlight with active slide
  function syncThumbs() {
    thumbCards.forEach(function (c) { c.classList.remove('active-thumb'); });
    const matching = document.querySelector('.thumb-card[data-target="' + current + '"]');
    if (matching) matching.classList.add('active-thumb');
  }

  // Override goToSlide to also sync thumbs
  const _goToSlide = goToSlide;
  function goToSlideSync(index) {
    _goToSlide(index);
    syncThumbs();
  }

  // Patch dot click and thumb handlers to use synced version
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      syncThumbs();
    });
  });

  thumbCards.forEach(function (card) {
    card.addEventListener('click', syncThumbs);
    card.addEventListener('mouseenter', syncThumbs);
  });

  // Patch autoplay to sync thumbs
  clearInterval(timer);
  timer = setInterval(function () {
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');
    current = (current + 1) % slides.length;
    slides[current].classList.add('active');
    dots[current].classList.add('active');
    syncThumbs();
  }, 3200);

  // Initial sync
  syncThumbs();

  // ── CTA hover pulse ──
  const ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mouseenter', function () {
      ctaBtn.style.boxShadow = '0 4px 16px rgba(0,88,171,0.28)';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      ctaBtn.style.boxShadow = '';
    });
  }

  // ── Promo tag pulse animation ──
  const promoTag = document.querySelector('.promo-tag');
  if (promoTag) {
    setInterval(function () {
      promoTag.style.transform = 'scale(1.04)';
      promoTag.style.transition = 'transform 0.18s ease';
      setTimeout(function () {
        promoTag.style.transform = 'scale(1)';
      }, 180);
    }, 4000);
  }

}());
