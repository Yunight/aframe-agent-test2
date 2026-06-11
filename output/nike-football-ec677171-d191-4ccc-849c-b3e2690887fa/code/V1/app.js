(function () {
  "use strict";

  var SLIDE_LABELS = [
    "Maillot Domicile",
    "Maillot Exterieur",
    "Veste Energy",
    "Survetement",
    "Polo Off-Pitch",
    "Air Max Plus OG"
  ];

  var AUTOPLAY_MS = 3800;

  var track       = document.getElementById("carouselTrack");
  var dotsEl      = document.getElementById("carouselDots");
  var labelEl     = document.getElementById("slideLabel");
  var wrapper     = document.getElementById("carouselWrapper");
  var progressBar = document.getElementById("progressBar");
  var copyBlock   = document.querySelector(".copy-block");
  var ctaWrap     = document.querySelector(".cta-wrap");
  var footer      = document.querySelector(".ad-footer");

  var dots        = dotsEl ? Array.from(dotsEl.querySelectorAll(".dot")) : [];
  var current     = 0;
  var total       = SLIDE_LABELS.length;
  var timer       = null;
  var locked      = false;

  function moveToSlide(index, instant) {
    if (locked && !instant) return;
    if (index < 0) index = total - 1;
    if (index >= total) index = 0;
    current = index;

    if (track) {
      if (instant) {
        track.style.transition = "none";
        track.style.transform  = "translateX(-" + (320 * current) + "px)";
      } else {
        track.style.transition = "transform 0.52s cubic-bezier(0.4,0,0.2,1)";
        track.style.transform  = "translateX(-" + (320 * current) + "px)";
      }
    }

    dots.forEach(function (d, i) {
      d.classList.toggle("active", i === current);
    });

    if (labelEl) {
      labelEl.style.opacity = "0";
      setTimeout(function () {
        labelEl.textContent  = SLIDE_LABELS[current];
        labelEl.style.opacity = "1";
      }, 180);
    }

    resetProgress();

    if (!instant) {
      locked = true;
      setTimeout(function () { locked = false; }, 560);
    }
  }

  function resetProgress() {
    if (!progressBar) return;
    progressBar.classList.remove("running");
    void progressBar.offsetWidth;
    progressBar.classList.add("running");
  }

  function nextSlide() {
    moveToSlide(current + 1, false);
  }

  function startAuto() {
    stopAuto();
    timer = setInterval(nextSlide, AUTOPLAY_MS);
  }

  function stopAuto() {
    if (timer) { clearInterval(timer); timer = null; }
  }

  // Dot clicks
  dots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      var idx = parseInt(dot.getAttribute("data-index"), 10);
      stopAuto();
      moveToSlide(idx, false);
      startAuto();
    });
  });

  // Touch swipe
  var txStart = 0;
  if (wrapper) {
    wrapper.addEventListener("touchstart", function (e) {
      txStart = e.changedTouches[0].clientX;
    }, { passive: true });

    wrapper.addEventListener("touchend", function (e) {
      var diff = txStart - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 28) {
        stopAuto();
        moveToSlide(diff > 0 ? current + 1 : current - 1, false);
        startAuto();
      }
    }, { passive: true });

    wrapper.addEventListener("mouseenter", stopAuto);
    wrapper.addEventListener("mouseleave", startAuto);
  }

  // Entrance reveals
  function revealUI() {
    if (copyBlock) copyBlock.classList.add("visible");
    if (ctaWrap)   ctaWrap.classList.add("visible");
    if (footer)    footer.classList.add("visible");
  }

  // Init
  moveToSlide(0, true);

  setTimeout(function () {
    revealUI();
    startAuto();
    resetProgress();
  }, 120);

}());
