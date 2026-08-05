'use strict';

// Returns the public Mapbox access token from env so it stays out of git.
// The token is a "pk." public token, but handing it to anyone who asks lets a
// stranger spend this account's Mapbox quota, so it is behind the same Bearer
// check as the rest of the API. URL restrictions in the Mapbox dashboard are
// still worth setting; this is the layer that does not depend on them.
const jwt = require('jsonwebtoken');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, process.env.JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Unauthorized' }); }

  return res.json({ token: process.env.MAPBOX_TOKEN || '' });
};
