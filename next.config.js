/** @type {import('next').NextConfig} */
const nextConfig = {
  // 确保 Server Action / Route 打包时带上字体文件（PDF 渲染需要）
  outputFileTracingIncludes: {
    '/api/pi/**': ['./public/fonts/**'],
    '/pi/**': ['./public/fonts/**'],
  },
  // @react-pdf/renderer 及其依赖是 ESM，需要 Next 转译才能在客户端打包
  transpilePackages: ['@react-pdf/renderer'],
  images: {
    // 允许加载 Supabase Storage 公开图片。请把 hostname 换成你的项目域名。
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
