'use strict';
/**
 * GET /api/cron/crm-news-catchup — the second of the morning's two pulls.
 *
 * Seven regions do not fit in one 300-second run; the budget holds four or
 * five. So the same job runs twice, ninety minutes apart, and because
 * api/cron/crm-news.js works stalest-first the second run picks up exactly
 * the regions the first did not reach — and retries any that failed, since a
 * failure leaves no timestamp and sorts to the front.
 *
 * It is a separate path only because Vercel keys a cron by its path and will
 * not schedule the same one twice. The behaviour is identical, deliberately:
 * two entry points to one job, not two jobs that have to agree about which
 * half of the work is theirs.
 */
module.exports = require('./crm-news');
