#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONNECTOR_DIR="${CONNECTOR_DIR:-$HOME/CodexRemoteConnector}"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/com.codexremote.connector.plist"
NODE_BIN="${NODE_BIN:-}"
RELAY_WS="${RELAY_WS:-wss://YOUR_SERVER_IP_OR_DOMAIN/agent}"
CODEX_HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
CODEX_REMOTE_WORKSPACE="${CODEX_REMOTE_WORKSPACE:-$ROOT_DIR}"
CODEX_BIN_PATH="${CODEX_BIN:-$HOME/.codex/plugins/.plugin-appserver/codex}"

if [ -z "$NODE_BIN" ]; then
  if [ -x "/opt/homebrew/bin/node" ]; then
    NODE_BIN="/opt/homebrew/bin/node"
  elif [ -x "/usr/local/bin/node" ]; then
    NODE_BIN="/usr/local/bin/node"
  else
    NODE_BIN="$(command -v node || true)"
  fi
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo "未找到可用 Node.js。请先安装 Node.js，或设置 NODE_BIN=/path/to/node。"
  exit 1
fi

mkdir -p "$CONNECTOR_DIR"

cd "$ROOT_DIR"
npm exec -- esbuild apps/connector/src/index.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node18 \
  --external:bufferutil \
  --external:utf-8-validate \
  --outfile=connector-bundle.cjs

cp connector-bundle.cjs "$CONNECTOR_DIR/codex-connector.cjs"
chmod 600 "$CONNECTOR_DIR/codex-connector.cjs"

cat > "$CONNECTOR_DIR/start-connector.sh" <<EOF
#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

export HTTP_PROXY="\${HTTP_PROXY:-http://127.0.0.1:1082}"
export HTTPS_PROXY="\${HTTPS_PROXY:-http://127.0.0.1:1082}"
export NO_PROXY="\${NO_PROXY:-localhost,127.0.0.1,::1,.local,YOUR_SERVER_IP_OR_DOMAIN}"

if [ -f "$CONNECTOR_DIR/relay-cert.pem" ]; then
  export NODE_EXTRA_CA_CERTS="$CONNECTOR_DIR/relay-cert.pem"
fi

export CODEX_HOME="$CODEX_HOME_DIR"
export CODEX_BIN="$CODEX_BIN_PATH"
export CODEX_REMOTE_WORKSPACE="$CODEX_REMOTE_WORKSPACE"
export RELAY_WS="$RELAY_WS"

export CODEX_DESKTOP_SYNC_MODE="\${CODEX_DESKTOP_SYNC_MODE:-paste}"
export CODEX_DESKTOP_SYNC_TIMEOUT_MS="\${CODEX_DESKTOP_SYNC_TIMEOUT_MS:-180000}"
export CODEX_DESKTOP_SYNC_POLL_MS="\${CODEX_DESKTOP_SYNC_POLL_MS:-250}"
export CODEX_DESKTOP_SYNC_PASTE_DELAY_MS="\${CODEX_DESKTOP_SYNC_PASTE_DELAY_MS:-350}"

export CONNECTOR_HEARTBEAT_MS="\${CONNECTOR_HEARTBEAT_MS:-25000}"
export CONNECTOR_PONG_TIMEOUT_MS="\${CONNECTOR_PONG_TIMEOUT_MS:-75000}"
export CONNECTOR_RECONNECT_INITIAL_MS="\${CONNECTOR_RECONNECT_INITIAL_MS:-1000}"
export CONNECTOR_RECONNECT_MAX_MS="\${CONNECTOR_RECONNECT_MAX_MS:-60000}"
export CONNECTOR_RECONNECT_JITTER_MS="\${CONNECTOR_RECONNECT_JITTER_MS:-500}"
export CONNECTOR_RECONNECT_MAX_ATTEMPTS="\${CONNECTOR_RECONNECT_MAX_ATTEMPTS:-0}"

exec "$NODE_BIN" "$CONNECTOR_DIR/codex-connector.cjs"
EOF

chmod 755 "$CONNECTOR_DIR/start-connector.sh"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$LAUNCH_AGENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.codexremote.connector</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$CONNECTOR_DIR/start-connector.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>$CONNECTOR_DIR/connector.log</string>
    <key>StandardErrorPath</key>
    <string>$CONNECTOR_DIR/connector.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$LAUNCH_AGENT" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT"

echo "已安装并重启本机 connector。"
echo "日志：$CONNECTOR_DIR/connector.log"
echo "强制同步：CODEX_DESKTOP_SYNC_MODE=paste"
