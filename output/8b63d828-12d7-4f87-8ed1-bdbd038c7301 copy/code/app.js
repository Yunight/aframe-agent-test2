(function () {
  'use strict';

  /* ==========================================================
     TRACKING — pixel comptage + click command
     Documented: data-tracking for impressions,
                 data-click-zone for click commands.
     Replace console.log with actual pixel / redirect URLs.
     ========================================================== */
  function fireTracking(eventType, zone) {
    if (window.console && console.log) {
      console.log('[Gaumont Ad]', eventType, ':', zone, '@', new Date().toISOString());
    }
    /* Production example (1×1 pixel):
       var px = new Image();
       px.src = 'https://ad.example.com/pixel?evt=' +
         encodeURIComponent(eventType) + '&zone=' +
         encodeURIComponent(zone) + '&cb=' + Date.now();
    */
  }

  /* ==========================================================
     ENTRANCE ANIMATIONS — staggered via data-anim-delay
     ========================================================== */
  function initEntranceAnimations() {
    var els = document.querySelectorAll('.anim-enter');
    for (var i = 0; i < els.length; i++) {
      (function (el) {
        var delay = parseInt(el.getAttribute('data-anim-delay'), 10) || 0;
        setTimeout(function () {
          el.classList.add('anim-visible');
        }, delay);
      })(els[i]);
    }
  }

  /* ==========================================================
     TITLE CHARACTER-BY-CHARACTER REVEAL
     ========================================================== */
  function initTitleReveal() {
    var title = document.getElementById('filmTitle');
    if (!title) return;

    var text = title.textContent;
    title.innerHTML = '';

    var chars = text.split('');
    for (var i = 0; i < chars.length; i++) {
      var span = document.createElement('span');
      span.className = 'char';
      span.textContent = chars[i];
      if (chars[i] === ' ') {
        span.style.width = '0.28em';
      }
      span.style.transitionDelay = (420 + i * 38) + 'ms';
      title.appendChild(span);
    }

    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        var charEls = title.querySelectorAll('.char');
        for (var j = 0; j < charEls.length; j++) {
          charEls[j].classList.add('visible');
        }
      });
    });
  }

  /* ==========================================================
     CLICK TRACKING — data-click-zone
     ========================================================== */
  function initClickTracking() {
    var zones = document.querySelectorAll('[data-click-zone]');
    for (var i = 0; i < zones.length; i++) {
      zones[i].addEventListener('click', function (e) {
        var zoneId = this.getAttribute('data-click-zone');
        fireTracking('click', zoneId);
        if (this.tagName === 'A') {
          e.preventDefault();
        }
      });
    }
  }

  /* ==========================================================
     IMPRESSION TRACKING — data-tracking
     ========================================================== */
  function initImpressionTracking() {
    var items = document.querySelectorAll('[data-tracking]');
    for (var i = 0; i < items.length; i++) {
      fireTracking('impression', items[i].getAttribute('data-tracking'));
    }
  }

  /* ==========================================================
     POSTER / SCENE 3-D TILT ON HOVER
     ========================================================== */
  function initPosterTilt() {
    var frames = document.querySelectorAll('.poster-frame, .scene-frame');
    for (var i = 0; i < frames.length; i++) {
      (function (frame) {
        frame.addEventListener('mousemove', function (e) {
          var rect = frame.getBoundingClientRect();
          var x = (e.clientX - rect.left) / rect.width - 0.5;
          var y = (e.clientY - rect.top) / rect.height - 0.5;
          frame.style.transform =
            'perspective(500px) rotateY(' + (x * 7).toFixed(2) +
            'deg) rotateX(' + (-y * 7).toFixed(2) + 'deg)';
          frame.style.transition = 'transform 0.12s ease-out';
        });

        frame.addEventListener('mouseleave', function () {
          frame.style.transform =
            'perspective(500px) rotateY(0deg) rotateX(0deg)';
          frame.style.transition = 'transform 0.45s ease-out';
        });
      })(frames[i]);
    }
  }

  /* ==========================================================
     FILM GRAIN — lightweight canvas on the header
     ========================================================== */
  function initFilmGrain() {
    var container = document.getElementById('headerGrain');
    if (!container) return;

    var canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 128;
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    if (!ctx) return;

    function renderGrain() {
      var imageData = ctx.createImageData(256, 128);
      var d = imageData.data;
      for (var i = 0, len = d.length; i < len; i += 4) {
        var v = (Math.random() * 255) | 0;
        d[i] = v;
        d[i + 1] = v;
        d[i + 2] = v;
        d[i + 3] = 255;
      }
      ctx.putImageData(imageData, 0, 0);
    }

    renderGrain();
    setInterval(renderGrain, 300);
  }

  /* ==========================================================
     CTA RIPPLE MICRO-INTERACTION
     ========================================================== */
  function initCtaRipple() {
    var ctas = document.querySelectorAll('.cta-main, .cta-small, .companion-cta');
    for (var i = 0; i < ctas.length; i++) {
      ctas[i].addEventListener('click', function (e) {
        var btn = this;
        var ripple = document.createElement('span');
        var rect = btn.getBoundingClientRect();
        var size = Math.max(rect.width, rect.height) * 1.4;
        ripple.style.cssText =
          'position:absolute;border-radius:50%;' +
          'background:rgba(255,255,255,0.25);pointer-events:none;z-index:10;' +
          'width:' + size + 'px;height:' + size + 'px;' +
          'left:' + (e.clientX - rect.left - size / 2) + 'px;' +
          'top:' + (e.clientY - rect.top - size / 2) + 'px;' +
          'transform:scale(0);opacity:1;' +
          'transition:transform 0.5s ease-out,opacity 0.5s ease-out;';
        btn.style.position = 'relative';
        btn.style.overflow = 'hidden';
        btn.appendChild(ripple);
        requestAnimationFrame(function () {
          ripple.style.transform = 'scale(1)';
          ripple.style.opacity = '0';
        });
        setTimeout(function () {
          if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
        }, 550);
      });
    }
  }

  /* ==========================================================
     COMPANION RADIAL GLOW ON HOVER
     ========================================================== */
  function initCompanionGlow() {
    var comp = document.getElementById('companion');
    if (!comp) return;

    comp.addEventListener('mousemove', function (e) {
      var rect = comp.getBoundingClientRect();
      var x = e.clientX - rect.left;
      var y = e.clientY - rect.top;
      comp.style.background =
        'radial-gradient(circle 120px at ' + x + 'px ' + y +
        'px, rgba(200,16,46,0.08), transparent), #0A0A0A';
    });

    comp.addEventListener('mouseleave', function () {
      comp.style.background = '#0A0A0A';
    });
  }

  /* ==========================================================
     BOOTSTRAP
     ========================================================== */
  document.addEventListener('DOMContentLoaded', function () {
    initEntranceAnimations();
    initTitleReveal();
    initClickTracking();
    initImpressionTracking();
    initPosterTilt();
    initFilmGrain();
    initCtaRipple();
    initCompanionGlow();
  });

})();
