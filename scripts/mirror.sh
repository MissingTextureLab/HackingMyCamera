#!/usr/bin/env sh
# Copies the project (without node_modules/.git) to a folder outside Documents.
# Windows Controlled Folder Access blocks Node from creating files under
# Documents, which makes Vite, Vitest and svelte-check hang there.
# Usage: scripts/mirror.sh <target-dir>
set -e
target="$1"
[ -n "$target" ] || { echo "usage: $0 <target-dir>"; exit 1; }
here="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$target"
(cd "$here" && tar --exclude=node_modules --exclude=.git --exclude=dist -cf - .) | (cd "$target" && tar -xf -)
[ -d "$target/node_modules" ] || (cd "$target" && pnpm install --frozen-lockfile)
