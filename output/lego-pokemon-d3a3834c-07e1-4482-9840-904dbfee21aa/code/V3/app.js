(function () {
  'use strict';

  var slides = document.querySelectorAll('#slideshow .slide');
  var dots = document.querySelectorAll('#slideshow .dot');
  var prevBtn = document.getElementById('prevBtn');
  var nextBtn = document.getElementById('nextBtn');
  var current = 0;
  var total = slides.length;
  var autoTimer = null;
  var isAnimating = false;

  function goTo(index, direction) {
    if (isAnimating || index === current) return;
    isAnimating = true;

    var prev = current;
    current = (index + total) % total;

    var incoming = slides[current];
    var outgoing = slides[prev];

    // Prepare incoming
    incoming.style.opacity = '0';
    incoming.style.transform = direction === 'next' ? 'translateX(40px)' : 'translateX(-40px)';
    incoming.classList.add('active');

    // Force reflow
    void incoming.offsetWidth;

    // Animate incoming
    incoming.style.transition = 'opacity 0.45s ease, transform 0.45s ease';
    incoming.style.opacity = '1';
    incoming.style.transform = 'translateX(0)';

    // Animate outgoing
    outgoing.style.transition = 'opacity 0.35s ease, transform 0.35s ease';
    outgoing.style.opacity = '0';
    outgoing.style.transform = direction === 'next' ? 'translateX(-40px)' : 'translateX(40px)';

    // Update dots
    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });

    setTimeout(function () {
      outgoing.classList.remove('active');
      outgoing.style.transition = '';
      outgoing.style.opacity = '';
      outgoing.style.transform = '';
      incoming.style.transition = '';
      isAnimating = false;
    }, 480);
  }

  function next() { goTo(current + 1, 'next'); }
  function prev() { goTo(current - 1, 'prev'); }

  function startAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(next, 3200);
  }

  function stopAuto() {
    clearInterval(autoTimer);
  }

  // Wire up arrows
  if (nextBtn) {
    nextBtn.addEventListener('click', function () {
      stopAuto();
      next();
      startAuto();
    });
  }

  if (prevBtn) {
    prevBtn.addEventListener('click', function () {
      stopAuto();
      prev();
      startAuto();
    });
  }

  // Wire up dots
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-dot'), 10);
      stopAuto();
      goTo(idx, idx > current ? 'next' : 'prev');
      startAuto();
    });
  });

  // Pause on hover
  var slideshow = document.getElementById('slideshow');
  if (slideshow) {
    slideshow.addEventListener('mouseenter', stopAuto);
    slideshow.addEventListener('mouseleave', startAuto);
  }

  // Init first slide styles
  slides.forEach(function (s, i) {
    if (i !== 0) {
      s.style.opacity = '0';
      s.style.transform = 'translateX(40px)';
    } else {
      s.style.opacity = '1';
      s.style.transform = 'translateX(0)';
    }
  });

  // Start auto-play
  startAuto();

  // Subtle headline entrance animation
  var headlineBlock = document.querySelector('.ad-headline-block');
  if (headlineBlock) {
    headlineBlock.style.opacity = '0';
    headlineBlock.style.transform = 'translateY(-8px)';
    headlineBlock.style.transition = 'opacity 0.5s ease 0.1s, transform 0.5s ease 0.1s';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        headlineBlock.style.opacity = '1';
        headlineBlock.style.transform = 'translateY(0)';
      });
    });
  }

  // CTA pulse animation trigger on hover
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('mouseenter', function () {
      ctaBtn.style.transform = 'translateY(-2px) scale(1.02)';
    });
    ctaBtn.addEventListener('mouseleave', function () {
      ctaBtn.style.transform = '';
    });
  }

}());
