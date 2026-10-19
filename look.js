// Light and dark: dark is the Workstream look, light is the Field notebook look (Michael, 2026-10-19: "you can just
// have them be light and dark versions for now"). With no saved choice it follows the device's setting.
(function () {
  var KEY = 'list-look', look = null;
  try { look = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
  if (look !== 'workstream' && look !== 'notebook') {
    look = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'notebook' : 'workstream';
  }
  document.documentElement.dataset.look = look;
  function label() {
    var b = document.getElementById('lookbtn'); if (!b) return;
    var dark = document.documentElement.dataset.look !== 'notebook';
    b.textContent = dark ? 'Dark' : 'Light';
    b.title = dark ? 'Switch to light' : 'Switch to dark';
  }
  document.addEventListener('DOMContentLoaded', function () {
    label();
    var b = document.getElementById('lookbtn'); if (!b) return;
    b.addEventListener('click', function () {
      var next = document.documentElement.dataset.look === 'notebook' ? 'workstream' : 'notebook';
      document.documentElement.dataset.look = next; label();
      try { localStorage.setItem(KEY, next); } catch (e) { /* private mode */ }
    });
  });
})();
