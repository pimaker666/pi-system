import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { DailyOrderWorkflowPanel } from '@/components/finance/daily-order-workflow-panel'
import { Button } from '@/components/ui/button'
import { requireApproved } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { fetchDailyOrderWorkflowDetail } from '@/lib/daily-orders-server'
import type {
  Customer,
  CustomerGroup,
  DailyOrderChangeRequest,
  DailyOrderCommission,
} from '@/types'

export default async function DailyOrderWorkflowDetailPage({
  params,
}: {
  params: Promise<{ workflowId: string }>
}) {
  const { workflowId } = await params
  const profile = await requireApproved()
  const supabase = await createClient()

  const detail = await fetchDailyOrderWorkflowDetail(supabase, workflowId)
  if (!detail) notFound()

  const isFinance = profile.role === 'admin' || profile.role === 'finance'
  const canBind = (profile.role === 'sales' || isFinance)

  const [customersResult, groupsResult, changesResult] = await Promise.all([
    // Customers/groups are only needed for the customer binder control.
    canBind
      ? supabase.from('customers').select('*').order('name')
      : Promise.resolve({ data: [], error: null }),
    canBind
      ? supabase.from('customer_groups').select('*').order('name')
      : Promise.resolve({ data: [], error: null }),
    supabase
      .from('finance_daily_order_change_requests')
      .select('*')
      .eq('workflow_id', workflowId)
      .order('requested_at', { ascending: false }),
  ])

  const error = customersResult.error || groupsResult.error || changesResult.error
  if (error) throw new Error(`订单工作流基础数据读取失败：${error.message}`)

  // Commission is finance/admin-only; RLS blocks sales/supervisor, so skip the query for them.
  let commission: DailyOrderCommission | null = null
  if (isFinance) {
    const { data, error: commissionError } = await supabase
      .from('finance_daily_order_commissions')
      .select('*')
      .eq('workflow_id', workflowId)
      .maybeSingle()
    if (commissionError) throw new Error(`提成读取失败：${commissionError.message}`)
    commission = (data as DailyOrderCommission) ?? null
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button asChild variant="ghost" size="icon" className="h-8 w-8">
          <Link href="/finance/performance/orders">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold">订单工作流</h1>
          <p className="text-sm text-muted-foreground">认领订单、绑定客户、提交业绩审核与改动申请。</p>
        </div>
      </div>

      <DailyOrderWorkflowPanel
        profile={profile}
        workflow={detail.workflow}
        orders={detail.orders}
        changeRequests={(changesResult.data ?? []) as DailyOrderChangeRequest[]}
        customers={(customersResult.data ?? []) as Customer[]}
        groups={(groupsResult.data ?? []) as CustomerGroup[]}
        commission={commission}
      />
    </div>
  )
}
