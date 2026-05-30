#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
INSTALL_DIR="${HOME}/.ecorelay"
OC_PLUGIN_DIR="${HOME}/.config/opencode/plugins"
CC_CACHE_DIR="${HOME}/.claude/plugins/cache/eco-relay/relay/0.8.0"
VERSION="0.8.0"

echo "EcoRelay v${VERSION} — installing..."

# 1. Create directories (fresh install)
if [ -L "${INSTALL_DIR}" ]; then
    echo "ERROR: ${INSTALL_DIR} is a symlink, refusing"
    exit 1
fi
rm -rf "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
chmod 0700 "${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}/src"
mkdir -p "${OC_PLUGIN_DIR}"

# Clean up old plugin path if it exists (would conflict)
if [ -f "${HOME}/.opencode/plugin/ecorelay.ts" ]; then
    rm -f "${HOME}/.opencode/plugin/ecorelay.ts"
    echo "Removed old plugin at ~/.opencode/plugin/"
fi

# VS4: refuse if OC_PLUGIN_DIR is a symlink
if [ -L "${OC_PLUGIN_DIR}" ]; then
    echo "ERROR: ${OC_PLUGIN_DIR} is a symlink, refusing"
    exit 1
fi

# 2. Copy core files (VS1: -rP = recursive, no symlink follow)
# F1: ensure intermediate directories exist
for dir in src/hub src/shared src/opencode-plugin src/channel src/relay-server src/integration; do
    if [ -d "${REPO_DIR}/${dir}" ]; then
        mkdir -p "${INSTALL_DIR}/${dir}"
        cp -rP "${REPO_DIR}/${dir}/"* "${INSTALL_DIR}/${dir}/"
    fi
done

# F2: copy all root src .ts files
cp -P "${REPO_DIR}/src/"*.ts "${INSTALL_DIR}/src/" 2>/dev/null || true

for file in package.json bun.lock tsconfig.json; do
    if [ -f "${REPO_DIR}/${file}" ]; then
        cp -P "${REPO_DIR}/${file}" "${INSTALL_DIR}/${file}"
    fi
done

# 3. Install dependencies (all — need devDeps for typecheck)
cd "${INSTALL_DIR}"
bun install --ignore-scripts

# 4. Install OpenCode plugin
cp -P "${INSTALL_DIR}/src/opencode-plugin/ecorelay.ts" "${OC_PLUGIN_DIR}/ecorelay.ts"

# Ensure OC package.json has required dependencies
if [ ! -f "${OC_PLUGIN_DIR}/package.json" ]; then
    cat > "${OC_PLUGIN_DIR}/package.json" << 'PACKAGEDEPS'
{
  "dependencies": {
    "@opencode-ai/plugin": "1.15.12",
    "ws": "8.18.0"
  }
}
PACKAGEDEPS
fi

# 5. Sync to Claude Code cache
if [ -d "${CC_CACHE_DIR}" ]; then
    mkdir -p "${CC_CACHE_DIR}/src"
    cp -rP "${INSTALL_DIR}/src/"* "${CC_CACHE_DIR}/src/"
    echo "CC cache synced"
fi

# 6. Verify (unit tests only — integration tests need isolated Hub)
bun run typecheck
bun test --path-ignore-patterns "src/integration/*"

echo ""
echo "EcoRelay v${VERSION} installed."
echo "Open Claude Code or OpenCode. Done."
