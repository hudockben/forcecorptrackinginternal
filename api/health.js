'use strict';

module.exports = (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
};
