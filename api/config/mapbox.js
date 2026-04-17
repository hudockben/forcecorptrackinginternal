'use strict';

// Returns the public Mapbox access token from env so it stays out of git.
// The token is a "pk." public token — safe to expose client-side when
// URL-restricted in the Mapbox dashboard.
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  return res.json({ token: process.env.MAPBOX_TOKEN || '' });
};
