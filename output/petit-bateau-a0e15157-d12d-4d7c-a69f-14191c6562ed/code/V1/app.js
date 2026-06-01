document.addEventListener('DOMContentLoaded', function () {
    /* Prevent CTA navigation in demo */
    var ctas = document.querySelectorAll('.cta');
    for (var i = 0; i < ctas.length; i++) {
        ctas[i].addEventListener('click', function (e) {
            e.preventDefault();
        });
    }

    /*
     * 160x600 product image carousel
     * Auto-play: 3 seconds per slide, 0.6s CSS fade transition.
     * Dot indicators update in sync. Clicking a dot jumps to that slide.
     * [warn fix] slide order updated so striped shirt (A044E01Z1) is last/settled slide.
     * Total loop: 3 slides × 3s = 9s cycle, continuous.
     */
    (function () {
        var container = document.getElementById('carousel-160');
        if (!container) return;
        var slides = container.querySelectorAll('.f8-slide');
        if (slides.length < 2) return;

        var dotsWrap = container.parentElement.querySelector('.f8-dots');
        var dots = dotsWrap ? dotsWrap.querySelectorAll('.f8-dot') : [];

        var idx = 0;
        var autoTimer = null;

        function goTo(next) {
            /* Remove active from current */
            slides[idx].classList.remove('active');
            if (dots[idx]) {
                dots[idx].classList.remove('active');
                dots[idx].setAttribute('aria-selected', 'false');
            }
            idx = next % slides.length;
            /* Activate next */
            slides[idx].classList.add('active');
            if (dots[idx]) {
                dots[idx].classList.add('active');
                dots[idx].setAttribute('aria-selected', 'true');
            }
        }

        function startAuto() {
            /* 3000ms per slide, matches CSS transition of 0.6s */
            autoTimer = setInterval(function () {
                goTo((idx + 1) % slides.length);
            }, 3000);
        }

        /* Dot click: jump to slide and restart timer */
        for (var d = 0; d < dots.length; d++) {
            (function (dotIdx) {
                dots[dotIdx].addEventListener('click', function (e) {
                    e.preventDefault();
                    clearInterval(autoTimer);
                    goTo(dotIdx);
                    startAuto();
                });
            })(d);
        }

        startAuto();
    })();

    /* 970x250 product hover z-index management */
    var items = document.querySelectorAll('.f3-pitem');
    for (var j = 0; j < items.length; j++) {
        items[j].addEventListener('mouseenter', function () {
            this.style.zIndex = '2';
        });
        items[j].addEventListener('mouseleave', function () {
            this.style.zIndex = '';
        });
    }
});
