/** @type {import('next').NextConfig} */
const nextConfig = {
  // 产出自包含的 .next/standalone 目录，便于做精简 Docker 镜像（香港服务器自托管）。
  output: 'standalone',
  // 同源反代：浏览器端对 Supabase 的调用（auth / rest / storage 及图片）统一走
  // 同源 /supabase/*，由 Next 服务端在 NAS 内网反代到真正的 Supabase，避免外网
  // 浏览器直连内网 IP。rewrites 在请求时于 Node 服务端执行，读运行时环境变量即可。
  async rewrites() {
    const target =
      process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
    return [
      {
        source: '/supabase/:path*',
        destination: `${target}/:path*`,
      },
    ]
  },
  // 确保 Server Action / Route 打包时带上字体文件（PDF 渲染需要）
  outputFileTracingIncludes: {
    '/api/pi/**': ['./public/fonts/**'],
    '/pi/**': ['./public/fonts/**'],
    '/api/finance/daily-orders/export/pdf': ['./public/fonts/**'],
  },
  // @react-pdf/renderer 是纯 ESM 且体积大，让 webpack 打包+压缩会在 Vercel
  // serverless 崩（reading 'S' at appendChild）。用 Next 官方 serverExternalPackages
  // 把它排除出服务端打包，配合路由里的动态 import() 由 Node 以 ESM 方式加载。
  // 注意：serverExternalPackages 与 transpilePackages 全局互斥，故此处不再列
  // transpilePackages；客户端预览改为动态 import 整个 react-pdf，无需转译。
  serverExternalPackages: ['@react-pdf/renderer'],
  experimental: {
    // Allow the client bundle to interop with the ESM-only @react-pdf/renderer
    // via dynamic import without tripping the strict esm-externals check.
    esmExternals: 'loose',
  },
  images: {
    // 内网自托管（NAS）：图片走 http://<NAS_IP>:8000，非 https 且主机为内网 IP，
    // 又跑在精简 standalone 镜像里（无 sharp）。关掉 Next 图片优化，让 next/image
    // 退化为普通 <img> 直接透传 URL —— 既绕过 remotePatterns 的协议/主机白名单，
    // 也不需要 sharp。缩略图仅 40/48px，优化无收益。
    unoptimized: true,
    // remotePatterns 仅在启用优化时生效，这里作为将来切回云端/域名的备用配置保留。
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.supabase.co',
        pathname: '/storage/v1/object/public/**',
      },
    ],
  },
}

module.exports = nextConfig
