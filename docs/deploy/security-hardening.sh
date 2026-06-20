#!/usr/bin/env bash
set -euo pipefail

# 用法：
# 1) 将此脚本拷贝到服务器执行（如 /tmp/security-hardening.sh）
# 2) 先 export 变量后执行：DOMAIN=remote.example.com PROJECT_DIR=/opt/local-codex bash security-hardening.sh

: "${DOMAIN:?请先设置 DOMAIN，比如 remote.example.com}"
: "${PROJECT_DIR:?请先设置 PROJECT_DIR，比如 /opt/local-codex}"
: "${WEB_ROOT:=${PROJECT_DIR}/apps/mobile-web/dist}"

ALERT_WEBHOOK="${ALERT_WEBHOOK:-}"
IP_ALLOWLIST_CIDR="${IP_ALLOWLIST_CIDR:-}"
ENABLE_NGINX_IP_ALLOWLIST="${ENABLE_NGINX_IP_ALLOWLIST:-0}"
AUTO_GENERATE_ADMIN_KEY="${AUTO_GENERATE_ADMIN_KEY:-1}"
CERT_FULLCHAIN="${CERT_FULLCHAIN:-}"
CERT_PRIVKEY="${CERT_PRIVKEY:-}"

if [[ -z "${IP_ALLOWLIST_CIDR}" ]]; then
  echo "未设置 IP_ALLOWLIST_CIDR：公网入口放行全部 IP，安全限制由验证码、token、后端限流与日志承担。"
elif [[ "${ENABLE_NGINX_IP_ALLOWLIST}" != "1" ]]; then
  echo "已设置 IP_ALLOWLIST_CIDR，但默认不写入 Nginx 硬白名单，避免手机蜂窝网络 IP 变化后无法登录。"
  echo "如确认只有固定出口 IP 访问，可设置 ENABLE_NGINX_IP_ALLOWLIST=1 后再执行。"
fi

