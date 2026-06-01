(function () {
  'use strict';

  /* ── Constants ── */
  var LOGO = './5bbc0f08a92ed-thumbnail.jpg';
  /* Logo description: The UNIQLO brand mark — a bold red square with the word
     UNIQLO in white uppercase letters, used as branding badge in header. */

  var PRODUCTS = [
    {
      /* Image description: A Pokémon UT graphic t-shirt product shot in portrait
         orientation, showing the tee flat-laid or on a model with original Ken
         Sugimori watercolour-style Pokémon character artwork on the front. */
      img: './goods_00_483676_3x4_45c5411b-6d7b-48f2-998d-46c334a246af.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Pikachu Aquarelle',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: A square-crop detail shot of a Pokémon UT collection
         tee highlighting the graphic print quality and cotton fabric texture. */
      img: './goods_00_483676_3x4_73ef886d-8ab2-4091-8c6c-c995cee21cbf.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'D\u00E9tail Graphique',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: A portrait product shot of another Pokémon UT t-shirt
         variant featuring a different character illustration. */
      img: './goods_00_483677_3x4_1.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Dracaufeu Classique',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: An additional Pokémon UT t-shirt showing a sub-detail
         or alternate colourway of the 30th anniversary collaboration range. */
      img: './goods_483675_sub14_3x4_e91f6eb8-782a-4ba2-b16f-db369ae75656.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Tortank Vintage',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: Close-up or styled shot of a Pokémon UT graphic tee
         featuring the Mewtwo character in Ken Sugimori watercolour style. */
      img: './goods_483676_sub20_3x4_65b7ff43-b06e-4d24-b739-4b92d6061310.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Mewtwo \u00C9dition',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: Product shot of a Pokémon UT t-shirt design variant
         featuring Eevee character artwork from the anniversary collection. */
      img: './goods_483677_sub20_3x4_1.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: '\u00C9voli Collection',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: A Pokémon UT graphic tee featuring Jigglypuff
         character art on the front of the cotton crew-neck shirt. */
      img: './goods_483678_sub20_3x4_08bd16c3-d3ba-4d54-be99-28dc36f6ab78.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Rondoudou Art',
      price: '14,90 \u20AC'
    },
    {
      /* Image description: An additional Pokémon UT t-shirt variant featuring
         the legendary Mew character in a special anniversary design. */
      img: './goods_489908_sub20_3x4_51ab24a6-366b-4368-9b15-6a810cfefa82.jpg',
      name: 'T-Shirt Graphique UT Pok\u00E9mon',
      desc: 'Mew Sp\u00E9cial',
      price: '14,90 \u20AC'
    }
  ];

  /* ── DOM refs ── */
  var container = document.getElementById('adContainer');
  var formatBtns = document.querySelectorAll('.format-btn');
  var currentFormat = 1;
  var cleanupFn = null;

  /* ── Format switching ── */
  formatBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      var fmt = parseInt(btn.dataset.format, 10);
      if (fmt === currentFormat) return;
      formatBtns.forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
      currentFormat = fmt;
      if (cleanupFn) { cleanupFn(); cleanupFn = null; }
      container.style.animation = 'none';
      void container.offsetHeight;
      container.style.animation = '';
      renderFormat(fmt);
    });
  });

  function renderFormat(n) {
    container.innerHTML = '';
    container.className = 'ad-container format-' + n;
    switch (n) {
      case 1: cleanupFn = renderPixel(); break;
      case 2: cleanupFn = renderStack(); break;
      case 3: cleanupFn = renderCinema(); break;
      case 4: cleanupFn = renderMosaic(); break;
    }
  }

  /* ═══════════════════════════════════════
     FORMAT 1 — PIXEL REVEAL
     Interactive 8-bit pixel grid that
     dissolves on tap / hover to unveil
     the hero product image beneath.
     ═══════════════════════════════════════ */
  function renderPixel() {
    var bg = makeEl('div', 'pixel-bg');
    bg.style.backgroundImage = 'url(' + PRODUCTS[0].img + ')';
    container.appendChild(bg);

    var grid = makeEl('div', 'pixel-grid');
    var COLS = 10, ROWS = 15;
    var cells = [];

    for (var r = 0; r < ROWS; r++) {
      for (var c = 0; c < COLS; c++) {
        var cell = makeEl('div', 'px-cell');
        var zone = r / ROWS;
        var color;
        if (zone < 0.3) color = Math.random() > 0.55 ? '#FFCB05' : '#000000';
        else if (zone < 0.6) color = Math.random() > 0.55 ? '#3B4CCA' : '#000000';
        else color = Math.random() > 0.55 ? '#ED1D24' : '#000000';
        cell.style.backgroundColor = color;
        cell.setAttribute('data-idx', String(r * COLS + c));
        grid.appendChild(cell);
        cells.push(cell);
      }
    }
    container.appendChild(grid);

    function dissolve(cell) {
      if (cell.classList.contains('dissolved')) return;
      cell.classList.add('dissolved');
      var idx = parseInt(cell.getAttribute('data-idx'), 10);
      var neighbours = [idx - 1, idx + 1, idx - COLS, idx + COLS, idx - COLS - 1, idx + COLS + 1];
      neighbours.forEach(function (ni, i) {
        if (ni >= 0 && ni < cells.length && !cells[ni].classList.contains('dissolved')) {
          setTimeout(function () {
            if (Math.random() > 0.4) cells[ni].classList.add('dissolved');
          }, 60 + i * 55);
        }
      });
    }

    grid.addEventListener('click', function (e) {
      if (e.target.classList.contains('px-cell')) dissolve(e.target);
    });
    grid.addEventListener('mouseover', function (e) {
      if (e.target.classList.contains('px-cell')) dissolve(e.target);
    });
    grid.addEventListener('touchmove', function (e) {
      var touch = e.touches[0];
      var target = document.elementFromPoint(touch.clientX, touch.clientY);
      if (target && target.classList && target.classList.contains('px-cell')) dissolve(target);
    }, { passive: true });

    var hdr = makeEl('div', 'pixel-hdr');
    hdr.innerHTML =
      '<img src="' + LOGO + '" class="pixel-logo" alt="UNIQLO">' +
      '<div class="pixel-title">30 ANS</div>' +
      '<div class="pixel-sub">POK\u00C9MON \u00D7 UNIQLO</div>';
    container.appendChild(hdr);

    var foot = makeEl('div', 'pixel-foot');
    foot.innerHTML =
      '<div class="pixel-hint">Touchez pour r\u00E9v\u00E9ler</div>' +
      '<button class="pixel-cta">D\u00E9couvrir</button>';
    container.appendChild(foot);

    var autoTimer = setInterval(function () {
      var remaining = cells.filter(function (c) { return !c.classList.contains('dissolved'); });
      if (remaining.length === 0) { clearInterval(autoTimer); return; }
      dissolve(remaining[Math.floor(Math.random() * remaining.length)]);
    }, 350);

    return function () { clearInterval(autoTimer); };
  }

  /* ═══════════════════════════════════════
     FORMAT 2 — CARD STACK (SWIPE)
     Draggable / swipeable product cards
     with like/nope feedback indicators.
     ═══════════════════════════════════════ */
  function renderStack() {
    var html =
      '<div class="stack-hdr">' +
        '<img src="' + LOGO + '" class="stack-logo" alt="UNIQLO">' +
        '<span class="stack-badge">30e Anniversaire</span>' +
      '</div>' +
      '<div class="stack-title">POK\u00C9MON \u00D7 UNIQLO</div>' +
      '<div class="stack-sub">Collection UT Graphique</div>' +
      '<div class="stack-area" id="stackArea"></div>' +
      '<div class="stack-counter" id="stackCounter">1 / ' + PRODUCTS.length + '</div>' +
      '<div class="stack-hint">\u2190 Glissez pour explorer \u2192</div>';
    container.innerHTML = html;

    var stackArea = document.getElementById('stackArea');
    var counter = document.getElementById('stackCounter');
    var deck = PRODUCTS.slice();
    var viewIdx = 0;
    var isDragging = false, startX = 0, deltaX = 0;
    var activeCard = null;
    var likeEl = null, nopeEl = null;

    function buildCards() {
      stackArea.innerHTML = '';
      var show = Math.min(4, deck.length);
      for (var i = show - 1; i >= 0; i--) {
        var p = deck[i];
        var card = makeEl('div', 'stack-card');
        card.style.zIndex = String(show - i);
        card.style.transform = 'translateY(' + (i * 5) + 'px) scale(' + (1 - i * 0.035) + ')';
        card.style.transition = 'transform 0.35s ease, opacity 0.35s ease';
        card.innerHTML =
          '<div class="stack-card-img" style="background-image:url(' + p.img + ')"></div>' +
          '<div class="stack-card-info">' +
            '<span class="stack-card-name">' + p.desc + '</span>' +
            '<span class="stack-card-price">' + p.price + '</span>' +
          '</div>' +
          '<span class="stack-like">\u2764</span>' +
          '<span class="stack-nope">\u2717</span>';
        stackArea.appendChild(card);
        if (i === 0) {
          activeCard = card;
          likeEl = card.querySelector('.stack-like');
          nopeEl = card.querySelector('.stack-nope');
          card.addEventListener('mousedown', function (e) { e.preventDefault(); startDrag(e.clientX); });
          card.addEventListener('touchstart', function (e) { startDrag(e.touches[0].clientX); }, { passive: true });
        }
      }
    }

    function startDrag(x) {
      isDragging = true; startX = x; deltaX = 0;
      if (activeCard) activeCard.style.transition = 'none';
    }

    function onMove(x) {
      if (!isDragging || !activeCard) return;
      deltaX = x - startX;
      activeCard.style.transform = 'translateX(' + deltaX + 'px) rotate(' + (deltaX * 0.07) + 'deg)';
      if (likeEl) likeEl.style.opacity = String(Math.min(1, Math.max(0, deltaX / 100)));
      if (nopeEl) nopeEl.style.opacity = String(Math.min(1, Math.max(0, -deltaX / 100)));
    }

    function onEnd() {
      if (!isDragging || !activeCard) return;
      isDragging = false;
      activeCard.style.transition = 'transform 0.4s ease, opacity 0.4s ease';

      if (Math.abs(deltaX) > 90) {
        var dir = deltaX > 0 ? 1 : -1;
        activeCard.style.transform = 'translateX(' + (dir * 450) + 'px) rotate(' + (dir * 35) + 'deg)';
        activeCard.style.opacity = '0';
        setTimeout(function () {
          deck.push(deck.shift());
          viewIdx = (viewIdx + 1) % PRODUCTS.length;
          counter.textContent = (viewIdx + 1) + ' / ' + PRODUCTS.length;
          buildCards();
        }, 380);
      } else {
        activeCard.style.transform = 'translateX(0) rotate(0)';
        if (likeEl) likeEl.style.opacity = '0';
        if (nopeEl) nopeEl.style.opacity = '0';
      }
      deltaX = 0;
    }

    var moveH = function (e) { onMove(e.clientX); };
    var touchMoveH = function (e) { if (e.touches.length) onMove(e.touches[0].clientX); };
    var endH = onEnd;

    container.addEventListener('mousemove', moveH);
    container.addEventListener('touchmove', touchMoveH, { passive: true });
    container.addEventListener('mouseup', endH);
    container.addEventListener('touchend', endH);
    container.addEventListener('mouseleave', endH);

    buildCards();

    return function () {
      container.removeEventListener('mousemove', moveH);
      container.removeEventListener('touchmove', touchMoveH);
      container.removeEventListener('mouseup', endH);
      container.removeEventListener('touchend', endH);
      container.removeEventListener('mouseleave', endH);
    };
  }

  /* ═══════════════════════════════════════
     FORMAT 3 — CINEMATIC SLIDESHOW
     Full-bleed images with Ken Burns,
     gradient overlays and auto-advance.
     ═══════════════════════════════════════ */
  function renderCinema() {
    var slideProducts = PRODUCTS.slice(0, 5);
    var cur = 0;

    var slidesHtml = slideProducts.map(function (p, i) {
      return '<div class="cine-slide' + (i === 0 ? ' active' : '') + '" style="background-image:url(' + p.img + ')"></div>';
    }).join('');

    var dotsHtml = slideProducts.map(function (_, i) {
      return '<div class="cine-dot' + (i === 0 ? ' active' : '') + '" data-slide="' + i + '"></div>';
    }).join('');

    container.innerHTML =
      '<div class="cine-slides">' + slidesHtml + '</div>' +
      '<div class="cine-overlay"></div>' +
      '<div class="cine-content">' +
        '<img src="' + LOGO + '" class="cine-logo" alt="UNIQLO">' +
        '<div class="cine-label">Collection 30e Anniversaire</div>' +
        '<div class="cine-heading">POK\u00C9MON<br>\u00D7 UNIQLO</div>' +
        '<div class="cine-desc" id="cineDesc">' + slideProducts[0].desc + '</div>' +
        '<div class="cine-price">' + slideProducts[0].price + '</div>' +
        '<button class="cine-cta">Acheter Maintenant</button>' +
      '</div>' +
      '<div class="cine-dots">' + dotsHtml + '</div>' +
      '<div class="cine-progress" id="cineProgress"></div>';

    var slides = container.querySelectorAll('.cine-slide');
    var dots = container.querySelectorAll('.cine-dot');
    var desc = document.getElementById('cineDesc');
    var progress = document.getElementById('cineProgress');

    function goTo(n) {
      slides.forEach(function (s) { s.classList.remove('active'); });
      dots.forEach(function (d) { d.classList.remove('active'); });
      slides[n].classList.add('active');
      dots[n].classList.add('active');
      desc.style.opacity = '0';
      setTimeout(function () {
        desc.textContent = slideProducts[n].desc;
        desc.style.opacity = '1';
      }, 300);
      cur = n;
      restartProgress();
    }

    function restartProgress() {
      progress.classList.remove('running');
      void progress.offsetHeight;
      progress.classList.add('running');
    }

    dots.forEach(function (dot) {
      dot.addEventListener('click', function () {
        goTo(parseInt(dot.getAttribute('data-slide'), 10));
        resetAutoAdvance();
      });
    });

    restartProgress();

    var autoId = setInterval(function () {
      goTo((cur + 1) % slideProducts.length);
    }, 3800);

    function resetAutoAdvance() {
      clearInterval(autoId);
      autoId = setInterval(function () {
        goTo((cur + 1) % slideProducts.length);
      }, 3800);
    }

    return function () { clearInterval(autoId); };
  }

  /* ═══════════════════════════════════════
     FORMAT 4 — INTERACTIVE MOSAÏQUE
     Tap-to-expand product grid with
     staggered entrance animation.
     ═══════════════════════════════════════ */
  function renderMosaic() {
    var gridP = PRODUCTS.slice(2, 6);

    var tilesHtml = gridP.map(function (p, i) {
      return '<div class="mosaic-tile" data-idx="' + i + '">' +
        '<div class="mosaic-tile-img" style="background-image:url(' + p.img + ')"></div>' +
        '<div class="mosaic-tile-ov"><span class="mosaic-tile-name">' + p.desc + '</span></div>' +
      '</div>';
    }).join('');

    container.innerHTML =
      '<div class="mosaic-top">' +
        '<img src="' + LOGO + '" class="mosaic-logo" alt="UNIQLO">' +
        '<div class="mosaic-title-area">' +
          '<div class="mosaic-label">POK\u00C9MON \u00D7 UNIQLO</div>' +
          '<div class="mosaic-sub">Collection UT Graphique</div>' +
        '</div>' +
        '<div class="mosaic-anniv">30e<br>ANS</div>' +
      '</div>' +
      '<div class="mosaic-grid" id="mosaicGrid">' + tilesHtml + '</div>' +
      '<div class="mosaic-bottom">' +
        '<div class="mosaic-price">D\u00E8s 14,90 \u20AC</div>' +
        '<button class="mosaic-cta">D\u00E9couvrir</button>' +
      '</div>' +
      '<div class="mosaic-exp" id="mosaicExp">' +
        '<div class="mosaic-exp-img" id="mosaicExpImg"></div>' +
        '<div class="mosaic-exp-body" id="mosaicExpBody"></div>' +
        '<button class="mosaic-exp-close" id="mosaicExpClose">\u2715</button>' +
      '</div>';

    var tiles = container.querySelectorAll('.mosaic-tile');
    var expPanel = document.getElementById('mosaicExp');
    var expImg = document.getElementById('mosaicExpImg');
    var expBody = document.getElementById('mosaicExpBody');
    var expClose = document.getElementById('mosaicExpClose');

    tiles.forEach(function (tile, i) {
      tile.style.opacity = '0';
      tile.style.transform = 'scale(0.8)';
      setTimeout(function () {
        tile.style.transition = 'all 0.45s cubic-bezier(0.34,1.56,0.64,1)';
        tile.style.opacity = '1';
        tile.style.transform = 'scale(1)';
      }, 120 + i * 110);
    });

    tiles.forEach(function (tile) {
      tile.addEventListener('click', function () {
        var idx = parseInt(tile.getAttribute('data-idx'), 10);
        var p = gridP[idx];
        expImg.style.backgroundImage = 'url(' + p.img + ')';
        expBody.innerHTML =
          '<div class="mosaic-exp-name">' + p.name + '</div>' +
          '<div class="mosaic-exp-desc">' + p.desc + '</div>' +
          '<div class="mosaic-exp-price">' + p.price + '</div>' +
          '<button class="mosaic-exp-btn">Acheter</button>';
        requestAnimationFrame(function () {
          expPanel.classList.add('visible');
        });
      });

      tile.addEventListener('touchstart', function () {
        tile.classList.add('tapped');
      }, { passive: true });
      tile.addEventListener('touchend', function () {
        setTimeout(function () { tile.classList.remove('tapped'); }, 600);
      }, { passive: true });
    });

    expClose.addEventListener('click', function (e) {
      e.stopPropagation();
      expPanel.classList.remove('visible');
    });

    return null;
  }

  /* ── Helpers ── */
  function makeEl(tag, cls) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  }

  /* ── Init ── */
  renderFormat(1);
})();
