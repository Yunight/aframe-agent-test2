(function () {
  'use strict';

  var SLIDE_COUNT  = 5;
  var AUTO_DELAY   = 3400;
  var TRANS_MS     = 600;

  var current       = 0;
  var autoTimer     = null;
  var transitioning = false;

  var track   = document.getElementById('carouselTrack');
  var dotsEl  = document.getElementById('carouselDots');
  var dots    = dotsEl ? Array.from(dotsEl.querySelectorAll('.dot')) : [];
  var wrapper = document.getElementById('carouselWrapper');

  function goTo(idx, instant) {
    if (transitioning && !instant) return;
    current = ((idx % SLIDE_COUNT) + SLIDE_COUNT) % SLIDE_COUNT;

    if (instant) {
      track.style.transition = 'none';
    } else {
      track.style.transition = 'transform 0.55s cubic-bezier(0.4, 0, 0.2, 1)';
      transitioning = true;
      setTimeout(function () { transitioning = false; }, TRANS_MS);
    }

    track.style.transform = 'translateX(-' + (current * 320) + 'px)';

    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === current);
    });
  }

  function startAuto() {
    clearInterval(autoTimer);
    autoTimer = setInterval(function () {
      goTo(current + 1, false);
    }, AUTO_DELAY);
  }

  function stopAuto() {
    clearInterval(autoTimer);
  }

  /* Dot clicks */
  dots.forEach(function (dot) {
    dot.addEventListener('click', function () {
      var idx = parseInt(dot.getAttribute('data-index'), 10);
      stopAuto();
      goTo(idx, false);
      startAuto();
    });
  });

  /* Touch swipe */
  var tStartX = 0;
  wrapper.addEventListener('touchstart', function (e) {
    tStartX = e.changedTouches[0].clientX;
    stopAuto();
  }, { passive: true });

  wrapper.addEventListener('touchend', function (e) {
    var delta = tStartX - e.changedTouches[0].clientX;
    if (Math.abs(delta) > 28) goTo(current + (delta > 0 ? 1 : -1), false);
    startAuto();
  }, { passive: true });

  /* Mouse drag */
  var mStartX  = 0;
  var dragging = false;

  wrapper.addEventListener('mousedown', function (e) {
    mStartX  = e.clientX;
    dragging = true;
    stopAuto();
  });

  document.addEventListener('mouseup', function (e) {
    if (!dragging) return;
    dragging = false;
    var delta = mStartX - e.clientX;
    if (Math.abs(delta) > 28) goTo(current + (delta > 0 ? 1 : -1), false);
    startAuto();
  });

  /* Pause on hover */
  wrapper.addEventListener('mouseenter', stopAuto);
  wrapper.addEventListener('mouseleave', startAuto);

  /* CTA ripple + navigation */
  var ctaBtn = document.querySelector('.cta-btn');
  if (ctaBtn) {
    ctaBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var ripple = document.createElement('span');
      ripple.style.cssText = [
        'position:absolute',
        'border-radius:50%',
        'width:10px',
        'height:10px',
        'background:rgba(0,0,0,0.15)',
        'transform:scale(0)',
        'animation:ripple-anim 0.55s linear forwards',
        'pointer-events:none',
        'left:' + (e.offsetX - 5) + 'px',
        'top:'  + (e.offsetY - 5) + 'px'
      ].join(';');
      ctaBtn.appendChild(ripple);
      setTimeout(function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 600);
      setTimeout(function () {
        window.open('https://www.lego.com/fr-fr/themes/pokemon', '_blank');
      }, 180);
    });
  }

  /* Init */
  goTo(0, true);
  startAuto();

}());
