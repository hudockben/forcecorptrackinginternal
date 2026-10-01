/* DataWatch — scheduled-report hook
 *
 * Manage Users → Auto Reports sends reports on a timetable. Nobody is at the
 * keyboard when the 6:30 Daily PM goes out, so the server opens the division
 * page in a headless browser, signed in as the admin who scheduled it, and
 * asks the page for the report through this hook — and the page answers with
 * the same builder its Email Report button calls. That is the point of doing
 * it this way rather than rebuilding the reports on the server: there is one
 * Daily PM report, not a page copy and a server copy drifting apart.
 *
 * The page side, once per page:
 *
 *   dwAutoReport.ready(promise)          // resolves when the page's data is in
 *   dwAutoReport.jobs(() => [{ id, name, jobNumber }])   // the In Progress jobs
 *   dwAutoReport.register(type, async spec => item | item[] | { skip },
 *                         { perJob: true })              // one job per call
 *
 * Most builders are a single line: set up what the button's dialog would have
 * set up, then `return dwAutoReport.capture(() => emailWhateverReport())` —
 * which runs the page's own Email function with the modal swapped for a
 * recorder. So a scheduled send is, quite literally, the Email button pressed
 * at the set time, and an alert() the function raises instead ("No production
 * data found…") comes back as the reason nothing went out.
 *
 * An item is { html, subject, projectId?, projectName?, attachments?, summary? }
 * — exactly what the page would have handed openReportEmailModal. `{ skip }`
 * says there is nothing to send and why ("No daily entries for Oct 4"), which
 * is an answer, not a failure: an empty report is an email people learn to
 * ignore.
 *
 * The server side (api/lib/report-schedule-runner.js) calls two things:
 *
 *   await dwAutoReport.plan(spec)   →  { jobs: null } | { jobs: [{ id, name }] }
 *   await dwAutoReport.build(spec)  →  { items: [...], skipped: [...], errors: [...] }
 *
 * For "every In Progress job" it asks for the jobs, then builds one job per
 * call — each with its own time limit, and sent before the next is built — so
 * a slow job costs that job, not every report already made.
 *
 * spec: { type, projectId ('*' = every In Progress job), start, end, day,
 *         options, timezone }.
 *
 * Loaded on every page that has a schedulable report. It does nothing until
 * build() is called, so a person using the page never runs any of it.
 */
