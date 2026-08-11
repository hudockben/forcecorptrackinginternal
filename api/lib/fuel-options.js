'use strict';
/**
 * The fixed option lists behind the Fuel Submissions form.
 *
 * This file is the CANONICAL copy. fuel.html and fuel-admin.html carry their
 * own copies because they are static pages with no build step and cannot
 * require() anything — scripts/test-fuel-submissions.js lifts the arrays back
 * out of both pages and fails if they have drifted from these. Change a list
 * here and the test tells you which page still disagrees.
 *
 * Why it matters: the server refuses a submit whose fuel_card or state is not
 * in these lists. A value that exists only in a page's copy is one a worker
 * can pick and then be refused for picking, with nothing on screen explaining
 * why — so the two must not be allowed to drift quietly.
 */

// Spelled exactly as the office asked for them. "Bulk Fuel – No card" carries
// an EN DASH (–), not a hyphen: it is a stored value, so the character is part
// of the data and both pages must reproduce it byte for byte.
const FUEL_CARDS = ['Guttman', 'Satterlee', 'Wex', 'Bulk Fuel – No card'];

const FUEL_TYPES = ['Diesel', 'Off Road Diesel', 'On Road', 'Gas'];

// Stored as the 2-letter code; both pages show the full name in the picker and
// the code in their tables. DC is included — crews cross into it — and the
// territories are not, which is the line the rest of the app draws too.
const US_STATES = [
  { code: 'AL', name: 'Alabama' },        { code: 'AK', name: 'Alaska' },
  { code: 'AZ', name: 'Arizona' },        { code: 'AR', name: 'Arkansas' },
  { code: 'CA', name: 'California' },     { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' },    { code: 'DE', name: 'Delaware' },
  { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' },        { code: 'GA', name: 'Georgia' },
  { code: 'HI', name: 'Hawaii' },         { code: 'ID', name: 'Idaho' },
  { code: 'IL', name: 'Illinois' },       { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' },           { code: 'KS', name: 'Kansas' },
  { code: 'KY', name: 'Kentucky' },       { code: 'LA', name: 'Louisiana' },
  { code: 'ME', name: 'Maine' },          { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' },  { code: 'MI', name: 'Michigan' },
  { code: 'MN', name: 'Minnesota' },      { code: 'MS', name: 'Mississippi' },
  { code: 'MO', name: 'Missouri' },       { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' },       { code: 'NV', name: 'Nevada' },
  { code: 'NH', name: 'New Hampshire' },  { code: 'NJ', name: 'New Jersey' },
  { code: 'NM', name: 'New Mexico' },     { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' },
  { code: 'OH', name: 'Ohio' },           { code: 'OK', name: 'Oklahoma' },
  { code: 'OR', name: 'Oregon' },         { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' },   { code: 'SC', name: 'South Carolina' },
  { code: 'SD', name: 'South Dakota' },   { code: 'TN', name: 'Tennessee' },
  { code: 'TX', name: 'Texas' },          { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' },        { code: 'VA', name: 'Virginia' },
  { code: 'WA', name: 'Washington' },     { code: 'WV', name: 'West Virginia' },
  { code: 'WI', name: 'Wisconsin' },      { code: 'WY', name: 'Wyoming' },
];

const US_STATE_CODES = US_STATES.map(s => s.code);

module.exports = { FUEL_CARDS, FUEL_TYPES, US_STATES, US_STATE_CODES };
