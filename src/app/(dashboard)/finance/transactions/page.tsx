import { TransactionManager } from '@/components/finance/transaction-manager'
import { requireFinanceAccess } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import type { FinanceOrder, FinanceTransaction, Profile } from '@/types'

export default async function FinanceTransactionsPage() {
  await requireFinanceAccess()
  const supabase = await createClient()

  const [transactionsResult, ordersResult, salespeopleResult] = await Promise.all([
    supabase
      .from('finance_transactions')
      .select('*')
      .order('transaction_date', { ascending: false }),
    supabase
      .from('finance_orders')
      .select('id, pi_number_snapshot')
      .eq('status', 'active')
      .order('order_date', { ascending: false }),
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('role', 'sales')
      .eq('status', 'approved')
      .order('full_name', { ascending: true }),
  ])

  const transactions = (transactionsResult.data ?? []) as FinanceTransaction[]
  const orders = (ordersResult.data ?? []) as Pick<FinanceOrder, 'id' | 'pi_number_snapshot'>[]
  const salespeople = (salespeopleResult.data ?? []) as Pick<
    Profile,
    'id' | 'full_name' | 'email'
  >[]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">收支流水</h1>
        <p className="text-sm text-muted-foreground">
          录入客户回款、日常支出及其他现金流水，并保留原币与登记汇率。
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
