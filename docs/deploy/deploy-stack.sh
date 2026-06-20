#!/usr/bin/env bash
set -euo pipefail

# 一键发布到公网 relay 服务器（本地执行）
# 一键部署脚本（需先在本机配置 SSH 登录到服务器）
# Example:
#   REMOTE_HOST=YOUR_SERVER_IP_OR_DOMAIN REMOTE_USER=admin bash docs/deploy/deploy-stack.sh

MODE="${1:--apply}"
if [[ "${MODE}" == "--help" || "${MODE}" == "-h" ]]; then
  cat <<'USAGE'
用途:
  1) 先准备环境变量（至少设置 REMOTE_HOST）
  2) 运行 docs/deploy/deploy-stack.sh

必需:
  REMOTE_HOST   服务器公网IP/域名（如 YOUR_SERVER_IP_OR_DOMAIN）

可选:
  REMOTE_USER           SSH 登录用户（默认：admin）
  PROJECT_DIR           服务端部署目录（默认：/opt/local-codex）
  DOMAIN                HTTPS 子域名（默认空，将使用 https://REMOTE_HOST）
  PUBLIC_BASE_URL       公开访问 URL（默认：https://DOMAIN 或 https://REMOTE_HOST）
  ADMIN_KEY             管理员KEY（可选；会写入 secrets 文件，不会写入 .env）
  SSH_KEY               SSH 私钥路径（可选，如 ~/.ssh/codex-deploy-key）
  HOST                  监听地址（默认：127.0.0.1）
  CODEX_MAX_USER_SESSIONS  同时在线用户会话上限
  CODEX_MAX_CONNECTORS     同时在线电脑端连接上限

操作:
  bash docs/deploy/deploy-stack.sh          # 构建+上传+部署（默认）
  bash docs/deploy/deploy-stack.sh --dry    # 只输出将执行的命令，不实际落地
USAGE
  exit 0
fi

: "${REMOTE_HOST:?请先设置 REMOTE_HOST，例如 REMOTE_HOST=YOUR_SERVER_IP_OR_DOMAIN}"
REMOTE_USER="${REMOTE_USER:-admin}"
PROJECT_DIR="${PROJECT_DIR:-/opt/local-codex}"
DOMAIN="${DOMAIN:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
ADMIN_KEY="${ADMIN_KEY:-}"
SSH_KEY="${SSH_KEY:-}"
HOST="${HOST:-127.0.0.1}"
CODEX_MAX_USER_SESSIONS="${CODEX_MAX_USER_SESSIONS:-500}"
CODEX_MAX_CONNECTORS="${CODEX_MAX_CONNECTORS:-300}"
CONNECTOR_CHAT_QUEUE_LIMIT="${CONNECTOR_CHAT_QUEUE_LIMIT:-8}"
CONNECTOR_CHAT_QUEUE_TIMEOUT_MS="${CONNECTOR_CHAT_QUEUE_TIMEOUT_MS:-300000}"
CODEX_IP_ALLOWLIST="${CODEX_IP_ALLOWLIST:-}"
CODEX_AUTH_KEY_ALLOWLIST="${CODEX_AUTH_KEY_ALLOWLIST:-}"
CODEX_AUTH_RATE_WINDOW_MS="${CODEX_AUTH_RATE_WINDOW_MS:-600000}"
CODEX_AUTH_RATE_MAX_FAILS="${CODEX_AUTH_RATE_MAX_FAILS:-5}"
CODEX_AUTH_RATE_BLOCK_MS="${CODEX_AUTH_RATE_BLOCK_MS:-60000}"
CODEX_ADMIN_RATE_WINDOW_MS="${CODEX_ADMIN_RATE_WINDOW_MS:-600000}"
CODEX_ADMIN_RATE_MAX_FAILS="${CODEX_ADMIN_RATE_MAX_FAILS:-3}"
CODEX_ADMIN_RATE_BLOCK_MS="${CODEX_ADMIN_RATE_BLOCK_MS:-600000}"
CODEX_WS_CONNECT_RATE_WINDOW_MS="${CODEX_WS_CONNECT_RATE_WINDOW_MS:-60000}"
CODEX_WS_CONNECT_RATE_MAX="${CODEX_WS_CONNECT_RATE_MAX:-30}"
CODEX_WS_CONNECT_RATE_BLOCK_MS="${CODEX_WS_CONNECT_RATE_BLOCK_MS:-60000}"
CODEX_AGENT_CONNECT_RATE_WINDOW_MS="${CODEX_AGENT_CONNECT_RATE_WINDOW_MS:-60000}"
CODEX_AGENT_CONNECT_RATE_MAX="${CODEX_AGENT_CONNECT_RATE_MAX:-12}"
CODEX_AGENT_CONNECT_RATE_BLOCK_MS="${CODEX_AGENT_CONNECT_RATE_BLOCK_MS:-300000}"
CODEX_SESSION_TTL_MS="${CODEX_SESSION_TTL_MS:-900000}"
CODEX_ADMIN_SESSION_TTL_MS="${CODEX_ADMIN_SESSION_TTL_MS:-300000}"
CODEX_SECURITY_AUDIT_LOG_PATH="${CODEX_SECURITY_AUDIT_LOG_PATH:-${PROJECT_DIR}/logs/security.log}"
CODEX_SECURITY_ALERT_WEBHOOK="${CODEX_SECURITY_ALERT_WEBHOOK:-}"
CODEX_SECURITY_ALERT_THROTTLE_MS="${CODEX_SECURITY_ALERT_THROTTLE_MS:-60000}"
PM2_HOME="${PM2_HOME:-/home/${REMOTE_USER}/.pm2}"

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

