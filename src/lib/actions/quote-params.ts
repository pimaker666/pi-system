'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/auth'
import type { ActionResult } from './products'

const VALID_CATEGORIES = new Set([
  'mask',
  'cotton',
  'oil',
  'cream',
  'eyemask',
  'globals',
])

export async function saveQuoteParams(
  entries: { category: string; overrides: Record<string, unknown> }[],
): Promise<ActionResult> {
  const profile = await requireAdmin()
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, error: '没有要保存的参数' }
  }

  const supabase = await createClient()
  for (const entry of entries) {
    if (!VALID_CATEGORIES.has(entry.category)) {
      return { ok: false, error: `未知品类：${entry.category}` }
    }
    const ov = entry.overrides
    if (typeof ov !== 'object' || ov === null || Array.isArray(ov)) {
      return { ok: false, error: `${entry.category} 的覆盖值必须是 JSON 对象` }
    }
    if (JSON.stringify(ov).length > 200_000) {
      return { ok: false, error: '参数内容过大（上限 200KB）' }
    }
    const { error } = await supabase.from('quote_params').upsert({
      category: entry.category,
      overrides: ov,
      updated_by: profile.id,
      updated_at: new Date().toISOString(),
    })
    if (error) return { ok: false, error: error.message }
  }

  revalidatePath('/quote-params')
  revalidatePath('/quote')
  return { ok: true }
}
