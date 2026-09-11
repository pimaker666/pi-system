# 发布运行手册（NAS 生产环境）

生产环境是群晖 NAS（`Jessie@192.168.0.5`）上的一组 Docker 容器：`pi-app`（Next.js
standalone）、`pi-cron`（备份与巡检）、以及自托管 Supabase（`supabase-db` 等）。
本手册是唯一的发布口径，任何入口（人或 AI 助手）改动生产都按这里执行。

## 红线

1. **不读取、不输出任何密钥。** `app.env`、`.env.production`、`docker inspect` 的
   `Config.Env` 都含 Supabase 密钥，禁止 `cat`/`grep`/打印。本地 `next build` 需要
   `NEXT_PUBLIC_SUPABASE_URL` 等变量时用一次性占位值，不要去读真实配置。
2. **迁移用 `psql -U supabase_admin`。** 库内多数对象 owner 是 `supabase_admin`，
   用 `postgres` 会报 `must be owner of table`。
3. **隔离库演练不加 `--no-owner` / `--no-acl`。** 这两个开关会掩盖 owner 与授权问题，
   而本项目的 RPC 全靠 `revoke all` + `grant execute to authenticated` 控权。
4. **改库前必须先 pg_dump 备份**，并核对容器内外 md5 一致后才动生产。
5. **前端改动必须重建镜像。** 直接改 NAS 上的部署目录不会影响运行中的容器。
6. **单一发布方。** 同时有多个入口能发布时，先约定谁负责本次发布，另一方只做只读诊断，
   否则容易出现「一方改了库、另一方用旧镜像重建容器」。

## 一、本地校验（改动进生产前全部要过）

Node 22。仓库根目录：

```bash
npm ci
node_modules/.bin/tsc --noEmit
node_modules/.bin/next lint
NEXT_PUBLIC_SUPABASE_URL=https://placeholder.invalid \
NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder \
SUPABASE_SERVICE_ROLE_KEY=placeholder \
NEXT_PUBLIC_SITE_URL=https://placeholder.invalid \
node_modules/.bin/next build
```

有迁移改动时，额外在内存库里重放并做功能演练：

```bash
cd tools/pglite-verify
npm install
node replay-migrations.mjs   # 空库按序重放全部 supabase/migrations，单事务后回滚
node verify-0040.mjs         # 最近一次功能演练；新迁移请照此新建 verify-00XX.mjs
```

`replay-migrations.mjs` 只保证 SQL 能全量重放；**RPC 行为、RLS 与权限要靠
`verify-00XX.mjs` 那种功能演练**。写新演练时以 `verify-0040.mjs` 为模板，注意：

- `auth`、`storage`、`extensions` 三个 schema 及 `auth.uid()`、`storage.foldername()`
  都是脚本自己搭的桩，PGlite 里没有。
- 用 `set_config('request.jwt.claim.sub', ...)` 切换调用者身份来验 RLS。
- 店铺的业务员名单只接受 `sales` / `supervisor` / `admin`，`finance` 会被拒。
- 收款流水要求 `business-payment-proofs` 桶里先存在对应的 `storage.objects` 行。

## 二、数据库迁移上生产

```bash
# 1) 备份（容器内 dump 后流出到 NAS，核对 md5）
ssh Jessie@192.168.0.5 'docker exec supabase-db pg_dump -U supabase_admin -d postgres \
  -Fc -f /tmp/before-00XX.dump'
ssh Jessie@192.168.0.5 'docker exec supabase-db sh -c "cat /tmp/before-00XX.dump"' \
  > /dev/null  # 实际写入 /home/Jessie/backups/pi-system-db-before-00XX-<UTC时间戳>.dump
# 两侧 md5sum 必须一致

# 2) 上传迁移文件（scp 到 NAS 会落在 /home/Jessie/Jessie/，所以用流式写入）
ssh Jessie@192.168.0.5 'docker exec -i supabase-db sh -c "cat > /tmp/00XX.sql"' \
  < supabase/migrations/00XX_xxx.sql
# 核对 md5 与本地一致

# 3) 隔离库演练：以 supabase_admin 恢复备份后应用迁移
ssh Jessie@192.168.0.5 'docker exec supabase-db psql -U supabase_admin -d postgres \
  -c "create database rehearsal_00XX owner supabase_admin;"'
ssh Jessie@192.168.0.5 'docker exec supabase-db pg_restore -U supabase_admin \
  -d rehearsal_00XX /tmp/before-00XX.dump'
ssh Jessie@192.168.0.5 'docker exec supabase-db psql -U supabase_admin -d rehearsal_00XX \
  -v ON_ERROR_STOP=1 -f /tmp/00XX.sql'
# 跑一遍结构与数据一致性检查（例：tools/pglite-verify/check-0040.sql），
# 再重复执行一次迁移确认可重跑，然后 drop database rehearsal_00XX

# 4) 生产应用 + 同一套检查
ssh Jessie@192.168.0.5 'docker exec supabase-db psql -U supabase_admin -d postgres \
  -v ON_ERROR_STOP=1 -f /tmp/00XX.sql'
```

