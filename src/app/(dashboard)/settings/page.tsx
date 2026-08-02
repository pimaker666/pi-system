import { requireProfile } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { CompanyForm } from '@/components/settings/company-form'
import { CompanyProfileManager } from '@/components/settings/company-profile-manager'
import type { CompanyProfile, CompanySettings } from '@/types'

export default async function SettingsPage() {
  const profile = await requireProfile()
  const supabase = await createClient()

  const [{ data: profilesData }, { data: settingsData }] = await Promise.all([
    supabase
      .from('company_profiles')
      .select('*')
      .eq('created_by', profile.id)
      .order('created_at', { ascending: true }),
    supabase.from('company_settings').select('*').eq('id', 1).maybeSingle(),
  ])

  const profiles = (profilesData ?? []) as CompanyProfile[]
  const defaultCompany = (settingsData ?? null) as CompanySettings | null

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">公司设置</h1>
        <p className="text-sm text-muted-foreground">
          管理你自己的公司信息，生效中的那份会显示在你生成的 Proforma Invoice 上。
        </p>
      </div>

      <CompanyProfileManager profiles={profiles} defaultCompany={defaultCompany} />

      {profile.role === 'admin' && (
        <div className="space-y-3 border-t pt-8">
          <div>
            <h2 className="text-lg font-medium">系统默认公司信息</h2>
            <p className="text-sm text-muted-foreground">
              当某个账号还没有添加自己的公司信息时，其生成的 PI 会回退使用这份默认信息。仅管理员可编辑。
            </p>
          </div>
          <CompanyForm settings={defaultCompany} />
        </div>
      )}
    </div>
  )
}
