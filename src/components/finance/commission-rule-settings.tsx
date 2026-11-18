'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, ListOrdered, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  deleteCommissionRule,
  moveCommissionRule,
  saveCommissionRule,
  toggleCommissionRule,
} from '@/lib/actions/commission-rules'
import {
  describeCommissionRuleConditions,
  filterRulesByLine,
} from '@/lib/commission-rules'
import { SHIPPING_LABELS } from '@/lib/daily-orders'
import { cn } from '@/lib/utils'
import type { CommissionRule, CommissionRuleLine, DailyOrderShippingCategory } from '@/types'

const ANY = 'any'

const LEGACY_LABELS: Record<string, string> = {
  tag: '客户标记同步',
  custom_tier: '定制单数同步',
  category: '分类提点同步',
}

interface RuleForm {
  id?: string
  name: string
  rate: string
  enabled: boolean
  tagColor: string
  shippingCategory: string
  customOrderMax: string
  orderIndexMax: string
  tenureMonthsMax: string
}

function emptyForm(): RuleForm {
  return {
    name: '',
    rate: '',
    enabled: true,
    tagColor: ANY,
    shippingCategory: ANY,
    customOrderMax: '',
    orderIndexMax: '',
    tenureMonthsMax: '',
  }
}

function formFromRule(rule: CommissionRule): RuleForm {
  return {
    id: rule.id,
    name: rule.name,
    rate: String(rule.product_commission_rate),
    enabled: rule.enabled,
    tagColor: rule.tag_color ?? ANY,
    shippingCategory: rule.shipping_category ?? ANY,
    customOrderMax: rule.custom_order_count_max == null ? '' : String(rule.custom_order_count_max),
    orderIndexMax: rule.order_index_max == null ? '' : String(rule.order_index_max),
    tenureMonthsMax: rule.tenure_months_max == null ? '' : String(rule.tenure_months_max),
  }
}

function optionalInt(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return null
  if (!/^\d+$/.test(trimmed)) return undefined
  return Number(trimmed)
}

