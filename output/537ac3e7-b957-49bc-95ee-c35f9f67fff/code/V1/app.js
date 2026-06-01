(function () {
    'use strict';

    document.addEventListener('DOMContentLoaded', function () {
        scaleAllPreviews();
        window.addEventListener('resize', scaleAllPreviews);
        initIntersectionObserver();
        initParticles();
    });

    /* ----------------------------------------------------------
       Scale ad-units to fit the browser viewport
    ---------------------------------------------------------- */
    function scaleAllPreviews() {
        var wrappers = document.querySelectorAll('.preview-wrapper');
        var maxW = Math.min(window.innerWidth - 64, 1440);

        wrappers.forEach(function (wrapper) {
            var ad = wrapper.querySelector('.ad-unit');
            if (!ad) return;
            var adW = parseInt(wrapper.getAttribute('data-width'), 10);
            var adH = parseInt(wrapper.getAttribute('data-height'), 10);
            var scale = Math.min(1, maxW / adW);
            ad.style.transform = 'scale(' + scale + ')';
            ad.style.transformOrigin = 'top left';
            wrapper.style.width  = Math.floor(adW * scale) + 'px';
            wrapper.style.height = Math.floor(adH * scale) + 'px';
        });
    }

    /* ----------------------------------------------------------
       Animate ad-units when they enter the viewport
    ---------------------------------------------------------- */
    function initIntersectionObserver() {
        if (!('IntersectionObserver' in window)) {
            document.querySelectorAll('.ad-unit').forEach(function (ad) {
                ad.classList.add('animated');
            });
            return;
        }

        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) {
                    entry.target.classList.add('animated');
                    observer.unobserve(entry.target);
                }
            });
        }, { threshold: 0.12 });

        document.querySelectorAll('.ad-unit').forEach(function (ad) {
            observer.observe(ad);
        });
    }

    /* ----------------------------------------------------------
       Floating sparkle particles for Format 1
    ---------------------------------------------------------- */
    function initParticles() {
        var ad1 = document.getElementById('ad-habillage-1920x1080');
        if (!ad1) return;

        var prefersReduced = window.matchMedia &&
            window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (prefersReduced) return;

        var count = 30;
        for (var i = 0; i < count; i++) {
            var p = document.createElement('div');
            p.className = 'ad1-particle';
            p.style.left = (Math.random() * 1920) + 'px';
            p.style.top  = (80 + Math.random() * 920) + 'px';
            p.style.animationDelay    = (Math.random() * 6) + 's';
            p.style.animationDuration = (3 + Math.random() * 4) + 's';
            var size = 2 + Math.random() * 5;
            p.style.width  = size + 'px';
            p.style.height = size + 'px';
            if (Math.random() > 0.6) p.style.background = '#FFFFFF';
            ad1.appendChild(p);
        }
    }

})();
