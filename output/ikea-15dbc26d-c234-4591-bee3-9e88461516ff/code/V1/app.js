// ===== Carousel logic =====
function initCarousel(trackId, dotSelector) {
  var track = document.getElementById(trackId);
  if (!track) return;
  var slides = track.querySelectorAll('.carousel-slide');
  var dots = document.querySelectorAll(dotSelector);
  var current = 0;
  var total = slides.length;
  var timer;

  function goTo(idx) {
    current = (idx + total) % total;
    track.style.transform = 'translateX(-' + (current * 100) + '%)';
    dots.forEach(function(d, i) {
      d.classList.toggle('active', i === current);
    });
  }

  function next() {
    goTo(current + 1);
  }

  function startAuto() {
    timer = setInterval(next, 3200);
  }

  function stopAuto() {
    clearInterval(timer);
  }

  dots.forEach(function(dot) {
    dot.addEventListener('click', function() {
      stopAuto();
      goTo(parseInt(this.getAttribute('data-idx'), 10));
      startAuto();
    });
  });

  // Touch/swipe support
  var startX = 0;
  track.addEventListener('touchstart', function(e) {
    startX = e.touches[0].clientX;
    stopAuto();
  }, { passive: true });

  track.addEventListener('touchend', function(e) {
    var dx = e.changedTouches[0].clientX - startX;
    if (Math.abs(dx) > 30) {
      goTo(dx < 0 ? current + 1 : current - 1);
    }
    startAuto();
  }, { passive: true });

  // Pause on hover
  track.parentElement.addEventListener('mouseenter', stopAuto);
  track.parentElement.addEventListener('mouseleave', startAuto);

  startAuto();
}

// ===== Entrance animation for 300x600 elements =====
function animateAd600() {
  var ad = document.getElementById('ad-300x600');
  if (!ad) return;

  var elements = [
    ad.querySelector('.ad-header'),
    ad.querySelector('.hero-packshot'),
    ad.querySelector('.feature-pills'),
    ad.querySelector('.copy-block--tall'),
    ad.querySelector('.price-strip'),
    ad.querySelector('.cta-area--tall')
  ];

  elements.forEach(function(el, i) {
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(14px)';
    el.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
    setTimeout(function() {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    }, 120 + i * 110);
  });
}

// ===== 320x480 entrance animation =====
function animateAd480() {
  var ad = document.getElementById('ad-320x480');
  if (!ad) return;

  var serieLabel = ad.querySelector('.serie-label');

  var elements = [
    ad.querySelector('.ad-header'),
    ad.querySelector('.carousel'),
    ad.querySelector('.copy-block'),
    ad.querySelector('.cta-area')
  ];

  elements.forEach(function(el, i) {
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(12px)';
    el.style.transition = 'opacity 0.45s ease, transform 0.45s ease';
    setTimeout(function() {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
      // After header animates in, ensure serie-label stays visible
      if (serieLabel) {
        serieLabel.style.opacity = '1';
        serieLabel.style.visibility = 'visible';
      }
    }, 100 + i * 100);
  });

  // Guarantee serie-label is always visible regardless of animation state
  if (serieLabel) {
    serieLabel.style.opacity = '1';
    serieLabel.style.visibility = 'visible';
    serieLabel.style.display = 'inline-block';
  }
}

// ===== CTA ripple effect =====
function initRipple() {
  document.querySelectorAll('.cta-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      var rect = btn.getBoundingClientRect();
      var ripple = document.createElement('span');
      var size = Math.max(rect.width, rect.height);
      ripple.style.cssText = [
        'position:absolute',
        'border-radius:50%',
        'background:rgba(255,255,255,0.35)',
        'width:' + size + 'px',
        'height:' + size + 'px',
        'left:' + (e.clientX - rect.left - size / 2) + 'px',
        'top:' + (e.clientY - rect.top - size / 2) + 'px',
        'transform:scale(0)',
        'transition:transform 0.45s ease, opacity 0.45s ease',
        'pointer-events:none',
        'z-index:99'
      ].join(';');
      btn.style.position = 'relative';
      btn.style.overflow = 'hidden';
      btn.appendChild(ripple);
      requestAnimationFrame(function() {
        ripple.style.transform = 'scale(2.5)';
        ripple.style.opacity = '0';
      });
      setTimeout(function() { ripple.remove(); }, 500);
    });
  });
}

// ===== Pill hover pulse =====
function initPills() {
  document.querySelectorAll('.pill').forEach(function(pill) {
    pill.addEventListener('mouseenter', function() {
      pill.style.transform = 'scale(1.07)';
    });
    pill.addEventListener('mouseleave', function() {
      pill.style.transform = 'scale(1)';
    });
  });
}

// ===== Init =====
document.addEventListener('DOMContentLoaded', function() {
  initCarousel('track-320', '[data-carousel="320"]');
  animateAd600();
  animateAd480();
  initRipple();
  initPills();
});
