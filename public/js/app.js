/* TERAPLAYZ — site-wide interactions (no framework, ~4 KB) */
(function () {
  'use strict';
  var d = document;
  d.documentElement.classList.add('js');
  var csrf = (d.querySelector('meta[name="csrf-token"]') || {}).content || '';
  window.TPZ = { csrf: csrf };

  // Glass nav on scroll
  var nav = d.querySelector('.nav');
  var onScroll = function () { if (nav) nav.classList.toggle('scrolled', window.scrollY > 24); };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Dropdowns (click + keyboard)
  d.querySelectorAll('.nav-dd').forEach(function (dd) {
    var btn = dd.querySelector('.nav-dd-btn');
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = !dd.classList.contains('open');
      d.querySelectorAll('.nav-dd.open').forEach(function (o) { o.classList.remove('open'); o.querySelector('.nav-dd-btn').setAttribute('aria-expanded', 'false'); });
      dd.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
  });
  d.addEventListener('click', function () {
    d.querySelectorAll('.nav-dd.open').forEach(function (o) { o.classList.remove('open'); o.querySelector('.nav-dd-btn').setAttribute('aria-expanded', 'false'); });
  });
  d.addEventListener('keydown', function (e) { if (e.key === 'Escape') d.body.click(); });

  // Mobile menu
  var burger = d.querySelector('.nav-burger');
  var mm = d.getElementById('mobile-menu');
  if (burger && mm) burger.addEventListener('click', function () {
    var open = mm.hidden;
    mm.hidden = !open;
    burger.setAttribute('aria-expanded', String(open));
  });

  // Flash dismiss + auto-hide
  d.querySelectorAll('.flash').forEach(function (f) {
    var x = f.querySelector('.flash-x');
    var close = function () { f.style.transition = 'opacity .3s'; f.style.opacity = '0'; setTimeout(function () { f.remove(); }, 300); };
    if (x) x.addEventListener('click', close);
    setTimeout(close, 6000);
  });

  // Confirm dialogs for destructive forms
  d.addEventListener('submit', function (e) {
    var f = e.target;
    if (f.dataset && f.dataset.confirm && !window.confirm(f.dataset.confirm)) e.preventDefault();
  });

  // Hero carousel
  var hero = d.querySelector('[data-hero]');
  if (hero) {
    var slides = hero.querySelectorAll('.hero-slide');
    var dots = d.querySelectorAll('.hero-dots button');
    var idx = 0; var timer = null;
    var show = function (i) {
      idx = (i + slides.length) % slides.length;
      slides.forEach(function (s, j) { s.classList.toggle('is-active', j === idx); s.setAttribute('aria-hidden', String(j !== idx)); });
      dots.forEach(function (b, j) { b.setAttribute('aria-selected', String(j === idx)); });
    };
    var play = function () { stop(); if (slides.length > 1 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) timer = setInterval(function () { show(idx + 1); }, 7000); };
    var stop = function () { if (timer) clearInterval(timer); };
    dots.forEach(function (b) { b.addEventListener('click', function () { show(+b.dataset.go); play(); }); });
    hero.parentElement.addEventListener('mouseenter', stop);
    hero.parentElement.addEventListener('mouseleave', play);
    d.addEventListener('visibilitychange', function () { d.hidden ? stop() : play(); });
    play();
  }

  // Row scroll buttons
  d.querySelectorAll('.row').forEach(function (row) {
    var track = row.querySelector('.row-track');
    row.querySelectorAll('.row-nav').forEach(function (b) {
      b.addEventListener('click', function () { track.scrollBy({ left: (+b.dataset.dir) * track.clientWidth * 0.85, behavior: 'smooth' }); });
    });
  });

  // Browse "Load more" (server-rendered partials, page by page)
  var grid = d.getElementById('grid');
  var more = d.getElementById('load-more');
  if (grid && more) {
    var page = +grid.dataset.page; var pages = +grid.dataset.pages; var busy = false;
    var load = function () {
      if (busy || page >= pages) return;
      busy = true; more.disabled = true; more.textContent = 'Loading…';
      var u = new URL(window.location.href);
      u.searchParams.set('page', page + 1); u.searchParams.set('partial', '1');
      fetch(u.toString(), { headers: { accept: 'text/html' }, credentials: 'same-origin' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.text(); })
        .then(function (html) {
          grid.insertAdjacentHTML('beforeend', html);
          page += 1;
          var clean = new URL(window.location.href); clean.searchParams.set('page', page);
          history.replaceState(null, '', clean.pathname + clean.search);
          if (page >= pages) { more.remove(); io && io.disconnect(); } else { more.disabled = false; more.textContent = 'Load more'; }
        })
        .catch(function () { more.disabled = false; more.textContent = 'Retry'; })
        .finally(function () { busy = false; });
    };
    more.addEventListener('click', load);
    var io = 'IntersectionObserver' in window ? new IntersectionObserver(function (es) { if (es[0].isIntersecting) load(); }, { rootMargin: '600px' }) : null;
    if (io) io.observe(more);
  }

  // Live search suggestions (debounced, cached)
  var input = d.getElementById('nav-search-input');
  var box = d.getElementById('search-suggest');
  if (input && box) {
    var t = null; var cache = {}; var hl = -1;
    var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var render = function (q, data) {
      hl = -1;
      if (!data.items.length) { box.innerHTML = '<div class="none">No matches for “' + esc(q) + '”</div>'; box.hidden = false; return; }
      box.innerHTML = data.items.map(function (v) {
        return '<a role="option" href="' + esc(v.url) + '"><img src="' + esc(v.thumb) + '" alt="" loading="lazy"><span><strong>' + esc(v.title) + '</strong><small>' + esc(v.category || 'Video') + (v.premium ? ' · Premium' : '') + '</small></span></a>';
      }).join('') + '<a href="/search?q=' + encodeURIComponent(q) + '"><span><strong>See all results →</strong></span></a>';
      box.hidden = false;
    };
    input.addEventListener('input', function () {
      var q = input.value.trim();
      clearTimeout(t);
      if (q.length < 2) { box.hidden = true; return; }
      t = setTimeout(function () {
        if (cache[q]) return render(q, cache[q]);
        fetch('/api/videos?limit=6&q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.ok ? r.json() : { items: [] }; })
          .then(function (data) { cache[q] = data; if (input.value.trim() === q) render(q, data); })
          .catch(function () {});
      }, 220);
    });
    input.addEventListener('keydown', function (e) {
      var links = box.querySelectorAll('a');
      if (box.hidden || !links.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        hl = (hl + (e.key === 'ArrowDown' ? 1 : -1) + links.length) % links.length;
        links.forEach(function (a, i) { a.classList.toggle('hl', i === hl); });
      } else if (e.key === 'Enter' && hl >= 0) { e.preventDefault(); links[hl].click(); }
      else if (e.key === 'Escape') { box.hidden = true; }
    });
    d.addEventListener('click', function (e) { if (!box.contains(e.target) && e.target !== input) box.hidden = true; });
  }

  // Share
  d.querySelectorAll('[data-share]').forEach(function (b) {
    b.addEventListener('click', function () {
      var url = window.location.href.split('?')[0];
      if (navigator.share) navigator.share({ title: d.title, url: url }).catch(function () {});
      else if (navigator.clipboard) navigator.clipboard.writeText(url).then(function () { b.textContent = 'Link copied!'; setTimeout(function () { b.textContent = 'Copy link'; }, 1800); });
    });
  });
})();
