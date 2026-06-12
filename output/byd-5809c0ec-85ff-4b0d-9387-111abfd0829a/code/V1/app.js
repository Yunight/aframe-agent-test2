(function () {
  'use strict';

  var TOTAL_STEPS = 4;
  var AUTO_INTERVAL = 2800;

  var currentStep = 0;
  var autoTimer = null;
  var hasInteracted = false;

  var ad = document.getElementById('ad-320x480');
  var slices = [
    document.getElementById('slice0'),
    document.getElementById('slice1'),
    document.getElementById('slice2'),
    document.getElementById('slice3')
  ];
  var progressBar = document.getElementById('progressBar');
  var dots = document.querySelectorAll('.dot');
  var tapHint = document.getElementById('tapHint');
  var ctaBtn = document.querySelector('.cta-btn');
  var carImgWrap = document.getElementById('carImgWrap');
  var heroBg = document.querySelector('.hero-bg');

  function goToStep(step) {
    var prev = currentStep;
    currentStep = ((step % TOTAL_STEPS) + TOTAL_STEPS) % TOTAL_STEPS;

    slices.forEach(function (sl, i) {
      sl.classList.remove('active', 'exit');
      if (i === currentStep) {
        sl.classList.add('active');
      } else if (i === prev && prev !== currentStep) {
        sl.classList.add('exit');
        (function (el) {
          setTimeout(function () {
            el.classList.remove('exit');
          }, 680);
        })(sl);
      }
    });

    var pct = ((currentStep + 1) / TOTAL_STEPS) * 100;
    progressBar.style.width = pct + '%';

    dots.forEach(function (d, i) {
      d.classList.toggle('active', i === currentStep);
    });

    var carShifts = [0, -10, -18, -6];
    carImgWrap.style.transform = 'translateX(' + (carShifts[currentStep] || 0) + 'px)';

    var heroShifts = ['scale(1.06) translateX(0px)', 'scale(1.06) translateX(4px)', 'scale(1.06) translateX(8px)', 'scale(1.06) translateX(2px)'];
    heroBg.style.transform = heroShifts[currentStep] || 'scale(1.06)';

    if (currentStep === TOTAL_STEPS - 1) {
      ctaBtn.classList.add('pulse');
    } else {
      ctaBtn.classList.remove('pulse');
    }

    if (hasInteracted) {
      tapHint.classList.add('hidden');
    }
  }

  function nextStep() {
    goToStep(currentStep + 1);
  }

  function startAutoTimer() {
    stopAutoTimer();
    autoTimer = setInterval(function () {
      nextStep();
    }, AUTO_INTERVAL);
  }

  function stopAutoTimer() {
    if (autoTimer !== null) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  ad.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.cta-btn')) return;
    hasInteracted = true;
    tapHint.classList.add('hidden');
    stopAutoTimer();
    nextStep();
    startAutoTimer();
  });

  dots.forEach(function (d) {
    d.addEventListener('click', function (e) {
      e.stopPropagation();
      hasInteracted = true;
      tapHint.classList.add('hidden');
      stopAutoTimer();
      var targetStep = parseInt(d.getAttribute('data-step'), 10);
      goToStep(targetStep);
      startAutoTimer();
    });
  });

  var touchStartX = 0;
  var touchStartY = 0;

  ad.addEventListener('touchstart', function (e) {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
  }, { passive: true });

  ad.addEventListener('touchend', function (e) {
    if (e.target.closest && e.target.closest('.cta-btn')) return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    var dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 28) {
      hasInteracted = true;
      tapHint.classList.add('hidden');
      stopAutoTimer();
      if (dx < 0) {
        goToStep(currentStep + 1);
      } else {
        goToStep(currentStep - 1);
      }
      startAutoTimer();
    }
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopAutoTimer();
    } else {
      startAutoTimer();
    }
  });

  // Boot — short delay so first slice animates in visibly
  goToStep(0);
  setTimeout(function () {
    startAutoTimer();
  }, 800);

}());