SOURCE_ARCHIVE="$TMP_DIR/local-codex-deploy.tar.gz"
DIST_ARCHIVE="$TMP_DIR/local-codex-dist.tar.gz"
BUNDLE_FILE="$TMP_DIR/connector-bundle.cjs"
LOCAL_PUBLIC="${PUBLIC_BASE_URL:-https://${DOMAIN:-$REMOTE_HOST}}"
SSH_OPTS=(-o StrictHostKeyChecking=no)
if [[ -n "${SSH_KEY}" ]]; then
  SSH_OPTS+=(-i "${SSH_KEY}" -o IdentitiesOnly=yes)
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 node。请先安装 Node.js。"
  exit 1
fi

cd "$ROOT_DIR"
echo "=== 1) 安装依赖并构建前端 ==="
npm install
npm run build -w apps/mobile-web

echo "=== 2) 本地打包 connector 客户端 bundle ==="
npm exec -- esbuild apps/connector/src/index.ts \
  --bundle \
  --platform=node \
  --format=cjs \
  --target=node18 \
  --external:bufferutil \
  --external:utf-8-validate \
  --outfile="$BUNDLE_FILE"

echo "=== 3) 打包源码与前端静态资源 ==="
tar -czf "$SOURCE_ARCHIVE" -C "$ROOT_DIR" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='.DS_Store' \
  --exclude='*.log' \
  package.json \
  package-lock.json \
  apps/connector \
  apps/relay \
  apps/mobile-web \
  apps/server \
  packages/shared

tar -czf "$DIST_ARCHIVE" -C "$ROOT_DIR/apps/mobile-web" dist

if [[ "${MODE}" == "--dry" ]]; then
  echo "Dry mode: no remote deployment will run."
  echo
  echo "Prepared:"
  echo "  [1] $SOURCE_ARCHIVE"
  echo "  [2] $DIST_ARCHIVE"
  echo "  [3] $BUNDLE_FILE"
  echo
  echo "建议执行以下命令："
  echo "scp ${SSH_OPTS[*]} $SOURCE_ARCHIVE $REMOTE_USER@$REMOTE_HOST:/tmp/local-codex-deploy.tar.gz"
  echo "scp ${SSH_OPTS[*]} $DIST_ARCHIVE $REMOTE_USER@$REMOTE_HOST:/tmp/local-codex-dist.tar.gz"
  echo "scp ${SSH_OPTS[*]} $BUNDLE_FILE $REMOTE_USER@$REMOTE_HOST:$PROJECT_DIR/connector-bundle.cjs"
  exit 0
fi

echo "=== 4) 上传到服务器 ==="
scp "${SSH_OPTS[@]}" "$SOURCE_ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:/tmp/local-codex-deploy.tar.gz"
scp "${SSH_OPTS[@]}" "$DIST_ARCHIVE" "$REMOTE_USER@$REMOTE_HOST:/tmp/local-codex-dist.tar.gz"
scp "${SSH_OPTS[@]}" "$BUNDLE_FILE" "$REMOTE_USER@$REMOTE_HOST:/tmp/connector-bundle.cjs"

echo "=== 5) 服务器端初始化与启动 ==="
ssh "${SSH_OPTS[@]}" "$REMOTE_USER@$REMOTE_HOST" bash -s <<EOF
set -euo pipefail

