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
  "        if (isDriver) setHaul(haulVals[b] || '', b);\n      }",
  "        if (isDriver) setHaul(haulVals[b] || '', b);\n        else          haulVals[b] = '';\n      }",
  "scripts/test-haul-timesheet-state.js"),
 ("mathis: drop haul_type from the digest SELECT","api/lib/mathis-digests.js",
  "             travel_to_shop_hours::float AS travel_to_shop_hours,\n             haul_type\n",
  "             travel_to_shop_hours::float AS travel_to_shop_hours\n","scripts/test-executive-layout.js"),
]
caught=missed=skipped=0
for label,f,old,new,test in MUT:
    s=io.open(f,encoding='utf-8').read()
    if s.count(old)!=1:
        print(f"  ??  SKIP (anchor x{s.count(old)}): {label}"); skipped+=1; continue
    io.open(f,'w',encoding='utf-8').write(s.replace(old,new,1))
    r=subprocess.run(['node',test],capture_output=True,text=True,timeout=400)
    io.open(f,'w',encoding='utf-8').write(s)
    if r.returncode!=0: print(f"  OK  caught by {test.split('/')[-1]}: {label}"); caught+=1
    else: print(f"  !!  NOT CAUGHT by {test.split('/')[-1]}: {label}"); missed+=1
print(f"\ncaught {caught} | MISSED {missed} | skipped {skipped}")
import sys; sys.exit(1 if (missed or skipped) else 0)
