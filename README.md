# 网页版产品库 & PI（形式发票）自动生成系统

面向 B2B / 外贸业务的轻量业务系统：业务员从**共享产品库**选品、填写客户信息，系统按公司抬头**自动生成标准形式发票（Proforma Invoice）PDF**，并支持历史记录与检索。

- **业务员数据隔离**：每个业务员只能看自己创建的客户与 PI；管理员（admin）可见全部；产品库全员共享。
- **简单金额模式**：单张 PI 统一税率 + 运费 + 折扣，单一币种。金额一律**服务端重算**，不信任前端提交值。

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 15（App Router，Server Actions） + React 19 |
| UI | Tailwind CSS + Shadcn/UI + lucide-react + sonner |
| 后端/数据库 | Supabase（PostgreSQL + Auth + Storage + Row Level Security） |
| 表单校验 | React Hook Form + Zod |
| 状态 | Zustand（选品购物车，`persist`） |
| PDF | @react-pdf/renderer（服务端 `renderToBuffer` 按需生成） |

## 目录结构

```
pi-system/
├─ src/
│  ├─ app/
│  │  ├─ (auth)/login/            登录 / 注册
│  │  ├─ (dashboard)/
│  │  │  ├─ dashboard/            概览统计
│  │  │  ├─ products/             产品库（列表 / 新建 / 编辑）
│  │  │  ├─ customers/            客户（列表 + 分组管理）
│  │  │  ├─ pi/                   PI 创建 / 历史 / 详情
│  │  │  └─ settings/             公司抬头设置（admin）
│  │  ├─ api/pi/[id]/pdf/         按需生成 PI 的 PDF 流
│  │  └─ auth/callback/           Supabase 邮箱确认回调
│  ├─ components/                 UI 组件 + 业务组件
│  ├─ lib/
│  │  ├─ supabase/{client,server,admin}.ts   三种客户端
│  │  ├─ actions/                 Server Actions（auth/products/customers/groups/pi/company）
│  │  ├─ auth.ts                  会话/角色守卫
│  │  ├─ calc.ts                  金额计算纯函数
│  │  └─ pdf-fonts.ts             中文字体注册
│  ├─ schemas/                    Zod 校验
│  ├─ stores/                     Zustand 购物车
│  └─ types/                      TypeScript 类型
├─ supabase/migrations/0001_init.sql   数据库初始化（表/枚举/RLS/RPC/Storage）
├─ public/fonts/                  Noto Sans SC .ttf（见该目录 README）
└─ .env.example
```

## 快速开始

### 1. 安装依赖

```bash
cd pi-system
npm install
```

### 2. 准备中文字体

按 `public/fonts/README.md` 放入 `NotoSansSC-Regular.ttf` 与 `NotoSansSC-Bold.ttf`（建议子集化到 1–2MB）。**缺失会导致 PDF 中文乱码或构建报错。**

### 3. 创建 Supabase 项目并初始化数据库

在 [supabase.com](https://supabase.com) 新建项目，然后在 **SQL Editor** 里整段执行：

```
supabase/migrations/0001_init.sql
```

或使用 Supabase CLI：

```bash
supabase link --project-ref <your-ref>
supabase db push
```

该脚本会创建：枚举、`profiles / company_settings / products / customer_groups / customers / proforma_invoices / pi_items / pi_sequences` 表、新用户自动建档触发器、PI 编号生成器、`create_pi_with_items` 原子 RPC、全部 RLS 策略、三个 Storage 桶（`product-images` 公开 / `pi-pdfs` 私有 / `company-assets` 公开），并写入 `company_settings` 单行占位数据。

### 4. 配置环境变量

复制 `.env.example` 为 `.env.local` 并填写（从 Supabase 控制台 Project Settings → API 获取）：

```bash
cp .env.example .env.local
```

```
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...          # 仅服务端，切勿加 NEXT_PUBLIC_ 前缀
NEXT_PUBLIC_SITE_URL=http://localhost:3000
```

### 5. 启动

```bash
npm run dev
```

访问 http://localhost:3000 ，先注册一个账号（默认角色 `sales`）。

### 6. 设置第一个管理员

新注册用户默认是业务员。要开通管理员（可管理产品库、公司抬头、查看全部数据），在 Supabase SQL Editor 执行：

```sql
update public.profiles set role = 'admin'
where email = '你的登录邮箱';
```

重新登录即可看到「产品管理」「公司设置」等管理员菜单。

## 核心设计说明

**数据快照保证历史不可变**：生成 PI 时，客户信息以 `customer_snapshot`（JSONB）写入 PI 主表，产品价格/名称写入 `pi_items`。之后即使产品改价或客户删除，历史 PI 内容保持不变。删除客户/分组用 `on delete set null`，不破坏历史 PI。

**PI 编号并发安全**：`pi_sequences` 按年份维护递增序列，`create_pi_with_items` 通过触发器 `set_pi_number` 生成形如 `PI-2026-001` 的编号，`upsert ... on conflict` 保证并发下不重号。

**金额服务端重算**：Server Action 收到明细后用 `lib/calc.ts` 重新计算 `subtotal / tax / shipping / discount / total`，忽略前端传来的合计，防篡改。

**PDF 按需生成**：`/api/pi/[id]/pdf` 用 `renderToBuffer` 实时渲染，`dynamic = 'force-dynamic'` + `no-store`，因此作废（VOID）状态会即时反映水印，无需预生成文件。

**权限三层防护**：Sidebar 按角色隐藏菜单（UI 层）→ 页面服务端 `requireAdmin()` 重定向（路由层）→ RLS 策略兜底（数据库层）。

## 可用脚本

```bash
npm run dev         # 开发
npm run build       # 生产构建
npm run start       # 生产启动
npm run lint        # ESLint
npm run typecheck   # 类型检查
```

## 部署

推荐 Vercel。在项目环境变量中配置上述四个变量；确保 `public/fonts/*.ttf` 已随仓库或构建产物一起部署（`next.config.js` 已通过 `outputFileTracingIncludes` 打包字体）。`next.config.js` 的 `images.remotePatterns` 需把 hostname 改成你的 Supabase 项目域名。
