#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd -P)"

[[ "$(uname -s)" == "Darwin" ]] || { echo "error: Sidecar packaging requires macOS" >&2; exit 1; }
case "$(uname -m)" in
  arm64|x86_64) ;;
  *) echo "error: supported macOS architectures are arm64 and x64" >&2; exit 1 ;;
esac
command -v node >/dev/null || { echo "error: Node.js is required to run the build controller" >&2; exit 1; }
command -v uv >/dev/null || { echo "error: uv is required to build the frozen Sidecar" >&2; exit 1; }
[[ -f "$DESKTOP_ROOT/shensi-sidecar.spec" ]] || { echo "error: committed Sidecar spec is missing" >&2; exit 1; }

exec node "$SCRIPT_DIR/build-sidecar.mjs"
