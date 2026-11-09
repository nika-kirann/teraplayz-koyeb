/* Polls server-verified membership status after a Stars checkout. */
(function () {
  'use strict';
  var box = document.querySelector('[data-poll]');
  if (!box) return;
  var status = box.querySelector('[data-poll-status]');
  var tries = 0;
  var tick = function () {
    tries++;
    fetch('/api/premium/status', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        if (s.premium && s.premium_until && s.premium_until > (+box.dataset.start || 0)) {
          if (status) status.textContent = 'Payment confirmed! Reloading…';
          setTimeout(function () { window.location.href = '/premium'; }, 900);
          return;
        }
        if (tries < 60) setTimeout(tick, tries < 10 ? 3000 : 6000);
        else if (status) status.textContent = 'Still waiting — refresh this page after paying.';
      })
      .catch(function () { if (tries < 60) setTimeout(tick, 6000); });
  };
  setTimeout(tick, 3000);
})();
