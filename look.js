// Look switch: "workstream" (default) or "notebook". Applied before the page paints, remembered per device.
(function () {
  var KEY = 'list-look', look = 'workstream';
  try { look = localStorage.getItem(KEY) || 'workstream'; } catch (e) { /* private mode */ }
  document.documentElement.dataset.look = look;
  function label() { var b = document.getElementById('lookbtn'); if (b) b.textContent = document.documentElement.dataset.look === 'notebook' ? 'Notebook' : 'Workstream'; }
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
