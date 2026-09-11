# 协作约定

任何入口（人或 AI 助手）改动本项目前先读这份文件。发布与数据库迁移的完整步骤见
[docs/RELEASE-RUNBOOK.md](docs/RELEASE-RUNBOOK.md)。

## 硬性红线

- **不读取、不输出任何密钥**（`app.env`、`.env.production`、`docker inspect` 的
  `Config.Env`）。本地 `next build` 用一次性占位环境变量。
- **动生产数据库前先 pg_dump 备份**，并在以 `supabase_admin` 恢复的隔离库里演练迁移；
  恢复时不要加 `--no-owner` / `--no-acl`。
- **迁移用 `psql -U supabase_admin`**，`postgres` 会因 owner 不符而失败。
- **迁移文件必须可重复执行**：生产库没有应用级 `supabase_migrations` 表。
- **前端改动必须重建镜像**才会生效；改 NAS 上的部署目录本身没有作用。
- 生产与 NAS 上的每一步都要先取得使用者的明确确认；一次授权只对当次有效。

## 提交前必过

```bash
node_modules/.bin/tsc --noEmit
node_modules/.bin/next lint
```

改了 `supabase/migrations/` 时追加：

```bash
cd tools/pglite-verify && npm install
node replay-migrations.mjs      # 全量重放
node verify-00XX.mjs            # 针对本次迁移的功能演练，以 verify-0040.mjs 为模板
```

`tsc` 抓不到的坑：把字段类型放宽成 `| null` 后，`Number(null)` 会静默变成 0。放宽可空性
时要手工 grep 所有展示与汇总处，显式区分「0」和「—」。

## 代码约定

- 校验规则写在 `src/schemas/`（Zod `.strict()` + `.superRefine()` 做跨字段校验），
  服务端动作在 `src/lib/actions/`，两侧的门禁必须与数据库 RPC 里的判断一致。
- 金额与发货的真正保护在数据库触发器和 `security definer` RPC 里；前端的禁用态只是
  提示，不要把它当作权限。
- RPC 走版本化包装（`create_business_order` → v2 → v3 → v4），旧签名保留原语义，
  不要给旧签名加默认值，否则会产生重载歧义。
- 每个 RPC 建完都要 `revoke all ... from public, anon, authenticated, service_role`
  再 `grant execute ... to authenticated`。