if [[ -z "${CERT_FULLCHAIN}" || -z "${CERT_PRIVKEY}" ]]; then
  if [[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" && -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]]; then
    CERT_FULLCHAIN="/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
    CERT_PRIVKEY="/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
  elif [[ -f "/etc/nginx/certs/relay-selfsigned.crt" && -f "/etc/nginx/certs/relay-selfsigned.key" ]]; then
    CERT_FULLCHAIN="/etc/nginx/certs/relay-selfsigned.crt"
    CERT_PRIVKEY="/etc/nginx/certs/relay-selfsigned.key"
  fi
fi

if [[ -z "${CERT_FULLCHAIN}" || -z "${CERT_PRIVKEY}" ]]; then
  echo "未找到可用证书文件。请设置 CERT_FULLCHAIN/CERT_PRIVKEY，或先申请 Let’s Encrypt。"
  exit 1
fi

NGINX_ALLOW_LIST_BLOCK=""
if [[ -n "${IP_ALLOWLIST_CIDR}" && "${ENABLE_NGINX_IP_ALLOWLIST}" == "1" ]]; then
  while IFS=',' read -ra _IPS; do
    for _IP in "${_IPS[@]}"; do
      _IP="${_IP//[[:space:]]/}"
      if [[ -n "${_IP}" ]]; then
        NGINX_ALLOW_LIST_BLOCK+=$'  allow '"${_IP}"$';\n'
      fi
    done
  done <<< "${IP_ALLOWLIST_CIDR}"
  NGINX_ALLOW_LIST_BLOCK+="  deny all;"
fi

echo "=== 1) 端口收敛：只保留 22/80/443 ==="
echo "  - 强烈建议外部 WAF/安全组也仅放行你自己的公网网段到 80 与 443。"
echo "  - 如需本机也可配合 ufw 源地址白名单（脚本下方会加固）。"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
if [[ -n "${IP_ALLOWLIST_CIDR}" && "${ENABLE_NGINX_IP_ALLOWLIST}" == "1" ]]; then
  echo "  - 应用设置了来源白名单，补充 ufw 源地址限制到 80/443。"
  while IFS=',' read -ra _IPS; do
    for _IP in "${_IPS[@]}"; do
      _IP="${_IP//[[:space:]]/}"
      if [[ -n "${_IP}" ]]; then
        sudo ufw allow from "${_IP}" to any port 80 proto tcp
        sudo ufw allow from "${_IP}" to any port 443 proto tcp
      fi
    done
  done <<< "${IP_ALLOWLIST_CIDR}"

  sudo ufw --force delete allow 80/tcp || true
  sudo ufw --force delete allow 443/tcp || true
  sudo ufw --force delete allow 80 || true
  sudo ufw --force delete allow 443 || true
fi
sudo ufw --force enable
sudo ufw status numbered

echo "=== 1.1) 防止误改：如需仅允许固定出口，可再执行云控制台侧白名单 ==="
echo "说明：云厂商安全组建议同步设置为仅允许你的客户端 IP/网段访问 80 与 443。"

echo "=== 2) 安装并写入 nginx 配置（子域名 + WS + 反代） ==="
echo "已检测到证书：${CERT_FULLCHAIN}"
sudo install -d /etc/nginx/sites-available /etc/nginx/sites-enabled /etc/nginx/conf.d
cat >/tmp/codex-remote.conf <<EOF
server {
  listen 80;
  server_name ${DOMAIN};
  access_log off;
  return 301 https://\$host\$request_uri;
}

limit_req_zone \$binary_remote_addr zone=codex_auth_zone:10m rate=20r/m;
limit_req_zone \$binary_remote_addr zone=codex_admin_zone:10m rate=10r/m;
limit_conn_zone \$binary_remote_addr zone=codex_conn_zone:10m;

server {
  listen 443 ssl;
  server_name ${DOMAIN};

  ssl_certificate ${CERT_FULLCHAIN};
  ssl_certificate_key ${CERT_PRIVKEY};
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_session_timeout 1d;
  ssl_session_cache shared:SSL:10m;

  client_max_body_size 20m;
${NGINX_ALLOW_LIST_BLOCK}
  access_log /var/log/nginx/codex-access.log;
  error_log /var/log/nginx/codex-error.log warn;

  add_header X-Content-Type-Options "nosniff" always;
  add_header X-Frame-Options "DENY" always;
  add_header Referrer-Policy "no-referrer-when-downgrade" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

  location / {
    root ${WEB_ROOT};
    try_files \$uri \$uri/ /index.html;
  }

  location /codex/ {
    limit_req zone=codex_auth_zone burst=15 nodelay;
    limit_conn codex_conn_zone 5;
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }

  location /ws {
    limit_conn codex_conn_zone 10;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:8787;
  }

  location /agent {
    limit_req zone=codex_admin_zone burst=5 nodelay;
    proxy_http_version 1.1;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
    proxy_pass http://127.0.0.1:8787;
  }

  location ~ ^/codex/connector/(cert\.pem|bundle\.cjs|download|download/.*)$ {
    proxy_pass http://127.0.0.1:8787;
  }
}
EOF
sudo install -m 644 /tmp/codex-remote.conf /etc/nginx/sites-available/codex-remote.conf
sudo ln -sf /etc/nginx/sites-available/codex-remote.conf /etc/nginx/sites-enabled/codex-remote.conf

echo "=== 3) 证书提示 ==="
if [[ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" && -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]]; then
  echo "已使用 Let’s Encrypt 证书：${DOMAIN}"
elif [[ "${CERT_FULLCHAIN}" == "/etc/nginx/certs/relay-selfsigned.crt" ]]; then
  echo "当前使用本机自签证书：${CERT_FULLCHAIN}（浏览器首次访问可能有信任提示）。"
else
  echo "请先执行：sudo certbot --nginx -d ${DOMAIN}"
fi

echo "=== 4) 重载 nginx ==="
sudo nginx -t
sudo systemctl reload nginx

echo "=== 5) 应用层环境变量模板（仅示例，按实际值保存到 ${PROJECT_DIR}/.env） ==="
mkdir -p "${PROJECT_DIR}/secrets" "${PROJECT_DIR}/logs"
cat > /tmp/security.env <<EOF
PORT=8787
HOST=127.0.0.1
PUBLIC_BASE_URL=https://${DOMAIN}
CODEX_ADMIN_KEY_FILE=${PROJECT_DIR}/secrets/codex-admin-key.txt
CODEX_IP_ALLOWLIST=${IP_ALLOWLIST_CIDR}
CODEX_AUTH_KEY_ALLOWLIST=
CODEX_SESSION_TTL_MS=900000
CODEX_ADMIN_SESSION_TTL_MS=300000
CODEX_SECURITY_AUDIT_LOG_PATH=${PROJECT_DIR}/logs/security.log
CODEX_SECURITY_ALERT_WEBHOOK=${ALERT_WEBHOOK}
CODEX_SECURITY_ALERT_THROTTLE_MS=60000
CODEX_AUTH_RATE_WINDOW_MS=600000
CODEX_AUTH_RATE_MAX_FAILS=5
CODEX_AUTH_RATE_BLOCK_MS=60000
CODEX_ADMIN_RATE_WINDOW_MS=600000
CODEX_ADMIN_RATE_MAX_FAILS=6
CODEX_ADMIN_RATE_BLOCK_MS=1200000
CODEX_MAX_USER_SESSIONS=500
CODEX_MAX_CONNECTORS=300
EOF

if [[ -f "${PROJECT_DIR}/.env" ]]; then
  echo "检测到 ${PROJECT_DIR}/.env 已存在，先备份为 ${PROJECT_DIR}/.env.bak-hardened"
  sudo cp -p "${PROJECT_DIR}/.env" "${PROJECT_DIR}/.env.bak-hardened"
fi

install -m 600 /tmp/security.env "${PROJECT_DIR}/.env"
cat "${PROJECT_DIR}/.env"

if [[ -z "$(tr -d '[:space:]' < "${PROJECT_DIR}/secrets/codex-admin-key.txt" 2>/dev/null || true)" ]]; then
  if [[ "${AUTO_GENERATE_ADMIN_KEY}" == "1" ]]; then
    openssl rand -hex 24 | tr -d '\n' | sudo tee "${PROJECT_DIR}/secrets/codex-admin-key.txt" >/dev/null
    sudo chmod 600 "${PROJECT_DIR}/secrets/codex-admin-key.txt"
    echo "已生成管理员密钥文件：${PROJECT_DIR}/secrets/codex-admin-key.txt"
  else
    echo "未检测到管理员密钥文件或内容为空。请先手工创建 secrets/codex-admin-key.txt（600权限）。"
  fi
else
  sudo chmod 600 "${PROJECT_DIR}/secrets/codex-admin-key.txt"
fi

echo "=== 完成 ==="
