'use strict';

/**
 * scripts/import-dust-rows.js
 *
 * Bulk-imports historical dust control tracking rows from CSV directly into
 * the Neon database so dust.html picks them up immediately.
 *
 * Usage:
 *   node scripts/import-dust-rows.js --list-keys
 *     Show all dust_* keys in the DB so you can find your company code.
 *
 *   node scripts/import-dust-rows.js --company <code> --csv <file.csv> [--csv <file2.csv>]
 *     Import one or more CSV files. Merges with existing rows (skips duplicates).
 *
 *   node scripts/import-dust-rows.js --company <code> --csv <file.csv> --dry-run
 *     Parse and preview without writing anything.
 *
 *   node scripts/import-dust-rows.js --company <code> --csv <file.csv> --replace
 *     Replace ALL existing rows instead of merging.
 *
 * Expected CSV columns (tab or comma delimited, header row required):
 *   Date, Start Time, End Time, Total Time, Conversion,
 *   Company, Company Man, Location, State,
 *   Vehicle 1, Unit #, Vehicle Rate, Vehicle #1 Total,
 *   Vehicle 2, Unit #, Vehicle Rate, Vehicle #2 Total,
 *   Vehicle Total $, Gallons of UB, UB Gallon Total $, Invoice Total
 *
 * Calculated columns (Total Time, Vehicle #1 Total, etc.) are ignored —
 * the app recomputes them from raw values at display time.
 */

