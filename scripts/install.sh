#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=$(grep '"version"' "$REPO_DIR/package.json" | head -1 | sed 's/.*: "//;s/".*//')

# Resolve real bun.exe (PATH may have .ps1 shim that bash can't execute)
BUN="$HOME/.bun/bin/bun.exe"
if [ ! -f "$BUN" ]; then
    BUN="$HOME/.bun/bin/bun"
fi
if [ ! -f "$BUN" ]; then
    BUN=$(command -v bun 2>/dev/null || true)
fi
if [ -z "$BUN" ]; then
    echo "ERROR: bun not found. Install bun first: https://bun.sh"
    exit 1
fi

echo "EcoRelay v${VERSION} — installing..."
echo "  bun: $BUN"

# ── Helper: copy src tree ──────────────────────────────────────────
copy_src() {
    local dest="$1"
    mkdir -p "$dest/src"
    for dir in hub shared opencode-plugin channel relay-server integration codex-adapter; do
        if [ -d "$REPO_DIR/src/$dir" ]; then
            mkdir -p "$dest/src/$dir"
            cp -rP "$REPO_DIR/src/$dir/"* "$dest/src/$dir/"
        fi
    done
    cp -P "$REPO_DIR/src/"*.ts "$dest/src/" 2>/dev/null || true
    for file in package.json bun.lock tsconfig.json; do
        [ -f "$REPO_DIR/$file" ] && cp -P "$REPO_DIR/$file" "$dest/$file"
    done
    if [ -d "$REPO_DIR/.claude-plugin" ]; then
        mkdir -p "$dest/.claude-plugin"
        cp -P "$REPO_DIR/.claude-plugin/"* "$dest/.claude-plugin/"
    fi
}

# ══════════════════════════════════════════════════════════════════════
# 1. ~/.ecorelay (standalone — OC daemon spawns from here)
# ══════════════════════════════════════════════════════════════════════
INSTALL_DIR="$HOME/.ecorelay"
if [ -L "$INSTALL_DIR" ]; then
    echo "ERROR: $INSTALL_DIR is a symlink, refusing"
    exit 1
fi
rm -rf "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
chmod 0700 "$INSTALL_DIR"
copy_src "$INSTALL_DIR"
cd "$INSTALL_DIR" && "$BUN" install --ignore-scripts
echo "  ~/.ecorelay ✓"

# ══════════════════════════════════════════════════════════════════════
# 2. OpenCode plugin (if OC detected)
# ══════════════════════════════════════════════════════════════════════
OC_PLUGIN_DIR="$HOME/.config/opencode/plugins"
if [ -d "$OC_PLUGIN_DIR" ] || command -v opencode &>/dev/null; then
    if [ -L "$OC_PLUGIN_DIR" ]; then
        echo "ERROR: $OC_PLUGIN_DIR is a symlink, refusing"
        exit 1
    fi
    mkdir -p "$OC_PLUGIN_DIR"
    cp -P "$REPO_DIR/src/opencode-plugin/ecorelay.ts" "$OC_PLUGIN_DIR/ecorelay.ts"
    if [ ! -f "$OC_PLUGIN_DIR/package.json" ]; then
        cat > "$OC_PLUGIN_DIR/package.json" << 'PKGJSON'
{
  "dependencies": {
    "@opencode-ai/plugin": "1.15.12",
    "ws": "8.18.0"
  }
}
PKGJSON
    fi
    echo "  OC plugin ✓"
else
    echo "  OC not detected — skipped"
fi

# Clean up old plugin path
[ -f "$HOME/.opencode/plugin/ecorelay.ts" ] && rm -f "$HOME/.opencode/plugin/ecorelay.ts"

# ══════════════════════════════════════════════════════════════════════
# 3. Claude Code marketplace (if CC detected)
# ══════════════════════════════════════════════════════════════════════
CC_MP="$HOME/.claude/plugins/marketplaces/eco-relay"
if [ -d "$CC_MP" ]; then
    copy_src "$CC_MP"
    cd "$CC_MP" && "$BUN" install --ignore-scripts
    echo "  CC marketplace ✓"
else
    echo "  CC marketplace not detected — skipped"
fi

# ══════════════════════════════════════════════════════════════════════
# 4. Claude Code cache (where CC normally loads from)
# ══════════════════════════════════════════════════════════════════════
CC_CACHE_BASE="$HOME/.claude/plugins/cache/eco-relay/relay"
if [ -d "$CC_CACHE_BASE" ]; then
    CC_CACHE="$CC_CACHE_BASE/$VERSION"
    mkdir -p "$CC_CACHE"
    copy_src "$CC_CACHE"
    cd "$CC_CACHE" && "$BUN" install --ignore-scripts
    echo "  CC cache v${VERSION} ✓"
else
    echo "  CC cache not detected — skipped"
fi

# ══════════════════════════════════════════════════════════════════════
# 5. Update CC plugin registry (installed_plugins.json)
# ══════════════════════════════════════════════════════════════════════
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
if [ -f "$INSTALLED" ] && [ -d "$CC_CACHE_BASE" ]; then
    GIT_SHA=$(cd "$REPO_DIR" && git rev-parse HEAD 2>/dev/null || echo "unknown")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
    # Convert Git Bash path to Windows path for installed_plugins.json
    WIN_CACHE=$(cygpath -w "$CC_CACHE" 2>/dev/null || echo "$CC_CACHE" | sed 's|^/\([a-z]\)/|\1:\\|; s|/|\\|g')
    WIN_INSTALLED=$(cygpath -w "$INSTALLED" 2>/dev/null || echo "$INSTALLED")

    "$BUN" -e "
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
        const entry = data.plugins['relay@eco-relay'];
        if (entry && entry[0]) {
            entry[0].version = process.argv[2];
            entry[0].installPath = process.argv[3];
            entry[0].lastUpdated = process.argv[4];
            entry[0].gitCommitSha = process.argv[5];
        }
        fs.writeFileSync(process.argv[1], JSON.stringify(data, null, 2));
    " "$WIN_INSTALLED" "$VERSION" "$WIN_CACHE" "$NOW" "$GIT_SHA"
    echo "  CC registry → v${VERSION} ✓"
