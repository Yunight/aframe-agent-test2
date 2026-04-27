/**
 * PARKSIDE 3D Holographic Ad — Custom A-Frame Components
 * Sparkle particle generator and click-url handler.
 */

AFRAME.registerComponent('sparkle-particles', {
  schema: {
    count:  { type: 'int',    default: 18 },
    colors: { type: 'string', default: '#78BE20,#C8D400,#FFFFFF' },
    width:  { type: 'number', default: 4.0 },
    height: { type: 'number', default: 6.0 }
  },

  init: function () {
    var data = this.data;
    var colorArr = data.colors.split(',');

    for (var i = 0; i < data.count; i++) {
      var el = document.createElement('a-circle');

      var x        = (Math.random() - 0.5) * data.width;
      var z        = -0.5 - Math.random() * 1.5;
      var radius   = 0.012 + Math.random() * 0.028;
      var dur      = 5000 + Math.random() * 7000;
      var delay    = Math.random() * dur;
      var color    = colorArr[Math.floor(Math.random() * colorArr.length)];
      var maxOp    = 0.15 + Math.random() * 0.4;
      var startY   = -data.height / 2 - Math.random() * 2;
      var endY     =  data.height / 2 + Math.random() * 2;
      var driftX   = (Math.random() - 0.5) * 0.6;

      el.setAttribute('position', x + ' ' + startY + ' ' + z);
      el.setAttribute('radius', radius);
      el.setAttribute('color', color);
      el.setAttribute('material', 'shader: flat; opacity: 0');

      // Float upward with slight horizontal drift
      el.setAttribute('animation',
        'property: position;' +
        ' from: ' + x + ' ' + startY + ' ' + z + ';' +
        ' to: '   + (x + driftX) + ' ' + endY + ' ' + z + ';' +
        ' dur: '  + Math.round(dur) + ';' +
        ' delay: ' + Math.round(delay) + ';' +
        ' loop: true;' +
        ' easing: linear'
      );

      // Fade in then out cyclically
      el.setAttribute('animation__opacity',
        'property: material.opacity;' +
        ' from: 0;' +
        ' to: '    + maxOp.toFixed(3) + ';' +
        ' dur: '   + Math.round(dur * 0.45) + ';' +
        ' delay: ' + Math.round(delay) + ';' +
        ' dir: alternate;' +
        ' loop: true;' +
        ' easing: easeInOutSine'
      );

      this.el.appendChild(el);
    }
  }
});


AFRAME.registerComponent('click-url', {
  schema: { type: 'string', default: '' },

  init: function () {
    var url = this.data;
    this.el.addEventListener('click', function () {
      if (url) {
        window.open(url, '_blank');
      }
    });
  }
});
