# 部署指南（中国大陆）

目标形态：单台 VPS + Docker Compose（Postgres + 应用 + Caddy），约 **¥40~70/月**。

---

## 0. 先读这一节：备案是硬性前置条件

**如果你的服务器在中国大陆，域名必须先完成 ICP 备案。**

未备案域名解析到大陆服务器时：

- 80 / 443 端口被运营商直接阻断
- 因此 Caddy 的 ACME 校验必然失败，表现为"证书一直申请不到"，
  而不是报一个清楚的备案错误——这是最容易浪费时间的地方

备案要点：

| 事项 | 说明 |
|---|---|
| 周期 | 通常 7~20 个工作日，**建议项目第一天就提交**，不要等开发完 |
| 前置 | 需先购买大陆服务器（多数云厂商要求 3 个月以上时长）并完成域名实名 |
| 主体 | 个人可备案，但**论坛/社区类**通常被要求企业主体，且可能需要额外材料 |
| 内容 | 涉及 UGC 的社区，部分省份要求提供内容审核制度说明 |
| 公安备案 | ICP 通过后 30 日内还需完成公安联网备案（多数省份线上可办） |

### 三种可行方案

| 方案 | 备案 | 中国大陆访问速度 | 适用 |
|---|---|---|---|
| **大陆服务器 + 已备案域名 + 企业主体** | 需要（长） | 最快 | 长期运营的正式社区 |
| **香港服务器 + 无需备案** | 不需要 | 尚可（延迟 30~80ms，晚高峰可能波动） | 快速上线试水、个人项目 |
| **境外服务器（新加坡/日本）** | 不需要 | 较差（延迟 80~200ms，可能丢包） | 面向海外中文用户 / 纯开发验证 |

> 本仓库的配置**三种情况都适用**，不需要改动。差别只在买哪里的机器。

### 推荐节奏：开发验证与备案并行

一个常见且划算的做法是先用一台便宜机器开发验证，同时把备案流程跑起来：

```
第 1 个月：便宜机器上开发验证 ──┐
                              ├─→ 提前买大陆服务器 + 立刻提交备案（并行！）
第 1 个月末：大陆服务器到手 ─────┘
                              ↓
                    备案审核 7~20 工作日（这期间服务器闲置）
                              ↓
                    备案通过 → 迁移上线（见第 6 节）
```

**关键：不要等开发机到期才买正式服务器。** 那样会白等 20~30 天。
备案审核期服务器闲置的成本，远低于多等一个月的代价。

---

## 1. 服务器选型

**推荐**：2 vCPU / 4 GB 内存 / 80 GB SSD。

- 2 GB 也能跑，但**首次 `docker compose build` 有 OOM 风险**（构建峰值 1.8~3.3 GB）。
  补救措施见下面的「低内存机器构建」
- 磁盘优先选 **SSD / ESSD**，不要普通云盘。Postgres 的随机读性能直接决定
  消息列表响应速度，`pg_trgm` 搜索索引的读放大更明显。这比 CPU 核心数重要得多
- 带宽不是瓶颈：SSE 心跳在 100 条连接下仅约 1.1 kbps。只有附件吃流量
- 国内可选：阿里云 / 腾讯云 / 华为云 的轻量应用服务器
- 境外可选：Hetzner CX22（$5.60/月，但只有新加坡亚洲节点）、Vultr、DigitalOcean

系统建议 **Ubuntu 22.04 / 24.04 LTS**。

### 内存参考（实测）

| 项 | 占用 |
|---|---|
| 构建峰值（`npm ci` + `next build`） | 1.8~3.3 GB |
| Postgres（`shared_buffers=256MB`） | 400~700 MB |
| Node 应用（0 连接） | ~150 MB |
| Node 应用（1,000 SSE 连接） | ~180 MB |
| Node 应用（10,000 SSE 连接） | ~450 MB |
| Caddy | 30~50 MB |
| 系统 + Docker daemon | 250~400 MB |

每个 SSE 连接约 30 KB 常驻。真正的容量瓶颈通常是**文件描述符数量**而非 CPU。

### 低内存机器：在本地构建镜像（★ 推荐做法）

**结论先说：内存小于 3GB 的服务器，不要在上面构建。**

