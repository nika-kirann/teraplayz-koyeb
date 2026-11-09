/* TERAPLAYZ admin helpers */
(function () {
  'use strict';
  var d = document;
  var csrf = (d.querySelector('meta[name="csrf-token"]') || {}).content || '';

  // Source type switch (Telegram / public URL) and ad kind switch
  var toggle = function (name, attr) {
    var radios = d.querySelectorAll('input[name="' + name + '"]');
    var sync = function () {
      var val = (d.querySelector('input[name="' + name + '"]:checked') || {}).value;
      d.querySelectorAll('[' + attr + ']').forEach(function (el) { el.hidden = el.getAttribute(attr) !== val; });
    };
    radios.forEach(function (r) { r.addEventListener('change', sync); });
  };
  toggle('source_type', 'data-source');
  toggle('kind', 'data-kind');

  // Thumbnail preview
  var file = d.getElementById('thumb-file');
  var prev = d.getElementById('thumb-preview');
  if (file && prev) file.addEventListener('change', function () {
    var f = file.files && file.files[0];
    if (f && /^image\//.test(f.type)) prev.src = URL.createObjectURL(f);
  });

  // Retrieve from Telegram
  var btn = d.getElementById('tg-lookup');
  var mid = d.getElementById('tg-mid');
  var out = d.getElementById('tg-lookup-status');
  var form = d.getElementById('video-form');
  if (btn && mid && form) btn.addEventListener('click', function () {
    var id = mid.value.trim();
    if (!/^\d+$/.test(id)) { out.className = 'small err'; out.textContent = 'Enter the numeric channel message id first.'; return; }
    btn.disabled = true; out.className = 'small'; out.textContent = 'Contacting Telegram…';
    fetch('/admin/api/telegram/lookup', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-csrf-token': csrf, accept: 'application/json' },
      body: JSON.stringify({ message_id: id }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || 'Lookup failed');
        var m = res.j.media;
        var set = function (n, v) { var el = form.elements[n]; if (el && v !== null && v !== undefined && v !== '') el.value = v; };
        set('telegram_file_id', m.file_id); set('telegram_file_unique_id', m.file_unique_id); set('telegram_thumb_file_id', m.thumb_file_id);
        set('mime_type', m.mime_type); set('file_size', m.file_size); set('duration', m.duration); set('width', m.width); set('height', m.height);
        if (!form.elements.title.value && m.caption) form.elements.title.value = m.caption.split('\n')[0].slice(0, 200);
        if (!form.elements.description.value && m.caption) form.elements.description.value = m.caption.split('\n').slice(1).join('\n').trim();
        var mb = m.file_size ? (m.file_size / 1048576).toFixed(1) + ' MB' : 'unknown size';
        out.className = 'small ' + (m.oversized ? 'err' : 'ok');
        out.textContent = (m.oversized ? '⚠ Found, but ' + mb + ' exceeds the ' + m.max_mb + ' MB Bot API limit — playback will be refused.' : '✓ Found ' + m.kind + ' (' + mb + (m.duration ? ', ' + m.duration + 's' : '') + '). Fields filled.') + (res.j.duplicate ? ' Already used by video #' + res.j.duplicate.id + '.' : '');
      })
      .catch(function (e) { out.className = 'small err'; out.textContent = e.message; })
      .finally(function () { btn.disabled = false; });
  });
})();
