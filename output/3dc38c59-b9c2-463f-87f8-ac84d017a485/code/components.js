/**
 * Red Bull Winter Olympics 2026 – Custom A-Frame Components
 * =========================================================
 * Snowfall particle system and starfield for immersive 3D ad.
 */

/* ---- SNOWFALL ---- */
AFRAME.registerComponent('snowfall', {
  schema: {
    count:  { type: 'number', default: 110 },
    spread: { type: 'number', default: 35 },
    height: { type: 'number', default: 16 }
  },

  init: function () {
    var data = this.data;
    var container = this.el;

    for (var i = 0; i < data.count; i++) {
      var flake = document.createElement('a-entity');

      var size = 0.012 + Math.random() * 0.042;
      var startX = (Math.random() - 0.5) * data.spread;
      var startY = Math.random() * data.height;
      var startZ = (Math.random() - 0.5) * data.spread;

      var driftX = startX + (Math.random() - 0.5) * 5;
      var driftZ = startZ + (Math.random() - 0.5) * 5;
      var fallDur = 5000 + Math.random() * 11000;
      var startDelay = Math.random() * 7000;
      var opacity = 0.35 + Math.random() * 0.55;

      flake.setAttribute('geometry', {
        primitive: 'sphere',
        radius: size,
        segmentsWidth: 4,
        segmentsHeight: 4
      });

      flake.setAttribute('material', {
        shader: 'flat',
        color: '#FFFFFF',
        opacity: opacity
      });

      flake.setAttribute('position', startX + ' ' + startY + ' ' + startZ);

      flake.setAttribute('animation', {
        property: 'position',
        to: driftX + ' -0.5 ' + driftZ,
        dur: fallDur,
        easing: 'linear',
        loop: true,
        delay: startDelay
      });

      container.appendChild(flake);
    }
  }
});

/* ---- STARFIELD ---- */
AFRAME.registerComponent('starfield', {
  schema: {
    count:     { type: 'number', default: 70 },
    spread:    { type: 'number', default: 60 },
    minHeight: { type: 'number', default: 7 },
    maxHeight: { type: 'number', default: 35 }
  },

  init: function () {
    var data = this.data;
    var container = this.el;

    for (var i = 0; i < data.count; i++) {
      var star = document.createElement('a-entity');

      var size = 0.018 + Math.random() * 0.06;
      var x = (Math.random() - 0.5) * data.spread;
      var y = data.minHeight + Math.random() * (data.maxHeight - data.minHeight);
      var z = -6 - Math.random() * 40;

      var opMin = 0.08 + Math.random() * 0.2;
      var opMax = 0.5 + Math.random() * 0.5;
      var twinkleDur = 1200 + Math.random() * 3500;

      star.setAttribute('geometry', {
        primitive: 'sphere',
        radius: size,
        segmentsWidth: 4,
        segmentsHeight: 4
      });

      star.setAttribute('material', {
        shader: 'flat',
        color: '#FFFFFF',
        opacity: opMin
      });

      star.setAttribute('position', x + ' ' + y + ' ' + z);

      star.setAttribute('animation', {
        property: 'material.opacity',
        from: opMin,
        to: opMax,
        dur: twinkleDur,
        dir: 'alternate',
        easing: 'easeInOutSine',
        loop: true,
        delay: Math.random() * 4000
      });

      container.appendChild(star);
    }
  }
});
