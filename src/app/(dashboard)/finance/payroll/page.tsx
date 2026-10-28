import { PayrollManager } from '@/components/finance/payroll-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { PayrollItemWithProfile, PayrollSheet, Profile } from '@/types'

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const profile = await requireApproved()
  const canManage = profile.role === 'admin' || profile.role === 'finance'
  const { month } = await searchParams
  const supabase = await createClient()

  const { data: sheetsData } = await supabase
    .from('payroll_sheets')
    .select('*')
    .order('period_month', { ascending: false })
  const sheets = (sheetsData ?? []) as PayrollSheet[]

  let itemsQuery = supabase
    .from('payroll_items')
    .select('*, profile:profiles!inner(id, chinese_name, full_name, email)')
    .order('sort_order', { ascending: true })
  if (!canManage) itemsQuery = itemsQuery.eq('profile_id', profile.id)
  const { data: itemsData } = await itemsQuery
  const visibleSheetIds = new Set(sheets.map((sheet) => sheet.id))
  const items = ((itemsData ?? []) as PayrollItemWithProfile[]).filter((item) =>
    visibleSheetIds.has(item.sheet_id),
  )

  let profiles: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[] = []
  if (canManage) {
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, chinese_name, full_name, email')
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .order('full_name', { ascending: true })
    profiles = (profilesData ?? []) as Pick<
      Profile,
      'id' | 'chinese_name' | 'full_name' | 'email'
    >[]
  }

  const selectedMonth =
    month && sheets.some((sheet) => sheet.period_month === month)
      ? month
      : (sheets[0]?.period_month ?? '')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{canManage ? '工资表' : '我的工资条'}</h1>
        <p className="text-sm text-muted-foreground">
          {canManage
            ? '财务核算工资后推送给员工，员工在系统中确认或驳回；修改已推送的金额会自动回到待确认。'
            : '财务推送后可在此查看本人工资条并确认或驳回。'}
        </p>
      </div>
      <PayrollManager
        canManage={canManage}
        myProfileId={profile.id}
        sheets={sheets}
        items={items}
        profiles={profiles}
        selectedMonth={selectedMonth}
      />
    </div>
  )
}