实测教训：在 1.6GB 的机器上跑 `docker compose build`，`npm ci` + `next build`
峰值约 1.8GB，超出部分全压到 swap，内核换页抖动严重到
**sshd 收下 TCP 连接却无法完成 banner 交换** —— SSH 完全失联，
只能去云控制台硬重启。即使把 Postgres/Caddy 都停掉，可用内存也只有约 1.4GB，
仍然在临界点上挣扎。

正确做法：**本地构建 → 导出镜像 → 服务器只 `docker load`**。
`docker load` 只是磁盘写入，内存开销可忽略。

```bash
# ① 在 WSL 里构建并导出（首次约 11 分钟，之后缓存命中约 1~2 分钟）
npm run build:image
# 产出：dist/bbs-images.tar.gz（约 205MB）

# ② 在 Windows 上：上传代码 + 镜像 → load → 迁移 → 重启 → 验证
npm run deploy:local -- -Server admin@<IP> -Images -Smoke
```

服务器端**完全不做构建**，因此：
- 内存压力从约 1.8GB 降到接近 0
- 构建失败不会影响线上服务
- 发布速度取决于传输带宽，而不是服务器 CPU

#### 前置：安装 WSL2 里的 Docker Engine

```bash
# 在 WSL 终端里（需要你的 Linux 密码）
cd "/mnt/e/dsh project bbs"
sudo bash scripts/wsl-install-docker.sh
```

> **大陆网络注意**：Docker Hub 的 `registry-1.docker.io` 会被解析到纯 IPv6
> 地址，而多数家宽 IPv6 不通，表现为 `dial tcp ...: i/o timeout`。
> 安装脚本已写好镜像加速器配置。若拉取仍失败，检查
> `/etc/docker/daemon.json` 里的 `registry-mirrors` 是否可用。

#### 镜像标签必须固定

`docker-compose.yml` 里给 app / migrate / seed 都写了显式 `image: bbs-*`。

**不要删掉这些 `image:` 行。** 不加的话 compose 会按**项目目录名**推导标签
（`/opt/bbs` 下是 `bbs-app`，`~/bbs-build` 下是 `bbs-build-app`），
于是本地导出、服务器加载、服务器 compose 查找三处的名字对不上：
`docker load` 报告成功，但服务起不来或静默用了旧镜像，**报错完全不指向真正原因**。

#### 直接构建（仅 ≥ 3GB 内存）

```bash
docker compose build app migrate seed
```

> ⚠️ **`build` 必须显式列出三个服务。**
> `docker compose build` 不带参数只构建有 `build:` 段的服务，
> 而 migrate / seed 各自有独立镜像标签。只建 app 的话，
> `docker compose run --rm migrate` 会用到**上次构建的旧镜像**，
> 表现为"代码改了但迁移脚本还是旧的"——这个坑真实发生过。

---

## 2. 服务器初始化

### 推荐：用附带的一键脚本

仓库里的 `scripts/provision.sh` 已完成下面全部工作，并且是幂等的：

```bash
# 以 root 登录新机器后
# 大陆服务器务必带镜像加速器地址（从云厂商「容器镜像服务 → 镜像加速器」获取）
DOCKER_MIRROR=https://<你的地址>.mirror.aliyuncs.com bash provision.sh
```

它做六件事：

1. 建非 root 用户并授予 sudo
2. 加固 SSH（禁 root 登录、禁密码登录）——**先 `sshd -t` 校验语法再重载**，防止把自己锁在外面
3. ufw 只放行 22 / 80 / 443
4. 配 2GB swap 并把 `swappiness` 调到 10
5. 把文件描述符上限提到 65535
6. 装 Docker + 镜像加速器 + fail2ban + 自动安全更新，并配置 Docker 日志轮转

> ★ 脚本跑完后**先开一个新终端确认 `ssh deploy@<IP>` 能登录，再关闭 root 会话**。

### 手动步骤（供审查或脚本不适用时参考）