else
    echo "  CC registry not found — skipped"
fi

# ══════════════════════════════════════════════════════════════════════
# 6. Copilot CLI extension (if Copilot detected)
# ══════════════════════════════════════════════════════════════════════
COPILOT_DIR="$HOME/.copilot"
COPILOT_EXT_DIR="$COPILOT_DIR/extensions/ecorelay"
COPILOT_EXT="$COPILOT_EXT_DIR/extension.mjs"
if [ -d "$COPILOT_DIR" ] || command -v copilot &>/dev/null; then
    if [ -L "$COPILOT_EXT_DIR" ]; then
        echo "ERROR: $COPILOT_EXT_DIR is a symlink, refusing"
        exit 1
    fi
    # No package.json: @github/copilot-sdk is auto-resolved by the CLI, no ws dep.
    mkdir -p "$COPILOT_EXT_DIR"
    cp -P "$REPO_DIR/src/copilot-extension/ecorelay.mjs" "$COPILOT_EXT"
    echo "  Copilot extension ✓ (launch with: copilot --experimental)"
else
    echo "  Copilot not detected — skipped"
fi

# ══════════════════════════════════════════════════════════════════════
# 7. Codex CLI adapter (if Codex detected)
# ══════════════════════════════════════════════════════════════════════
CODEX_BIN=""
if command -v codex &>/dev/null; then
    CODEX_BIN=$(command -v codex)
elif [ -d "$HOME/AppData/Local/OpenAI/Codex" ]; then
    CODEX_BIN="detected"
fi

if [ -n "$CODEX_BIN" ]; then
    CODEX_ADAPTER_DIR="$INSTALL_DIR/src/codex-adapter"
    if [ -d "$REPO_DIR/src/codex-adapter" ]; then
        mkdir -p "$CODEX_ADAPTER_DIR"
        cp -rP "$REPO_DIR/src/codex-adapter/"*.ts "$CODEX_ADAPTER_DIR/"
    fi

    # Install launcher scripts
    cp -P "$REPO_DIR/scripts/ecorelay-codex.cmd" "$INSTALL_DIR/ecorelay-codex.cmd"
    cp -P "$REPO_DIR/scripts/ecorelay-codex-launch.ts" "$INSTALL_DIR/ecorelay-codex-launch.ts"

    # Register MCP server in Codex config.toml (if config dir exists)
    CODEX_CONFIG="$HOME/.codex/config.toml"
    if [ -d "$HOME/.codex" ]; then
        if ! grep -q 'mcp_servers.ecorelay' "$CODEX_CONFIG" 2>/dev/null; then
            ADAPTER_PATH=$(cygpath -w "$INSTALL_DIR/src/codex-adapter/index.ts" 2>/dev/null || echo "$INSTALL_DIR/src/codex-adapter/index.ts")
            BUN_WIN=$(cygpath -w "$BUN" 2>/dev/null || echo "$BUN")
            cat >> "$CODEX_CONFIG" << TOMLEOF

[mcp_servers.ecorelay]
command = '$BUN_WIN'
args = ["run", '$ADAPTER_PATH']
startup_timeout_sec = 20
tool_timeout_sec = 60
TOMLEOF
            echo "  Codex config.toml → [mcp_servers.ecorelay] ✓"
        else
            echo "  Codex config.toml → [mcp_servers.ecorelay] already present"
        fi
    fi
    echo "  Codex adapter ✓ (launch with: ecorelay-codex.cmd or ~/.ecorelay/ecorelay-codex.cmd)"
else
    echo "  Codex not detected — skipped"
fi

# ══════════════════════════════════════════════════════════════════════
# 8. Verify
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "Verifying..."
MARKER="ws_endpoint_failed"
FAIL=0

check() {
    local label="$1" file="$2" pattern="$3"
    if [ -f "$file" ] && grep -q "$pattern" "$file"; then
        echo "  $label: v${VERSION} ✓"
    else
        echo "  $label: MISSING or OLD ✗"
        FAIL=1
    fi
}

check "~/.ecorelay" "$INSTALL_DIR/src/hub/index.ts" "$MARKER"
[ -d "$CC_MP" ] && check "CC marketplace" "$CC_MP/src/hub/index.ts" "$MARKER"
[ -d "${CC_CACHE:-/nonexistent}" ] && check "CC cache" "$CC_CACHE/src/hub/index.ts" "$MARKER"
[ -f "$OC_PLUGIN_DIR/ecorelay.ts" ] && check "OC plugin" "$OC_PLUGIN_DIR/ecorelay.ts" "spawnHubDaemon"
[ -f "$COPILOT_EXT" ] && check "Copilot extension" "$COPILOT_EXT" "joinSession"
[ -f "$INSTALL_DIR/src/codex-adapter/index.ts" ] && check "Codex adapter" "$INSTALL_DIR/src/codex-adapter/index.ts" "AppServerClient"

if [ "$FAIL" -eq 0 ]; then
    echo ""
    echo "EcoRelay v${VERSION} installed successfully."
    echo "Restart Claude Code and/or OpenCode to load the new version."
else
    echo ""
    echo "WARNING: Some locations failed verification. Check above."
    exit 1
fi