(function () {
  if (window.dwAutoReport) return;

  const registry = Object.create(null);
  let readyPromise = null;
  let jobsFn = null;

  function asArray(v) { return v == null ? [] : (Array.isArray(v) ? v : [v]); }

  // What the email modal does to a report on Send, done here so a scheduled
  // copy is the same email: the DataWatch header stamped on, and the key
  // figures lifted out of the header strip for the email body.
  function finish(item, fallback) {
    let html = String(item.html || '');
    try { if (typeof window.dwBrand === 'function') html = window.dwBrand(html); } catch (_) {}
    let summary = Array.isArray(item.summary) ? item.summary : null;
    if (!summary) {
      try {
        summary = typeof window.dwExtractReportSummary === 'function'
          ? window.dwExtractReportSummary(html) : [];
      } catch (_) { summary = []; }
    }
    return {
      html,
      subject:     item.subject || '',
      projectId:   item.projectId || fallback.projectId || null,
      projectName: item.projectName || fallback.projectName || null,
      attachments: Array.isArray(item.attachments) ? item.attachments.filter(Boolean) : [],
      summary:     Array.isArray(summary) ? summary : [],
    };
  }

  async function runOne(fn, spec, job, out) {
    const label = { projectId: job ? job.id : null, projectName: job ? job.name : null };
    let res;
    try {
      res = await fn(job ? Object.assign({}, spec, { projectId: job.id }) : spec);
    } catch (err) {
      out.errors.push(Object.assign({ error: (err && err.message) || String(err) }, label));
      return;
    }
    for (const r of asArray(res)) {
      if (!r) continue;
      if (r.skip) { out.skipped.push(Object.assign({ why: String(r.skip) }, label, r.projectName ? { projectName: r.projectName } : {})); continue; }
      if (!r.html) { out.errors.push(Object.assign({ error: 'The report came back empty.' }, label)); continue; }
      out.items.push(finish(r, label));
    }
  }

  // Run a page's Email function with openReportEmailModal swapped for a
  // recorder, and hand back what it would have opened the modal with. The
  // modal's getHTML/getAttachments/getSummary are called here, while whatever
  // state the caller set up is still in place.
  async function capture(fn) {
    const realModal = window.openReportEmailModal;
    const realAlert = window.alert;
    const alerts = [];
    let opts = null;
    window.openReportEmailModal = o => { opts = o || null; };
    window.alert = msg => { alerts.push(String(msg == null ? '' : msg)); };
    try {
      await fn();
      if (!opts) return alerts.length ? { skip: alerts[0] } : null;
      const html = typeof opts.getHTML === 'function' ? opts.getHTML() : '';
      const attachments = typeof opts.getAttachments === 'function' ? opts.getAttachments() : [];
      const summary = typeof opts.getSummary === 'function' ? opts.getSummary() : undefined;
      return {
        html,
        subject:     opts.defaultSubject || '',
        projectId:   opts.projectId || null,
        projectName: opts.projectName || null,
        attachments,
        ...(Array.isArray(summary) ? { summary } : {}),
      };
    } finally {
      window.openReportEmailModal = realModal;
      window.alert = realAlert;
    }
  }

  // Resolve once pred() is true; reject after `ms`. For the flags a page sets
  // when one of its lazy loads lands.
  function waitFor(pred, ms, what) {
    const limit = ms || 30000;
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        let ok = false;
        try { ok = Boolean(pred()); } catch (_) { ok = false; }
        if (ok) return resolve();
        if (Date.now() - t0 > limit) return reject(new Error((what || 'The page') + ' did not finish loading.'));
        setTimeout(tick, 150);
      })();
    });
  }

  window.dwAutoReport = {
    capture,
    waitFor,
    ready(p) {
      readyPromise = Promise.resolve(p);
      // build() awaits it and sees a failed boot; this only stops a person's
      // page logging the same failure a second time when nobody builds.
      readyPromise.catch(() => {});
    },
    jobs(fn) { jobsFn = fn; },
    register(type, fn, opts) { registry[type] = { fn, perJob: Boolean(opts && opts.perJob) }; },
    types() { return Object.keys(registry); },
    has(type) { return Boolean(registry[type]); },

    // The jobs an every-job spec covers; null for anything that is one build.
    async plan(spec) {
      const entry = spec && registry[spec.type];
      if (!entry) throw new Error('This page cannot build "' + (spec && spec.type) + '".');
      if (readyPromise) await readyPromise;
      if (!entry.perJob || spec.projectId !== '*') return { jobs: null };
      return { jobs: asArray(jobsFn ? jobsFn() : []).map(j => ({ id: j.id, name: j.name || null })) };
    },

    async build(spec) {
      const out = { items: [], skipped: [], errors: [] };
      const entry = spec && registry[spec.type];
      if (!entry) throw new Error('This page cannot build "' + (spec && spec.type) + '".');
      if (readyPromise) await readyPromise;

      if (!entry.perJob) {
        await runOne(entry.fn, spec, null, out);
        return out;
      }

      const all = asArray(jobsFn ? jobsFn() : []);
      let jobs;
      if (spec.projectId === '*') {
        jobs = all;
        if (!jobs.length) out.skipped.push({ why: 'No jobs are marked In Progress.' });
      } else {
        // A job no longer In Progress can still be named outright — the
        // schedule asked for that job, not for whatever is active. The page's
        // builder says so if the job itself is gone.
        const one = all.find(j => String(j.id) === String(spec.projectId));
        jobs = one ? [one] : [{ id: spec.projectId, name: spec.projectName || null }];
      }
      for (const job of jobs) await runOne(entry.fn, spec, job, out);
      return out;
    },
  };
})();
