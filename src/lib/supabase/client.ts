import { createBrowserClient } from '@supabase/ssr'
import { SUPABASE_STORAGE_KEY } from './urls'

/**
 * 浏览器端 Supabase 客户端。
 *
 * 基址走同源 `${origin}/supabase`，由 next.config 的 rewrite 反代到内网 Supabase，
 * 这样外网浏览器（pi.gainwinskincare.com）无需直连内网 IP，auth / rest / storage
 * 及上传后 getPublicUrl 生成的图片地址都会落在同源域名下。
 * 非浏览器环境（SSR / 构建期）退回 NEXT_PUBLIC_SUPABASE_URL。
 */
export function createClient() {
  const url =
    typeof window !== 'undefined'
      ? `${window.location.origin}/supabase`
      : process.env.NEXT_PUBLIC_SUPABASE_URL!

  return createBrowserClient(
    url,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: { storageKey: SUPABASE_STORAGE_KEY },
    },
  )
}
