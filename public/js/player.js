/* TERAPLAYZ custom HTML5 player
 * Play/pause, ±10s, volume/mute, seek bar (mouse/touch/keyboard), speed menu,
 * fullscreen (incl. iOS fallback), PiP, buffering indicator, HD badge,
 * resume playback (localStorage for everyone + server sync when signed in).
 * The <video> element streams from /stream/:id with HTTP Range — the browser
 * fetches only what it needs; nothing is buffered whole in app memory.
 */
(function () {
  'use strict';
  var root = document.getElementById('player');
  if (!root) return;
  var v = document.getElementById('video');
  var $ = function (s) { return root.querySelector(s); };
  var id = root.dataset.videoId;
  var loggedIn = root.dataset.loggedIn === '1';
  var serverResume = +root.dataset.resume || 0;
  var csrf = (window.TPZ && window.TPZ.csrf) || '';
  var KEY = 'tpz:progress:' + id;
  var prog = $('.player-progress'), played = $('.pp-played'), buf = $('.pp-buffer'), thumb = $('.pp-thumb'), hover = $('.pp-hover');
  var cur = $('[data-cur]'), dur = $('[data-dur]'), toast = $('.player-toast'), vol = $('.pc-vol-range');
  var speedBtn = $('[data-act="speed"]'), speedMenu = $('.pc-menu'), speedLabel = $('[data-speed-label]');
  var quality = $('[data-quality]');
  var resumeBox = $('.player-resume');

  var fmt = function (s) {
    s = Math.max(0, Math.floor(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0');
  };
  var flash = function (msg) { toast.textContent = msg; toast.classList.add('show'); clearTimeout(flash.t); flash.t = setTimeout(function () { toast.classList.remove('show'); }, 900); };
  var duration = function () { return isFinite(v.duration) && v.duration > 0 ? v.duration : (+root.dataset.duration || 0); };

  // ---------- preferences ----------
  try {
    var pv = localStorage.getItem('tpz:vol'); if (pv !== null) v.volume = Math.min(1, Math.max(0, +pv));
    v.muted = localStorage.getItem('tpz:muted') === '1';
    var ps = +localStorage.getItem('tpz:speed'); if (ps >= 0.25 && ps <= 3) v.playbackRate = ps;
  } catch (e) { /* storage blocked */ }

  // ---------- play / pause ----------
  var toggle = function () { if (v.paused || v.ended) { var p = v.play(); if (p && p.catch) p.catch(function () {}); } else v.pause(); };
  $('.player-bigplay').addEventListener('click', toggle);
  v.addEventListener('click', function () { if (matchMedia('(hover: none)').matches && root.classList.contains('idle')) { wake(); return; } toggle(); });
  v.addEventListener('dblclick', function () { fs(); });
  v.addEventListener('play', function () { root.classList.add('playing', 'started'); root.classList.remove('paused'); wake(); hideResume(); });
  v.addEventListener('pause', function () { root.classList.remove('playing'); root.classList.add('paused'); wake(); save(true); });
  v.addEventListener('ended', function () { root.classList.remove('playing'); root.classList.add('paused'); clearProgress(); });
  v.addEventListener('waiting', function () { root.classList.add('waiting'); });
  ['playing', 'canplay', 'seeked'].forEach(function (e) { v.addEventListener(e, function () { root.classList.remove('waiting'); }); });
  v.addEventListener('error', function () { root.classList.remove('waiting'); flash('Playback error — please retry'); });

  // ---------- time + buffer ----------
  var paint = function () {
    var d = duration(); var t = v.currentTime;
    var pct = d ? (t / d) * 100 : 0;
    played.style.width = pct + '%'; thumb.style.left = pct + '%';
    cur.textContent = fmt(t); dur.textContent = fmt(d);
    prog.setAttribute('aria-valuenow', String(Math.round(pct)));
    prog.setAttribute('aria-valuetext', fmt(t) + ' of ' + fmt(d));
  };
  v.addEventListener('timeupdate', function () { if (!dragging) paint(); save(false); });
  v.addEventListener('loadedmetadata', function () {
    paint();
    if (v.videoHeight) {
      var hgt = v.videoHeight; var label = hgt >= 2160 ? '4K' : hgt >= 1440 ? '1440p' : hgt >= 1080 ? '1080p HD' : hgt >= 720 ? '720p HD' : hgt + 'p';
      quality.textContent = label; quality.hidden = false;
    }
    offerResume();
  });
  v.addEventListener('progress', function () {
    var d = duration(); if (!d || !v.buffered.length) return;
    for (var i = 0; i < v.buffered.length; i++) {
      if (v.buffered.start(i) <= v.currentTime + 0.5 && v.buffered.end(i) >= v.currentTime) { buf.style.width = (v.buffered.end(i) / d * 100) + '%'; return; }
    }
  });

  // ---------- seek bar (pointer events = mouse + touch + pen) ----------
  var dragging = false;
  var posToTime = function (clientX) { var r = prog.getBoundingClientRect(); var f = Math.min(1, Math.max(0, (clientX - r.left) / r.width)); return { f: f, t: f * duration() }; };
  prog.addEventListener('pointerdown', function (e) { if (!duration()) return; dragging = true; prog.classList.add('dragging'); prog.setPointerCapture(e.pointerId); move(e); });
  prog.addEventListener('pointermove', function (e) {
    var p = posToTime(e.clientX);
    hover.hidden = false; hover.style.left = (p.f * 100) + '%'; hover.textContent = fmt(p.t);
    if (dragging) move(e);
  });
  prog.addEventListener('pointerleave', function () { hover.hidden = true; });
  var move = function (e) { var p = posToTime(e.clientX); played.style.width = (p.f * 100) + '%'; thumb.style.left = (p.f * 100) + '%'; cur.textContent = fmt(p.t); prog._t = p.t; };
  var end = function () { if (!dragging) return; dragging = false; prog.classList.remove('dragging'); if (prog._t !== undefined) v.currentTime = prog._t; };
  prog.addEventListener('pointerup', end);
  prog.addEventListener('pointercancel', end);
  prog.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekBy(e.key === 'ArrowRight' ? 5 : -5); }
    if (e.key === 'Home') { e.preventDefault(); v.currentTime = 0; }
    if (e.key === 'End') { e.preventDefault(); v.currentTime = Math.max(0, duration() - 1); }
  });
  var seekBy = function (s) { v.currentTime = Math.min(Math.max(0, v.currentTime + s), duration() || v.currentTime + s); flash((s > 0 ? '+' : '−') + Math.abs(s) + 's'); };

  // ---------- volume ----------
  var syncVol = function () { root.classList.toggle('muted', v.muted || v.volume === 0); vol.value = v.muted ? 0 : v.volume; try { localStorage.setItem('tpz:vol', String(v.volume)); localStorage.setItem('tpz:muted', v.muted ? '1' : '0'); } catch (e) {} };
  v.addEventListener('volumechange', syncVol);
  vol.addEventListener('input', function () { v.volume = +vol.value; v.muted = +vol.value === 0; });
  syncVol();

  // ---------- speed ----------
  var setSpeed = function (s) {
    v.playbackRate = s; speedLabel.textContent = s + '×';
    speedMenu.querySelectorAll('[data-speed]').forEach(function (b) { b.setAttribute('aria-checked', String(+b.dataset.speed === s)); });
    try { localStorage.setItem('tpz:speed', String(s)); } catch (e) {}
  };
  setSpeed(v.playbackRate || 1);
  speedBtn.addEventListener('click', function (e) { e.stopPropagation(); var open = speedMenu.hidden; speedMenu.hidden = !open; speedBtn.setAttribute('aria-expanded', String(open)); if (open) speedMenu.querySelector('[aria-checked="true"]').focus(); });
  speedMenu.addEventListener('click', function (e) { var b = e.target.closest('[data-speed]'); if (!b) return; setSpeed(+b.dataset.speed); speedMenu.hidden = true; speedBtn.setAttribute('aria-expanded', 'false'); flash(b.dataset.speed + '×'); speedBtn.focus(); });
  document.addEventListener('click', function () { speedMenu.hidden = true; speedBtn.setAttribute('aria-expanded', 'false'); });
  var SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  var stepSpeed = function (dir) { var i = SPEEDS.indexOf(v.playbackRate); if (i < 0) i = 2; i = Math.min(SPEEDS.length - 1, Math.max(0, i + dir)); setSpeed(SPEEDS[i]); flash(SPEEDS[i] + '×'); };

  // ---------- fullscreen ----------
  var fsEl = function () { return document.fullscreenElement || document.webkitFullscreenElement; };
  var fs = function () {
    if (fsEl()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    if (root.requestFullscreen) root.requestFullscreen().catch(function () {});
    else if (root.webkitRequestFullscreen) root.webkitRequestFullscreen();
    else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen(); // iOS Safari
  };
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      var on = Boolean(fsEl()); root.classList.toggle('fs', on);
      if (on && screen.orientation && screen.orientation.lock && v.videoWidth > v.videoHeight) screen.orientation.lock('landscape').catch(function () {});
    });
  });

  // ---------- PiP ----------
  var pipBtn = $('[data-act="pip"]');
  if (document.pictureInPictureEnabled && pipBtn) pipBtn.hidden = false;

  // ---------- button wiring ----------
  root.addEventListener('click', function (e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var a = b.dataset.act;
    if (a === 'play') toggle();
    else if (a === 'back') seekBy(-10);
    else if (a === 'fwd') seekBy(10);
    else if (a === 'mute') v.muted = !v.muted;
    else if (a === 'fs') fs();
    else if (a === 'pip') { (document.pictureInPictureElement ? document.exitPictureInPicture() : v.requestPictureInPicture()).catch(function () {}); }
  });

  // ---------- keyboard shortcuts ----------
  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('.pc-menu')) return;
    var k = e.key;
    var handled = true;
    if (k === ' ' || k === 'k' || k === 'K') { if (k === ' ' && tag === 'button') return; toggle(); }
    else if (k === 'j' || k === 'J') seekBy(-10);
    else if (k === 'l' || k === 'L') seekBy(10);
    else if (k === 'ArrowLeft') seekBy(-5);
    else if (k === 'ArrowRight') seekBy(5);
    else if (k === 'ArrowUp') { v.muted = false; v.volume = Math.min(1, v.volume + 0.1); flash('Volume ' + Math.round(v.volume * 100) + '%'); }
    else if (k === 'ArrowDown') { v.volume = Math.max(0, v.volume - 0.1); flash('Volume ' + Math.round(v.volume * 100) + '%'); }
    else if (k === 'm' || k === 'M') { v.muted = !v.muted; flash(v.muted ? 'Muted' : 'Unmuted'); }
    else if (k === 'f' || k === 'F') fs();
    else if (k === '>' || (k === '.' && e.shiftKey)) stepSpeed(1);
    else if (k === '<' || (k === ',' && e.shiftKey)) stepSpeed(-1);
    else if (/^[0-9]$/.test(k) && duration()) v.currentTime = duration() * (+k / 10);
    else handled = false;
    if (handled) { e.preventDefault(); wake(); }
  });

  // ---------- auto-hide controls ----------
  var idleT = null;
  var wake = function () { root.classList.remove('idle'); clearTimeout(idleT); idleT = setTimeout(function () { if (!v.paused && speedMenu.hidden) root.classList.add('idle'); }, 2800); };
  root.addEventListener('pointermove', wake);
  root.addEventListener('touchstart', wake, { passive: true });
  root.addEventListener('focusin', wake);

  // ---------- resume playback ----------
  var local = function () { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } };
  var resumeAt = function () {
    var l = local(); var t = serverResume;
    if (l && l.t > 5 && (!t || l.at > (Date.now() - 864e5 * 30))) t = Math.max(t, l.t);
    var d = duration();
    return t > 5 && (!d || t < d - 5) ? t : 0;
  };
  var offered = false;
  var offerResume = function () {
    if (offered) return; offered = true;
    var t = resumeAt(); if (!t) return;
    resumeBox.querySelector('[data-resume-label]').textContent = fmt(t);
    resumeBox.hidden = false;
    resumeBox.querySelector('[data-resume-yes]').onclick = function () { v.currentTime = t; hideResume(); toggle(); };
    resumeBox.querySelector('[data-resume-no]').onclick = function () { v.currentTime = 0; clearProgress(); hideResume(); toggle(); };
  };
  var hideResume = function () { resumeBox.hidden = true; };
  var lastLocal = 0, lastServer = 0;
  var save = function (force) {
    var t = v.currentTime, d = duration(); if (!t || t < 3) return;
    var now = Date.now();
    if (force || now - lastLocal > 4000) { lastLocal = now; try { localStorage.setItem(KEY, JSON.stringify({ t: t, d: d, at: now })); } catch (e) {} }
    if (loggedIn && (force || now - lastServer > 15000)) {
      lastServer = now;
      fetch('/api/progress', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify({ video_id: +id, position: t, duration: d }),
      }).catch(function () {});
    }
  };
  var clearProgress = function () {
    try { localStorage.removeItem(KEY); } catch (e) {}
    if (loggedIn) fetch('/api/progress', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ video_id: +id, position: 0, duration: duration() }) }).catch(function () {});
  };
  window.addEventListener('pagehide', function () { save(true); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) save(true); });

  // Media Session (lock-screen controls on mobile)
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: document.title.replace(/ — TERAPLAYZ$/, ''), artist: 'TERAPLAYZ', artwork: [{ src: v.poster, sizes: '640x360', type: 'image/webp' }] });
      navigator.mediaSession.setActionHandler('seekbackward', function () { seekBy(-10); });
      navigator.mediaSession.setActionHandler('seekforward', function () { seekBy(10); });
    } catch (e) { /* unsupported */ }
  }
  root.classList.add('paused');
  paint();
})();
