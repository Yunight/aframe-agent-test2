/* Lindt — 4 ad creatives · vanilla JS only */
(function(){
  'use strict';

  /* ============================================================
     AD 1 · UNWRAP REVEAL
     Trigger : tap on foil sphere
     Rules   : foil splits (top up, bottom down), product fades + glow,
               14 gold sparks burst radially.
     Loop    : opens once; hint pulses until interaction.
  ============================================================ */
  (function ad1(){
    const ad = document.querySelector('.ad-unwrap');
    if(!ad) return;
    const foil  = ad.querySelector('#foilEl');
    const stage = ad.querySelector('#truffleStage');
    let opened = false;

    function openIt(){
      if(opened) return;
      opened = true;
      ad.classList.add('is-opened');

      const COUNT = 14;
      for(let i = 0; i < COUNT; i++){
        const s = document.createElement('span');
        s.className = 'spark';
        const a = (Math.PI * 2) * (i / COUNT) + (Math.random() * 0.3);
        const r = 70 + Math.random() * 30;
        s.style.setProperty('--tx', Math.cos(a) * r + 'px');
        s.style.setProperty('--ty', Math.sin(a) * r + 'px');
        s.style.animationDelay = (i * 18) + 'ms';
        stage.appendChild(s);
        setTimeout(function(){ s.remove(); }, 1200);
      }
    }

    foil.addEventListener('click', openIt);
    foil.addEventListener('touchstart', function(e){ e.preventDefault(); openIt(); }, {passive:false});

    /* gentle auto-reveal demo after a few seconds */
    setTimeout(function(){ if(!opened) openIt(); }, 4200);
  })();

  /* ============================================================
     AD 2 · 3D COVERFLOW CAROUSEL
     Trigger : auto-rotate, arrows, dots
     Rules   : 4 cards, 3 visible (center + sides), wrap-around
     Feedback: card transform, name+tag swap, dot pill
     Loop    : auto every 3.4 s, paused on hover
  ============================================================ */
  (function ad2(){
    const ad = document.querySelector('.ad-carousel');
    if(!ad) return;
    const track   = ad.querySelector('#coverflow');
    const cards   = Array.prototype.slice.call(track.querySelectorAll('.cf-card'));
    const dotsEl  = ad.querySelector('#dots');
    const nameEl  = ad.querySelector('#cName');
    const tagEl   = ad.querySelector('#cTag');
    const prevBtn = ad.querySelector('#prevBtn');
    const nextBtn = ad.querySelector('#nextBtn');

    const meta = [
      { name:'LINDOR Lait Fruité',   tag:"L'instant fondant" },
      { name:'LINDOR Assorti 1kg',    tag:'Le format partage' },
      { name:'Cornet LINDOR 337g',    tag:'Le grand classique' },
      { name:'EXCELLENCE Cocoa Pure', tag:'Édition limitée' }
    ];

    let idx = 0, timer = null;

    cards.forEach(function(_, i){
      const d = document.createElement('button');
      d.className = 'dot';
      d.type = 'button';
      d.setAttribute('role','tab');
      d.setAttribute('aria-label', 'Slide ' + (i + 1));
      d.addEventListener('click', function(){ go(i, true); });
      dotsEl.appendChild(d);
    });

    function render(){
      const n = cards.length;
      cards.forEach(function(c, i){
        let off = (i - idx + n) % n;
        if(off > n / 2) off -= n;
        c.setAttribute('data-pos', off);
      });
      Array.prototype.slice.call(dotsEl.children).forEach(function(d, i){
        d.classList.toggle('active', i === idx);
      });
      nameEl.textContent = meta[idx].name;
      tagEl.textContent  = meta[idx].tag;
    }

    function go(n, userInitiated){
      idx = ((n % cards.length) + cards.length) % cards.length;
      render();
      if(userInitiated) restart();
    }
    function next(){ go(idx + 1); }
    function restart(){
      if(timer) clearInterval(timer);
      timer = setInterval(next, 3400);
    }

    nextBtn.addEventListener('click', function(){ go(idx + 1, true); });
    prevBtn.addEventListener('click', function(){ go(idx - 1, true); });
    ad.addEventListener('mouseenter', function(){ if(timer){ clearInterval(timer); timer = null; } });
    ad.addEventListener('mouseleave', restart);

    render();
    restart();
  })();

  /* ============================================================
     AD 3 · PLUIE DE CHOCOLAT (catch-game)
     Trigger : Start button → spawn falling truffles
     Rules   : 15 s timer, catch 5 to win, cornet follows pointer
     Feedback: score pill increments, caught items pop, timer drains
     End     : reveal -10% code (win) or retry (lose)
  ============================================================ */
  (function ad3(){
    const ad = document.querySelector('.ad-game');
    if(!ad) return;

    const intro       = ad.querySelector('#gIntro');
    const play        = ad.querySelector('#gPlay');
    const end         = ad.querySelector('#gEnd');
    const startBtn    = ad.querySelector('#startBtn');
    const replayBtn   = ad.querySelector('#replayBtn');
    const fallingArea = ad.querySelector('#fallingArea');
    const catcher     = ad.querySelector('#catcher');
    const scoreEl     = ad.querySelector('#score');
    const timerFill   = ad.querySelector('#timerFill');
    const endEye      = ad.querySelector('#endEye');
    const endTitle    = ad.querySelector('#endTitle');
    const endLead     = ad.querySelector('#endLead');
    const codeTag     = ad.querySelector('#codeTag');

    const TRUFFLE_SRC = './lindt_lindor_strawberries_cream_chocolate_truffles_box_200g.png';
    const GOAL = 5;
    const DURATION = 15000;

    let running = false;
    let score = 0;
    let falling = [];
    let spawnTimer = null;
    let endTimeout = null;
    let rafId = null;

    function show(state){
      intro.hidden = state !== 'intro';
      play.hidden  = state !== 'play';
      end.hidden   = state !== 'end';
    }

    function start(){
      score = 0;
      scoreEl.textContent = '0';
      falling = [];
      fallingArea.innerHTML = '';
      show('play');

      timerFill.style.transition = 'none';
      timerFill.style.width = '100%';
      /* force reflow */
      void timerFill.offsetWidth;
      timerFill.style.transition = 'width ' + (DURATION / 1000) + 's linear';
      requestAnimationFrame(function(){ timerFill.style.width = '0%'; });

      running = true;
      spawnTimer = setInterval(spawn, 650);
      endTimeout = setTimeout(function(){ finish(score >= GOAL); }, DURATION);
      rafId = requestAnimationFrame(loop);
    }

    function spawn(){
      if(!running) return;
      const el = document.createElement('div');
      el.className = 'falling';
      const img = document.createElement('img');
      img.src = TRUFFLE_SRC;
      img.alt = '';
      el.appendChild(img);
      const x = 12 + Math.random() * (320 - 12 - 36);
      el.style.left = x + 'px';
      el.style.top  = '-40px';
      el._x = x;
      el._y = -40;
      el._v = 1.6 + Math.random() * 1.6;
      fallingArea.appendChild(el);
      falling.push(el);
    }

    function loop(){
      if(!running) return;
      const cR = catcher.getBoundingClientRect();
      const sR = play.getBoundingClientRect();
      const cLeft  = cR.left - sR.left;
      const cRight = cLeft + cR.width;

      for(let i = falling.length - 1; i >= 0; i--){
        const t = falling[i];
        t._y += t._v;
        t.style.top = t._y + 'px';

        const truffleCenterX = t._x + 18;
        if(t._y > 230 && truffleCenterX > (cLeft - 6) && truffleCenterX < (cRight + 6)){
          score++;
          scoreEl.textContent = score;
          t.classList.add('caught');
          (function(node){ setTimeout(function(){ node.remove(); }, 260); })(t);
          falling.splice(i, 1);
          if(score >= GOAL){ finish(true); return; }
          continue;
        }
        if(t._y > 320){
          t.remove();
          falling.splice(i, 1);
        }
      }
      rafId = requestAnimationFrame(loop);
    }

    function finish(won){
      running = false;
      clearInterval(spawnTimer); spawnTimer = null;
      clearTimeout(endTimeout); endTimeout = null;
      cancelAnimationFrame(rafId); rafId = null;
      falling.forEach(function(t){ t.remove(); });
      falling = [];

      if(won){
        endEye.textContent = 'Bravo !';
        endTitle.innerHTML = '<em>−10%</em><br/>nouveautés.';
        endLead.textContent = 'Votre code exclusif vous attend.';
        codeTag.innerHTML = 'CODE&nbsp;:&nbsp;<b>LINDOR10</b>';
      } else {
        endEye.textContent = 'Presque !';
        endTitle.innerHTML = 'Encore<br/><em>un essai ?</em>';
        endLead.textContent = 'Vous avez attrapé ' + score + ' truffe' + (score > 1 ? 's' : '') + '. Réessayez pour gagner −10%.';
        codeTag.innerHTML = 'OBJECTIF&nbsp;:&nbsp;<b>5 TRUFFES</b>';
      }
      show('end');
    }

    function movePointer(clientX){
      const sR = play.getBoundingClientRect();
      let x = clientX - sR.left;
      x = Math.max(46, Math.min(320 - 46, x));
      catcher.style.left = x + 'px';
    }

    play.addEventListener('mousemove', function(e){ movePointer(e.clientX); });
    play.addEventListener('touchmove', function(e){
      if(e.touches[0]){ e.preventDefault(); movePointer(e.touches[0].clientX); }
    }, {passive:false});

    startBtn.addEventListener('click', start);
    replayBtn.addEventListener('click', start);
  })();

  /* ============================================================
     AD 4 · TOKYO EDITORIAL
     Trigger : on load → continuous gentle motion (petals, halo)
     Rules   : spawn cherry-blossom petals at varied speeds and sizes
     Feedback: floating product, conic halo rotation
  ============================================================ */
  (function ad4(){
    const ad = document.querySelector('.ad-tokyo');
    if(!ad) return;
    const sakura = ad.querySelector('#sakura');

    function petal(){
      if(!document.body.contains(sakura)) return;
      const p = document.createElement('span');
      p.className = 'petal';
      p.style.left = (Math.random() * 100) + '%';
      const dur = (5.5 + Math.random() * 4.5);
      p.style.animationDuration = dur + 's';
      p.style.opacity = (0.45 + Math.random() * 0.5).toFixed(2);
      const scale = (0.55 + Math.random() * 0.8);
      p.style.width  = (10 * scale + 4) + 'px';
      p.style.height = (7  * scale + 4) + 'px';
      sakura.appendChild(p);
      setTimeout(function(){ p.remove(); }, dur * 1000 + 200);
    }

    for(let i = 0; i < 10; i++) setTimeout(petal, i * 250);
    setInterval(petal, 700);
  })();

})();
