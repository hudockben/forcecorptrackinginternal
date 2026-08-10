'use strict';

/**
 * The `source` tags carried by rows in the shared intercompany billing blob
 * (fct_intercompany_billing_entries → intercompany_billing_entries).
 *
 * Dust Control bills from three separate tabs, each mirroring into the same
 * blob under its own tag. Anything that wants "all of Dust Control" has to
 * name every one of them, and twice now a query listed only some — the
 * executive report's unbilled-dust figure understated the division while the
 * AR and top-customer figures beside it, which filter on nothing, counted all
 * three. Enumerating them here means a new dust tab is added in one place.
 *
 * intercompany.html carries its own copy of DUST (it is a static page and
 * cannot require this). scripts/test-ic-sources.js fails if the two disagree,
 * so the duplication cannot silently drift.
 */

const IC_SOURCES = {
  TRUCKING:          'trucking',
  DUST_TRACKING:     'dust',
  DUST_OTHER_BILLING:'dust-other-billing',
  DUST_EES_OTHER:    'dust-ees-other',
};

// Every tag Dust Control bills under. Order is not significant.
const DUST_IC_SOURCES = [
  IC_SOURCES.DUST_TRACKING,
  IC_SOURCES.DUST_OTHER_BILLING,
  IC_SOURCES.DUST_EES_OTHER,
];

function isDustSource(source) {
  return DUST_IC_SOURCES.includes(String(source || ''));
}

module.exports = { IC_SOURCES, DUST_IC_SOURCES, isDustSource };
