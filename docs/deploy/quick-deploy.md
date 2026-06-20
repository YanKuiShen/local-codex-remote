# 快速部署（中文 / English）

## 中文

这份清单对应你当前架构：**电脑端运行 connector**，**云端只跑 relay + 资源**。

### 一、先设置连接参数

```bash
export REMOTE_HOST=YOUR_SERVER_IP_OR_DOMAIN
export REMOTE_USER=admin
export PROJECT_DIR=/opt/local-codex
export PUBLIC_BASE_URL=https://YOUR_SERVER_IP_OR_DOMAIN
export DOMAIN=your-domain.example.com
export CODEX_MAX_USER_SESSIONS=500   # 同时在线用户会话上限
export CODEX_MAX_CONNECTORS=300      # 同时在线 connector 上限
export CODEX_IP_ALLOWLIST="1.2.3.4/32,10.0.0.0/24"
export CODEX_AUTH_RATE_MAX_FAILS=5
export CODEX_AUTH_RATE_BLOCK_MS=60000
export CODEX_ADMIN_RATE_MAX_FAILS=6
```

可选：

```bash
export DOMAIN=your-domain.example.com
export PUBLIC_BASE_URL="https://your-domain.example.com"
```

### 二、执行发布（本机运行）

```bash
bash docs/deploy/deploy-stack.sh
```

### 三、子域名 + HTTPS + WAF/防火墙（建议）

脚本会部署 Node 服务。建议优先使用子域名（如 `https://remote.example.com`）并执行安全加固脚本：

1. `security-hardening.sh` 已内置 `80/443` 反代、限流、仅保留 22/80/443 出口；
2. 执行：

```bash
export DOMAIN=your-domain.example.com
export PROJECT_DIR=/opt/local-codex
export IP_ALLOWLIST_CIDR="1.2.3.4/32,10.0.0.0/24"
export ALERT_WEBHOOK=https://xxx.your-alert.com/webhook    # 可选
bash docs/deploy/security-hardening.sh
```

3. 在云厂商 WAF/安全组再做一次来源 IP 白名单（推荐仅你的公网 IP/网段）和 `/codex/auth/verify`、`/codex/admin/verify`、`/agent` 的告警；
   - 腾讯云 WAF 细节见：`docs/deploy/tencent-waf-and-sg-guide.md`
   - 阿里云 WAF：加白名单 + CC 防护速率封禁，触发告警；

示例（Linux 层面补充）：
```bash
# 限制来源 IP（可选，和应用层白名单一致）
export APP_ALLOWLIST="1.2.3.4/32 10.0.0.0/24"  # 空格分隔
for cidr in ${APP_ALLOWLIST}; do
  sudo ufw allow from ${cidr} to any port 80 proto tcp
  sudo ufw allow from ${cidr} to any port 443 proto tcp
done
```
4. `CONNECTOR_TLS_CA_PATH` 为空时，下载的 Mac/Windows 客户端会尝试从 `/codex/connector/cert.pem` 获取证书。

### 四、验收命令

```bash
curl -sS "${PUBLIC_BASE_URL}/health"
```

你手机网页可访问：

- `http://YOUR_SERVER_IP_OR_DOMAIN`（无 HTTPS）或
- `https://你的域名`（有 HTTPS）

## English

This project is designed as: **Codex runs on your PC**, cloud only runs **relay + web assets**.

### 1) Set deploy variables

```bash
export REMOTE_HOST=YOUR_SERVER_IP_OR_DOMAIN
export REMOTE_USER=admin
export PROJECT_DIR=/opt/local-codex
export PUBLIC_BASE_URL=https://YOUR_SERVER_IP_OR_DOMAIN
export DOMAIN=your-domain.example.com
export CODEX_MAX_USER_SESSIONS=500
export CODEX_MAX_CONNECTORS=300
export CODEX_IP_ALLOWLIST="1.2.3.4/32,10.0.0.0/24"
export CODEX_AUTH_RATE_MAX_FAILS=5
export CODEX_AUTH_RATE_BLOCK_MS=60000
export CODEX_ADMIN_RATE_MAX_FAILS=6
```

Optional:

```bash
export DOMAIN=your-domain.example.com
export PUBLIC_BASE_URL="https://your-domain.example.com"
```

### 2) Deploy from local machine

```bash
bash docs/deploy/deploy-stack.sh
```

### 3) TLS

Use subdomain HTTPS first (recommended), then run:

1. put Nginx/HAProxy in front of `127.0.0.1:8787`,
2. run security hardening (ports 22/80/443 + proxy + rate-limit):

```bash
export DOMAIN=your-domain.example.com
export PROJECT_DIR=/opt/local-codex
export IP_ALLOWLIST_CIDR="1.2.3.4/32,10.0.0.0/24"
export ALERT_WEBHOOK=https://xxx.your-alert.com/webhook    # optional
bash docs/deploy/security-hardening.sh
```

3. configure WAF whitelist and alerts for `/codex/auth/verify`, `/codex/admin/verify`, `/agent`.
   - Tencent WAF guide: `docs/deploy/tencent-waf-and-sg-guide.md`
   - Alibaba WAF: add IP whitelist + CC rule and alert actions.

Example (Linux firewall complement):
```bash
# Optional: restrict source CIDRs at OS-level, aligned with CODEX_IP_ALLOWLIST
export APP_ALLOWLIST="1.2.3.4/32 10.0.0.0/24"
for cidr in ${APP_ALLOWLIST}; do
  sudo ufw allow from ${cidr} to any port 80 proto tcp
  sudo ufw allow from ${cidr} to any port 443 proto tcp
done
```
4. clients will download cert from `/codex/connector/cert.pem` if `CONNECTOR_TLS_CA_PATH` is not configured.

### 4) Health checks

```bash
curl -sS "${PUBLIC_BASE_URL}/health"
```