```bash
# ── 创建非 root 用户（不要用 root 跑服务）──────────────────────────
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys

# ── 加固 SSH：禁 root 登录、禁密码登录 ─────────────────────────────
# 先确认新用户可以正常登录并 sudo，再执行这一步，否则会把自己锁在外面
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sshd -t                       # 先校验语法，通过再重启
systemctl restart ssh

# ── 防火墙：只放行 SSH 与 Web ─────────────────────────────────────
# 注意：应用端口 3000 与数据库端口 5432 都不对公网开放，
# 它们只在 compose 内网中可达。这是本部署方案的重要安全边界。
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp      # HTTP/3
ufw enable

# ── swap：2GB 内存机器必需，否则 docker compose build 会 OOM ──────
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10

# ── 文件描述符上限：SSE 长连接应用最经典的容量陷阱 ────────────────
# 默认 1024 会在 300~400 并发连接时开始报错
cat >/etc/security/limits.d/99-bbs.conf <<'EOF'
*    soft nofile 65535
*    hard nofile 65535
EOF
echo 'fs.file-max = 200000' >> /etc/sysctl.d/99-bbs.conf
sysctl --system

# ── SSH 防爆破 ────────────────────────────────────────────────────
apt-get update && apt-get install -y fail2ban
systemctl enable --now fail2ban

# ── 安装 Docker ───────────────────────────────────────────────────
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy
# 国内服务器必须配镜像加速器，否则拉取 node:22-bookworm-slim 会超时：
#   /etc/docker/daemon.json → {"registry-mirrors": ["https://<你的加速地址>"]}
systemctl restart docker
```

> **重要**：如果使用云厂商的安全组，还要在控制台里再放行一次 80/443。
> `ufw` 与安全组是两层独立过滤，只配一层是常见疏漏。

---

## 3. 拉取代码与配置

```bash
su - deploy
git clone <你的仓库地址> /opt/bbs
cd /opt/bbs

# 生成会话密钥（不要复用示例值）
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
# 或服务器上没有 node：openssl rand -base64 48
```

创建 `/opt/bbs/.env`（**不要提交到 git**）：

```bash
# ── 域名 ────────────────────────────────────────────────────────
# 大陆生产：填已备案域名
# 境外验证机（用 SSH 隧道时）：DOMAIN=localhost, SITE_URL=http://localhost:3000
DOMAIN=bbs.example.com
SITE_URL=https://bbs.example.com
SITE_NAME=技术社区

# ── 数据库 ──────────────────────────────────────────────────────
POSTGRES_USER=bbs
POSTGRES_PASSWORD=<用 openssl rand -base64 24 生成，不要用弱口令>
POSTGRES_DB=bbs

# ── 会话密钥 ────────────────────────────────────────────────────
SESSION_SECRET=<上一步生成的随机串>

# ── Snowflake ID ────────────────────────────────────────────────
# ⚠️ 一旦有数据就不可再改，改了会让 ID 失去单调性，分页与实时补齐都会错乱
# 从验证机迁移到生产机时，这两个值必须原样保留
SNOWFLAKE_EPOCH=1704067200000
SNOWFLAKE_WORKER_ID=1

# ── 首个管理员（仅在首次 seed 时使用）───────────────────────────
SEED_ADMIN_EMAIL=you@example.com
SEED_ADMIN_PASSWORD=<强口令，至少 10 位>
SEED_ADMIN_HANDLE=admin
```

```bash
chmod 600 /opt/bbs/.env
```

---

## 4. 首次部署

### 推荐：一条命令

```bash
cd /opt/bbs
chmod +x scripts/*.sh
./scripts/deploy.sh                 # 构建 → 迁移 → 重启 → 健康检查
./scripts/deploy.sh --smoke         # 上面全部 + 端到端验证
```

首次部署后还要写入初始化数据（分类、频道、内置角色、首个管理员）：

```bash
docker compose run --rm seed
```

`deploy.sh` 内部严格保证顺序，并在失败时保留旧版本继续服务：

```
环境检查 → 更新代码 → 构建镜像 → 数据库迁移 → 启动服务 → 健康检查
                        ↓失败         ↓失败         ↓失败
                    中止（旧版仍在跑）  中止       打印日志并中止
```

它解决的三个具体问题：

