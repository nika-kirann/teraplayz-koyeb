'use strict';
const { rateLimit } = require('express-rate-limit');

const make = (windowMin, limit, message) => rateLimit({
  windowMs: windowMin * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: message },
  handler: (req, res, _next, opts) => {
    res.status(opts.statusCode);
    if (req.accepts(['html', 'json']) === 'html' && !req.path.startsWith('/api/')) {
      return res.render('errors/error', { title: 'Slow down', status: 429, message });
    }
    return res.json(opts.message);
  },
});

module.exports = {
  // Generous global ceiling to absorb abuse without hurting real viewers.
  global: make(1, 300, 'Too many requests. Please wait a minute.'),
  auth: make(15, 20, 'Too many login attempts. Try again in 15 minutes.'),
  register: make(60, 10, 'Too many accounts created from this network. Try again later.'),
  search: make(1, 40, 'Too many searches. Please wait a moment.'),
  api: make(1, 120, 'Too many API requests. Please slow down.'),
  stream: make(1, 240, 'Too many playback requests.'),
  payment: make(10, 20, 'Too many payment attempts. Try again shortly.'),
  webhook: make(1, 600, 'Too many webhook calls.'),
  admin: make(1, 200, 'Too many admin requests.'),
};
