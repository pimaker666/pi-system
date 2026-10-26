import { TransactionManager } from '@/components/finance/transaction-manager'
import { requireFinanceView } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrder, FinanceTransaction, Profile } from '@/types'

export default async function FinanceTransactionsPage() {
  await requireFinanceView()
  const supabase = await createClient()

  // 流水与可选订单都按时间倒序展示，宽裕上限只用于兜底，正常业务量不会触顶。
  const LIST_LIMIT = 2000
  const [transactionsResult, ordersResult, salespeopleResult] = await Promise.all([
    supabase
      .from('finance_transactions')
      .select('*, salesperson:profiles!salesperson_id(id, chinese_name, full_name, email)')
      .order('transaction_date', { ascending: false })
      .limit(LIST_LIMIT),
    supabase
      .from('finance_orders')
      .select('id, pi_number_snapshot')
      .eq('status', 'active')
      .order('order_date', { ascending: false })
      .limit(LIST_LIMIT),
    supabase
      .from('profiles')
      .select('id, full_name, email, chinese_name')
      .eq('role', 'sales')
      .eq('status', 'approved')
      .order('full_name', { ascending: true }),
  ])

  const transactions = (transactionsResult.data ?? []) as FinanceTransaction[]
  const orders = (ordersResult.data ?? []) as Pick<FinanceOrder, 'id' | 'pi_number_snapshot'>[]
  const salespeople = (salespeopleResult.data ?? []) as Pick<
    Profile,
    'id' | 'full_name' | 'email' | 'chinese_name'
  >[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">收支流水</h1>
        <p className="text-sm text-muted-foreground">
          录入日常支出及其他独立现金流水；业务订单客户收款统一在订单详情登记。
        </p>
      </div>
      <TransactionManager
        transactions={transactions}
        orders={orders}
        salespeople={salespeople}
      />
    </div>
  )
}
