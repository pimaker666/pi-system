# PI System 维护手册（MAINTENANCE）

> 面向后续任何智能体 / 维护者。读这份文档即可接手日常运维与改代码部署。
> 更详细的初次部署说明见 `deploy/nas/README-NAS.md`。

## 1. 系统概览

- 应用：Next.js 15（App Router）+ Supabase（自托管）+ Shadcn/UI + Zustand + @react-pdf/renderer
- 用途：外贸 PI（形式发票）系统 —— 产品库、开 PI、导出 PDF/Excel、计算重量
- 运行环境：绿联 UGREEN DXP4800 Plus NAS，UGOS Pro / Debian 12 Bookworm，内核 6.1.x，amd64
- 外网访问：`https://pi.gainwinskincare.com`（Cloudflare Tunnel）
- 内网：NAS = `192.168.0.5`

## 2. 两个终端别搞混（重要）

维护时经常同时开两个终端，命令跑错地方是最常见的坑：

- 提示符 `yangxiaoling@…MacBook-Air` → **Mac 本机**（跑 scp、gh、git、本地构建）
- 提示符 `Jessie@DXP4800PLUS-120A` → **NAS**（跑 docker、sudo、看日志）
- 进 NAS：`ssh Jessie@192.168.0.5`
- scp 传文件必须在 **Mac** 终端跑，不能在已 ssh 进 NAS 后跑。

## 3. NAS 上的关键路径（全部在 `/volume2/docker`，root-only，需 sudo）

| 用途 | 路径 |
|---|---|
| 源码 + Dockerfile（构建上下文） | `/volume2/docker/pi-system` |
| app compose | `/volume2/docker/supabase/docker-compose.app.yml` |
| app 环境变量 | `/volume2/docker/supabase/app.env` |
| Supabase 目录（DB/storage 卷） | `/volume2/docker/supabase/volumes` |
| 上传图片实际存储 | `/volume2/docker/supabase/volumes/storage`（容器内 `/var/lib/storage`） |
| 备份输出 | `/volume2/docker/backups/pi/` |
| 备份脚本 | `/volume2/docker/backups/pi-backup.sh` |
| Docker 清理脚本 | `/volume2/docker/backups/pi-docker-cleanup.sh` |

- 镜像：`pi-system:latest`，容器：`pi-app`，端口 3000
- Supabase 容器：`supabase-db / -storage / -kong / -auth / -rest / -meta / -studio / -edge-functions / -pooler / -imgproxy` + `realtime-dev.supabase-realtime`
- `docker inspect/logs` 对 Jessie 免 sudo；读写 `/volume2/docker` 下文件需 sudo。

## 4. 改代码 → 部署流程

源码同时存在两处：本仓库（Mac `~/pi-system` / GitHub）和 NAS `/volume2/docker/pi-system`。改完代码后：

1. **Mac** 打包改动文件（保持目录结构），例如单文件：
   ```bash
   cd ~/pi-system
   tar czf ~/patch.tgz src/app/.../xxx.tsx
   ```
2. **Mac** 传到 NAS（macOS scp 默认 SFTP，UGOS sshd 没开 sftp，必须加 `-O` 走旧协议）：
   ```bash
   scp -O ~/patch.tgz Jessie@192.168.0.5:~/
   ```
3. **NAS** 解包覆盖源码（需 sudo，因 `/volume2/docker` root-only）：
   ```bash
   ssh Jessie@192.168.0.5
   sudo tar xzf ~/patch.tgz -C /volume2/docker/pi-system
   ```
4. **NAS** 重建并起容器（**禁止**加 `--remove-orphans`，会停掉整套 Supabase；orphans 警告忽略即可）：
   ```bash
   sudo docker compose -f /volume2/docker/supabase/docker-compose.app.yml \
     --env-file /volume2/docker/supabase/app.env up -d --build
   ```
5. 验证：`docker logs -f pi-app`，浏览器访问 `https://pi.gainwinskincare.com`。

> 构建日志全是 `CACHED` = 源码没覆盖成功（补丁没传上去或路径错）。改动生效时对应层会重新构建。

### 数据库迁移
新增迁移放 `supabase/migrations/00NN_xxx.sql`，部署后按序执行（见 `deploy/nas/apply-migrations.sh`）。当前已到 `0015_postal_codes.sql`。

## 5. 自动化任务（NAS root crontab）

```
30 2 * * *   /volume2/docker/backups/pi-backup.sh          # 每天 02:30 备份 DB + 图片，保留 14 天
0  3 1 * *   /volume2/docker/backups/pi-docker-cleanup.sh  # 每月 1 号 03:00 清 Docker 构建缓存
```

- 备份内容：`db.sql.gz`（pg_dump postgres）+ `storage.tgz`（上传图片），输出到 `/volume2/docker/backups/pi/<日期>/`。
- 清理脚本只做安全操作：`docker builder prune -af` + `docker image prune -f`。**绝不**用 `docker system prune` / `volume prune` / `image prune -a`（会删数据或在用镜像）。
- 查 cron：`sudo crontab -l`；查服务：`systemctl is-active cron`。
- 查备份产物（注意 glob 要在 sudo 内展开）：`sudo sh -c 'ls -lh /volume2/docker/backups/pi/*/'`

## 6. 数据恢复（灾难时）

- DB：`postgres` 库 / `postgres` 用户，密码 = 容器 `supabase-db` 环境变量 `POSTGRES_PASSWORD`。
  ```bash
  gunzip -c db.sql.gz | docker exec -i supabase-db sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -U postgres -h 127.0.0.1 -d postgres'
  ```
- 图片：把 `storage.tgz` 解到 `/volume2/docker/supabase/volumes/storage`。

## 7. 已知坑 / 经验（省时间）

- **scp 报 `Connection closed`** → 加 `-O` 走 legacy 协议；或用 `cat file | ssh host 'cat > ~/file'`。
- **`app.env` 里 `NEXT_PUBLIC_SUPABASE_URL` 必须是内网 `http://192.168.0.5:8000`（=Kong）**，不能改成公网域名，否则服务端 hairpin 请求失败。
- **计算重量页克重/数量输入框显示空白但总重量有值** = shadcn Table auto 布局把数值列挤到 ~45px 裁切了，不是数据问题。修法：`<Table className="table-fixed">` + 产品列加 `min-w`。
- **开 PI 报 FK `pi_items_product_id_fkey`** = zustand persist 存在 localStorage（key `pi-cart`）里的旧/已删 product_id。服务端已在 `createProformaInvoice` 校验产品存在、缺失置 null；用户侧临时解：清空购物车重新加。
- **文件保护**：改 NAS 源码前，因为不在 git 里，先 `sudo cp` 备份原文件；删文件用 trash 不用 `rm`。本仓库里的改动走 git，可随时回滚。
- `sudo du path/*` 在 root-only 父目录 glob 不展开 → 用 `sudo du -h -d 1` 或 `sudo sh -c '...'`。

## 8. 本地开发

```bash
cd ~/pi-system
cp .env.example .env.local   # 填本地 Supabase 连接
npm install
npm run dev        # 本地起 http://localhost:3000
npm run typecheck  # 提交前类型检查
npm run lint
```
