(function(){
  'use strict';

  /* ======================
     PARTICLE SYSTEM
     ====================== */
  var canvas = document.getElementById('particlesCanvas');
  var ctx = canvas.getContext('2d');
  var W = 320, H = 480;
  canvas.width = W;
  canvas.height = H;

  /* Only palette colours: #0476F2, #D11013, #FFD200, #C0C0C0 */
  var COLORS = ['#0476F2','#D11013','#FFD200','#C0C0C0'];
  var particles = [];
  var PCOUNT = 28;

  function Particle(scatter){
    this.reset(scatter);
  }
  Particle.prototype.reset = function(scatter){
    this.x = Math.random() * W;
    this.y = scatter ? Math.random() * H : H + Math.random() * 40;
    this.r = Math.random() * 1.6 + 0.4;
    this.vy = -(Math.random() * 0.45 + 0.15);
    this.vx = (Math.random() - 0.5) * 0.25;
    this.alpha = Math.random() * 0.45 + 0.15;
    this.color = COLORS[Math.floor(Math.random() * COLORS.length)];
  };
  Particle.prototype.update = function(){
    this.y += this.vy;
    this.x += this.vx;
    this.alpha -= 0.0008;
    if(this.y < -10 || this.alpha <= 0) this.reset(false);
  };
  Particle.prototype.draw = function(){
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
    ctx.fillStyle = this.color;
    ctx.globalAlpha = this.alpha;
    ctx.fill();
  };

  for(var i = 0; i < PCOUNT; i++) particles.push(new Particle(true));

  function loopParticles(){
    ctx.clearRect(0, 0, W, H);
    for(var j = 0; j < particles.length; j++){
      particles[j].update();
      particles[j].draw();
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(loopParticles);
  }
  loopParticles();

  /* ======================
     IMAGE CAROUSEL
     ====================== */
  var slides = document.querySelectorAll('.slide');
  var dots   = document.querySelectorAll('.dot');
  var cur = 0;
  var autoTimer = null;

  function goTo(idx){
    if(idx === cur) return;
    slides[cur].classList.remove('active');
    dots[cur].classList.remove('active');
    cur = idx;
    slides[cur].classList.add('active');
    dots[cur].classList.add('active');
    firePulse();
  }

  function next(){ goTo((cur + 1) % slides.length); }
  function prev(){ goTo((cur - 1 + slides.length) % slides.length); }

  dots.forEach(function(d){
    d.addEventListener('click', function(){
      goTo(parseInt(this.dataset.i));
      resetAuto();
    });
  });

  function startAuto(){ autoTimer = setInterval(next, 3800); }
  function resetAuto(){ clearInterval(autoTimer); startAuto(); }

  /* Swipe / drag detection */
  var carousel = document.getElementById('carousel');
  var txStart = 0, dragging = false;

  carousel.addEventListener('touchstart', function(e){
    txStart = e.changedTouches[0].clientX;
  }, {passive: true});

  carousel.addEventListener('touchend', function(e){
    var diff = e.changedTouches[0].clientX - txStart;
    if(Math.abs(diff) > 30){
      diff < 0 ? next() : prev();
      resetAuto();
    }
  }, {passive: true});

  carousel.addEventListener('mousedown', function(e){
    dragging = true;
    txStart = e.clientX;
    carousel.style.cursor = 'grabbing';
  });

  document.addEventListener('mouseup', function(e){
    if(!dragging) return;
    dragging = false;
    carousel.style.cursor = 'grab';
    var diff = e.clientX - txStart;
    if(Math.abs(diff) > 30){
      diff < 0 ? next() : prev();
      resetAuto();
    }
  });

  /* Energy pulse visual */
  function firePulse(){
    var showcase = document.getElementById('showcase');
    var p = document.createElement('div');
    p.className = 'energy-pulse';
    showcase.appendChild(p);
    setTimeout(function(){ if(p.parentNode) p.parentNode.removeChild(p); }, 650);
  }

  /* ======================
     PARALLAX ON MOUSE
     ====================== */
  var adFrame = document.getElementById('adFrame');

  adFrame.addEventListener('mousemove', function(e){
    var rect = adFrame.getBoundingClientRect();
    var nx = (e.clientX - rect.left) / W - 0.5;
    var ny = (e.clientY - rect.top)  / H - 0.5;

    var active = document.querySelector('.slide.active');
    if(active){
      active.style.transform = 'scale(1.08) translate(' + (nx * -10) + 'px,' + (ny * -6) + 'px)';
    }
    var logo = document.querySelector('.logo-img');
    if(logo){
      logo.style.transform = 'translate(' + (nx * 4) + 'px,' + (ny * 2) + 'px)';
    }
  });

  adFrame.addEventListener('mouseleave', function(){
    var active = document.querySelector('.slide.active');
    if(active) active.style.transform = 'scale(1.08) translate(0,0)';
    var logo = document.querySelector('.logo-img');
    if(logo) logo.style.transform = 'translate(0,0)';
  });

  /* ======================
     ENTRANCE ANIMATION
     ====================== */
  function entrance(){
    var els = [
      {el: document.getElementById('logoBar'),   delay: 200},
      {el: document.getElementById('showcase'),  delay: 500},
      {el: document.getElementById('hudData'),   delay: 850},
      {el: document.getElementById('textBlock'), delay: 1050},
      {el: document.getElementById('ctaWrap'),   delay: 1350}
    ];

    els.forEach(function(item){
      setTimeout(function(){
        item.el.style.transition = 'opacity .55s cubic-bezier(.22,1,.36,1), transform .55s cubic-bezier(.22,1,.36,1)';
        item.el.style.opacity = '1';
        item.el.style.transform = 'translateY(0)';
      }, item.delay);
    });

    /* Fade swipe hint after a few seconds */
    setTimeout(function(){
      var hint = document.getElementById('swipeHint');
      if(hint) hint.style.opacity = '0';
    }, 5000);

    /* Start autoplay after entrance settles */
    setTimeout(startAuto, 2200);
  }

  /* ======================
     CTA FEEDBACK
     ====================== */
  var ctaBtn = document.getElementById('ctaBtn');
  ctaBtn.addEventListener('click', function(){
    ctaBtn.classList.add('clicked');
    setTimeout(function(){
      ctaBtn.classList.remove('clicked');
    }, 300);
  });

  /* ======================
     CORNER GLOW CYCLE
     ====================== */
  var corners = document.querySelectorAll('.corner');
  function pulseCorners(){
    corners.forEach(function(c, i){
      setTimeout(function(){
        c.style.transition = 'opacity .6s ease';
        c.style.opacity = '1';
        setTimeout(function(){
          c.style.opacity = '.55';
        }, 600);
      }, i * 150);
    });
  }
  setInterval(pulseCorners, 4000);

  /* === Init === */
  entrance();

})();