export PROJECT_DIR="${PROJECT_DIR}"
export HOST="${HOST}"
export PM2_HOME="${PM2_HOME}"
export PUBLIC_BASE_URL="${LOCAL_PUBLIC}"
export CODEX_MAX_USER_SESSIONS="${CODEX_MAX_USER_SESSIONS}"
export CODEX_MAX_CONNECTORS="${CODEX_MAX_CONNECTORS}"
export ADMIN_KEY="${ADMIN_KEY}"
export CONNECTOR_CHAT_QUEUE_LIMIT="${CONNECTOR_CHAT_QUEUE_LIMIT}"
export CONNECTOR_CHAT_QUEUE_TIMEOUT_MS="${CONNECTOR_CHAT_QUEUE_TIMEOUT_MS}"
export CODEX_IP_ALLOWLIST="${CODEX_IP_ALLOWLIST}"
export CODEX_AUTH_KEY_ALLOWLIST="${CODEX_AUTH_KEY_ALLOWLIST}"
export CODEX_AUTH_RATE_WINDOW_MS="${CODEX_AUTH_RATE_WINDOW_MS}"
export CODEX_AUTH_RATE_MAX_FAILS="${CODEX_AUTH_RATE_MAX_FAILS}"
export CODEX_AUTH_RATE_BLOCK_MS="${CODEX_AUTH_RATE_BLOCK_MS}"
export CODEX_ADMIN_RATE_WINDOW_MS="${CODEX_ADMIN_RATE_WINDOW_MS}"
export CODEX_ADMIN_RATE_MAX_FAILS="${CODEX_ADMIN_RATE_MAX_FAILS}"
export CODEX_ADMIN_RATE_BLOCK_MS="${CODEX_ADMIN_RATE_BLOCK_MS}"
export CODEX_WS_CONNECT_RATE_WINDOW_MS="${CODEX_WS_CONNECT_RATE_WINDOW_MS}"
export CODEX_WS_CONNECT_RATE_MAX="${CODEX_WS_CONNECT_RATE_MAX}"
export CODEX_WS_CONNECT_RATE_BLOCK_MS="${CODEX_WS_CONNECT_RATE_BLOCK_MS}"
export CODEX_AGENT_CONNECT_RATE_WINDOW_MS="${CODEX_AGENT_CONNECT_RATE_WINDOW_MS}"
export CODEX_AGENT_CONNECT_RATE_MAX="${CODEX_AGENT_CONNECT_RATE_MAX}"
export CODEX_AGENT_CONNECT_RATE_BLOCK_MS="${CODEX_AGENT_CONNECT_RATE_BLOCK_MS}"
export CODEX_SESSION_TTL_MS="${CODEX_SESSION_TTL_MS}"
export CODEX_ADMIN_SESSION_TTL_MS="${CODEX_ADMIN_SESSION_TTL_MS}"
export CODEX_SECURITY_AUDIT_LOG_PATH="${CODEX_SECURITY_AUDIT_LOG_PATH}"
export CODEX_SECURITY_ALERT_WEBHOOK="${CODEX_SECURITY_ALERT_WEBHOOK}"
export CODEX_SECURITY_ALERT_THROTTLE_MS="${CODEX_SECURITY_ALERT_THROTTLE_MS}"

