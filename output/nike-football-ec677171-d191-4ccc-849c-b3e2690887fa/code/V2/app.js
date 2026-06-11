(function () {
  "use strict";

  var SLIDE_DURATION = 3000; // ms per slide
  var slides = document.querySelectorAll(".slide");
  var dots = document.querySelectorAll(".dot");
  var progressBar = document.getElementById("progressBar");
  var current = 0;
  var total = slides.length;
  var timer = null;
  var progressTimer = null;
  var startTime = null;
  var isPaused = false;

  // Create progress bar element if not present
  if (!progressBar) {
    progressBar = document.createElement("div");
    progressBar.id = "progressBar";
    document.getElementById("ad-300x250").appendChild(progressBar);
  }

  function goToSlide(index) {
    slides[current].classList.remove("active");
    dots[current].classList.remove("active");
    current = (index + total) % total;
    slides[current].classList.add("active");
    dots[current].classList.add("active");
    resetProgress();
  }

  function nextSlide() {
    goToSlide(current + 1);
  }

  function resetProgress() {
    if (progressBar) {
      progressBar.style.transition = "none";
      progressBar.style.width = "0%";
    }
    clearInterval(progressTimer);
    startTime = performance.now();
    animateProgress();
  }

  function animateProgress() {
    if (isPaused) return;
    var elapsed = performance.now() - startTime;
    var pct = Math.min((elapsed / SLIDE_DURATION) * 100, 100);
    if (progressBar) {
      progressBar.style.transition = "none";
      progressBar.style.width = pct + "%";
    }
    if (pct < 100) {
      progressTimer = requestAnimationFrame(animateProgress);
    }
  }

  function startAutoplay() {
    clearInterval(timer);
    timer = setInterval(function () {
      if (!isPaused) {
        nextSlide();
      }
    }, SLIDE_DURATION);
    resetProgress();
  }

  // Dot click handlers
  dots.forEach(function (dot) {
    dot.addEventListener("click", function () {
      var idx = parseInt(dot.getAttribute("data-slide"), 10);
      clearInterval(timer);
      goToSlide(idx);
      startAutoplay();
    });
  });

  // Pause on hover
  var adRoot = document.getElementById("ad-300x250");
  adRoot.addEventListener("mouseenter", function () {
    isPaused = true;
    cancelAnimationFrame(progressTimer);
  });
  adRoot.addEventListener("mouseleave", function () {
    isPaused = false;
    startTime = performance.now() - (parseFloat(progressBar ? progressBar.style.width : 0) / 100 * SLIDE_DURATION);
    animateProgress();
  });

  // Swipe / touch support
  var touchStartX = 0;
  adRoot.addEventListener("touchstart", function (e) {
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  adRoot.addEventListener("touchend", function (e) {
    var diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 30) {
      clearInterval(timer);
      goToSlide(diff > 0 ? current + 1 : current - 1);
      startAutoplay();
    }
  }, { passive: true });

  // Boot
  startAutoplay();
})();
