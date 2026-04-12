'use strict';
const jwt = require('jsonwebtoken');

/**
 * Verify the Bearer JWT on a request.
 * Returns the decoded payload or null if missing/invalid.
 */
function verifyToken(req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  try {
    return jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return null;
  }
}

/** Standard CORS + auth check. Returns payload or sends 401 and returns null. */
function requireAuth(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(200).end(); return null; }
  const payload = verifyToken(req);
  if (!payload) { res.status(401).json({ error: 'Unauthorized — please log in' }); return null; }
  return payload;
}

module.exports = { verifyToken, requireAuth };
