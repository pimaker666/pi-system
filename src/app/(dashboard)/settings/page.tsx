import { requireAdmin } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { CompanyForm } from '@/components/settings/company-form'
import type { CompanySettings } from '@/types'

export default async function SettingsPage() {
  await requireAdmin()
  const supabase = await createClient()
  const { data } = await supabase.from('company_settings').select('*').eq('id', 1).maybeSingle()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">公司设置</h1>
        <p className="text-sm text-muted-foreground">
          这些信息会显示在所有生成的 Proforma Invoice 上。
        </p>
      </div>
      <CompanyForm settings={(data ?? null) as CompanySettings | null} />
    </div>
  )
}