| 问题 | 脚本的做法 |
|---|---|
| 迁移与应用更新顺序颠倒 | 强制「先迁移，再 `up -d`」 |
| `NEXT_PUBLIC_*` 改了没生效 | 把 build 和 up 绑在一起，杜绝"只 restart" |
| 构建失败把站点留在半更新状态 | `set -e` + 首步构建，失败即停，旧容器继续服务 |

常用参数：

```bash
./scripts/deploy.sh --no-pull       # 不拉 git（配合本地上传的代码）
./scripts/deploy.sh --no-build      # 只改了 .env 等运行时配置
./scripts/deploy.sh --rollback      # 回到上一个 git 提交并重新部署
./scripts/deploy.sh --help
```

### 从 Windows 本地一键编排

如果不习惯在服务器上敲命令，可以在本地运行：

```powershell
npm run deploy:local -- -Server root@1.2.3.4
npm run deploy:local -- -Server root@1.2.3.4 -Smoke
npm run deploy:local -- -Server root@1.2.3.4 -CheckEnv   # 只体检，不改动

# 低内存服务器：本地构建镜像 → 上传 → 服务器零构建
npm run build:image
npm run deploy:local -- -Server root@1.2.3.4 -Images -Smoke
```

它会：本地前置检查 → 远程体检（内存/swap/fd 上限/Docker/.env，并给出告警）→
tar 打包上传 → 远程执行 `deploy.sh` → 返回退出码。

#### SSH 身份与主机密钥

脚本默认使用项目内的 `.ssh-local/bbs_deploy` 与 `.ssh-local/known_hosts`
（均在 `.gitignore` 中），因此**新机器不需要任何手工 ssh 配置**即可部署。

> 早期版本调用的是裸 `ssh`，即依赖操作者自己有 `~/.ssh/config` 和已填充的
> `known_hosts`。在干净的 Windows 上这不成立，而报错极具误导性：
>
> ```
> ssh.exe : Host key verification failed.
> ```
>
> 这句话完全没提"脚本从未告诉 ssh 用哪把钥匙"。而且裸 ssh 会回落到密码认证，
> 而 `BatchMode=yes` 又禁止了交互输入，最终表现为一个无法解释的连接失败。

可用参数覆盖：

```powershell
-Key <私钥路径>            # 换一把部署密钥
-KnownHosts <文件路径>     # 换一个 known_hosts
-Insecure                  # 完全跳过主机密钥校验（仅限一次性验证机）
```

默认是 `StrictHostKeyChecking=accept-new`：首次连接记录主机密钥，
**但主机密钥一旦变化就立刻失败**（那正是中间人攻击的样子）。

> ⚠️ `deploy.ps1` 是**纯 ASCII**的。原因：Windows PowerShell 5.1 会用系统 ANSI 代码页
> （中文系统为 GBK/936）解码没有 UTF-8 BOM 的 `.ps1`，
> 写中文会变成乱码。人读的说明一律放在本文件里。

### 手动步骤（首次部署时用于理解每一步）

```bash
cd /opt/bbs

# 1) 构建镜像（2GB 机器先看第 1 节的「低内存机器构建」）
docker compose build

# 2) 执行数据库迁移（必须在应用启动前完成）
docker compose run --rm migrate

# 3) 写入初始化数据
docker compose run --rm seed

# 4) 启动全部服务
docker compose up -d

# 5) 观察日志，确认 Caddy 拿到证书
docker compose logs -f caddy
```

看到类似 `certificate obtained successfully` 后访问 `https://你的域名`。

首次 ACME 申请需要域名已解析到本机且 80 端口可达——
如果一直失败，先检查备案状态与安全组，而不是反复重启 Caddy。

### 没有域名时：用 SSH 隧道验证

如果这台机器只是用来开发/验证（例如境外机器、还没备案），**不要**去折腾域名和证书。
用 SSH 隧道，两分钟就能访问：

```bash
# 本地 Windows / macOS 上执行
ssh -N -L 3000:127.0.0.1:3000 deploy@<服务器IP>
# 然后浏览器打开 http://localhost:3000
```

对应 `.env`：

```bash
DOMAIN=localhost          # Caddy 见到 localhost 会用内部自签证书，不会去申请 Let's Encrypt
SITE_URL=http://localhost:3000
COOKIE_SECURE=false        # ★ 必须设置，原因见下
```

