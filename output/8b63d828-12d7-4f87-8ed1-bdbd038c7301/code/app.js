/* ==========================================================
   Gaumont — Un Bon Petit Soldat — "Éclosion" Ad Creative
   Vanilla DOM scripting — no dependencies
   ========================================================== */

document.addEventListener('DOMContentLoaded', function () {
  'use strict';

  var adUnits = document.querySelectorAll('.ad-unit');
  var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ----------------------------------------------------------
     1. Intersection Observer — reveal on scroll into view
     ---------------------------------------------------------- */
  function revealUnit(unit) {
    if (unit.classList.contains('revealed')) return;
    unit.classList.add('revealed');
  }

  if ('IntersectionObserver' in window && !prefersReduced) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          revealUnit(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.25 });

    adUnits.forEach(function (unit) {
      observer.observe(unit);
    });
  } else {
    // Fallback: reveal all immediately
    adUnits.forEach(function (unit) {
      unit.classList.add('revealed');
    });
  }

  /* ----------------------------------------------------------
     2. Mouse parallax on background image (subtle Ken Burns)
     ---------------------------------------------------------- */
  adUnits.forEach(function (unit) {
    var img = unit.querySelector('.ad-bg-img');
    if (!img) return;

    unit.addEventListener('mouseenter', function () {
      img.style.transitionDuration = '5s';
    });

    unit.addEventListener('mousemove', function (e) {
      if (prefersReduced) return;
      var rect = unit.getBoundingClientRect();
      var px = (e.clientX - rect.left) / rect.width - 0.5; // -0.5 to 0.5
      var py = (e.clientY - rect.top) / rect.height - 0.5;
      img.style.transform = 'scale(1.06) translate(' + (px * -6) + 'px, ' + (py * -6) + 'px)';
    });

    unit.addEventListener('mouseleave', function () {
      img.style.transitionDuration = '1.2s';
      img.style.transform = 'scale(1) translate(0, 0)';
    });
  });

  /* ----------------------------------------------------------
     3. CTA ripple effect on click
     ---------------------------------------------------------- */
  var ctas = document.querySelectorAll('.cta-btn');
  ctas.forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      var ripple = document.createElement('span');
      ripple.className = 'cta-ripple';
      var rect = btn.getBoundingClientRect();
      ripple.style.left = (e.clientX - rect.left) + 'px';
      ripple.style.top = (e.clientY - rect.top) + 'px';
      btn.appendChild(ripple);
      setTimeout(function () {
        if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
      }, 650);
    });
  });

  /* ----------------------------------------------------------
     4. Periodic "heartbeat" red pulse on ad border
        Adds a brief red glow every 6 seconds for attention
     ---------------------------------------------------------- */
  if (!prefersReduced) {
    setInterval(function () {
      adUnits.forEach(function (unit) {
        if (!unit.classList.contains('revealed')) return;
        unit.style.boxShadow = '0 0 18px 4px rgba(200,16,46,0.3), 0 8px 32px rgba(0,0,0,0.45)';
        setTimeout(function () {
          unit.style.boxShadow = '0 8px 32px rgba(0,0,0,0.45)';
        }, 800);
      });
    }, 6000);
  }

  /* ----------------------------------------------------------
     5. Accessibility: ensure CTA is keyboard-focusable
        and Enter triggers navigation
     ---------------------------------------------------------- */
  ctas.forEach(function (btn) {
    btn.setAttribute('role', 'link');
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        btn.click();
      }
    });
  });
});
