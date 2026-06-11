(function () {
  "use strict";

  var track    = document.getElementById("carouselTrack");
  var dots     = document.querySelectorAll(".dot");
  var prevBtn  = document.getElementById("arrowPrev");
  var nextBtn  = document.getElementById("arrowNext");

  var TOTAL       = 3;
  var current     = 0;
  var isAnimating = false;
  var autoTimer   = null;

  function goTo(index) {
    if (isAnimating) return;
    isAnimating = true;

    current = (index + TOTAL) % TOTAL;
    track.style.transform = "translateX(-" + (current * (100 / TOTAL)) + "%)";    

    dots.forEach(function (d) { d.classList.remove("active"); });
    dots[current].classList.add("active");

    setTimeout(function () { isAnimating = false; }, 480);
  }

  function startAuto() {
    stopAuto();
    autoTimer = setInterval(function () {
      goTo(current + 1);
    }, 3400);
  }

  function stopAuto() {
    if (autoTimer) {
      clearInterval(autoTimer);
      autoTimer = null;
    }
  }

  prevBtn.addEventListener("click", function () {
    goTo(current - 1);
    stopAuto();
    startAuto();
  });

  nextBtn.addEventListener("click", function () {
    goTo(current + 1);
    stopAuto();
    startAuto();
  });

  dots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      var idx = parseInt(dot.getAttribute("data-dot"), 10);
      goTo(idx);
      stopAuto();
      startAuto();
    });
  });

  /* Swipe support */
  var touchStartX = 0;

  track.addEventListener("touchstart", function (e) {
    touchStartX = e.changedTouches[0].screenX;
  }, { passive: true });

  track.addEventListener("touchend", function (e) {
    var diff = touchStartX - e.changedTouches[0].screenX;
    if (Math.abs(diff) > 30) {
      goTo(diff > 0 ? current + 1 : current - 1);
      stopAuto();
      startAuto();
    }
  }, { passive: true });

  /* CTA micro-interaction */
  var ctaBtn = document.querySelector(".cta-btn");
  if (ctaBtn) {
    ctaBtn.addEventListener("click", function (e) {
      e.preventDefault();
      ctaBtn.style.transform = "scale(0.95)";
      setTimeout(function () {
        ctaBtn.style.transform = "";
        window.open(ctaBtn.getAttribute("href"), "_blank", "noopener");
      }, 140);
    });
  }

  /* Init */
  goTo(0);

  var mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (!mq || !mq.matches) {
    startAuto();
  }

}());
