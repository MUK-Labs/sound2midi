#!/bin/bash
# Run this launcher from Terminal or double-click it on macOS.
set -euo pipefail
cd -- "$(dirname -- "$0")"

if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3.10 or later is required. Install Python, then run this launcher again." >&2
    exit 1
fi
if ! python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "The python3 on your PATH is older than 3.10. Install a newer Python and try again." >&2
    exit 1
fi

if [[ ! -x .venv/bin/python ]]; then
    echo "Creating a Python environment in this folder..."
    python3 -m venv .venv
fi

if ! .venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)'; then
    echo "This folder's .venv uses an older Python. Rename .venv and run the launcher again." >&2
    exit 1
fi

if [[ ! -f .venv/.requirements-installed || requirements.txt -nt .venv/.requirements-installed ]]; then
    echo "Installing Python packages into this folder's environment..."
    .venv/bin/python -m pip install -r requirements.txt
    touch .venv/.requirements-installed
fi

exec .venv/bin/python system_audio_midi.py "$@"
