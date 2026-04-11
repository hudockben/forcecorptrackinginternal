'use strict';

/**
 * scripts/import-dust-rows.js
 *
 * Bulk-imports historical dust control rows from CSV via the live Vercel API.
 * No database credentials needed — uses the same JWT token your browser uses.
 *
 * ── Setup ──────────────────────────────────────────────────────────────────
 * 1. Open dust.html in your browser and log in.
 * 2. Open DevTools → Console and run:
 *      localStorage.getItem('fct_token')
 *    Copy the token string.
 * 3. Run this script:
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   node scripts/import-dust-rows.js \
 *     --url   https://your-app.vercel.app \
 *     --token eyJhbGc... \
 *     --csv   ./2024.csv \
 *     --csv   ./2025.csv
 *
 *   # Preview without writing anything:
 *   node scripts/import-dust-rows.js --url ... --token ... --csv ... --dry-run
 *
 *   # Replace ALL existing rows instead of merging:
 *   node scripts/import-dust-rows.js --url ... --token ... --csv ... --replace
 *
 * ── Expected CSV columns ───────────────────────────────────────────────────
 *   Date, Start Time, End Time, Total Time, Conversion,
 *   Company, Company Man, Location, State,
 *   Vehicle 1, Unit #, Vehicle Rate, Vehicle #1 Total,
 *   Vehicle 2, Unit #, Vehicle Rate, Vehicle #2 Total,
 *   Vehicle Total $, Gallons of UB, UB Gallon Total $, Invoice Total
 *
 *   Tab or comma delimited. Calculated columns are ignored (the app recomputes them).
 */

const fs   = require('fs');
const path = require('path');

// ── CLI arg parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let appUrl      = null;
let token       = null;
let csvPaths    = [];
let replace     = false;
let dryRun      = false;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === '--url')     appUrl   = args[++i];
  else if (args[i] === '--token')   token    = args[++i];
  else if (args[i] === '--csv')     csvPaths.push(args[++i]);
  else if (args[i] === '--replace') replace  = true;
  else if (args[i] === '--dry-run') dryRun   = true;
}

if (!appUrl || !token) {
  console.error('');
  console.error('Usage:');
  console.error('  node scripts/import-dust-rows.js \\');
  console.error('    --url   https://your-app.vercel.app \\');
  console.error('    --token <jwt-token> \\');
  console.error('    --csv   ./2024.csv [--csv ./2025.csv]');
  console.error('');
  console.error('Get your token from the browser console:');
  console.error('  localStorage.getItem(\'fct_token\')');
  console.error('');
  process.exit(1);
}
if (!csvPaths.length) {
  console.error('Error: at least one --csv <path> is required.');
  process.exit(1);
}

// Normalize base URL (strip trailing slash)
const BASE = appUrl.replace(/\/$/, '');

// ── API helpers ────────────────────────────────────────────────────────────
async function apiGet(key) {
  const url = `${BASE}/api/data/${key}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    console.error('Error: token rejected (401). Copy a fresh token from localStorage.');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  const { value } = await res.json();
  return value;
}

async function apiPut(key, value) {
  const url = `${BASE}/api/data/${key}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) throw new Error(`PUT ${url} → ${res.status} ${res.statusText}`);
}

// ── CSV helpers ────────────────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** MM/DD/YYYY or M/D/YYYY → YYYY-MM-DD. Passes through YYYY-MM-DD unchanged. */
function normalizeDate(raw) {
  if (!raw || !String(raw).trim()) return '';
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  console.warn(`  [warn] Unrecognized date: "${raw}" — stored as-is`);
  return s;
}

