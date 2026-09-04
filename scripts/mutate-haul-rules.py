#!/usr/bin/env python3
"""
Mutation test for the truck-driver hauling rules.

Run: python3 scripts/mutate-haul-rules.py

A green suite proves the tests PASS. It does not prove they would FAIL if the
behaviour broke — and an assertion that cannot fail is worse than none, because
it reads as coverage. This breaks each haul rule in turn, runs the suite that is
supposed to notice, and puts the file back.

Every entry must report OK. A NOT CAUGHT line means that rule is unguarded:
someone can delete it and the suite stays green. Two were found that way and are
now covered:

  * dropping haul_type from a payrollMetrics consumer's explicit SELECT — the
    consumer then silently reports the OLD prevailing split while the others
    report the new one, and nothing errors.
  * the first version of that very guard, which scanned the raw source and
    matched the COMMENT explaining the rule (it contains both "SELECT" and
    "haul_type") rather than the query. The note written to prevent the bug was
    hiding it. Comments are stripped before scanning now.

Every entry must name a test that runs WITHOUT a database. A DB-backed suite
invoked with no PG_TEST_URL exits non-zero for want of a connection, which this
would read as "caught" — marking a rule guarded when nothing checked it.

Anchors are exact source strings, so this file needs updating when the code it
quotes is reformatted. A SKIP line means an anchor no longer matches: that is a
failure to fix, not a pass, and the exit code says so.
"""
import io,subprocess,sys,os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
# (label, file, old, new, test that MUST fail)
MUT=[
 ("insertSplitRows: stop zeroing the haul rate","api/timesheet-entries.js",
  "${isHaulRow ? 0 : (isTravel ? travelRate : workRate)},",
  "${isTravel ? travelRate : workRate},","scripts/test-injection-autofill.js"),
 ("insertSplitRows: stop stamping field_type","api/timesheet-entries.js",
  "const fieldType = isTravel ? 'Travel' : (isHaulRow ? HAUL_FIELD_TYPE[haulType] : null);",
  "const fieldType = isTravel ? 'Travel' : null;","scripts/test-injection-autofill.js"),
 ("payroll-metrics: off_site counts as prevailing again","api/lib/payroll-metrics.js",
  "  if (!e || e.haul_type !== 'off_site') return 0;","  if (true) return 0;",
  "scripts/test-haul-prevailing.js"),
 ("payroll-metrics: on_site wrongly excluded too","api/lib/payroll-metrics.js",
  "  if (!e || e.haul_type !== 'off_site') return 0;","  if (!e || !e.haul_type) return 0;",
  "scripts/test-haul-prevailing.js"),
 ("payroll-metrics: an unsplit day stops moving any hours","api/lib/payroll-metrics.js",
  "  if (e.haul_hours == null) return work;","  if (e.haul_hours == null) return 0;",
  "scripts/test-haul-prevailing.js"),
 ("payroll-metrics: the hauled hours stop leaving prevailing","api/lib/payroll-metrics.js",
  "          acc.pwHours  += work - haulWork;","          acc.pwHours  += work;",
  "scripts/test-haul-prevailing.js"),
 ("backfill: stop zeroing haul rows","api/timesheet-entries.js",
  "const rate      = haulType\n            ? 0\n            : resolver.rateFor(emp, !travelRow && !!pwFlags.get(String(r.job_id)));",
  "const rate      = resolver.rateFor(emp, !travelRow && !!pwFlags.get(String(r.job_id)));",
  "scripts/test-injection-autofill.js"),
 ("tracker: production rates count haul hours again","tracker.html",
  "const site_hours = Math.max(0, a.labor_hours - (a.haul_hours || 0));",
  "const site_hours = a.labor_hours;","scripts/test-cost-averages.js"),
 ("tracker: PV preview reprices haul rows again","tracker.html",
  "  const _pvRow       = pvPreview.active && pvPreview.rate > 0\n    && !HAUL_FIELD_TYPE_RE.test(String(row.field_type || '').trim());",
  "  const _pvRow       = pvPreview.active && pvPreview.rate > 0;",
  "scripts/test-mathis.js"),
 ("warning: back to name-only check","payroll.html",
  "        && (Number(r && r.equip_hours) || 0) > 0;",
  "        ;","scripts/test-haul-unpriced-warning.js"),
 ("warning: flag every row again, not only the claimed hauls","payroll.html",
  "        if (!splitRowIsHaul(r)) return;","        if (isTravelSplitRow(r)) return;",
  "scripts/test-haul-unpriced-warning.js"),
 ("regex: back to the over-broad form","api/timesheet-entries.js",
  "const HAUL_FIELD_TYPE_RE = /^haul\\s*[—–-]\\s/i;","const HAUL_FIELD_TYPE_RE = /^haul\\b/i;",
  "scripts/test-haul-unpriced-warning.js"),
 ("timesheet: render mutates state again","timesheet.html",
  "        if (isDriver) renderHaul(b);\n        applyHaulUnitVisibility(b);",
  "        if (isDriver) { haulVals[b] = haulVals[b] || ''; renderHaul(b); }\n        applyHaulUnitVisibility(b);",
  "scripts/test-haul-timesheet-state.js"),
 ("timesheet: put the pre-lit \"No\" back","timesheet.html",
  "    let haulVals       = { 0: null };","    let haulVals       = { 0: '' };",
  "scripts/test-haul-timesheet-state.js"),
 ("timesheet: let a blank haul answer save","timesheet.html",
  "        if (isDriver && haulVals[i] == null) {","        if (false) {",
  "scripts/test-haul-timesheet-state.js"),
 ("cost grid: blank a haul row's rate instead of showing 0","tracker.html",
  "  return HAUL_FIELD_TYPE_RE.test((row.field_type || '').trim()) ? 0 : (autoRate || '');",
  "  return autoRate || '';",
  "scripts/test-haul-unpriced-warning.js"),
 ("backfill: leave a stale haul stamp on a row that became travel","api/timesheet-entries.js",
  "          const fieldType = travelRow\n            ? (stamped ? 'Travel' : (r.field_type || 'Travel'))",
  "          const fieldType = travelRow\n            ? (r.field_type || 'Travel')",
  "scripts/test-injection-autofill.js"),
 ("split modal: ignore the truck the driver named","payroll.html",
  "      const said = String((splitEntry && splitEntry.truck_unit) || '').trim();\n      if (said) { r.equipment = said; r._haulAutoEquip = true; return true; }\n",
  "",
  "scripts/test-haul-unpriced-warning.js"),
 ("split modal: write the picker onto the cached grid entry again","payroll.html",
  "      splitHaulAnswer = el.value || '';",
  "      splitEntry.haul_type = el.value || null;",
  "scripts/test-haul-unpriced-warning.js"),
 ("split modal: stop taking back what it guessed","payroll.html",
  "        changed = splitClearHaulAuto(r)        || changed;\n",
  "",
  "scripts/test-haul-unpriced-warning.js"),
 ("resplit: treat approved equipment hours as untouched again","payroll.html",
  "          _equipHoursTouched: true,",
  "          _equipHoursTouched: false,",
  "scripts/test-haul-unpriced-warning.js"),
 ("split modal: stop following the driver's hours with the truck's","payroll.html",
  "      const want = Number(r.labor_hours) || 0;",
  "      const want = Number(r.equip_hours) || 0;",
  "scripts/test-haul-unpriced-warning.js"),
 ("split modal: guess a truck when the job assigns several","payroll.html",
  "      if (only.length !== 1) return false;",
  "      if (only.length < 1) return false;",
  "scripts/test-haul-unpriced-warning.js"),
 ("mathis: drop haul_type from the digest SELECT","api/lib/mathis-digests.js",
  "             haul_type,\n             haul_hours::float           AS haul_hours\n",
  "             haul_hours::float           AS haul_hours\n","scripts/test-executive-layout.js"),
 ("mathis: drop haul_hours from the digest SELECT","api/lib/mathis-digests.js",
  "             haul_type,\n             haul_hours::float           AS haul_hours\n",
  "             haul_type\n","scripts/test-executive-layout.js"),
 ("executive: drop haul_hours from the report SELECT","api/executive/report.js",
  "      haul_type,\n      haul_hours::float                  AS haul_hours\n",
  "      haul_type\n","scripts/test-executive-layout.js"),

 # ── the per-row rule ──────────────────────────────────────────────────────
 # Each of these puts the day-level answer back in some form: the whole day
 # priced as one haul, which is what zeroed a driver's site labour.
 ("per-row: every row on a haul day is a haul again","api/timesheet-entries.js",
  "    const isHaulRow = !isTravel && isHaulWorkRow(r, haulType, entry);",
  "    const isHaulRow = !isTravel && !!haulType;","scripts/test-injection-autofill.js"),
 ("per-row: any machine counts as the truck again","api/timesheet-entries.js",
  "  const said = String((entry && entry.truck_unit) || '').trim();\n  if (!said) return true;\n  return String(row.equipment).trim().toLowerCase() === said.toLowerCase();",
  "  return true;","scripts/test-haul-row-rate.js"),
 ("per-row: a priced machine is confused with the named truck again","api/timesheet-entries.js",
  "  return pricedMachineOnRow(row) && !truckOnRow(row, entry);",
  "  return false;","scripts/test-haul-row-rate.js"),
 ("warning: ask for the named truck instead of any priced machine","payroll.html",
  "        if (splitPricedMachineOnRow(r)) return;",
  "        if (splitTruckOnRow(r)) return;","scripts/test-haul-unpriced-warning.js"),
 ("warning: stop surfacing a machine that is not the named truck","payroll.html",
  "      const odd = splitUnnamedMachineRows();","      const odd = [];",
  "scripts/test-haul-unpriced-warning.js"),
 ("per-row: the approver's tick is ignored","api/timesheet-entries.js",
  "  if (row && row.is_haul === true)  return true;\n  if (row && row.is_haul === false) return false;",
  "",  "scripts/test-haul-row-rate.js"),
 ("per-row: the stored exemption is dropped on insert","api/timesheet-entries.js",
  "        ${r.is_haul === false}","        ${false}","scripts/test-haul-row-rate.js"),
 ("sweep: ignore the stored exemption and re-haul the row","api/timesheet-entries.js",
  "  if (row && row.haul_exempt === true) return { is_haul: false };","",
  "scripts/test-haul-unpriced-warning.js"),
 ("stored answer: let haul_exempt outrank the stamp","api/timesheet-entries.js",
  "  if (HAUL_FIELD_TYPE_RE.test(String((row && row.field_type) || ''))) return { is_haul: true };\n  if (row && row.haul_exempt === true) return { is_haul: false };",
  "  if (row && row.haul_exempt === true) return { is_haul: false };\n  if (HAUL_FIELD_TYPE_RE.test(String((row && row.field_type) || ''))) return { is_haul: true };",
  "scripts/test-haul-unpriced-warning.js"),
 ("sweep: stop adjusting a stale haul_hours","api/timesheet-entries.js",
  "            seen.delta += (haulType ? 1 : -1) * (Number(r.labor_hours) || 0);","",
  "scripts/test-haul-row-rate.js"),
 ("sweep: clear haul_hours instead of adjusting it","api/timesheet-entries.js",
  "                COALESCE(haul_hours, ${work}::numeric) + ${_r2(moved.delta)}::numeric",
  "                NULL","scripts/test-haul-row-rate.js"),
 ("sweep: stop naming whose prevailing split moved","api/timesheet-entries.js",
  "        reclassified,\n","","scripts/test-haul-row-rate.js"),
 ("resplit: hand every row back as a deliberate 'not a haul'","api/timesheet-entries.js",
  "          ...storedHaulAnswer(r),","          is_haul: false,","scripts/test-haul-row-rate.js"),
 ("approve: stop recording how much of the day was hauled","api/timesheet-entries.js",
  "      const haulHours = splitRows ? haulWorkHoursOf(existing, splitRows) : null;",
  "      const haulHours = null;","scripts/test-haul-row-rate.js"),
]
caught=missed=skipped=0
for label,f,old,new,test in MUT:
    s=io.open(f,encoding='utf-8').read()
    if s.count(old)!=1:
        print(f"  ??  SKIP (anchor x{s.count(old)}): {label}"); skipped+=1; continue
    # try/finally, so a hung test, a timeout or a Ctrl-C cannot leave a
    # deliberately broken source file on disk — which would be a silent,
    # committable regression in the working tree.
    io.open(f,'w',encoding='utf-8').write(s.replace(old,new,1))
    try:
        r=subprocess.run(['node',test],capture_output=True,text=True,timeout=400)
        rc=r.returncode
    except subprocess.TimeoutExpired:
        rc=None
    finally:
        io.open(f,'w',encoding='utf-8').write(s)
    if rc is None:
        print(f"  ??  TIMEOUT running {test.split('/')[-1]}: {label}"); missed+=1
    elif rc!=0: print(f"  OK  caught by {test.split('/')[-1]}: {label}"); caught+=1
    else: print(f"  !!  NOT CAUGHT by {test.split('/')[-1]}: {label}"); missed+=1
print(f"\ncaught {caught} | MISSED {missed} | skipped {skipped}")
sys.exit(1 if (missed or skipped) else 0)