注意：**生产库没有应用级 `supabase_migrations` 表**，版本只能靠源码与库内对象反推。
所以迁移文件必须自身幂等（`create or replace`、`if not exists`、按 catalog 匹配再
drop 约束），并且每次发布都要在演练库里重跑一遍验证可重复执行。

嵌套引号在 `psql -Atc` 里很容易出错（不要写 `\x27`），复杂查询一律写进 `.sql` 文件后
用 `psql -f` 执行。

## 三、前端发布

```bash
# 1) 打包目标提交的源码（只含已提交内容）
git archive --format=tar HEAD -o /tmp/pi-<sha>.tar
ssh Jessie@192.168.0.5 'mkdir -p /home/Jessie/deploy-<sha> && cat > /home/Jessie/pi-<sha>.tar' \
  < /tmp/pi-<sha>.tar
ssh Jessie@192.168.0.5 'md5sum /home/Jessie/pi-<sha>.tar; \
  tar -xf /home/Jessie/pi-<sha>.tar -C /home/Jessie/deploy-<sha>'

# 2) 沿用上一版的 app.env 与 runtime compose，并把绝对 build.context 改成新目录
ssh Jessie@192.168.0.5 'cp /home/Jessie/deploy-<old>/app.env /home/Jessie/deploy-<sha>/app.env; \
  chmod 600 /home/Jessie/deploy-<sha>/app.env; \
  sed "s#/home/Jessie/deploy-<old>#/home/Jessie/deploy-<sha>#g" \
    /home/Jessie/deploy-<old>/docker-compose.runtime.yml \
    > /home/Jessie/deploy-<sha>/docker-compose.runtime.yml'
# 必须 grep 一遍 context 行确认已改，否则会构建出旧源码

# 3) 留回滚镜像后构建、替换容器（新目录 = 新 compose 项目名，先删旧容器）
ssh Jessie@192.168.0.5 'docker tag pi-system:latest pi-system:rollback-<old>'
ssh Jessie@192.168.0.5 'cd /home/Jessie/deploy-<sha> && \
  docker compose --env-file app.env -f docker-compose.runtime.yml build pi-app'
ssh Jessie@192.168.0.5 'docker tag pi-system:latest pi-system:release-<sha>-<时间戳>; \
  docker rm -f pi-app; cd /home/Jessie/deploy-<sha> && \
  docker compose --env-file app.env -f docker-compose.runtime.yml up -d pi-app'
```

服务名是 `pi-app`（不是 `web`，`docker-compose.yml` 里那个 `web` 服务是旧模板）。

## 四、验收

- **镜像真的换了**：`docker images` 里 `pi-system:latest` 的 ID 与发布前不同。
- **容器指向新目录**：`docker inspect pi-app --format '{{.Config.WorkingDir}}'` 为 `/app`，
  compose 标签 `project.working_dir` 指向新的 `deploy-<sha>`。
- **网络**：`pi-app` 必须在 `supabase_default` 网络上。
- **文案对账**：挑只在本次提交出现、上一个提交 grep 为 0 的中文文案，在容器内
  `grep -rl "<文案>" /app/.next` 命中，说明跑的确实是新代码。
- **HTTP**：`/login` 返回 200；受保护路由（如 `/finance/daily-orders`）未登录返回 **307
  是登录守卫的正常行为，不是故障**。
- **日志**：`docker logs --since 5m pi-app` 无 error。
- 容器、HTTP、RPC 正常**不等于**业务验收，多角色（admin / sales / supervisor / finance）
  的页面与流程仍需登录浏览器实测。

## 五、回滚

```bash
# 前端
ssh Jessie@192.168.0.5 'docker tag pi-system:rollback-<old> pi-system:latest; \
  docker rm -f pi-app; cd /home/Jessie/deploy-<old> && \
  docker compose --env-file app.env -f docker-compose.runtime.yml up -d pi-app'
# 数据库：用本次发布前那份 /home/Jessie/backups/pi-system-db-before-00XX-*.dump 恢复
```

## 六、其它环境事实

- `scp` 到 NAS 默认落在 `/home/Jessie/Jessie/` 而不是 `$HOME`，所以文件一律用
  `ssh ... 'cat > /path'` 流式写入并核对 md5。
- PG 17 的 `pg_dump` 不接受 `-f -` 和 `-i`，会得到 0 字节产物；先 dump 到容器内
  `/tmp` 再 `cat` 出来。
- `pi-cron` 的 crond 必须以 `hostuser` 身份运行，否则 bind-mount 出来的备份产物会变成
  `root:root`。
