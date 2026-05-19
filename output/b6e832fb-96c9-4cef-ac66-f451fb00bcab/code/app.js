document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  /* ==========================================
     PARTICLES — 320x480
     ========================================== */
  var particleBox = document.querySelector('.a1-particles');
  if (particleBox) {
    var pColors = ['#F39200', '#009FE3', '#FFD500', '#FF6F61', '#00A651'];
    for (var i = 0; i < 28; i++) {
      var p = document.createElement('div');
      p.className = 'a1-particle';
      var size = 4 + Math.random() * 10;
      p.style.width = size + 'px';
      p.style.height = size + 'px';
      p.style.left = Math.random() * 320 + 'px';
      p.style.bottom = '-20px';
      p.style.background = pColors[Math.floor(Math.random() * pColors.length)];
      p.style.animationDuration = (5 + Math.random() * 7) + 's';
      p.style.animationDelay = (Math.random() * 10) + 's';
      particleBox.appendChild(p);
    }
  }

  /* ==========================================
     RIPPLE — 320x480 CTA
     ========================================== */
  var a1Cta = document.querySelector('.a1-cta');
  if (a1Cta) {
    a1Cta.addEventListener('click', function (e) {
      var rect = a1Cta.getBoundingClientRect();
      var r = document.createElement('span');
      r.className = 'ripple';
      r.style.left = (e.clientX - rect.left) + 'px';
      r.style.top = (e.clientY - rect.top) + 'px';
      r.style.width = '20px';
      r.style.height = '20px';
      a1Cta.appendChild(r);
      setTimeout(function () { r.remove(); }, 650);
    });
  }

  /* ==========================================
     CAROUSEL — 300x250
     ========================================== */
  var slides = document.querySelectorAll('.a2-slide');
  var dots = document.querySelectorAll('.a2-dot');
  var a2Paused = false;
  var a2Current = 0;

  function showSlide(idx) {
    slides.forEach(function (s) { s.classList.remove('active'); });
    dots.forEach(function (d) { d.classList.remove('active'); });
    slides[idx].classList.add('active');
    dots[idx].classList.add('active');
    a2Current = idx;
  }

  if (slides.length > 0) {
    dots.forEach(function (dot, i) {
      dot.addEventListener('click', function () { showSlide(i); });
    });

    var a2Box = document.getElementById('ad-300x250');
    if (a2Box) {
      a2Box.addEventListener('mouseenter', function () { a2Paused = true; });
      a2Box.addEventListener('mouseleave', function () { a2Paused = false; });
    }

    setInterval(function () {
      if (!a2Paused) {
        showSlide((a2Current + 1) % slides.length);
      }
    }, 3500);
  }

  /* ==========================================
     SEQUENTIAL CARDS — 300x600
     ========================================== */
  var a4Cards = document.querySelectorAll('.a4-card');
  if (a4Cards.length) {
    a4Cards.forEach(function (card, i) {
      setTimeout(function () {
        card.classList.add('visible');
      }, 600 + i * 350);
    });
  }

  /* ==========================================
     FLIP CARD — 336x280
     ========================================== */
  var flipCard = document.querySelector('.a5-card');
  if (flipCard) {
    flipCard.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('button')) return;
      flipCard.classList.toggle('flipped');
    });
  }

  /* ==========================================
     SLIDESHOW — 970x250
     ========================================== */
  var a6Slides = document.querySelectorAll('.a6-slide');
  var a6Current = 0;
  if (a6Slides.length > 0) {
    setInterval(function () {
      a6Slides.forEach(function (s) { s.classList.remove('active'); });
      a6Current = (a6Current + 1) % a6Slides.length;
      a6Slides[a6Current].classList.add('active');
    }, 4000);
  }

  /* ==========================================
     CASCADE — 160x600
     ========================================== */
  var a7Items = document.querySelectorAll('.a7-img-wrap, .a7-feat');
  if (a7Items.length) {
    a7Items.forEach(function (item, i) {
      setTimeout(function () {
        item.classList.add('visible');
      }, 500 + i * 280);
    });
  }

  /* ==========================================
     HOVER GLOW — ALL AD UNITS
     ========================================== */
  var adUnits = document.querySelectorAll('.ad-unit');
  adUnits.forEach(function (unit) {
    unit.addEventListener('mouseenter', function () {
      unit.style.boxShadow = '0 12px 48px rgba(243,146,0,0.25)';
    });
    unit.addEventListener('mouseleave', function () {
      unit.style.boxShadow = '0 8px 32px rgba(29,41,57,0.7)';
    });
  });

  /* ==========================================
     ENTRANCE ANIMATION — GALLERY ITEMS
     ========================================== */
  var wraps = document.querySelectorAll('.ad-wrap');
  if ('IntersectionObserver' in window) {
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          obs.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15 });

    wraps.forEach(function (w) {
      w.style.opacity = '0';
      w.style.transform = 'translateY(30px)';
      w.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
      obs.observe(w);
    });
  }
});