省掉域名、证书、备案的全部干扰，专注验证功能。

> ★ **`COOKIE_SECURE=false` 是隧道方案的必要配置，不是可选项。**
>
> 生产模式下会话 Cookie 默认带 `Secure` 标志，而浏览器在 `http://` 下
> **不会发送** Secure Cookie。结果是"登录成功但立刻又变回未登录"，
> 极容易被误判成认证逻辑有 bug。
>
> 这个开关只应在纯 HTTP 的验证环境使用。**任何走 HTTPS 的环境都必须留空**
> （留空 = 跟随 `NODE_ENV`，生产为 true）。

### 冒烟验证清单

```bash
# 健康检查：期望 status=ok，database.ok=true
curl -s http://127.0.0.1:3000/api/health | head -20

# 容器状态：三个服务都应是 healthy
docker compose ps

# 数据库连通性
docker compose exec postgres pg_isready -U bbs

# 公开频道列表
curl -s http://127.0.0.1:3000/api/channels | head -30
```

然后**务必**跑第 5 节的端到端验证脚本——它能发现"页面看起来正常但实时其实不通"这类问题。

---

## 5. 端到端验证（部署后必跑）

附带的 `scripts/smoke.mjs` 会验证四件"打开页面看看"无法确认的事：

1. 用户能注册、频道能列出、消息能落库
2. SSE 能建立连接（含跨源检查与 Cookie 鉴权）
3. **A 发的消息，B 能在 2 秒内收到** ← 本项目的核心验收标准
4. **心跳是否按时到达** ← 判断是否有中间层在缓冲 SSE

```bash
# 容器内跑（推荐：默认连 http://127.0.0.1:3000，且自动带上 .env 里的口令）
cd /opt/bbs && docker compose exec -T app node scripts/smoke.mjs

# 或经 deploy.sh（等价，只是多包一层输出）
./scripts/deploy.sh --no-pull --no-build --smoke

# 指定站点地址（验证对外域名，含 Caddy 的 SSE 配置）
BASE_URL=https://bbs.example.com node scripts/smoke.mjs
```

脚本只依赖 Node 内置能力（`fetch` / `crypto`），不需要安装任何依赖。

### 必须先设置 `SMOKE_PASSWORD`

脚本用两个**长期固定的账号**（`smokea` / `smokeb`）模拟两个浏览器互相收发消息。
它们的口令**不写在源码里**：写死等于把一把长期有效的钥匙提交进版本库，
仓库转公开或加协作者时就泄露了。放在服务器 `.env` 里，由 compose 注入容器：

```bash
# 生成一个随机口令（不要复用 SESSION_SECRET）
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
# 写进 /opt/bbs/.env
SMOKE_PASSWORD=<上面生成的串>
```

未配置时脚本以退出码 **2** 报配置错误（而不是回退到某个默认口令，也不是静默跳过）。
退出码 **1** 才表示"站点有项目失败"，两者刻意区分开。

账号不存在时脚本会自动注册它们，所以首次配好直接跑即可；之后每次都是登录。

> `deploy.sh` 会在迁移之后自动跑一次 `db:seed`（幂等），它会创建这两个夹具
> 账号并把它们的 `trust_level` 设为 **1**。这一步很关键：夹具不是新用户，
> 不该被新人限流约束 —— 少这一步，`verify-attachments.mjs` 在账号未满
> 10 分钟时会因"冷却期禁止附件"整片失败，看起来像附件功能坏了。

> 改口令用 `scripts/set-password.mjs`（会同时撤销该用户的所有会话）：
>
> ```bash
> docker compose exec -T app sh -c 'NEW_PASSWORD="$SMOKE_PASSWORD" node scripts/set-password.mjs smokea'
> ```

### 另外两个验证脚本

```bash
# 新人限流策略单元测试：注入假时钟，穷举 10 分钟 / 24 小时边界与配额
# 不碰数据库、不发网络请求，毫秒级完成
docker compose exec -T app node scripts/test-trust.mjs
# 本机也行：
npm run test:trust

# 新人限流端到端：注册一个真新账号，验证第 2 条被拒、冷却期禁附件，
# 然后等过间隔证明"是延迟而非封禁"（约 35 秒，含 31 秒等待）
docker compose exec -T app node scripts/verify-newuser.mjs

# 附件链路：写入 → 卷 → Caddy 直出 的完整闭环，含魔法数字与响应头
docker compose exec -T app sh -c 'CADDY_URL=http://caddy node scripts/verify-attachments.mjs'
```

