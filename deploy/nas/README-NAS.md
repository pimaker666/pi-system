# pi-system 内网离线部署指南（绿联 DXP4800 Plus）

把 pi-system 从 Vercel + 云端 Supabase，整体迁到**绿联 NAS 内网、完全离线自建**：
NAS 上用 Docker 同时跑「自建 Supabase 全家桶」和「pi-system 应用」，数据全部留在公司，
断网也能用。内部同事连公司网络访问 `http://NAS内网IP:3000` 登录共用。

> 机型：绿联 DXP4800 Plus（Intel N100 / x86_64 / 16G 内存），性能充足。
> 本方案 Supabase 用官方 self-hosted 编排作底座，稳定可靠；我们只叠加应用、迁移脚本和密钥。

---

## 架构总览

```
          公司局域网
 ┌───────────────────────────────────────────┐
 │  绿联 NAS (静态IP 192.168.0.5)             │
 │                                             │
 │  Docker:                                    │
 │   ├─ Supabase 全家桶                        │
 │   │    db(Postgres) / auth / rest /         │
 │   │    storage / kong(:8000) / studio       │
 │   └─ pi-app (Next.js, :3000)  ── 连 ──▶ kong│
 │                                             │
 │  数据卷：Postgres 数据 + 存储文件（本地磁盘）│
 └───────────────────────────────────────────┘
        ▲                     ▲
   同事浏览器            管理员 Studio
 http://IP:3000       http://IP:8000
```

浏览器和应用都通过 `NAS_IP:8000`（Kong 网关）访问 Supabase，保证客户端上传/图片显示也走内网。

---

## 第 0 步：准备工作

1. **给 NAS 设内网固定 IP**（很重要，IP 变了要重配）。在绿联 UGOS「控制面板 → 网络」里设静态 IP，
   记为 `192.168.0.5`（按你实际网段改；下文所有 `192.168.0.5` 都要替换）。
2. **UGOS 开启 SSH**：控制面板 → 终端机/SSH，开启 SSH，记下 NAS 管理员账号密码。
3. **UGOS 安装 Docker**：应用中心安装「Docker」（UGOS 的容器管理）。本指南主要用 SSH 命令行操作，最稳。
4. 本机 SSH 登录 NAS：
   ```bash
   ssh 你的NAS账号@192.168.0.5
   # 切到有权限的目录，例如 /volume1/docker
   sudo -i        # 若需要 root
   mkdir -p /volume1/docker && cd /volume1/docker
   ```

---

## 第 1 步：拉取本项目代码到 NAS

把 pi-system 整个项目放到 NAS，例如 `/volume1/docker/pi-system`：

- 有 Git 就 `git clone`；没有就本机打包上传：
  ```bash
  # 本机
  cd /path/to/pi-system
  tar --exclude=node_modules --exclude=.next --exclude=.git -czf pi-system.tgz .
  scp pi-system.tgz 你的NAS账号@192.168.0.5:/volume1/docker/
  # NAS
  mkdir -p /volume1/docker/pi-system && tar -xzf /volume1/docker/pi-system.tgz -C /volume1/docker/pi-system
  ```

本仓库 `deploy/nas/` 下已备好：`supabase.env`、`docker-compose.app.yml`、`app.env`、
`apply-migrations.sh`、`copy-storage.mjs`（本文件）。

---

## 第 2 步：部署自建 Supabase（官方底座）

```bash
cd /volume1/docker
git clone --depth 1 https://github.com/supabase/supabase.git supabase-src
cp -r supabase-src/docker /volume1/docker/supabase
cd /volume1/docker/supabase
cp .env.example .env
```

用我们生成好的密钥覆盖官方 `.env`（把关键变量替换进去）。最省事的做法：直接把本仓库
`deploy/nas/supabase.env` 里的每一项，对应填进 `/volume1/docker/supabase/.env`
（变量名与官方一致）。**务必把 `192.168.0.5` 改成你的 NAS 实际 IP。**

> 内存优化（可选）：绿联 16G 足够跑全套，如想更省，可在 `docker-compose.yml` 里注释掉
> `analytics`、`vector`、`realtime`、`functions` 四个服务（本应用用不到），并删掉其它服务里
> 对它们的 `depends_on`。不确定就**保持默认全套**，最稳。

拉起 Supabase：

