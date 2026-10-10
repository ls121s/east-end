#!/usr/bin/env bash
# Set the app version in config.js and sw.js. Phones fetch new files only when sw.js changes.
#   bash tools/release.sh 1.0.1
set -euo pipefail
cd "$(dirname "$0")/.."
v="${1:?Give a version, for example: bash tools/release.sh 1.0.1}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Version must look like 1.0.1" >&2; exit 2; }
sed -i -E "s/^(const VERSION = \")[^\"]+(\";)/\1$v\2/" sw.js
sed -i -E "s/(version: \")[^\"]+(\")/\1$v\2/" config.js
grep -n "const VERSION" sw.js
grep -n "version:" config.js
