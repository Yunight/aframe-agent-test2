(function () {
  'use strict';

  // Variant data
  const variants = {
    electric: {
      headline: 'NOUVELLE <span class="hl">E-208</span>',
      sub: 'Zéro émission,<br>100% plaisir de conduire.',
      price: 'À partir de <strong>179 €/mois</strong><sup>*</sup>',
    },
    hybrid: {
      headline: 'NOUVELLE <span class="hl">208</span>',
      sub: 'La perfection<br>hybride rechargeable.',
      price: 'À partir de <strong>199 €/mois</strong><sup>*</sup>',
    },
    puretech: {
      headline: 'NOUVELLE <span class="hl">208</span>',
      sub: 'Le choix de la puissance,<br>thermique PureTech.',
      price: 'À partir de <strong>149 €/mois</strong><sup>*</sup>',
    },
  };

  const tabs = document.querySelectorAll('.tab-btn');
  const slides = document.querySelectorAll('.hero-slide');
  const headline = document.getElementById('ad-headline');
  const sub = document.getElementById('ad-sub');
  const price = document.getElementById('ad-price');

  let currentVariant = 'electric';
  let autoTimer = null;

  function switchVariant(variantKey, fromAuto) {
    if (variantKey === currentVariant && !fromAuto) return;
    currentVariant = variantKey;

    // Update tabs
    tabs.forEach(btn => {
      const isActive = btn.dataset.variant === variantKey;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    // Update slides
    slides.forEach(slide => {
      const isActive = slide.dataset.slide === variantKey;
      slide.classList.toggle('active', isActive);
    });

    // Animate copy out
    headline.style.opacity = '0';
    headline.style.transform = 'translateY(8px)';
    sub.style.opacity = '0';
    price.style.opacity = '0';

    setTimeout(() => {
      const data = variants[variantKey];
      headline.innerHTML = data.headline;
      sub.innerHTML = data.sub;
      price.innerHTML = data.price;

      headline.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
      headline.style.opacity = '1';
      headline.style.transform = 'translateY(0)';
      sub.style.transition = 'opacity 0.4s ease 0.1s';
      sub.style.opacity = '1';
      price.style.transition = 'opacity 0.4s ease 0.2s';
      price.style.opacity = '1';
    }, 220);
  }

  // Tab click listeners
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      clearTimeout(autoTimer);
      switchVariant(btn.dataset.variant, false);
      // Resume auto-cycle after 8s of inactivity
      scheduleAuto(8000);
    });
  });

  // Auto-cycle through variants
  const variantOrder = ['electric', 'hybrid', 'puretech'];

  function scheduleAuto(delay) {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(function cycle() {
      const nextIdx = (variantOrder.indexOf(currentVariant) + 1) % variantOrder.length;
      switchVariant(variantOrder[nextIdx], true);
      autoTimer = setTimeout(cycle, 4000);
    }, delay);
  }

  // Initial copy state
  const initData = variants[currentVariant];
  headline.innerHTML = initData.headline;
  sub.innerHTML = initData.sub;
  price.innerHTML = initData.price;

  // Start auto-cycle after 3s
  scheduleAuto(3000);

  // CTA click tracking (placeholder)
  const cta = document.querySelector('.cta-btn');
  if (cta) {
    cta.addEventListener('click', function (e) {
      // Analytics hook placeholder
      console.log('[Peugeot 208 Ad] CTA clicked — variant:', currentVariant);
    });
  }

  // Keyboard accessibility for tabs
  const tabList = document.querySelector('.variant-tabs');
  if (tabList) {
    tabList.addEventListener('keydown', function (e) {
      const tabArr = Array.from(tabs);
      const activeIdx = tabArr.findIndex(t => t.classList.contains('active'));
      if (e.key === 'ArrowRight') {
        const next = tabArr[(activeIdx + 1) % tabArr.length];
        next.focus();
        next.click();
      } else if (e.key === 'ArrowLeft') {
        const prev = tabArr[(activeIdx - 1 + tabArr.length) % tabArr.length];
        prev.focus();
        prev.click();
      }
    });
  }
})();
