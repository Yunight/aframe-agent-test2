(function(){
  'use strict';

  /* ==========================================================
     FORMAT NAVIGATION
     ========================================================== */
  var btns = document.querySelectorAll('.fmt-btn');
  var ads  = document.querySelectorAll('.ad');

  btns.forEach(function(b){
    b.addEventListener('click', function(){
      var id = 'v' + b.dataset.v;
      btns.forEach(function(x){ x.classList.remove('active'); });
      b.classList.add('active');
      ads.forEach(function(a){ a.classList.remove('active'); });
      document.getElementById(id).classList.add('active');

      if (b.dataset.v === '1') spawnPetals();
      if (b.dataset.v === '2') resetV2();
      if (b.dataset.v === '3') resetV3();
      if (b.dataset.v === '4') resetV4();
    });
  });

  /* ==========================================================
     V1 — PETALES DE SAKURA  (falling petal particles)
     ========================================================== */
  var petalBox = document.getElementById('v1Petals');

  function spawnPetals(){
    petalBox.innerHTML = '';
    for (var i = 0; i < 22; i++){
      var p = document.createElement('div');
      p.className = 'petal';
      p.style.left = (Math.random() * 300 + 10) + 'px';
      p.style.animationDuration = (5 + Math.random() * 5) + 's';
      p.style.animationDelay = (Math.random() * 7) + 's';
      p.style.opacity = String(0.18 + Math.random() * 0.22);
      var sc = 0.55 + Math.random() * 0.9;
      p.style.width = (10 * sc) + 'px';
      p.style.height = (14 * sc) + 'px';
      petalBox.appendChild(p);
    }
  }
  spawnPetals();

  /* ==========================================================
     V2 — LE COFFRET IDEAL  (interactive carousel)
     ========================================================== */
  var cur   = 0;
  var total = 3;
  var CARD  = 260;
  var track = document.getElementById('v2Track');
  var dots  = document.querySelectorAll('.v2-dot');
  var vp    = document.getElementById('v2Viewport');

  function goSlide(n){
    cur = ((n % total) + total) % total;
    track.style.transform = 'translateX(' + (-cur * CARD) + 'px)';
    dots.forEach(function(d, i){ d.classList.toggle('active', i === cur); });
  }
  function resetV2(){ goSlide(0); }

  document.getElementById('v2Prev').addEventListener('click', function(){ goSlide(cur - 1); });
  document.getElementById('v2Next').addEventListener('click', function(){ goSlide(cur + 1); });
  dots.forEach(function(d){
    d.addEventListener('click', function(){ goSlide(parseInt(d.dataset.i, 10)); });
  });

  /* touch swipe */
  var tx = 0;
  vp.addEventListener('touchstart', function(e){ tx = e.touches[0].clientX; }, {passive:true});
  vp.addEventListener('touchend', function(e){
    var dx = e.changedTouches[0].clientX - tx;
    if (dx > 40) goSlide(cur - 1);
    else if (dx < -40) goSlide(cur + 1);
  }, {passive:true});

  /* auto-advance */
  setInterval(function(){
    if (document.getElementById('v2').classList.contains('active')) goSlide(cur + 1);
  }, 4000);

  /* ==========================================================
     V3 — REVELATION DOREE  (tap-to-reveal)
     ========================================================== */
  var curtain = document.getElementById('v3Curtain');
  var v3c     = document.getElementById('v3Content');

  function resetV3(){
    curtain.classList.remove('open');
    v3c.classList.remove('revealed');
  }
  function revealV3(){
    curtain.classList.add('open');
    v3c.classList.add('revealed');
  }

  curtain.addEventListener('click', revealV3);
  curtain.addEventListener('touchend', function(e){ e.preventDefault(); revealV3(); });

  /* ==========================================================
     V4 — PROFONDEUR INTERACTIVE  (parallax depth)
     ========================================================== */
  var scene  = document.getElementById('v4Scene');
  var layers = document.querySelectorAll('#v4 .v4-layer');

  function moveParallax(x, y){
    var r  = scene.getBoundingClientRect();
    var cx = (x - r.left) / r.width  - 0.5;
    var cy = (y - r.top)  / r.height - 0.5;
    layers.forEach(function(l){
      var d  = parseFloat(l.dataset.depth) || 0;
      var mx = cx * d * 32;
      var my = cy * d * 22;
      l.style.transform = 'translate(' + mx.toFixed(2) + 'px,' + my.toFixed(2) + 'px)';
    });
  }
  function resetV4(){
    layers.forEach(function(l){ l.style.transform = 'translate(0,0)'; });
  }

  scene.addEventListener('mousemove', function(e){ moveParallax(e.clientX, e.clientY); });
  scene.addEventListener('touchmove', function(e){
    moveParallax(e.touches[0].clientX, e.touches[0].clientY);
  }, {passive:true});
  scene.addEventListener('mouseleave', resetV4);

})();
