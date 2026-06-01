(function () {
  'use strict';

  var slides     = Array.from(document.querySelectorAll('.slide'));
  var dots       = Array.from(document.querySelectorAll('.dot'));
  var prevBtn    = document.getElementById('prevBtn');
  var nextBtn    = document.getElementById('nextBtn');
  var headlineEl = document.getElementById('headline');
  var subheadEl  = document.getElementById('subhead');
  var carouselWrap = document.getElementById('carouselWrap');
  var slideCounter = document.getElementById('slideCounter');

  var COPY = [
    {
      headline: 'Découvrez les<br><span class="accent">Nouveautés LEGO</span>',
      sub: 'Sets exclusifs & collections fraîches'
    },
    {
      headline: 'La vie<br><span class="accent">en briques</span>',
      sub: 'Lifestyle, fêtes & saveurs en LEGO'
    },
    {
      headline: 'Construis<br><span class="accent">tes souvenirs</span>',
      sub: 'Le cadre photo façon LEGO'
    },
    {
      headline: 'Rejoins les<br><span class="accent">Insiders</span>',
      sub: 'Avantages exclusifs & offres membres'
    }
  ];

  var current     = 0;
  var isAnimating = false;
  var autoTimer   = null;
  var total       = slides.length;

  function updateAriaLabel(index) {
    if (carouselWrap) {
      carouselWrap.setAttribute('aria-label', 'Produits en vedette, diapositive ' + (index + 1) + ' sur ' + total);
    }
    if (slideCounter) {
      slideCounter.textContent = (index + 1) + ' / ' + total;
    }
  }

  function goTo(index, dir) {
    if (isAnimating || index === current) return;
    isAnimating = true;

    var outSlide = slides[current];
    var inSlide  = slides[index];

    // Remove active, add exit on outgoing slide
    outSlide.classList.remove('active');
    outSlide.classList.add('exit');

    // Set incoming slide starting position
    inSlide.style.transition = 'none';
    inSlide.style.opacity    = '0';
    inSlide.style.transform  = dir === 'next' ? 'translateX(40px)' : 'translateX(-40px)';

    // Force reflow
    void inSlide.offsetWidth;

    // Animate in
    inSlide.style.transition = '';
    inSlide.classList.add('active');
    inSlide.style.opacity   = '';
    inSlide.style.transform = '';

    // Dots
    dots[current].classList.remove('active');
    dots[index].classList.add('active');

    // Update copy
    updateCopy(index);

    // Update aria label and counter
    updateAriaLabel(index);

    current = index;

    setTimeout(function () {
      outSlide.classList.remove('exit');
      isAnimating = false;
    }, 580);
  }

  function updateCopy(index) {
    var c = COPY[index];

    headlineEl.style.transition = 'none';
    subheadEl.style.transition  = 'none';
    headlineEl.style.opacity    = '0';
    subheadEl.style.opacity     = '0';
    headlineEl.style.transform  = 'translateY(10px)';
    subheadEl.style.transform   = 'translateY(10px)';

    setTimeout(function () {
      headlineEl.innerHTML      = c.headline;
      subheadEl.textContent     = c.sub;

      // Force reflow
      void headlineEl.offsetWidth;

      headlineEl.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
      subheadEl.style.transition  = 'opacity 0.35s ease 0.08s, transform 0.35s ease 0.08s';

      headlineEl.style.opacity   = '1';
      headlineEl.style.transform = 'translateY(0)';
      subheadEl.style.opacity    = '1';
      subheadEl.style.transform  = 'translateY(0)';
    }, 160);
  }

  function nextSlide() {
    goTo((current + 1) % slides.length, 'next');
  }

  function prevSlide() {
    goTo((current - 1 + slides.length) % slides.length, 'prev');
  }

  function startAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(nextSlide, 3400);
  }

  function stopAuto() {
    clearInterval(autoTimer);
  }

  // Button listeners
  nextBtn.addEventListener('click', function () { nextSlide(); startAuto(); });
  prevBtn.addEventListener('click', function () { prevSlide(); startAuto(); });

  // Dot listeners
  dots.forEach(function (dot, i) {
    dot.addEventListener('click', function () {
      var dir = i > current ? 'next' : 'prev';
      goTo(i, dir);
      startAuto();
    });
  });

  // Pause on hover
  var adEl = document.getElementById('ad-320x480');
  adEl.addEventListener('mouseenter', stopAuto);
  adEl.addEventListener('mouseleave', startAuto);

  // Touch swipe
  var touchStartX = 0;
  adEl.addEventListener('touchstart', function (e) {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  adEl.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 28) {
      if (dx < 0) nextSlide(); else prevSlide();
      startAuto();
    }
  }, { passive: true });

  // Reduced motion: no auto-advance
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  if (prefersReduced.matches) {
    stopAuto();
  } else {
    startAuto();
  }
  prefersReduced.addEventListener('change', function (e) {
    if (e.matches) stopAuto(); else startAuto();
  });

}());
