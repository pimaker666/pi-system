'use server'

import { z } from 'zod'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { ImageAssetMetaMap } from '@/lib/image-assets'

// 私有常量，绝不 export：'use server' 文件只允许导出 async 函数，
// 且打包器会把本地小模块的值导入内联进本模块，导出对象会被当作 Server Action 校验而崩整页。
const IMAGE_ASSET_BUCKETS = [
  'business-payment-proofs',
  'business-shipment-screenshots',
  'customer-assets',
] as const

const bucketSchema = z.enum(IMAGE_ASSET_BUCKETS)
const pathSchema = z.string().trim().min(1).max(1024)
const nameSchema = z.string().trim().min(1).max(255)

/** 上传完成后登记文件名与上传时间；同名路径重复登记时只更新文件名。 */
export async function registerImageAssetMeta(
  rawInput: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireApproved()
  const parsed = z
    .object({
      bucket: bucketSchema,
      items: z.array(z.object({ path: pathSchema, name: nameSchema })).min(1).max(20),
    })
    .safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: '图片信息参数不合法' }

  const supabase = await createClient()
  const { error } = await supabase.from('image_asset_meta').upsert(
    parsed.data.items.map((item) => ({
      bucket: parsed.data.bucket,
      object_path: item.path,
      display_name: item.name,
      uploaded_by: profile.id,
    })),
    { onConflict: 'bucket,object_path' },
  )
  if (error) return { ok: false, error: '图片信息保存失败' }
  return { ok: true }
}

/**
 * 修改已上传图片的展示名；不改变存储路径。
 * 历史图片可能还没有元数据行，此时补插一行：已知的真实上传时间（如订单附件 created_at）
 * 由调用方通过 uploadedAt 传入，未知则留空显示「未记录」。
 */
export async function renameImageAsset(
  rawInput: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const profile = await requireApproved()
  const parsed = z
    .object({
      bucket: bucketSchema,
      path: pathSchema,
      name: nameSchema,
      uploadedAt: z.string().trim().max(64).nullable().optional(),
    })
    .safeParse(rawInput)
  if (!parsed.success) return { ok: false, error: '图片名称不合法' }

  const supabase = await createClient()
  const { data: updated, error } = await supabase
    .from('image_asset_meta')
    .update({ display_name: parsed.data.name, updated_at: new Date().toISOString() })
    .eq('bucket', parsed.data.bucket)
    .eq('object_path', parsed.data.path)
    .select('object_path')
  if (error) return { ok: false, error: '图片名称修改失败' }
  if (updated && updated.length > 0) return { ok: true }

  const { error: insertError } = await supabase.from('image_asset_meta').insert({
    bucket: parsed.data.bucket,
    object_path: parsed.data.path,
    display_name: parsed.data.name,
    uploaded_at: parsed.data.uploadedAt ?? null,
    uploaded_by: profile.id,
  })
  if (insertError) return { ok: false, error: '图片名称修改失败' }
  return { ok: true }
}

/** 批量读取图片展示元数据；未登记的路径不会出现在结果里。 */
export async function getImageAssetMeta(
  rawInput: unknown,
): Promise<{ meta: ImageAssetMetaMap; error?: string }> {
  await requireApproved()
  const parsed = z
    .object({
      bucket: bucketSchema,
      paths: z.array(pathSchema).max(50),
    })
    .safeParse(rawInput)
  if (!parsed.success) return { meta: {} }
  const paths = [...new Set(parsed.data.paths)]
  if (paths.length === 0) return { meta: {} }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('image_asset_meta')
    .select('object_path, display_name, uploaded_at')
    .eq('bucket', parsed.data.bucket)
    .in('object_path', paths)
  if (error || !data) return { meta: {} }

  return {
    meta: Object.fromEntries(
      data.map((row) => [
        row.object_path,
        { displayName: row.display_name, uploadedAt: row.uploaded_at },
      ]),
    ),
  }
}
