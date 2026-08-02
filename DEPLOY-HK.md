# pi-system 香港轻量服务器部署指南

本指南把 pi-system（Next.js 15 + Supabase）从 Vercel 迁到**香港轻量应用服务器**，用 Docker 运行，
先以 `IP` 访问（免域名、免备案）。Supabase 保持不动（新加坡），香港服务器到新加坡延迟低，
登录/数据/PDF 全部在服务端完成，国内用户无需 VPN 即可访问。

---

## 一、买香港轻量服务器

阿里云或腾讯云均可，选**香港**地域的「轻量应用服务器」：

- 配置：2 核 2G 起步（4G 更稳，PDF 渲染吃内存）；系统盘 40G+。
- 镜像：选 **Ubuntu 22.04 / 24.04**（下面命令以 Ubuntu 为准）。
- 记下：公网 IP、root 密码（或设置 SSH 密钥）。
- 防火墙/安全组：放行入站 **22（SSH）** 和 **80（HTTP）**。
  阿里云在「轻量服务器控制台 → 防火墙」加规则；腾讯云在「防火墙」加规则。

---

## 二、连上服务器并装 Docker

本机终端 SSH 登录（把 `IP` 换成你的公网 IP）：

```bash
ssh root@IP
```

一键装 Docker（Ubuntu）：

```bash
curl -fsSL https://get.docker.com | sh
# 验证
docker --version
docker compose version
```

> 若 `get.docker.com` 慢，可用阿里云镜像源脚本：
> `curl -fsSL https://get.docker.com | sh -s -- --mirror Aliyun`

---

## 三、把代码传上去

**方式 A：用 Git（推荐，后续更新方便）**
如果代码已在 Git 仓库：

```bash
cd /opt
git clone <你的仓库地址> pi-system
cd pi-system
```

**方式 B：从本机直接打包上传（无 Git 时）**
在本机项目目录执行（会自动排除 node_modules/.next）：

```bash
# 本机
cd /path/to/pi-system
tar --exclude=node_modules --exclude=.next --exclude=.git -czf pi-system.tgz .
scp pi-system.tgz root@IP:/opt/
# 服务器
ssh root@IP
mkdir -p /opt/pi-system && tar -xzf /opt/pi-system.tgz -C /opt/pi-system
cd /opt/pi-system
```

---

## 四、填写生产环境变量

在服务器项目目录：

```bash
cp .env.production.example .env.production
vi .env.production   # 或 nano .env.production
```

填入四个值（从 Supabase 控制台 → Settings → API 拿）：

```
NEXT_PUBLIC_SUPABASE_URL=https://spirybjrvhgevreyanvf.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
SUPABASE_SERVICE_ROLE_KEY=<service_role key>
NEXT_PUBLIC_SITE_URL=http://你的公网IP
```

> anon / service_role 在 Supabase「API Keys」页的 **Legacy anon, service_role** 标签下。
> `NEXT_PUBLIC_SITE_URL` 先填 `http://公网IP`（映射到 80 端口时不带端口号）。

---

## 五、构建并启动容器

`docker-compose.yml` 已配好，会把宿主机 **80** 端口映射到容器 **3000**：

```bash
cd /opt/pi-system
# 构建期需要 NEXT_PUBLIC_*，compose 已从 .env.production 读取并作为 build args 注入
docker compose --env-file .env.production up -d --build
```

首次构建约 3–8 分钟。完成后查看状态与日志：

```bash
docker compose ps
docker compose logs -f web    # Ctrl+C 退出日志
```

看到 `✓ Ready` 即启动成功。

---

## 六、访问验证

浏览器打开：**http://你的公网IP**

依次确认：能打开登录页并登录 → 进 PI 详情页 → PDF 预览（iframe）渲染出中文和版式 → 点下载能拿到 PDF。

> PDF 由服务端生成、字体已打进镜像（`public/fonts/*.ttf`），中文不会乱码。

---

## 七、更新版本（以后改了代码）

```bash
cd /opt/pi-system
git pull                              # 方式 A
# 或重新 scp 覆盖代码（方式 B）
docker compose --env-file .env.production up -d --build
docker image prune -f                 # 清理旧镜像
```

---

## 八、后续可选优化

1. **加域名 + HTTPS**：注册域名后，把 A 记录解析到公网 IP。香港服务器**免 ICP 备案**即可用域名。
   再加一层 Nginx/Caddy 做反向代理 + Let's Encrypt 自动 HTTPS（Caddy 最省事，一行配置自动签证书）。
   届时把 `NEXT_PUBLIC_SITE_URL` 改成 `https://你的域名` 并重新构建。

2. **图片加速（若国内加载 Supabase 图片偏慢）**：产品/PI 图片目前直接从 `supabase.co` 加载。
   若实测慢，可在香港服务器加一个图片代理路由（浏览器 → 香港服务器 → supabase.co），
   或把图片改存到国内对象存储 + CDN。**先上线看真实速度，慢再做。**

3. **进程守护**：`restart: unless-stopped` 已配置，服务器重启后容器会自动拉起。

---

## 常见问题

- **80 端口被占 / 想先测试**：把 `docker-compose.yml` 里的 `"80:3000"` 改成 `"3000:3000"`，
  然后访问 `http://IP:3000`（记得安全组也放行 3000）。
- **构建 OOM（内存不足被 kill）**：2G 内存机型可加 swap：
  ```bash
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  ```
- **登录后一直跳回登录页**：多半是 `NEXT_PUBLIC_SITE_URL` 或 Supabase 密钥填错，
  用 `docker compose logs web` 看报错。
