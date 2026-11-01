#!/usr/bin/env bash
# Lints every GitHub Actions workflow with actionlint AND ShellCheck. actionlint silently skips the shell analysis of every `run:` block
# when `shellcheck` is not on PATH, which is how a clean local run once hid SC2034 (ci.yml:167). So a missing ShellCheck is a hard failure here.
# Usage: tools/workflow-lint.sh [path-to-actionlint]   (CI downloads the pinned actionlint; locally it must be on PATH or passed)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
ACTIONLINT="${1:-$(command -v actionlint || true)}"
[ -n "$ACTIONLINT" ] && [ -x "$ACTIONLINT" ] || { echo "actionlint not found (pass its path)" >&2; exit 2; }
command -v shellcheck >/dev/null || { echo "shellcheck not found: actionlint would skip all shell analysis, which is not a pass" >&2; exit 2; }
"$ACTIONLINT" -color
echo "actionlint $("$ACTIONLINT" -version | head -1) + shellcheck $(shellcheck --version | sed -n 2p | cut -d' ' -f2): all workflows clean"
