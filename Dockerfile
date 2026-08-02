# syntax=docker/dockerfile:1

##########  1) 依赖层：只装依赖，利用缓存  ##########
FROM node:22-slim AS deps
WORKDIR /app
# 只复制 lock 文件，命中缓存
COPY package.json package-lock.json* ./
RUN npm ci

##########  2) 构建层：编译 Next（standalone 产物）  ##########
FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期需要 NEXT_PUBLIC_* 才能内联到客户端 bundle。
# 通过 --build-arg 传入（见 docker-compose / 构建命令）。
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build

##########  3) 运行层：极简镜像，只带 standalone 产物  ##########
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# 非 root 用户运行
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# standalone 自带精简的 node_modules + server.js
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# standalone 不会自动带 static 资源和 public，需手动拷贝
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# standalone 的入口是 server.js
CMD ["node", "server.js"]
