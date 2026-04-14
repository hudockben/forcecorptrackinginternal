'use strict';
const jwt = require('jsonwebtoken');

/**
 * Validates the Bearer JWT and returns the decoded payload.
 * If invalid, sends 401 and returns null so the caller can `return`.
 */
function requireAuth(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    res.status(401).json({ error: 'Unauthorized — please log in' });
    return null;
  }
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    res.status(401).json({ error: 'Unauthorized — please log in' });
    return null;
  }
}

module.exports = { requireAuth };