> **注册限流预算**：注册接口限流为 5 次/小时/IP。
> `verify-newuser.mjs` 每次运行注册 1 个新账号（新人限流只能对真新账号生效，
> 绕不开），`verify-attachments.mjs` 现在**不再注册**（改用夹具账号登录）。
> 所以一小时跑两轮完整验证是安全的。
>
> 验证会留下垃圾数据：`nu*@newuser.test` 账号与若干测试消息。
> 上线前需清理（连同演示账号 alice / bob / carol 一起）。

### 如何解读输出

```
结果  通过 22  失败 0  警告 1
```

| 现象 | 含义 | 处置 |
|---|---|---|
| `✗ 心跳检测` | **中间层在缓冲 SSE** | 检查 `Caddyfile` 的 `flush_interval -1`；若套了 CDN，需对该路径关闭缓冲（见 docs/EVENTS.md 第 7 节） |
| `✗ A 实时收到 B 的消息`，但页面刷新能看到消息 | SSE 链路断了，降级轮询也没生效 | 查浏览器控制台与 `docker compose logs app` |
| `! 延迟在 2000ms 预算内` | 延迟偏高但仍收到 | 若服务器在境外，这是**网络延迟，不是代码问题** |
| `✗ 未登录访问被拒` | 鉴权没生效 | 严重问题，先别开放注册 |
| `! 频道页服务端渲染消息` | 首屏消息没进 HTML | **SEO 会失效**，检查是否有页面被误改成客户端渲染 |

> ⚠️ **境外服务器的延迟结论不可用于预判大陆服务器的表现。**
> 新加坡到大陆延迟 80~200ms 且晚高峰有丢包，会让 SSE 频繁重连、
> 触发降级轮询。这是网络问题，**不要为了让"实时看起来更快"去改代码**。

---

## 6. 从境外验证机迁移到大陆生产机

典型场景：先用一台境外/低配机器开发验证，之后再买大陆服务器并备案上线。
下面是从验证机搬到生产机的完整流程。

### 迁移前：环境相关的东西已全部外置

本项目已做到这点——`docker-compose.yml`、`Caddyfile`、`.env` 都不含机器相关信息。
**因此迁移不需要改代码，只改 `.env`**。这是刻意设计的，迁移成本因此是分钟级。

需要改的只有四项：

| 变量 | 验证机 | 生产机 |
|---|---|---|
| `DOMAIN` | `localhost` | `bbs.example.com`（已备案） |
| `SITE_URL` | `http://localhost:3000` | `https://bbs.example.com` |
| `POSTGRES_PASSWORD` | 测试密码 | **换新密码** |
| `SESSION_SECRET` | 测试密钥 | **换新密钥**（换了会强制所有人重新登录，属预期） |

`SNOWFLAKE_EPOCH` 与 `SNOWFLAKE_WORKER_ID` **保持不变**——
纪元一旦有数据就不能改，改了会让 ID 失去单调性，分页与实时补齐全乱。

### 需要搬走的数据

`/opt/bbs` 下真正有状态的只有两处：

1. **数据库**（全部内容）
2. **`uploads` 卷**（附件；当前 P2 尚未实现上传功能，通常是空的）

```bash
# ── 在验证机上 ────────────────────────────────────────────────────
cd /opt/bbs
./scripts/backup.sh                       # 产出 backups/bbs-<时间戳>.sql.gz
ls -lh backups/                           # 确认文件存在且非 0 字节

tar czf /tmp/bbs-migrate.tar.gz \
  --exclude='node_modules' --exclude='.next' --exclude='var' \
  .env backups/bbs-*.sql.gz \
  package.json package-lock.json tsconfig.json next.config.ts drizzle.config.ts \
  Dockerfile docker-compose.yml Caddyfile src drizzle scripts public docs README.md

# 下载到本地（在本地执行）
# scp deploy@<验证机IP>:/tmp/bbs-migrate.tar.gz .
```

