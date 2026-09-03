import type {
  BusinessFulfillmentType,
  BusinessOrderStatus,
  BusinessPaymentType,
  CustomerSnapshot,
} from '@/types'

export const BUSINESS_ORDER_STATUS_LABELS: Record<BusinessOrderStatus, string> = {
  draft: '草稿',
  submitted: '待审核',
  rejected: '已驳回',
  approved: '待财务核算',
  completed: '已完成',
}

export const BUSINESS_ORDER_STATUS_VARIANTS: Record<
  BusinessOrderStatus,
  'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'muted'
> = {
  draft: 'muted',
  submitted: 'default',
  rejected: 'destructive',
  approved: 'outline',
  completed: 'success',
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
