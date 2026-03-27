# Tomorrow's Session — Feature Documentation

## Goal
Build a comprehensive list of every tab in the app and the features within each one.
This will serve as a master reference for the product — useful for onboarding, future
development planning, and identifying gaps or improvements.

## What to Cover Per Tab
- Tab name and purpose (1-2 sentence summary)
- Every feature/button/interaction within it
- How it connects to other tabs (data flow)
- Any AI integrations
- Known limitations or planned improvements

## Tabs to Document
- Daily Tracking
- Project Dashboard (bid items, target dates, deadlines)
- Scheduling (pace table, Today's Goal, 7d Trend, Export PDF)
- Daily PM Report (overlay + PDF)
- Projection Planner
- AI Insights
- Purchase Orders
- Trucking
- Supplier
- Admin / Users

## Notes
- Started this conversation: 2026-03-27
- Active branch: claude/add-vercel-tracking-wblDH
- Recent features added this session:
  - Vercel Speed Insights script
  - Sticky header fix on daily tracking table
  - Today's Goal alert column in Schedule tab
  - Daily PM Report (overlay + print PDF)
  - Projection Planner wired into pace calculations
  - PP schedule persisted to DB
  - Per-bid-item target dates
  - AI Insights on Schedule tab
  - AI Insights embedded in Daily PM Report (overlay + PDF)
  - Historical pace trend tracking (7d Trend column, sparklines, consecutive-day streaks)
  - Schedule tab Export PDF button (landscape, full pace table + AI + trends)