```bash
cd /volume1/docker/supabase
docker compose pull
docker compose up -d
docker compose ps          # 等所有服务 healthy（首次约 1-3 分钟）
```

验证网关：浏览器开 `http://192.168.0.5:8000`，用 `supabase` / `PgHD1681WrRBkw8u`（见 supabase.env）
登录 Studio，能进就说明 Supabase 起来了。

---

## 第 3 步：灌入数据库结构（11 个迁移脚本）

等 auth、storage 服务都 healthy 后（它们会在 db 里建好 auth/storage schema），执行：

```bash
cd /volume1/docker/supabase
cp /volume1/docker/pi-system/deploy/nas/apply-migrations.sh .
MIGRATIONS_DIR=/volume1/docker/pi-system/supabase/migrations \
  bash apply-migrations.sh
```

脚本会按 0001→0011 顺序执行，建好所有表、RLS、RPC、触发器，并自动创建三个存储桶。

---

## 第 4 步：迁移云端现有数据（可选，想保留历史 PI/客户就做）

如果不需要历史数据，可**跳过本步**，直接在系统里重新录入（最简单）。
若要保留云端已有的产品/客户/PI 和图片，按下面做。

### 4.1 迁移数据库数据（需要云端数据库密码）

在 Supabase 云端控制台 → Settings → Database 拿到**数据库密码**（Connection string 里的 password）。
**不需要在电脑上装任何 Postgres 工具**——NAS 上的 `db` 容器自带 `pg_dump` / `psql`，且 NAS 搭建时能上外网，
所以直接在 NAS 上、用容器里的工具从云端拉数据。

```bash
cd /volume1/docker/supabase
CLOUD="postgresql://postgres:<云端密码>@db.spirybjrvhgevreyanvf.supabase.co:5432/postgres"

# 只导「数据」（结构已由第 3 步迁移脚本在 NAS 建好）。
# 关键：--schema=public 只导业务表；auth 只导 users/identities（让老账号能登录）；
# 不要导 storage schema —— 存储元数据会在 4.2 上传文件时自动重建，导了反而冲突。
docker compose exec -T db pg_dump "$CLOUD" \
  --data-only --no-owner --no-privileges \
  --table='auth.users' --table='auth.identities' \
  > auth_data.sql

docker compose exec -T db pg_dump "$CLOUD" \
  --data-only --no-owner --no-privileges \
  --schema=public \
  > public_data.sql
```

导入 NAS 数据库。用 `session_replication_role = replica` 包裹，既解决外键先后顺序，
又能**关闭触发器**——否则导入 `auth.users` 时 `on_auth_user_created` 触发器会自动建一份 profile，
和随后导入的 `public.profiles` 冲突。

```bash
# 先导 auth 用户，再导业务数据；两次都在 replica 模式下执行
{ echo "SET session_replication_role = replica;"; cat auth_data.sql; } \
  | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres

{ echo "SET session_replication_role = replica;"; cat public_data.sql; } \
  | docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgres -d postgres
```

> 若云端 5432 直连不通（部分网络限制），把连接串换成 Supabase 的连接池地址
> （控制台 Connection string 里的 **Session pooler**，形如
> `postgresql://postgres.spirybjrvhgevreyanvf:<密码>@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`）。

### 4.2 复制存储文件（图片/PDF）

在有 node 和外网的机器上：

```bash
cd /volume1/docker/pi-system/deploy/nas   # 或任意目录，确保 copy-storage.mjs 在此
npm i @supabase/supabase-js
CLOUD_URL=https://spirybjrvhgevreyanvf.supabase.co \
CLOUD_SERVICE_KEY=<云端 service_role> \
NAS_URL=http://192.168.0.5:8000 \
NAS_SERVICE_KEY=<NAS 端 service_role，见 deploy/nas/supabase.env 的 SERVICE_ROLE_KEY> \
node copy-storage.mjs
```

### 4.3 改写数据库里的图片 URL（把云端地址换成 NAS 地址）

数据里存的是云端完整 URL，迁移后要批量替换成 NAS 地址：

