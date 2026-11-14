import { PayrollManager } from '@/components/finance/payroll-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type {
  PayrollItemWithProfile,
  PayrollSalaryProfile,
  PayrollSheet,
  Profile,
} from '@/types'

export default async function PayrollPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const profile = await requireApproved()
  const canManage = profile.role === 'admin' || profile.role === 'finance'
  const { month } = await searchParams
  const supabase = await createClient()

  // 四段查询互不依赖，一次并发发出；可见表集合在拿到结果后再过滤。
  const itemsQuery = supabase
    .from('payroll_items')
    .select('*, profile:profiles(id, chinese_name, full_name, email)')
    .order('sort_order', { ascending: true })
  const scopedItemsQuery = canManage ? itemsQuery : itemsQuery.eq('profile_id', profile.id)

  const [sheetsResult, itemsResult, profilesResult, salaryResult] = await Promise.all([
    supabase
      .from('payroll_sheets')
      .select('*')
      .order('period_month', { ascending: false }),
    scopedItemsQuery,
    canManage
      ? supabase
        .from('profiles')
        .select('id, chinese_name, full_name, email')
        .eq('status', 'approved')
        .order('created_at', { ascending: true })
        .order('full_name', { ascending: true })
      : Promise.resolve({ data: null }),
    canManage
      ? supabase
        .from('payroll_salary_profiles')
        .select('*')
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true })
      : Promise.resolve({ data: null }),
  ])

  const sheets = (sheetsResult.data ?? []) as PayrollSheet[]
  const visibleSheetIds = new Set(sheets.map((sheet) => sheet.id))
  const items = ((itemsResult.data ?? []) as PayrollItemWithProfile[]).filter((item) =>
    visibleSheetIds.has(item.sheet_id),
  )

  const profiles = (profilesResult.data ?? []) as Pick<
    Profile,
    'id' | 'chinese_name' | 'full_name' | 'email'
  >[]
  const salaryProfiles = (salaryResult.data ?? []) as PayrollSalaryProfile[]

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
            ? '人员取自薪资档案（可含无系统账号的员工）；核算后推送工资条，无账号人员默认不推送。推送后金额锁定，修改需先撤回发布。'
            : '财务推送后可在此查看本人工资条，每人只能看到自己的。'}
        </p>
      </div>
      <PayrollManager
        canManage={canManage}
        myProfileId={profile.id}
        sheets={sheets}
        items={items}
        profiles={profiles}
        salaryProfiles={salaryProfiles}
        selectedMonth={selectedMonth}
      />
    </div>
  )
}
