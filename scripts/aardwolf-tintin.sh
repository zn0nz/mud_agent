#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec /usr/games/tt++ -G -r "$ROOT_DIR/tintin/aardwolf.tin"