// Load env from api/.env (where DATABASE_URL lives) with fallback to root .env
require('dotenv').config({ path: require('path').join(__dirname, '../api/.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { neon } = require('@neondatabase/serverless');
const fs   = require('fs');
const path = require('path');

// ── CLI arg parsing ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let companyCode = null;
let csvPaths    = [];
let replace     = false;
let dryRun      = false;
let listKeys    = false;

for (let i = 0; i < args.length; i++) {
  if      (args[i] === '--company')   companyCode = args[++i];
  else if (args[i] === '--csv')       csvPaths.push(args[++i]);
  else if (args[i] === '--replace')   replace  = true;
  else if (args[i] === '--dry-run')   dryRun   = true;
  else if (args[i] === '--list-keys') listKeys = true;
}

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set.');
  console.error('Make sure api/.env contains: DATABASE_URL=postgresql://...');
  process.exit(1);
}

const sql = neon(process.env.DATABASE_URL);

// ── Helpers ────────────────────────────────────────────────────────────────
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
  console.warn(`  [warn] Unrecognized date format: "${raw}" — storing as-is`);
  return s;
}

/** Normalizes to HH:MM (24h). Handles "7:00", "07:00", "7:00 AM", "3:30 PM". */
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
    const isPM = ap[3].toUpperCase() === 'PM';
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${ap[2]}`;
  }
  console.warn(`  [warn] Unrecognized time format: "${raw}" — storing as-is`);
  return s;
}

/** Strips $, commas, spaces and returns a number or '' if empty/invalid. */
function parseNum(raw) {
  if (!raw || !String(raw).trim()) return '';
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return isNaN(n) ? '' : n;
}

/** Auto-detect tab vs comma delimiter from the header line. */
function detectDelimiter(line) {
  const tabs   = (line.match(/\t/g) || []).length;
  const commas = (line.match(/,/g)  || []).length;
  return tabs > commas ? '\t' : ',';
}

/** Split a CSV line respecting double-quoted fields. */
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

// ── CSV → row objects ──────────────────────────────────────────────────────
function parseCSVFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines   = content.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    console.warn(`  [warn] ${path.basename(filePath)}: empty or header-only — skipping`);
    return [];
  }

  const delim = detectDelimiter(lines[0]);

  // Normalize header text: lowercase, collapse whitespace, strip trailing #
  const norm    = s => s.toLowerCase().replace(/\s+/g, ' ').replace(/#/g, '').trim();
  const headers = parseCSVLine(lines[0], delim).map(norm);

  // "unit " and "vehicle rate" each appear twice — resolve by occurrence index
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
    v1_unit:     findIdx('unit', 0),           // "Unit #" → "unit"
    v1_rate:     findIdx('vehicle rate', 0),
    vehicle2:    findIdx('vehicle 2'),
    v2_unit:     findIdx('unit', 1),
    v2_rate:     findIdx('vehicle rate', 1),
    gallons_ub:  findIdx('gallons of ub'),
  };

  console.log(`\n  Column mapping for ${path.basename(filePath)}:`);
  Object.entries(COL).forEach(([k, v]) => {
    if (v < 0) console.warn(`    ⚠  "${k}" not found in headers — will be blank`);
    else        console.log( `    ✓  "${k}" → col ${v} ("${headers[v]}")`);
  });

  const get = (cols, idx) => (idx >= 0 && idx < cols.length) ? cols[idx] : '';

  const parsed = [];
  for (let li = 1; li < lines.length; li++) {
    const cols = parseCSVLine(lines[li], delim);
    if (cols.every(c => !c)) continue; // skip blank rows
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

  // --list-keys: discover company codes in the DB
  if (listKeys) {
    console.log('Scanning app_data for dust_rows keys…\n');
    const result = await sql`
      SELECT key, updated_at,
             jsonb_array_length(CASE WHEN jsonb_typeof(value) = 'array' THEN value ELSE '[]'::jsonb END) AS row_count
      FROM app_data
      WHERE key LIKE '%:dust_rows'
      ORDER BY key
    `;
    if (!result.length) {
      console.log('No dust_rows keys found in DB yet.');
      console.log('The key is created automatically when dust.html first saves data.');
    } else {
      console.log('Found dust_rows entries:');
      result.forEach(r => {
        const code = r.key.replace(':dust_rows', '');
        console.log(`  company code: "${code}"  →  ${r.row_count} rows  (updated ${r.updated_at})`);
      });
    }
    console.log('\nUse: node scripts/import-dust-rows.js --company <code> --csv <file.csv>');
    return;
  }

  if (!companyCode) {
    console.error('Error: --company <code> is required.\n');
    console.error('Run with --list-keys first to find your company code:');
    console.error('  node scripts/import-dust-rows.js --list-keys\n');
    console.error('Then import:');
    console.error('  node scripts/import-dust-rows.js --company <code> --csv ./2024.csv --csv ./2025.csv');
    process.exit(1);
  }

  if (!csvPaths.length) {
    console.error('Error: at least one --csv <path> is required.');
    process.exit(1);
  }

  // Expand directories to .csv files
  const files = [];
  for (const p of csvPaths) {
    const resolved = path.resolve(p);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
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

  // Parse all CSV files
  let incoming = [];
  for (const f of files) {
    console.log(`\nParsing: ${f}`);
    const parsed = parseCSVFile(f);
    console.log(`  → ${parsed.length} data rows parsed`);
    incoming = incoming.concat(parsed);
  }

  console.log(`\nTotal rows from all CSVs: ${incoming.length}`);
  if (!incoming.length) { console.log('Nothing to import.'); return; }

  if (dryRun) {
    console.log('\n── DRY RUN — first 5 rows preview ──');
    incoming.slice(0, 5).forEach((r, i) => {
      console.log(`  [${i + 1}] ${r.date || '(no date)'}  ${r.start_time}-${r.end_time}  ` +
        `${r.company || '(no company)'}  /  ${r.vehicle1 || '—'}  gal:${r.gallons_ub || 0}`);
    });
    console.log('\nDRY RUN complete — no changes written to the database.');
    return;
  }

  const scopedKey = `${companyCode}:dust_rows`;
  let existing = [];

  if (!replace) {
    console.log(`\nFetching existing rows from DB (key: ${scopedKey})…`);
    const result = await sql`SELECT value FROM app_data WHERE key = ${scopedKey}`;
    if (result.length && Array.isArray(result[0].value)) {
      existing = result[0].value;
      console.log(`  ${existing.length} existing rows found`);
    } else {
      console.log('  No existing rows found — this will be a fresh import');
    }
  } else {
    console.log('\n--replace flag set: all existing rows will be discarded');
  }

  // Deduplicate: skip rows that already exist (matched by date + company + start_time)
  const existingKeys = new Set(
    existing.map(r => `${r.date}|${(r.company || '').toLowerCase()}|${r.start_time}`)
  );
  const newRows = incoming.filter(r => {
    const k = `${r.date}|${(r.company || '').toLowerCase()}|${r.start_time}`;
    return !existingKeys.has(k);
  });

  const skipped = incoming.length - newRows.length;
  if (skipped > 0) console.log(`  Skipped ${skipped} duplicate rows (same date + company + start time)`);
  console.log(`  Writing ${newRows.length} new rows`);

  if (!newRows.length && !replace) {
    console.log('\nAll rows already exist in the database. Nothing to do.');
    return;
  }

  const merged = replace ? incoming : [...existing, ...newRows];
  merged.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  await sql`
    INSERT INTO app_data (key, value, updated_at)
    VALUES (${scopedKey}, ${JSON.stringify(merged)}::jsonb, NOW())
    ON CONFLICT (key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;

  // Print year breakdown
  const byYear = {};
  merged.forEach(r => {
    const y = (r.date || '').slice(0, 4) || '(unknown)';
    byYear[y] = (byYear[y] || 0) + 1;
  });
  console.log('\nRows by year:');
  Object.keys(byYear).sort().forEach(y => console.log(`  ${y}: ${byYear[y]} rows`));
  console.log(`\nDone! ${merged.length} total rows now in the database.`);
  console.log('Refresh dust.html to see the imported data.');
}

main().catch(err => {
  console.error('\nImport failed:', err.message);
  process.exit(1);
});
