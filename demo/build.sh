#!/usr/bin/env bash
# Build the DataWatch "Timesheet -> Payroll -> Project" explainer video.
#
#   bash demo/build.sh
#
# Produces:
#   demo/forcecorp-timesheet-payroll-project.mp4   (1080p H.264, for sending out)
#   demo/forcecorp-timesheet-payroll-project.gif    (silent loop preview)
#
# Requirements: Chromium (Playwright) + a static ffmpeg with libx264.
set -euo pipefail
cd "$(dirname "$0")"

FFMPEG="${FFMPEG:-./ffmpeg}"            # static ffmpeg with libx264 (see README)
FPS=30
OUT_MP4="forcecorp-timesheet-payroll-project.mp4"
OUT_GIF="forcecorp-timesheet-payroll-project.gif"

echo "==> 1/3  Rendering frames"
node render.js

echo "==> 2/3  Encoding MP4 (H.264)"
"$FFMPEG" -y -framerate "$FPS" -i frames/%05d.png \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -preset slow \
  -movflags +faststart -profile:v high -level 4.2 "$OUT_MP4"

echo "==> 3/3  Encoding GIF preview (downscaled)"
"$FFMPEG" -y -framerate "$FPS" -i frames/%05d.png \
  -vf "fps=15,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" \
  "$OUT_GIF"

echo "Done:"
ls -lh "$OUT_MP4" "$OUT_GIF"
