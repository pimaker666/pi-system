import { SUPABASE_SERVER_URL } from './urls'

/**
 * 图片地址归一化助手（同源改造）。
 *
 * 存库的 image_url / remark_image_url / logo_url 可能是以下任意形态：
 *   - 内网绝对：http://192.168.0.5:8000/storage/v1/object/public/...
 *   - 域名绝对：https://pi.gainwinskincare.com/supabase/storage/v1/object/public/...
 *   - 云端绝对：https://xxx.supabase.co/storage/v1/object/public/...
 * 三者都含有 `/storage/`，因此统一按 `/storage/` 切分后重建，
 * 无论存的是哪种形态都能在对应环境正确解析。
 */

/** `/storage/` 之后的部分（含前导斜杠），找不到返回 null。 */
function storageTail(url?: string | null): string | null {
  if (!url) return null
  const i = url.indexOf('/storage/')
  return i === -1 ? null : url.slice(i)
}

/**
 * 浏览器端使用：把图片地址改写成同源相对路径 `/supabase/storage/...`，
 * 交由 next.config 的 rewrite 反代到内网 Supabase。外网浏览器因此无需
 * 直连内网 IP。非 /storage/ 形态（如外链）原样返回。
 */
export function toImageSrc(url?: string | null): string {
  const tail = storageTail(url)
  if (tail === null) return url ?? ''
  return '/supabase' + tail
}

/**
 * 服务端使用（PDF / xlsx 渲染，Node 在 NAS 内网 fetch）：把图片地址改写成
 * 内网绝对地址 `${SUPABASE_SERVER_URL}/storage/...`，走内网直连、不出公网。
 * 非 /storage/ 形态原样返回。
 */
export function toServerImageSrc(url?: string | null): string {
  const tail = storageTail(url)
  if (tail === null) return url ?? ''
  return SUPABASE_SERVER_URL + tail
}
