(function () {
  'use strict';

  var slideLabels = [
    '308 SW — Break',
    '308 SW — Hybride',
    '308 — Lifestyle',
    '308 — Urbaine',
    '308 — Berline'
  ];

  var slides = document.querySelectorAll('#slideshow .slide');
  var dots   = document.querySelectorAll('#slideDots .dot');
  var label  = document.getElementById('slideLabel');
  var dotsContainer = document.getElementById('slideDots');

  var current  = 0;
  var total    = slides.length;
  var timer    = null;
  var INTERVAL = 3200;

  // Hide dots if only 1 or fewer distinct slides
  if (total <= 1 && dotsContainer) {
    dotsContainer.style.display = 'none';
  }

  function goTo(index) {
    // Deactivate current
    slides[current].classList.remove('active');
    dots[current].classList.remove('active');

    // Update index
    current = (index + total) % total;

    // Activate next
    slides[current].classList.add('active');
    dots[current].classList.add('active');

    // Update label with brief fade
    if (label) {
      label.style.opacity = '0';
      setTimeout(function () {
        label.textContent = slideLabels[current] || '';
        label.style.opacity = '1';
      }, 200);
    }
  }

  function startAuto() {
    if (timer) clearInterval(timer);
    if (total <= 1) return;
    timer = setInterval(function () {
      goTo(current + 1);
    }, INTERVAL);
  }

  // Dot click nav
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-dot'), 10);
      goTo(idx);
      startAuto(); // reset timer on manual nav
    });
  });

  // Touch/swipe support on slideshow
  var slideshow = document.getElementById('slideshow');
  var touchStartX = 0;

  if (slideshow) {
    slideshow.addEventListener('touchstart', function (e) {
      touchStartX = e.changedTouches[0].clientX;
    }, { passive: true });

    slideshow.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - touchStartX;
      if (Math.abs(dx) > 30) {
        goTo(dx < 0 ? current + 1 : current - 1);
        startAuto();
      }
    }, { passive: true });
  }

  // Pause on hover (desktop)
  if (slideshow) {
    slideshow.addEventListener('mouseenter', function () {
      clearInterval(timer);
    });
    slideshow.addEventListener('mouseleave', function () {
      startAuto();
    });
  }

  // CTA micro-interaction: ripple
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('click', function (e) {
      e.preventDefault(); // demo — remove in production
      var ripple = document.createElement('span');
      ripple.style.cssText = [
        'position:absolute',
        'border-radius:50%',
        'background-color:rgba(255,255,255,0.28)',
        'width:80px',
        'height:80px',
        'left:' + (e.offsetX - 40) + 'px',
        'top:' + (e.offsetY - 40) + 'px',
        'transform:scale(0)',
        'animation:ripple 0.55s ease-out forwards',
        'pointer-events:none',
        'z-index:2'
      ].join(';');

      // Inject keyframes once
      if (!document.getElementById('rippleStyle')) {
        var st = document.createElement('style');
        st.id = 'rippleStyle';
        st.textContent = '@keyframes ripple{to{transform:scale(3);opacity:0;}}';
        document.head.appendChild(st);
      }

      ctaBtn.appendChild(ripple);
      setTimeout(function () { ripple.remove(); }, 600);

      // In production, navigate:
      // window.open('https://www.peugeot.fr/offres-pro/gamme-thermique.html', '_blank');
    });
  }

  // Start autoplay
  startAuto();

}());
