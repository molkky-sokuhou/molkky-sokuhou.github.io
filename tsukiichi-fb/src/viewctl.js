/* 表示の切り替え：明るい・暗い／文字の大きさ。最初は端末の設定に合わせ、選んだらこの端末で覚える */
(function () {
  var R = document.documentElement, P = 'mk_view_';
  function g(k) { try { return localStorage.getItem(P + k); } catch (e) { return null; } }
  function s(k, v) { try { localStorage.setItem(P + k, v); } catch (e) {} }
  var t = g('theme'); if (t === 'light' || t === 'dark') R.setAttribute('data-theme', t);
  var f = g('fs'); if (f === 'l' || f === 'xl') R.setAttribute('data-fs', f);
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function isDark() { var a = R.getAttribute('data-theme'); return a ? a === 'dark' : !!(mq && mq.matches); }
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function paint() {
    var d = isDark(), fs = R.getAttribute('data-fs') || 'm';
    all('[data-vc="theme"]').forEach(function (b) { b.innerHTML = d ? SUN : MOON; var l = d ? '明るい画面にする' : '暗い画面にする'; b.setAttribute('aria-label', l); b.title = l; });
    all('[data-fs-set]').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-fs-set') === fs ? 'true' : 'false'); });
  }
  function closeAll() { all('.vc-pop').forEach(function (p) { p.hidden = true; }); all('[data-vc="font"]').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); }); }
  document.addEventListener('click', function (e) {
    var el = e.target && e.target.closest ? e.target : null;
    var b = el && el.closest('[data-vc],[data-fs-set]');
    if (!b) { if (!(el && el.closest('.vc-pop'))) closeAll(); return; }
    var vc = b.getAttribute('data-vc');
    if (vc === 'theme') { var n = isDark() ? 'light' : 'dark'; R.setAttribute('data-theme', n); s('theme', n); closeAll(); paint(); }
    else if (vc === 'font') { var pop = b.parentNode.querySelector('.vc-pop'), open = pop.hidden; closeAll(); pop.hidden = !open; b.setAttribute('aria-expanded', open ? 'true' : 'false'); }
    else { var v = b.getAttribute('data-fs-set'); if (v === 'm') R.removeAttribute('data-fs'); else R.setAttribute('data-fs', v); s('fs', v); paint(); }
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
  if (mq && mq.addEventListener) mq.addEventListener('change', paint);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint); else paint();
})();
