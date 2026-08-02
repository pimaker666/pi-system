/**
 * 把云端 Supabase 三个存储桶里的所有文件，复制到 NAS 自建 Supabase。
 * 逐桶列举 → 下载 → 上传。适合小规模（几百个文件）一次性迁移。
 *
 * 依赖：@supabase/supabase-js（在有 node 的机器上跑，能同时访问云端和 NAS）
 *   npm i @supabase/supabase-js
 *
 * 运行：
 *   CLOUD_URL=https://spirybjrvhgevreyanvf.supabase.co \
 *   CLOUD_SERVICE_KEY=<云端 service_role> \
 *   NAS_URL=http://192.168.0.5:8000 \
 *   NAS_SERVICE_KEY=<NAS service_role> \
 *   node copy-storage.mjs
 */
import { createClient } from '@supabase/supabase-js'

const BUCKETS = ['product-images', 'pi-pdfs', 'company-assets']

const cloud = createClient(process.env.CLOUD_URL, process.env.CLOUD_SERVICE_KEY, {
  auth: { persistSession: false },
})
const nas = createClient(process.env.NAS_URL, process.env.NAS_SERVICE_KEY, {
  auth: { persistSession: false },
})

/** 递归列举某个前缀下的所有文件（Supabase list 不递归，需手动下钻）。 */
async function listAll(client, bucket, prefix = '') {
  const out = []
  const { data, error } = await client.storage.from(bucket).list(prefix, {
    limit: 1000,
    sortBy: { column: 'name', order: 'asc' },
  })
  if (error) throw error
  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name
    // 文件夹的 id 为 null
    if (item.id === null) {
      out.push(...(await listAll(client, bucket, path)))
    } else {
      out.push(path)
    }
  }
  return out
}

async function ensureBucket(bucket) {
  // 桶应由迁移脚本 0001 自动创建；这里兜底一次。
  const { data } = await nas.storage.getBucket(bucket)
  if (!data) {
    await nas.storage.createBucket(bucket, { public: bucket !== 'pi-pdfs' })
    console.log(`  + 在 NAS 创建桶 ${bucket}`)
  }
}

for (const bucket of BUCKETS) {
  console.log(`\n=== 桶 ${bucket} ===`)
  await ensureBucket(bucket)
  const paths = await listAll(cloud, bucket)
  console.log(`  云端文件数：${paths.length}`)
  let ok = 0
  for (const path of paths) {
    const { data: blob, error: dErr } = await cloud.storage.from(bucket).download(path)
    if (dErr) {
      console.warn(`  下载失败 ${path}: ${dErr.message}`)
      continue
    }
    const buf = Buffer.from(await blob.arrayBuffer())
    const { error: uErr } = await nas.storage
      .from(bucket)
      .upload(path, buf, { upsert: true, contentType: blob.type || undefined })
    if (uErr) {
      console.warn(`  上传失败 ${path}: ${uErr.message}`)
      continue
    }
    ok++
    if (ok % 20 === 0) console.log(`  已复制 ${ok}/${paths.length}`)
  }
  console.log(`  完成：${ok}/${paths.length}`)
}

console.log('\n全部桶复制完成。')
