(function () {
  'use strict';
  var root = document.documentElement;
  var btn = document.getElementById('theme-toggle');
  if (!btn) return;

  function apply(stored) {
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var theme = stored === 'light' || stored === 'dark' ? stored : (prefersDark ? 'dark' : 'light');
    root.setAttribute('data-theme', theme);
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  }

  try {
    apply(localStorage.getItem('style-guide-theme'));
  } catch (e) {
    apply(null);
  }

  btn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    btn.setAttribute('aria-pressed', next === 'dark' ? 'true' : 'false');
    try {
      localStorage.setItem('style-guide-theme', next);
    } catch (e) { /* file:// ou stockage refusé */ }
  });
})();
