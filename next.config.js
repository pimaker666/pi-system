/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // 确保 Server Action / Route 打包时带上中文字体文件（PDF 渲染需要）
    outputFileTracingIncludes: {
      '/api/pi/**': ['./public/fonts/**'],
      '/pi/**': ['./public/fonts/**'],
    },
  },
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