```bash
# ── 在生产机上 ────────────────────────────────────────────────────
sudo -iu deploy
cd /opt/bbs
tar xzf bbs-migrate.tar.gz          # 上传后解包

# 1) 改 .env 的四项（见上表）
vi .env

# 2) 启动数据库
docker compose up -d postgres
docker compose ps                   # 等 postgres 变成 healthy

# 3) 先跑迁移建表，再恢复数据 —— 顺序不能反
docker compose run --rm migrate
./scripts/restore.sh backups/bbs-<时间戳>.sql.gz

# 4) 启动全部服务
docker compose up -d

# 5) 验证（容器内跑；宿主上没有 node，app 端口也没映射到宿主）
docker compose exec -T app node scripts/smoke.mjs
```

> **为什么先 migrate 再 restore**：备份里已含 Drizzle 的迁移记录表。
> 若先 restore 再 migrate，migrate 会认为已执行过而跳过——当备份来自更早版本时
> 这就会漏掉新迁移。先 migrate 建立正确基线更安全。

### 迁移后的必查项

```bash
# ① 消息 ID 是否连续（Snowflake 纪元没被改动的证据）
docker compose exec postgres psql -U bbs -d bbs -c \
  "select min(id) as oldest, max(id) as newest, count(*) from messages;"

# ② 搜索索引是否随数据一起恢复（pg_trgm 扩展必须存在）
docker compose exec postgres psql -U bbs -d bbs -c "\dx pg_trgm"

# ③ 迁移记录是否完整
docker compose exec postgres psql -U bbs -d bbs -c \
  "select hash, created_at from drizzle.__drizzle_migrations order by created_at;"
```

### 迁移后别忘的三件事

1. **把备份 cron 挂到新机器**（旧机器的 crontab 不会跟过来）

   ```bash
   crontab -e
   # 加入：0 4 * * * /opt/bbs/scripts/backup.sh >> /var/log/bbs-backup.log 2>&1
   ```

2. **在 DNS 处把域名解析到生产机 IP**，并确认备案已通过
3. **旧验证机到期前先别销毁**：保留一周作为回滚兜底。确认生产机稳定后再释放

---

## 7. 备份（不做这一步等于没有数据）

单机部署没有托管数据库的自动 PITR，备份脚本就是唯一保障。

```bash
chmod +x /opt/bbs/scripts/*.sh

# 挂到 cron：每天凌晨 4 点
crontab -e
# 加入：
0 4 * * * /opt/bbs/scripts/backup.sh >> /var/log/bbs-backup.log 2>&1
```

**强烈建议**把备份同步到对象存储（Cloudflare R2 零出口费，10GB 免费）：

```bash
apt-get install -y rclone
rclone config          # 配置一个名为 r2 的 remote
# 然后在 .env 或 cron 环境里设置：R2_REMOTE=r2:bbs-backups
```

### 恢复演练

**上线前至少完整走一遍恢复流程到一台临时机器上。**
没演练过的备份策略等于没有备份策略。

```bash
docker compose stop app
./scripts/restore.sh backups/bbs-20250101-040000.sql.gz
docker compose start app
```

---

## 8. 更新部署

```bash
cd /opt/bbs
./scripts/deploy.sh              # 拉代码 → 构建 → 迁移 → 重启 → 健康检查
./scripts/deploy.sh --smoke      # 再跑一次端到端验证（改动了实时逻辑时建议带上）
```

或从 Windows 本地：

```powershell
npm run deploy:local -- -Server root@1.2.3.4 -Smoke
```

脚本内部顺序不能颠倒：**先迁移，再滚动更新应用**。
反过来的话，新代码会访问还不存在的列/表，表现为 500 而不是清晰的报错。

**注意 `NEXT_PUBLIC_SITE_NAME` 是构建期变量**：改站点名必须重新 `build`，
只 `restart` 容器不会生效。同理，任何 `NEXT_PUBLIC_*` 的改动都需要重建镜像。
`deploy.sh` 把 build 与 up 绑在一起，正是为了避免这个误判。

### 回滚

