'use client'

import { FormEvent, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  deletePaymentAccount,
  savePaymentAccount,
} from '@/lib/actions/daily-orders'
import type { PaymentAccount } from '@/types'

interface Props {
  accounts: PaymentAccount[]
}

export function PaymentAccountManager({ accounts }: Props) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function submitAccount(event: FormEvent<HTMLFormElement>, account?: PaymentAccount) {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    startTransition(async () => {
      const result = await savePaymentAccount({
        id: account?.id,
        name: data.get('name'),
        is_active: data.get('is_active') === 'on',
      })
      if (!result.ok) {
        toast.error(result.error ?? '保存失败')
        return
      }
      toast.success(account ? '收款账户已更新' : '收款账户已创建')
      if (!account) form.reset()
      router.refresh()
    })
  }

  function removeAccount(account: PaymentAccount) {
    if (!window.confirm(`确定删除收款账户“${account.name}”吗？`)) return
    startTransition(async () => {
      const result = await deletePaymentAccount(account.id)
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      toast.success('收款账户已删除')
      router.refresh()
    })
  }

  const activeAccounts = accounts.filter((account) => account.is_active)
  const inactiveAccounts = accounts.filter((account) => !account.is_active)

  const accountForm = (account?: PaymentAccount) => (
    <form
      key={account?.id ?? 'new'}
      className="flex flex-col gap-3 sm:flex-row sm:items-end"
      onSubmit={(event) => submitAccount(event, account)}
    >
      <div className="flex-1 space-y-2">
        <Label>{account ? '账户名称' : '新收款账户'}</Label>
        <Input
          name="name"
          defaultValue={account?.name ?? ''}
          required
          maxLength={200}
          placeholder="如银行卡号、支付宝账号等"
        />
      </div>
      <label className="flex h-10 items-center gap-2 text-sm">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={account?.is_active ?? true}
        />
        启用
      </label>
      <Button type="submit" variant={account ? 'outline' : 'default'} disabled={pending}>
        {pending ? '保存中…' : account ? '保存' : '新增'}
      </Button>
      {account && (
        <Button
          type="button"
          variant="destructive"
          disabled={pending}
          onClick={() => removeAccount(account)}
        >
          删除
        </Button>
      )}
    </form>
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">新增收款账户</CardTitle>
        </CardHeader>
        <CardContent>{accountForm()}</CardContent>
      </Card>

      {activeAccounts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">启用中</h2>
            <span className="text-sm text-muted-foreground">{activeAccounts.length} 个</span>
          </div>
          {activeAccounts.map((account) => (
            <Card key={account.id}>
              <CardContent className="pt-6">{accountForm(account)}</CardContent>
            </Card>
          ))}
        </section>
      )}

      {inactiveAccounts.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">已停用</h2>
            <span className="text-sm text-muted-foreground">{inactiveAccounts.length} 个</span>
          </div>
          {inactiveAccounts.map((account) => (
            <Card key={account.id} className="opacity-60">
              <CardContent className="pt-6">{accountForm(account)}</CardContent>
            </Card>
          ))}
        </section>
      )}
    </div>
  )
}