sudo mkdir -p "${PROJECT_DIR}"
sudo mkdir -p "${PROJECT_DIR}/apps" "${PROJECT_DIR}/packages" "${PROJECT_DIR}/node_modules"
sudo tar -xzf /tmp/local-codex-deploy.tar.gz -C "$PROJECT_DIR"
sudo mv /tmp/connector-bundle.cjs "$PROJECT_DIR/connector-bundle.cjs"
sudo rm -rf "$PROJECT_DIR/apps/mobile-web/dist"
sudo mkdir -p "$PROJECT_DIR/apps/mobile-web/dist"
sudo tar -xzf /tmp/local-codex-dist.tar.gz -C "$PROJECT_DIR/apps/mobile-web/dist"
sudo mv "$PROJECT_DIR/apps/mobile-web/dist/dist"/* "$PROJECT_DIR/apps/mobile-web/dist/" || true
sudo rm -rf "$PROJECT_DIR/apps/mobile-web/dist/dist"
sudo mkdir -p "$PROJECT_DIR/secrets" "$PROJECT_DIR/logs"

if [ -f "$PROJECT_DIR/.env" ]; then
  sudo cp -f "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.bak-deploy-stack" || true
fi

sudo cat > "$PROJECT_DIR/.env" <<ENV
PORT=8787
HOST=${HOST}
PUBLIC_BASE_URL=${LOCAL_PUBLIC}
CONNECTOR_BUNDLE_PATH=${PROJECT_DIR}/connector-bundle.cjs
CONNECTOR_TLS_CA_PATH=${PROJECT_DIR}/relay-cert.pem
CODEX_ADMIN_KEY_FILE=${PROJECT_DIR}/secrets/codex-admin-key.txt
CODEX_IP_ALLOWLIST=${CODEX_IP_ALLOWLIST}
CODEX_AUTH_KEY_ALLOWLIST=${CODEX_AUTH_KEY_ALLOWLIST}
CODEX_SESSION_TTL_MS=${CODEX_SESSION_TTL_MS}
CODEX_ADMIN_SESSION_TTL_MS=${CODEX_ADMIN_SESSION_TTL_MS}
CODEX_SECURITY_AUDIT_LOG_PATH=${CODEX_SECURITY_AUDIT_LOG_PATH}
CODEX_SECURITY_ALERT_WEBHOOK=${CODEX_SECURITY_ALERT_WEBHOOK}
CODEX_SECURITY_ALERT_THROTTLE_MS=${CODEX_SECURITY_ALERT_THROTTLE_MS}
CODEX_AUTH_RATE_WINDOW_MS=${CODEX_AUTH_RATE_WINDOW_MS}
CODEX_AUTH_RATE_MAX_FAILS=${CODEX_AUTH_RATE_MAX_FAILS}
CODEX_AUTH_RATE_BLOCK_MS=${CODEX_AUTH_RATE_BLOCK_MS}
CODEX_ADMIN_RATE_WINDOW_MS=${CODEX_ADMIN_RATE_WINDOW_MS}
CODEX_ADMIN_RATE_MAX_FAILS=${CODEX_ADMIN_RATE_MAX_FAILS}
CODEX_ADMIN_RATE_BLOCK_MS=${CODEX_ADMIN_RATE_BLOCK_MS}
CODEX_WS_CONNECT_RATE_WINDOW_MS=${CODEX_WS_CONNECT_RATE_WINDOW_MS}
CODEX_WS_CONNECT_RATE_MAX=${CODEX_WS_CONNECT_RATE_MAX}
CODEX_WS_CONNECT_RATE_BLOCK_MS=${CODEX_WS_CONNECT_RATE_BLOCK_MS}
CODEX_AGENT_CONNECT_RATE_WINDOW_MS=${CODEX_AGENT_CONNECT_RATE_WINDOW_MS}
CODEX_AGENT_CONNECT_RATE_MAX=${CODEX_AGENT_CONNECT_RATE_MAX}
CODEX_AGENT_CONNECT_RATE_BLOCK_MS=${CODEX_AGENT_CONNECT_RATE_BLOCK_MS}
CODEX_CONNECTOR_DEVICE_FILE=${PROJECT_DIR}/secrets/connector-devices.json
CODEX_MAX_USER_SESSIONS=${CODEX_MAX_USER_SESSIONS}
CODEX_MAX_CONNECTORS=${CODEX_MAX_CONNECTORS}
CONNECTOR_CHAT_QUEUE_LIMIT=${CONNECTOR_CHAT_QUEUE_LIMIT}
CONNECTOR_CHAT_QUEUE_TIMEOUT_MS=${CONNECTOR_CHAT_QUEUE_TIMEOUT_MS}
ENV
sudo chmod 600 "$PROJECT_DIR/.env"

if [ -n "\${ADMIN_KEY}" ] && [ ! -f "${PROJECT_DIR}/secrets/codex-admin-key.txt" ]; then
  echo "\${ADMIN_KEY}" | tr -d '\\n' | sudo tee "${PROJECT_DIR}/secrets/codex-admin-key.txt" >/dev/null
  sudo chmod 600 "${PROJECT_DIR}/secrets/codex-admin-key.txt"
fi
if [ ! -f "${PROJECT_DIR}/secrets/codex-admin-key.txt" ]; then
  openssl rand -hex 24 | tr -d '\\n' | sudo tee "${PROJECT_DIR}/secrets/codex-admin-key.txt" >/dev/null
  sudo chmod 600 "${PROJECT_DIR}/secrets/codex-admin-key.txt"
fi

cat > "$PROJECT_DIR/start-relay.sh" <<'STARTER'
#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$PROJECT_DIR/.env" ]; then
  unset CODEX_ADMIN_KEY
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

cd "$PROJECT_DIR"
exec node_modules/.bin/tsx apps/relay/src/index.ts
STARTER
chmod +x "$PROJECT_DIR/start-relay.sh"
sudo chown -R "${REMOTE_USER}:$(id -gn "$REMOTE_USER")" "$PROJECT_DIR"

cd "$PROJECT_DIR"
npm install

if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe codex-relay >/dev/null 2>&1; then
    PM2_HOME="${PM2_HOME}" pm2 restart codex-relay --update-env
  else
    PM2_HOME="${PM2_HOME}" pm2 start ./start-relay.sh --name codex-relay --time
  fi
else
  echo "未检测到 pm2：先在服务器安装 PM2（npm i -g pm2）"
  exit 1
fi

PM2_HOME="${PM2_HOME}" pm2 save
PM2_HOME="${PM2_HOME}" pm2 ls | sed -n '1,50p'
EOF

echo
echo "=== 完成 ==="
echo "公网地址: ${LOCAL_PUBLIC}"
echo "健康检查:"
echo "curl -sS ${LOCAL_PUBLIC}/health"
echo "curl -sS ${LOCAL_PUBLIC}/codex/status"
