'use strict';

const { requireAuth } = require('../lib/auth');

/**
 * Verify the bearer token AND return the account's current access, read from
 * the database rather than the token. The token is a snapshot of sign-in; the
 * pages call this on load so a change made in Manage Users since then is what
 * they draw, without a sign-out / sign-in cycle.
 *
 * It answers from requireAuth, the same read every endpoint gates on, so what
 * a page is told it may do is exactly what the server will then allow.
 *
 *   401  a bad or expired token — or an account that no longer exists. That
 *        used to answer ok from the token's own claims, which kept a deleted
 *        account signed in on every device it had used; the pages sign out
 *        on a 401.
 *   503  the account could not be read. The pages keep their cached session
 *        on anything but a 401, so a database blip signs nobody out.
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')     return res.status(405).json({ error: 'Method not allowed' });

  const payload = await requireAuth(req, res);
  if (!payload) return;

  return res.json({
    ok: true,
    user: {
      userId:           payload.userId,
      username:         payload.username,
      companyCode:      payload.companyCode,
      companyName:      payload.companyName,
      role:             payload.role,
      divisionRoles:    payload.divisionRoles,
      allowedDivisions: payload.allowedDivisions,
      isPlatformAdmin:  payload.isPlatformAdmin,
    },
  });
};