export function CommissionRuleSettings({
  line,
  rules,
  tagOptions,
}: {
  line: CommissionRuleLine
  rules: CommissionRule[]
  tagOptions: Array<{ color: string; label: string }>
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<RuleForm | null>(null)

  const lineRules = filterRulesByLine(rules, line)
  const tagLabels = new Map(tagOptions.map((tag) => [tag.color.toLowerCase(), tag.label]))
  const tagLabelMap = Object.fromEntries(tagLabels)
  const isBusiness = line === 'business'

  function run(action: () => Promise<void>, successMessage?: string) {
    startTransition(async () => {
      try {
        await action()
        if (successMessage) toast.success(successMessage)
        router.refresh()
      } catch {
        toast.error('操作失败，请刷新后重试')
      }
    })
  }

  function submitForm() {
    if (!form) return
    const name = form.name.trim()
    if (!name) {
      toast.error('请填写规则名称')
      return
    }
    const rate = Number(form.rate)
    if (!form.rate.trim() || !Number.isFinite(rate) || rate < 0 || rate > 100) {
      toast.error('提点必须是 0~100 的数字')
      return
    }
    const customOrderMax = optionalInt(form.customOrderMax)
    const orderIndexMax = optionalInt(form.orderIndexMax)
    const tenureMonthsMax = optionalInt(form.tenureMonthsMax)
    if (customOrderMax === undefined || orderIndexMax === undefined || tenureMonthsMax === undefined) {
      toast.error('订单数 / 年限条件必须是非负整数')
      return
    }
    const payload = {
      id: form.id,
      line,
      name,
      enabled: form.enabled,
      tag_color: form.tagColor === ANY ? null : form.tagColor,
      shipping_category:
        form.shippingCategory !== ANY ? (form.shippingCategory as DailyOrderShippingCategory) : null,
      custom_order_count_max: isBusiness ? customOrderMax : null,
      order_index_max: orderIndexMax,
      tenure_months_max: tenureMonthsMax,
      product_commission_rate: Math.round(rate * 10000) / 10000,
    }
    run(async () => {
      const result = await saveCommissionRule(payload)
      if (!result.ok) {
        const firstFieldError = Object.values(result.fieldErrors ?? {}).flat()[0]
        toast.error(firstFieldError ?? result.error ?? '规则保存失败')
        return
      }
      toast.success(form.id ? '规则已更新' : '规则已添加')
      setForm(null)
    })
  }

  function removeRule(rule: CommissionRule) {
    run(async () => {
      const result = await deleteCommissionRule({ id: rule.id, line })
      if (!result.ok) {
        toast.error(result.error ?? '删除失败')
        return
      }
      toast.success('规则已删除')
    })
  }

  function toggleRule(rule: CommissionRule) {
    run(async () => {
      const result = await toggleCommissionRule({ id: rule.id, line, enabled: !rule.enabled })
      if (!result.ok) toast.error(result.error ?? '状态更新失败')
    })
  }

  function moveRule(rule: CommissionRule, direction: 'up' | 'down') {
    run(async () => {
      const result = await moveCommissionRule({ id: rule.id, line, direction })
      if (!result.ok) toast.error(result.error ?? '排序失败')
    })
  }

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <ListOrdered className="mr-1.5 h-4 w-4" />
        {isBusiness ? '提成规则' : '运营规则'}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setForm(null)
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{isBusiness ? '业务提成规则' : '运营提成规则'}</DialogTitle>
          </DialogHeader>

          {form ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>规则名称</Label>
                  <Input
                    value={form.name}
                    maxLength={80}
                    placeholder="例如：新客户前两单"
                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>产品提点（%）</Label>
                  <Input
                    value={form.rate}
                    type="number"
                    min={0}
                    max={100}
                    step="0.0001"
                    onChange={(event) => setForm({ ...form, rate: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-3 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">
                  所有条件需同时满足；留空的条件下不参与判断。多个条件都留空即为兜底规则。
                </p>
                {!isBusiness && (
                  <p className="text-xs text-muted-foreground">
                    运营提成按订单聚合：发货分类条件表示订单内存在该分类的产品行即命中。
                  </p>
                )}
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label>客户标记</Label>
                    <Select
                      value={form.tagColor}
                      onValueChange={(value) => setForm({ ...form, tagColor: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>不限</SelectItem>
                        {tagOptions.map((tag) => (
                          <SelectItem key={tag.color} value={tag.color.toLowerCase()}>
                            {tag.label}（{tag.color}）
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label>发货分类</Label>
                    <Select
                      value={form.shippingCategory}
                      onValueChange={(value) => setForm({ ...form, shippingCategory: value })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={ANY}>不限</SelectItem>
                        {(Object.keys(SHIPPING_LABELS) as DailyOrderShippingCategory[]).map((category) => (
                          <SelectItem key={category} value={category}>
                            {SHIPPING_LABELS[category]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {isBusiness && (
                    <div className="space-y-1.5">
                      <Label>累计定制订单 ≤（单）</Label>
                      <Input
                        value={form.customOrderMax}
                        type="number"
                        min={0}
                        placeholder="留空不限"
                        onChange={(event) => setForm({ ...form, customOrderMax: event.target.value })}
                      />
                    </div>
                  )}
                  <div className="space-y-1.5">
                    <Label>客户前 N 单</Label>
                    <Input
                      value={form.orderIndexMax}
                      type="number"
                      min={1}
                      placeholder="留空不限，仅统计成交单"
                      onChange={(event) => setForm({ ...form, orderIndexMax: event.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>客户年限 ≤（个月）</Label>
                    <Input
                      value={form.tenureMonthsMax}
                      type="number"
                      min={0}
                      placeholder="留空不限，12 = 1 年"
                      onChange={(event) => setForm({ ...form, tenureMonthsMax: event.target.value })}
                    />
                  </div>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                    className="h-4 w-4 rounded border-gray-300"
                  />
                  启用该规则
                </label>
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setForm(null)}>
                  <X className="mr-1.5 h-4 w-4" />
                  取消
                </Button>
                <Button type="button" disabled={pending} onClick={submitForm}>
                  <Save className="mr-1.5 h-4 w-4" />
                  保存规则
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-xs leading-5 text-muted-foreground">
                自上而下逐条匹配，命中第一条即采用该规则的提点；都不命中则提点为 0。
                {isBusiness
                  ? '业务与运营各自独立排序；产品行手动填写的提点始终最高。'
                  : '运营与业务各自独立排序；固定点数模式不受本页规则影响。'}
                旧设置（分类 / 定制单数 / 客户标记）会自动同步为规则，可在这里调整顺序或停用。
              </p>
              <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
                {lineRules.length === 0 && (
                  <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                    还没有规则，新增后按顺序生效。
                  </p>
                )}
                {lineRules.map((rule, index) => (
                  <div
                    key={rule.id}
                    className={cn(
                      'rounded-lg border p-3',
                      !rule.enabled && 'bg-muted/40 opacity-70',
                    )}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0 space-y-1.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/10 px-1.5 text-[11px] font-semibold text-primary">
                            {index + 1}
                          </span>
                          <span className="text-sm font-medium">{rule.name}</span>
                          <span className="text-sm font-semibold tabular-nums text-primary">
                            {rule.product_commission_rate}%
                          </span>
                          {rule.legacy_source && (
                            <Badge variant="secondary" className="text-[11px]">
                              {LEGACY_LABELS[rule.legacy_source] ?? '旧设置同步'}
                            </Badge>
                          )}
                          {!rule.enabled && (
                            <Badge variant="outline" className="text-[11px]">
                              已停用
                            </Badge>
                          )}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {describeCommissionRuleConditions(rule, tagLabelMap).map((part) => (
                            <span
                              key={part}
                              className="rounded-full border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                            >
                              {part}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={pending || index === 0}
                          title="上移"
                          onClick={() => moveRule(rule, 'up')}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={pending || index === lineRules.length - 1}
                          title="下移"
                          onClick={() => moveRule(rule, 'down')}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => toggleRule(rule)}
                        >
                          {rule.enabled ? '停用' : '启用'}
                        </Button>
                        {!rule.legacy_source && (
                          <>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title="编辑"
                              disabled={pending}
                              onClick={() => setForm(formFromRule(rule))}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              title="删除"
                              disabled={pending}
                              onClick={() => removeRule(rule)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button type="button" onClick={() => setForm(emptyForm())}>
                  <Plus className="mr-1.5 h-4 w-4" />
                  新增规则
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
