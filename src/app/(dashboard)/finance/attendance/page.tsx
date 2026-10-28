import { AttendanceManager } from '@/components/finance/attendance-manager'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { AttendanceEntry, AttendanceSheet, Profile } from '@/types'

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
  if (selected) {
    const { data: entriesData } = await supabase
      .from('attendance_entries')
      .select('*')
      .eq('sheet_id', selected.id)
    entries = (entriesData ?? []) as AttendanceEntry[]
  }

  let profiles: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'>[]
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
  } else {
    profiles = [
      {
        id: profile.id,
        chinese_name: profile.chinese_name,
        full_name: profile.full_name,
        email: profile.email,
      },
    ]
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{canManage ? '考勤表' : '我的考勤'}</h1>
        <p className="text-sm text-muted-foreground">
          {canManage
            ? '按月份维护全员考勤，点选单元格切换符号；汇总列按考勤符号自动统计。'
            : '查看本人当月考勤记录。'}
        </p>
      </div>
      <AttendanceManager
        canManage={canManage}
        sheets={sheets}
        profiles={profiles}
        entries={entries}
        selectedMonth={selected?.month ?? ''}
        selectedSheetId={selected?.id ?? ''}
        initialNote={selected?.note ?? ''}
      />
    </div>
  )
}