```bash
docker compose exec -T db psql -U postgres -d postgres <<'SQL'
UPDATE public.products
   SET image_url = replace(image_url,
       'https://spirybjrvhgevreyanvf.supabase.co', 'http://192.168.0.5:8000')
 WHERE image_url LIKE 'https://spirybjrvhgevreyanvf.supabase.co%';

UPDATE public.pi_items
   SET image_url = replace(image_url,
       'https://spirybjrvhgevreyanvf.supabase.co', 'http://192.168.0.5:8000')
 WHERE image_url LIKE 'https://spirybjrvhgevreyanvf.supabase.co%';

-- 公司资料/快照里的 logo 等（按实际列名补充；company_snapshot 是 jsonb）
UPDATE public.company_profiles
   SET logo_url = replace(logo_url,
       'https://spirybjrvhgevreyanvf.supabase.co', 'http://192.168.0.5:8000')
 WHERE logo_url LIKE 'https://spirybjrvhgevreyanvf.supabase.co%';
SQL
```

> 提示：`pi_items` 若还存了 `remark_image_url`，一并替换。用 Studio 的 SQL 编辑器执行也行。

---

## 第 5 步：构建并启动 pi-system 应用

把本仓库 `deploy/nas/docker-compose.app.yml` 和 `app.env` 放到 `supabase/docker` 目录旁，
并**确认 `app.env` 里的 IP 和两个密钥已改对**（IP 换成 NAS 实际 IP；ANON/SERVICE 与 supabase.env 一致）。

```bash
cd /volume1/docker/supabase   # 与 supabase 网络同目录，便于复用其 network
cp /volume1/docker/pi-system/deploy/nas/docker-compose.app.yml .
cp /volume1/docker/pi-system/deploy/nas/app.env .

# 确认 supabase 网络名（默认 supabase_default）
docker network ls | grep supabase

docker compose -f docker-compose.app.yml --env-file app.env up -d --build
docker compose -f docker-compose.app.yml logs -f pi-app   # 看到 ✓ Ready 即成功
```

> `docker-compose.app.yml` 里 build context 是 `../..`，对应 `/volume1/docker/pi-system`。
> 若你的项目放在别处，改 context 路径即可。

---

## 第 6 步：创建管理员并验证

1. 若没迁云端用户：在 Studio（`http://192.168.0.5:8000`）→ Authentication → Users → Add user，
   建一个管理员邮箱+密码（因为开了 auto-confirm，建完即可登录）。
   再到 Table editor 的 `public.profiles` 把该用户的 `role` 改成 `admin`。
2. 浏览器访问 **`http://192.168.0.5:3000`**，用刚建的账号登录。
3. 依次验证：进 PI 详情页 → PDF 预览渲染中文/版式 → 下载 PDF → 产品图片正常显示 → 新建 PI。

内部同事在公司网络内，直接访问 `http://192.168.0.5:3000` 即可共用登录。

---

## 第 7 步：数据备份（重要，数据都在本地了）

定期备份两样东西：Postgres 数据 + 存储文件。

```bash
# 数据库全量备份
cd /volume1/docker/supabase
docker compose exec -T db pg_dump -U postgres -d postgres > /volume1/backup/pi-db-$(date +%F).sql

# 存储文件（官方 compose 的 storage 卷，通常在 ./volumes/storage）
tar -czf /volume1/backup/pi-storage-$(date +%F).tgz -C /volume1/docker/supabase/volumes storage
```

可在绿联「任务计划」里设每日定时执行。也建议开启 NAS 的 RAID/快照。

---

## 常见问题

- **同事打不开 3000**：确认 NAS 防火墙放行 3000/8000；确认在同一局域网；IP 没变。
- **登录后跳回登录页**：多半是 `app.env` 的 `NEXT_PUBLIC_SUPABASE_URL` 或密钥与 supabase.env 不一致，
  或 IP 填错。改对后 `up -d --build` 重建。
- **图片不显示**：检查第 4.3 步 URL 是否已改写成 NAS 地址；`product-images`/`company-assets` 桶是否 public。
- **改了 NAS IP**：`supabase.env`、`app.env` 里所有 IP 都要改，并重建应用镜像（NEXT_PUBLIC_* 是构建期内联的）。
  建议一开始就把 NAS IP 固定死，避免返工。
- **内存/CPU 吃紧**：按第 2 步注释掉 analytics/vector/realtime/functions；16G 一般无需。
- **想用域名而非 IP**：内网可在路由器/内网 DNS 里把 `pi.公司.local` 解析到 NAS IP，
  再把两个 env 的 IP 换成该域名并重建。
