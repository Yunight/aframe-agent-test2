/* ================================================
   BYD SEAL U DM-i  |  320x480  |  app.js
   ================================================ */
'use strict';

// ---- Hero Carousel ----------------------------------
var slides   = Array.from(document.querySelectorAll('.hero-slide'));
var dots     = Array.from(document.querySelectorAll('.hero-dot'));
var heroFade = document.getElementById('heroFade');
var active   = 0;
var timer    = null;

function goTo(idx) {
  slides[active].classList.remove('active');
  dots[active].classList.remove('active');
  active = (idx + slides.length) % slides.length;
  slides[active].classList.add('active');
  dots[active].classList.add('active');
}

function startAuto() {
  clearInterval(timer);
  timer = setInterval(function () { goTo(active + 1); }, 3500);
}

dots.forEach(function (d) {
  d.addEventListener('click', function () {
    goTo(parseInt(d.dataset.slide, 10));
    startAuto();
  });
});

// Start after entrance animations settle (~1.8 s)
setTimeout(startAuto, 1800);


// ---- Count-Up Animations ----------------------------
function countUp(el, to, ms) {
  var t0 = performance.now();
  function frame(ts) {
    var p     = Math.min((ts - t0) / ms, 1);
    var eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
    el.textContent = Math.round(to * eased);
    if (p < 1) {
      requestAnimationFrame(frame);
    } else {
      el.textContent = to;
    }
  }
  requestAnimationFrame(frame);
}

var specData = [
  { id: 'specAuto', val: 1200, ms: 1600, delay: 1100 },
  { id: 'specPow',  val: 160,  ms: 1100, delay: 1300 },
  { id: 'specNcap', val: 5,    ms: 700,  delay: 1500 }
];

specData.forEach(function (item) {
  setTimeout(function () {
    var el = document.getElementById(item.id);
    if (el) { countUp(el, item.val, item.ms); }
  }, item.delay);
});


// ---- A/B Theme Toggle -------------------------------
var adContainer = document.getElementById('adContainer');
var abTog       = document.getElementById('abTog');
var promoBg     = document.getElementById('promoBg');
var theme       = 'a';

// Only palette hex colors used in gradient strings
var THEMES = {
  a: {
    fadeGrad: 'linear-gradient(to bottom, transparent, #252728)',
    promoSrc: './Promo_SEAL_U_DM-i.webp',
    label:    'B'
  },
  b: {
    fadeGrad: 'linear-gradient(to bottom, transparent, #0A2A4A)',
    promoSrc: './seal_u_maggio.webp',
    label:    'A'
  }
};

function applyTheme(t) {
  theme = t;
  var cfg = THEMES[t];
  if (t === 'b') {
    adContainer.classList.add('theme-b');
  } else {
    adContainer.classList.remove('theme-b');
  }
  if (heroFade) { heroFade.style.background = cfg.fadeGrad; }
  if (promoBg)  { promoBg.src = cfg.promoSrc; }
  abTog.textContent = cfg.label;
}

abTog.addEventListener('click', function () {
  applyTheme(theme === 'a' ? 'b' : 'a');
});


// ---- CTA Click Feedback -----------------------------
var ctaBtn = document.querySelector('.cta-btn');
if (ctaBtn) {
  ctaBtn.addEventListener('click', function (e) {
    e.preventDefault();
    ctaBtn.style.transform = 'scale(0.96)';
    setTimeout(function () {
      ctaBtn.style.transform = '';
    }, 150);
  });
}