/** Normalizes to HH:MM 24h. Handles "7:00", "07:00", "7:00 AM", "3:30 PM". */
function normalizeTime(raw) {
  if (!raw || !String(raw).trim()) return '';
  const s = String(raw).trim();
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  }
  const ap = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (ap) {
    let h = parseInt(ap[1], 10);
    if (ap[3].toUpperCase() === 'PM' && h !== 12) h += 12;
    if (ap[3].toUpperCase() === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${ap[2]}`;
  }
  console.warn(`  [warn] Unrecognized time: "${raw}" — stored as-is`);
  return s;
}

/** Strips $, commas; returns number or '' if blank/invalid. */
function parseNum(raw) {
  if (!raw || !String(raw).trim()) return '';
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return isNaN(n) ? '' : n;
}

function detectDelimiter(line) {
  const tabs   = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g)  || []).length;
  return tabs > commas ? '\t' : ',';
}

function parseCSVLine(line, delim) {
  const cols = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      cols.push(cur.trim()); cur = '';
    } else cur += ch;
  }
  cols.push(cur.trim());
  return cols;
}

function parseCSVFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines   = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    console.warn(`  [warn] ${path.basename(filePath)}: empty or header-only — skipping`);
    return [];
  }

  const delim   = detectDelimiter(lines[0]);
  const norm    = s => s.toLowerCase().replace(/\s+/g, ' ').replace(/#/g, '').trim();
  const headers = parseCSVLine(lines[0], delim).map(norm);

  // "unit" and "vehicle rate" each appear twice — resolve by occurrence
  const findIdx = (name, occ = 0) => {
    let count = 0;
    for (let i = 0; i < headers.length; i++) {
      if (headers[i] === name) { if (count === occ) return i; count++; }
    }
    return -1;
  };

  const COL = {
    date:        findIdx('date'),
    start_time:  findIdx('start time'),
    end_time:    findIdx('end time'),
    company:     findIdx('company'),
    company_man: findIdx('company man'),
    location:    findIdx('location'),
    state:       findIdx('state'),
    vehicle1:    findIdx('vehicle 1'),
    v1_unit:     findIdx('unit', 0),
    v1_rate:     findIdx('vehicle rate', 0),
    vehicle2:    findIdx('vehicle 2'),
    v2_unit:     findIdx('unit', 1),
    v2_rate:     findIdx('vehicle rate', 1),
    gallons_ub:  findIdx('gallons of ub'),
  };

  console.log(`\n  Column mapping for ${path.basename(filePath)}:`);
  Object.entries(COL).forEach(([k, v]) => {
    if (v < 0) console.warn(`    ⚠  "${k}" not found — will be blank`);
    else        console.log( `    ✓  "${k}" → col ${v} ("${headers[v]}")`);
  });

  const get = (cols, idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : '';

  const parsed = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCSVLine(lines[li], delim);
    if (cols.every(c => !c)) continue;
    parsed.push({
      id:          uid(),
      date:        normalizeDate(get(cols, COL.date)),
      start_time:  normalizeTime(get(cols, COL.start_time)),
      end_time:    normalizeTime(get(cols, COL.end_time)),
      company:     get(cols, COL.company),
      company_man: get(cols, COL.company_man),
      location:    get(cols, COL.location),
      state:       get(cols, COL.state),
      vehicle1:    get(cols, COL.vehicle1),
      v1_unit:     get(cols, COL.v1_unit),
      v1_rate:     parseNum(get(cols, COL.v1_rate)),
      vehicle2:    get(cols, COL.vehicle2),
      v2_unit:     get(cols, COL.v2_unit),
      v2_rate:     parseNum(get(cols, COL.v2_rate)),
      gallons_ub:  parseNum(get(cols, COL.gallons_ub)),
    });
  }
  return parsed;
}

// ── Main ───────────────────────────────────────────────────────────────────
async function main() {

  // Expand any directory paths to .csv files
  const files = [];
  for (const p of csvPaths) {
    const resolved = path.resolve(p);
    if (fs.statSync(resolved).isDirectory()) {
      fs.readdirSync(resolved)
        .filter(f => f.toLowerCase().endsWith('.csv'))
        .sort()
        .forEach(f => files.push(path.join(resolved, f)));
    } else {
      files.push(resolved);
    }
  }
  if (!files.length) {
    console.error('No .csv files found at the specified paths.');
    process.exit(1);
  }

  // Parse CSV files
  let incoming = [];
  for (const f of files) {
    console.log(`\nParsing: ${f}`);
    const parsed = parseCSVFile(f);
    console.log(`  → ${parsed.length} data rows`);
    incoming = incoming.concat(parsed);
  }

  console.log(`\nTotal rows from CSV: ${incoming.length}`);
  if (!incoming.length) { console.log('Nothing to import.'); return; }

  if (dryRun) {
    console.log('\n── DRY RUN — first 5 rows ──');
    incoming.slice(0, 5).forEach((r, i) => {
      console.log(`  [${i + 1}] ${r.date || '(no date)'}  ${r.start_time}–${r.end_time}  ` +
        `"${r.company || '(no company)'}"  v1: ${r.vehicle1 || '—'}  gal: ${r.gallons_ub || 0}`);
    });
    console.log('\nDRY RUN complete — nothing written.');
    return;
  }

  // Fetch existing rows via API
  let existing = [];
  if (!replace) {
    process.stdout.write(`\nFetching existing rows from ${BASE}… `);
    const saved = await apiGet('dust_rows');
    existing = Array.isArray(saved) ? saved : [];
    console.log(`${existing.length} rows found`);
  } else {
    console.log('\n--replace: discarding all existing rows');
  }

  // Deduplicate by date + company + start_time
  const existingKeys = new Set(
    existing.map(r => `${r.date}|${(r.company || '').toLowerCase()}|${r.start_time}`)
  );
  const newRows = incoming.filter(r => {
    const k = `${r.date}|${(r.company || '').toLowerCase()}|${r.start_time}`;
    return !existingKeys.has(k);
  });

  const skipped = incoming.length - newRows.length;
  if (skipped > 0) console.log(`  Skipped ${skipped} duplicates (same date + company + start time)`);
  console.log(`  Adding ${newRows.length} new rows`);

  if (!newRows.length && !replace) {
    console.log('\nAll rows already exist. Nothing to write.');
    return;
  }

  const merged = replace ? incoming : [...existing, ...newRows];
  merged.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  process.stdout.write(`Uploading ${merged.length} rows to ${BASE}… `);
  await apiPut('dust_rows', merged);
  console.log('done.');

  // Year summary
  const byYear = {};
  merged.forEach(r => {
    const y = (r.date || '').slice(0, 4) || '(unknown)';
    byYear[y] = (byYear[y] || 0) + 1;
  });
  console.log('\nRows by year in DB:');
  Object.keys(byYear).sort().forEach(y => console.log(`  ${y}: ${byYear[y]} rows`));
  console.log(`\nDone! Refresh dust.html to see the data.`);
}

main().catch(err => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