```bash
./scripts/deploy.sh --rollback
```

它执行 `git checkout HEAD~1` 后重新构建部署，并会提示：

- 数据库迁移**不回滚**（Drizzle 不生成 down 迁移）
- 若新版本引入了破坏性变更，回滚后应用可能报错
- 回到分支：`git checkout <分支名>`

**因此写迁移时优先只做加法**（加列、加表、加索引），避免在同一版本里删列或改类型。
真要删列，分两个版本做：先停用代码路径，下个版本再删。

如果没有用 git（纯上传代码部署），回滚只能手动：把上一版的代码重新上传，
然后 `./scripts/deploy.sh --no-pull`。

---

## 9. 监控

| 项 | 做法 |
|---|---|
| 存活与数据库 | 外部探针定时请求 `/api/health`，非 200 告警（Uptime Kuma 足够） |
| 磁盘 | 告警阈值 80%。附件与 Postgres WAL 是主要增长源 |
| 证书到期 | Caddy 自动续期；只需监控 HTTPS 是否可访问 |
| 慢查询 | 已配 `log_min_duration_statement=500`，`docker compose logs postgres` 里找 |
| 日志轮转 | 已在 `provision.sh` 里配好（单文件 20MB × 5），否则日志会无限增长 |
| 实时连接数 | `/api/health` 的 `realtime.connections`。**只增不减说明连接泄漏** |

---

## 10. 合规与内容治理

公开 UGC 社区这一节不是可选项：

| 事项 | 说明 |
|---|---|
| 用户协议 + 隐私政策 | 必须有两份独立页面，明确 UGC 责任划分与个人信息处理规则 |
| 举报通道 | 每个帖子需可举报。表已建好（`reports`），管理界面属 P2 |
| 处置留痕 | 所有管理动作写 `audit_logs`（已实现），受控动作词表见 `src/lib/audit.ts` |
| 内容审核 | 敏感词过滤属 P2。**上线前建议至少接入人工巡查 + 举报响应** |
| 数据安全 | 定期备份、最小权限（数据库不对公网开放）、`SESSION_SECRET` 不入库 |
| 未成年人保护 | 视内容定位，必要时增加年龄提示与内容分级 |

---

## 11. 排障速查

| 症状 | 排查方向 |
|---|---|
| 证书申请失败 | 域名备案状态；80 端口是否可达；DNS 是否已解析（`dig +short 你的域名`） |
| 消息延迟数十秒 | 中间层缓冲：确认 Caddyfile 的 `flush_interval -1`；若加了 CDN，**必须对该路径关闭缓冲** |
| 每隔几分钟断线重连 | 反代读超时：确认 `/api/events` 的 `read_timeout 0` |
| 建站后侧栏空白 | 数据库不可用，`listChannels` 已降级为空（设计如此）。查 `docker compose logs app` 里的 `[query]` 警告 |
| 发了消息自己看不到 | 看浏览器控制台是否有 401/403；403 通常是权限或禁言 |
| 登录后立刻又变成未登录 | 生产模式下 Cookie 带 `Secure`，若用 `http://` 访问浏览器不会保存。必须走 HTTPS |
| 大量 `too many clients` | 调小 `DATABASE_POOL_MAX`，或调大 Postgres `max_connections` |
| 构建时连库失败 | 不应发生：所有页面都是动态渲染。若出现，检查是否新页面加了 `revalidate` 且未做 `safeQuery` 包装 |
| `docker build` 被杀（exit 137） | 内存不足，见第 1 节「低内存机器构建」 |
| 磁盘满 | `docker system prune -a`；检查 `pgdata` 与附件卷；确认日志轮转已配置 |

---

## 12. 成本参考

| 项 | 月成本 |
|---|---|
| 大陆轻量服务器 2C4G（年付摊算） | ¥35~60 |
| 境外验证机（如 Hetzner CX22） | $5.60 ≈ ¥40 |
| 域名（.com 年付摊算） | ¥5~8 |
| 对象存储（R2 免费额度内） | ¥0 |
| 备份存储 | ¥0~5 |
| **合计** | **约 ¥40~70/月** |

备案本身不收费（部分云厂商的服务商代办会收取代办费，可自行在工信部系统提交）。
