import type {
  BusinessApprovalStatus,
  BusinessFulfillmentStatus,
  BusinessFulfillmentType,
  BusinessOrderStatus,
  BusinessPaymentStatus,
  BusinessPaymentType,
  CustomerSnapshot,
} from '@/types'

export type BusinessStatusVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'muted'

export const BUSINESS_ORDER_STATUS_LABELS: Record<BusinessOrderStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  rejected: '已驳回',
  approved: '已审核',
  completed: '已完成',
}

export const BUSINESS_ORDER_STATUS_VARIANTS: Record<BusinessOrderStatus, BusinessStatusVariant> = {
  draft: 'muted',
  submitted: 'default',
  rejected: 'destructive',
  approved: 'outline',
  completed: 'success',
}

export const BUSINESS_APPROVAL_STATUS_LABELS: Record<BusinessApprovalStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  rejected: '已驳回',
  approved: '已审核',
}

export const BUSINESS_APPROVAL_STATUS_VARIANTS: Record<
  BusinessApprovalStatus,
  BusinessStatusVariant
> = {
  draft: 'muted',
  submitted: 'default',
  rejected: 'destructive',
  approved: 'success',
}

export const BUSINESS_PAYMENT_STATUS_LABELS: Record<BusinessPaymentStatus, string> = {
  unpaid: '未收款',
  partially_paid: '部分收款',
  fully_paid: '已收齐',
}

export const BUSINESS_PAYMENT_STATUS_VARIANTS: Record<
  BusinessPaymentStatus,
  BusinessStatusVariant
> = {
  unpaid: 'destructive',
  partially_paid: 'default',
  fully_paid: 'success',
}

export const BUSINESS_FULFILLMENT_STATUS_LABELS: Record<BusinessFulfillmentStatus, string> = {
  unshipped: '未发货',
  partially_shipped: '部分发货',
  fully_shipped: '已全部发货',
}

export const BUSINESS_FULFILLMENT_STATUS_VARIANTS: Record<
  BusinessFulfillmentStatus,
  BusinessStatusVariant
> = {
  unshipped: 'muted',
  partially_shipped: 'default',
  fully_shipped: 'success',
}

export const BUSINESS_FULFILLMENT_LABELS: Record<BusinessFulfillmentType, string> = {
  custom: '定制',
  stock: '现货',
}

export const BUSINESS_PAYMENT_LABELS: Record<BusinessPaymentType, string> = {
  full: '全款',
  deposit: '定金',
  balance: '尾款',
}

export function getBusinessOrderCustomerName(snapshot: CustomerSnapshot) {
  return snapshot.company || snapshot.name || '未命名客户'
}

const BUSINESS_TIME_ZONE = 'Asia/Shanghai'

export function getBusinessDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function getBusinessDateTimeLocal(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`
}

export function businessDateTimeLocalToIso(value: string) {
  const normalized = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(normalized)) {
    throw new Error('请选择有效的业务时间')
  }
  const parsed = new Date(`${normalized}:00+08:00`)
  if (Number.isNaN(parsed.getTime())) throw new Error('请选择有效的业务时间')
  return parsed.toISOString()
}

function dateKeyToDay(dateKey: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!match) return null
  return Math.floor(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000)
}

export function getBusinessOverdueDays(dueDate: string | null, fullyPaid: boolean) {
  if (!dueDate || fullyPaid) return 0
  const dueDay = dateKeyToDay(dueDate)
  const today = dateKeyToDay(getBusinessDateKey())
  if (dueDay === null || today === null) return 0
  return Math.max(today - dueDay, 0)
}
