# Demo video — Timesheet → Payroll → Project

A short (~1 min), branded explainer animation showing how **one timesheet
entry** flows into both **payroll** (what you pay the crew) and **project cost
tracking** (what the job costs) — with no double entry.

It's built to match how the real app works:

1. **Timesheet** — a field employee logs a shift against a job. Hours are
   computed (shift − lunch + travel). Status goes Draft → Submitted.
   *(`timesheet.html`, `api/timesheet-entries.js`)*
2. **Payroll** — the entry shows up in **Pending Review**. The admin **splits**
   the hours across **cost codes** and clicks **Approve & Inject Cost Tracking**.
   The split must equal the timesheet's total hours.
   *(`payroll.html`, validation in `api/timesheet-entries.js`)*
3. **Project** — approval auto-injects **locked rows** into the job's cost
   tracking, tagged `TS` and linked by `timesheet_entry_id`, so labor cost
   rolls up automatically and stays traceable.
   *(`tracker.html`, `api/daily-rows.js`)*

## Files

| File | What it is |
|------|------------|
| `explainer.html` | The animation itself — self-contained, deterministic. Open it in a browser to watch it loop. |
| `render.js` | Steps the animation frame-by-frame in headless Chromium → PNG frames. |
| `build.sh` | Renders frames, then encodes the MP4 + GIF with ffmpeg. |
| `forcecorp-timesheet-payroll-project.mp4` | **The deliverable** — 1080p, send this out. |

## Regenerate it

```bash
# needs a static ffmpeg with libx264 in demo/ffmpeg (or set FFMPEG=...)
bash demo/build.sh
```

Want to tweak the numbers, names, or copy? Edit the data and the `seek()`
timeline near the bottom of `explainer.html`, then re-run `build.sh`.

## Narration script (optional voiceover)

The video reads fine on mute (everything is on-screen), but if you want to
record a voiceover, here's a ~60-second script timed to the scenes:

> **[Intro]** Here's how a single day in the field turns into both a paycheck
> and a project cost — entered just once.
>
> **[Timesheet]** A crew member logs their shift on the Timesheet tab: the job,
> the supervisor, clock-in to clock-out. The system nets out lunch and adds
> travel — eight and a half payable hours — and they submit it.
>
> **[Payroll]** Payroll picks it up under Pending Review. Before approving, the
> admin splits those hours across the job's cost codes — six hours of milling,
> two and a half of paving. The split has to match the timesheet exactly, then
> it's "Approve and Inject Cost Tracking."
>
> **[Project]** Instantly, those hours post to the Elm Street job as locked,
> traceable rows — tagged T-S so you always know they came from a timesheet.
> The project's labor total ticks up, and the very same hours are already on
> the employee's paycheck.
>
> **[Close]** Enter time once. It pays the crew, and it costs the job —
> automatically.
