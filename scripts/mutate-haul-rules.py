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
  "const offSiteHaul = e.haul_type === 'off_site';","const offSiteHaul = false;",
  "scripts/test-haul-prevailing.js"),
 ("payroll-metrics: on_site wrongly excluded too","api/lib/payroll-metrics.js",
  "const offSiteHaul = e.haul_type === 'off_site';","const offSiteHaul = !!e.haul_type;",
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
  "if (String(r.equipment || '').trim() && (Number(r.equip_hours) || 0) > 0) return;",
  "if (String(r.equipment || '').trim()) return;","scripts/test-haul-unpriced-warning.js"),
 ("regex: back to the over-broad form","api/timesheet-entries.js",
  "const HAUL_FIELD_TYPE_RE = /^haul\\s*[—–-]\\s/i;","const HAUL_FIELD_TYPE_RE = /^haul\\b/i;",
  "scripts/test-haul-unpriced-warning.js"),
 ("timesheet: render mutates state again","timesheet.html",
  "        if (isDriver) setHaul(haulVals[b] || '', b);\n        else applyHaulUnitVisibility(b);",
  "        if (isDriver) setHaul(haulVals[b] || '', b);\n        else { haulVals[b] = ''; applyHaulUnitVisibility(b); }",
  "scripts/test-haul-timesheet-state.js"),
 ("cost grid: blank a haul row's rate instead of showing 0","tracker.html",
  "  return HAUL_FIELD_TYPE_RE.test((row.field_type || '').trim()) ? 0 : (autoRate || '');",
  "  return autoRate || '';",
  "scripts/test-haul-unpriced-warning.js"),
 ("backfill: leave a stale haul stamp on a row that became travel","api/timesheet-entries.js",
  "          const fieldType = travelRow\n            ? (HAUL_FIELD_TYPE_RE.test(String(r.field_type || '')) ? 'Travel' : (r.field_type || 'Travel'))",
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
  "             travel_to_shop_hours::float AS travel_to_shop_hours,\n             haul_type\n",
  "             travel_to_shop_hours::float AS travel_to_shop_hours\n","scripts/test-executive-layout.js"),
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
