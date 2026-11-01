#!/usr/bin/env bash
# Runs a gate command and mirrors its tail into the GitHub Actions job summary, so a blocked PR shows the reason without opening raw logs.
# Usage: tools/ci-step-summary.sh "<title>" "<how to fix>" <command...>   Exit code is the command's own.
set -uo pipefail
title=$1; hint=$2; shift 2
log=$(mktemp)
"$@" 2>&1 | tee "$log"
status=${PIPESTATUS[0]}
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  if [ "$status" -eq 0 ]; then
    printf '### ✅ %s\n\n```\n%s\n```\n' "$title" "$(tail -n 5 "$log")" >> "$GITHUB_STEP_SUMMARY"
  else
    printf '### ❌ %s\n\n**How to fix:** %s\n\n```\n%s\n```\n' "$title" "$hint" "$(tail -n 60 "$log")" >> "$GITHUB_STEP_SUMMARY"
    printf '::error title=%s::%s (details in the job summary)\n' "$title" "$hint"
  fi
fi
rm -f "$log"
exit "$status"
