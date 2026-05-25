(function () {
  "use strict";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ===========================================
     320x480 — Image Carousel
     =========================================== */
  var carousel = document.getElementById("ad-320x480");
  if (carousel) {
    var slides = carousel.querySelectorAll(".slide-320");
    var dots   = carousel.querySelectorAll(".dot");
    var cur    = 0;
    var timer  = null;
    var DELAY  = 3500;

    function goTo(i) {
      slides[cur].classList.remove("active");
      dots[cur].classList.remove("active");
      cur = ((i % slides.length) + slides.length) % slides.length;
      var s = slides[cur];
      s.classList.add("active");
      /* restart ken-burns */
      s.style.animation = "none";
      s.offsetHeight;
      s.style.animation = "";
      dots[cur].classList.add("active");
    }

    function next() { goTo(cur + 1); }

    function startTimer() { stopTimer(); timer = setInterval(next, DELAY); }
    function stopTimer()  { if (timer) { clearInterval(timer); timer = null; } }

    /* Dot navigation */
    for (var d = 0; d < dots.length; d++) {
      (function (dot) {
        dot.addEventListener("click", function () {
          var idx = parseInt(this.getAttribute("data-index"), 10);
          if (idx !== cur) { goTo(idx); startTimer(); }
        });
      })(dots[d]);
    }

    /* Pause on hover */
    carousel.addEventListener("mouseenter", stopTimer);
    carousel.addEventListener("mouseleave", function () {
      if (!reducedMotion) startTimer();
    });

    /* Touch swipe */
    var x0 = 0;
    carousel.addEventListener("touchstart", function (e) {
      x0 = e.changedTouches[0].screenX;
    }, { passive: true });
    carousel.addEventListener("touchend", function (e) {
      var dx = x0 - e.changedTouches[0].screenX;
      if (Math.abs(dx) > 40) {
        goTo(dx > 0 ? cur + 1 : cur - 1);
        startTimer();
      }
    }, { passive: true });

    /* Auto-play */
    if (!reducedMotion) startTimer();
  }

  /* ===========================================
     CTA Click Feedback (all units)
     =========================================== */
  var ctas = document.querySelectorAll(".cta");
  for (var c = 0; c < ctas.length; c++) {
    (function (btn) {
      btn.addEventListener("click", function () {
        var label = this.getAttribute("data-label");
        this.textContent = "MERCI !";
        this.style.pointerEvents = "none";
        var self = this;
        setTimeout(function () {
          self.textContent = label;
          self.style.pointerEvents = "";
        }, 1400);
      });
    })(ctas[c]);
  }

})();