#!/usr/bin/env bash
set -euo pipefail

# 一键检查 relay 安全状态（建议部署后执行）
# 用法：
#   SSH 到服务器后执行：
#   bash /tmp/security-audit.sh
# 或本地：
#   scp docs/deploy/security-audit.sh admin@HOST:/tmp/security-audit.sh
#   ssh admin@HOST 'bash /tmp/security-audit.sh'

PROJECT_DIR="${PROJECT_DIR:-/opt/local-codex}"
BASE_URL="${BASE_URL:-https://YOUR_SERVER_IP_OR_DOMAIN}"
BASE_HOST="${BASE_HOST:-$(echo "${BASE_URL}" | sed 's#https*://##' | sed 's#/.*##')}"

echo "=== [1] 基本系统与进程 ==="
hostname
date
echo "进程:"
if command -v pm2 >/dev/null 2>&1; then
  pm2 describe codex-relay || true
else
  echo "未安装 pm2"
fi

echo
echo "=== [2] 防火墙与端口 ==="
sudo ufw status verbose || true
echo
echo "监听端口:"
ss -lntup | grep -E ':(22|80|443|8787)\\s' || true

echo
echo "=== [3] relay 环境 ==="
if [ -f "${PROJECT_DIR}/.env" ]; then
  set -a
  # shellcheck disable=SC1090
  . "${PROJECT_DIR}/.env"
  set +a
  echo "CODEX_ADMIN_KEY_FILE=${CODEX_ADMIN_KEY_FILE:-}"
  echo "CODEX_IP_ALLOWLIST=${CODEX_IP_ALLOWLIST:-}"
  echo "CODEX_SESSION_TTL_MS=${CODEX_SESSION_TTL_MS:-}"
  echo "CODEX_ADMIN_SESSION_TTL_MS=${CODEX_ADMIN_SESSION_TTL_MS:-}"
  echo "CODEX_AUTH_RATE_WINDOW_MS=${CODEX_AUTH_RATE_WINDOW_MS:-}"
  echo "CODEX_AUTH_RATE_MAX_FAILS=${CODEX_AUTH_RATE_MAX_FAILS:-}"
  echo "CODEX_AUTH_RATE_BLOCK_MS=${CODEX_AUTH_RATE_BLOCK_MS:-}"
  echo "CODEX_ADMIN_RATE_WINDOW_MS=${CODEX_ADMIN_RATE_WINDOW_MS:-}"
  echo "CODEX_ADMIN_RATE_MAX_FAILS=${CODEX_ADMIN_RATE_MAX_FAILS:-}"
  echo "CODEX_ADMIN_RATE_BLOCK_MS=${CODEX_ADMIN_RATE_BLOCK_MS:-}"
  echo "CODEX_MAX_USER_SESSIONS=${CODEX_MAX_USER_SESSIONS:-}"
  echo "CODEX_MAX_CONNECTORS=${CODEX_MAX_CONNECTORS:-}"
  echo "CODEX_SECURITY_AUDIT_LOG_PATH=${CODEX_SECURITY_AUDIT_LOG_PATH:-}"
  echo "CODEX_SECURITY_ALERT_WEBHOOK=${CODEX_SECURITY_ALERT_WEBHOOK:-}"
else
  echo "${PROJECT_DIR}/.env 不存在"
fi

if [ -n "${CODEX_ADMIN_KEY_FILE:-}" ] && [ -f "${CODEX_ADMIN_KEY_FILE}" ]; then
  echo "管理员密钥文件: ${CODEX_ADMIN_KEY_FILE}，权限 $(stat -c '%a' "${CODEX_ADMIN_KEY_FILE}")"
fi

if [ -n "${CODEX_SECURITY_AUDIT_LOG_PATH:-}" ] && [ -f "${CODEX_SECURITY_AUDIT_LOG_PATH}" ]; then
  echo "安全日志尾部（最近 5 条）："
  tail -n 5 "${CODEX_SECURITY_AUDIT_LOG_PATH}" || true
fi

echo
echo "=== [4] Nginx 与证书 ==="
if [ -n "${BASE_HOST}" ]; then
  BASE_HOST_ESCAPED="${BASE_HOST//./\\.}"
  sudo nginx -T | sed -n "/server_name ${BASE_HOST_ESCAPED}/,/server {/p" | sed -n '1,120p' || true
else
  sudo nginx -T | sed -n '1,120p' || true
fi
if [ -f /etc/nginx/certs/relay-selfsigned.crt ]; then
  echo "使用自签证书: /etc/nginx/certs/relay-selfsigned.crt"
elif [ -f /etc/letsencrypt/live/*/fullchain.pem ]; then
  echo "使用 Let's Encrypt 证书"
else
  echo "未检测到已知证书文件"
fi

echo
echo "=== [5] 连通性快检 ==="
echo "--- HTTP 直连节点健康 ---"
curl -ksS --max-time 10 "http://127.0.0.1:8787/health" || true
echo
echo "--- 本地 Nginx 根路径（如域名解析与证书正常，响应应为 200/4xx）---"
if [[ "${BASE_URL}" == http://* || "${BASE_URL}" == https://* ]]; then
  curl -ksS --max-time 10 "${BASE_URL}/" || true
else
  curl -ksS --max-time 10 "https://${BASE_URL}/" || true
fi
echo
echo "--- Nginx 公开健康（仅当上游可达时返回）---"
if [[ "${BASE_URL}" == https://* || "${BASE_URL}" == http://* ]]; then
  HEALTH_URL="${BASE_URL}/health"
else
  HEALTH_URL="https://${BASE_URL}/health"
fi
curl -ksS --max-time 10 "${HEALTH_URL}" || true
echo
if [[ "${BASE_HOST}" == "localhost" || "${BASE_HOST}" == "127.0.0.1" ]]; then
  echo "提示：服务器内部建议优先用本地 127.0.0.1:8787 做服务层巡检，公网地址从外部网络访问更准确。"
else
  echo "提示：服务器内部访问公网地址可能被回环路由规则拦截，若出现超时，请改为外部网络验证。"
fi

echo "=== 完成 ==="
