import { AttendanceManager } from '@/components/finance/attendance-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { AttendanceEntry, AttendanceMember, AttendanceSheet, Profile } from '@/types'

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>
}) {
  const profile = await requireApproved()
  const canManage = profile.role === 'admin' || profile.role === 'finance'
  const { month } = await searchParams
  const supabase = await createClient()

  const { data: sheetsData } = await supabase
    .from('attendance_sheets')
    .select('*')
    .order('month', { ascending: false })
  const sheets = (sheetsData ?? []) as AttendanceSheet[]

  const selected = sheets.find((sheet) => sheet.month === month) ?? sheets[0] ?? null

  let entries: AttendanceEntry[] = []
  let members: AttendanceMember[] = []
  if (selected) {
    const [{ data: entriesData }, { data: membersData }] = await Promise.all([
      supabase.from('attendance_entries').select('*').eq('sheet_id', selected.id),
      supabase
        .from('attendance_members')
        .select('*')
        .eq('sheet_id', selected.id)
        .order('sort_order', { ascending: true })
        .order('name', { ascending: true }),
    ])
    entries = (entriesData ?? []) as AttendanceEntry[]
    members = (membersData ?? []) as AttendanceMember[]
  }

  // 有账号成员的去重选择源（管理端「从账号添加」用）
  let accounts: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[] = []
  if (canManage) {
    const { data: profilesData } = await supabase
      .from('profiles')
      .select('id, chinese_name, full_name, email')
      .eq('status', 'approved')
      .order('created_at', { ascending: true })
      .order('full_name', { ascending: true })
    accounts = (profilesData ?? []) as Pick<
      Profile,
      'id' | 'chinese_name' | 'full_name' | 'email'
    >[]
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{canManage ? '考勤表' : '我的考勤'}</h1>
        <p className="text-sm text-muted-foreground">
          {canManage
            ? '按月份维护考勤，点选单元格或用笔刷刷选符号；支持手动添加无账号人员；汇总列按考勤符号自动统计。'
            : '查看本人当月考勤记录。'}
        </p>
      </div>
      <AttendanceManager
        canManage={canManage}
        sheets={sheets}
        members={members}
        accounts={accounts}
        entries={entries}
        selectedMonth={selected?.month ?? ''}
        selectedSheetId={selected?.id ?? ''}
        initialNote={selected?.note ?? ''}
        currentProfileId={profile.id}
      />
    </div>
  )
}
