export type UserRole = 'admin' | 'finance' | 'sales' | 'supervisor'
export type UserStatus = 'pending' | 'approved' | 'disabled'
export type CurrencyCode = 'USD' | 'EUR' | 'CNY' | 'GBP' | 'JPY'
export type PiStatus = 'active' | 'void'
export type FinanceRecordStatus = 'active' | 'void'
export type FinanceTransactionType = 'income' | 'expense'
export type FinanceCostType =
  | 'product'
  | 'shipping'
  | 'customs'
  | 'platform_fee'
  | 'payment_fee'
  | 'other'

export type BusinessOrderStatus =
  | 'draft'
  | 'submitted'
  | 'rejected'
  | 'approved'
  | 'completed'
export type BusinessFulfillmentType = 'custom' | 'stock'
export type BusinessPerformanceGroupBy =
  | 'salesperson'
  | 'shop'
  | 'date'
  | 'month'
  | 'product_group'
  | 'shipping_category'
export type BusinessPaymentType = 'full' | 'deposit' | 'balance'

export interface BusinessPerformanceSummary {
  order_count: number
  /** 全部订单按各自订单汇率折算后的订单总额（CNY）。 */
  order_total_cny: number
  /** USD 订单的订单总额（USD 原币）。 */
  order_total_usd: number
  /** CNY 订单的订单总额（CNY 原币）。 */
  order_total_cny_native: number
  /** 全部订单按各自订单汇率折算后的已收金额（CNY）。 */
  received_cny: number
  /** USD 订单的已收金额（USD 原币）。 */
  received_usd: number
  /** CNY 订单的已收金额（CNY 原币）。 */
  received_cny_native: number
  /** 全部订单按各自订单汇率折算后的未收金额（CNY）。 */
  outstanding_cny: number
  /** USD 订单的未收金额（USD 原币）。 */
  outstanding_usd: number
  /** CNY 订单的未收金额（CNY 原币）。 */
  outstanding_cny_native: number
  overdue_count: number
}

export interface BusinessPerformanceGroupRow {
  group_key: string
  group_label: string
  group_sort_order: number
  order_count: number
  /** 全部订单按各自订单汇率折算后的订单总额（CNY）。 */
  order_total_cny: number
  /** USD 订单的订单总额（USD 原币）。 */
  order_total_usd: number
  /** CNY 订单的订单总额（CNY 原币）。 */
  order_total_cny_native: number
  /** 全部订单按各自订单汇率折算后的已收金额（CNY）。 */
  received_cny: number
  /** USD 订单的已收金额（USD 原币）。 */
  received_usd: number
  /** CNY 订单的已收金额（CNY 原币）。 */
  received_cny_native: number
  /** 全部订单按各自订单汇率折算后的未收金额（CNY）。 */
  outstanding_cny: number
  /** USD 订单的未收金额（USD 原币）。 */
  outstanding_usd: number
  /** CNY 订单的未收金额（CNY 原币）。 */
  outstanding_cny_native: number
  overdue_count: number
}
export type BusinessOrderItemSourceType = 'catalog' | 'custom' | 'legacy'
export type BusinessApprovalStatus = 'draft' | 'submitted' | 'rejected' | 'approved'
export type BusinessPaymentStatus = 'unpaid' | 'partially_paid' | 'fully_paid'
export type BusinessFulfillmentStatus =
  | 'unshipped'
  | 'partially_shipped'
  | 'fully_shipped'
export type BusinessAuditAction =
  | 'create'
  | 'update'
  | 'payment_add'
  | 'payment_update'
  | 'payment_void'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'finance_update'
  | 'complete'
  | 'correct'

export interface SettledOrderRow {
  business_order_item_id: string
  order_id: string
  order_number: string
  external_order_number: string | null
  order_date: string
  shop_name: string | null
  shop_group_name: string | null
  salesperson_name: string
  customer_name: string | null
  currency: CurrencyCode
  product_name: string
  product_sku: string
  shipping_category: DailyOrderShippingCategory | null
  quantity: number
  unit_cost: number | null
  total_cost: number | null
  /** 结算归属年月（YYYY-MM）。 */
  period: string
  settled_by_name: string | null
  settled_at: string
}

export interface FinanceOrder {
  id: string
  pi_id: string | null
  pi_number_snapshot: string
  customer_name_snapshot: string | null
  salesperson_id: string | null
  salesperson_name_snapshot: string | null
  salesperson_display_name_snapshot: string | null
  order_date: string
  amount_original: number
  currency: CurrencyCode
  exchange_rate_to_cny: number
  amount_cny: number
  status: FinanceRecordStatus
  notes: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface FinanceTransaction {
  id: string
  transaction_type: FinanceTransactionType
  category: string
  transaction_date: string
  amount_original: number
  currency: CurrencyCode
  exchange_rate_to_cny: number
  amount_cny: number
  finance_order_id: string | null
  salesperson_id: string | null
  salesperson_name_snapshot: string | null
  salesperson_display_name_snapshot: string | null
  reference_no: string | null
  description: string | null
  status: FinanceRecordStatus
  created_by: string | null
  created_at: string
  updated_at: string
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface FinanceOrderCost {
  id: string
  finance_order_id: string | null
  business_order_id: string | null
  cost_type: FinanceCostType
  incurred_date: string
  amount_original: number
  currency: CurrencyCode
  exchange_rate_to_cny: number
  amount_cny: number
  description: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface DailyOrderProductCost {
  daily_order_id: string
  shipping_date: string
  order_date: string
  order_number: string
  shop_name: string
  salesperson_name: string
  shipping_category: DailyOrderShippingCategory
  sales_product_name: string
  sales_product_sku: string
  quantity: number
  financial_number: string | null
  financial_product_name: string | null
  catalog_cost: number | null
  cost: number | null
  cost_overridden: boolean
}

export interface BusinessOrderProductCost {
  order_id: string
  item_id: string
  /** 合并行对应的底层明细行 ID；单行时与 item_id 相同。 */
  item_ids: string[]
  order_date: string
  shipping_date: string | null
  shop_name: string | null
  shop_group_name: string | null
  salesperson_name: string
  order_number: string
  external_order_number: string | null
  customer_name: string | null
  customer_tag_color: string | null
  payment_account: string | null
  shipping_number: string | null
  shipping_category: DailyOrderShippingCategory | null
  product_name: string
  product_sku: string
  image_url: string | null
  quantity: number
  shipping_progress: string
  unit_price: number
  product_received_amount: number
  logistics_fee_amount: number | null
  sales_total_amount: number
  currency: CurrencyCode
  order_total_amount: number
  order_sales_total_amount: number
  outstanding_amount: number
  order_status: BusinessOrderStatus
  order_closed_at: string | null
  payment_category: DailyOrderPaymentCategory | null
  sales_notes: string | null
  attachments: BusinessOrderAttachment[]
  financial_number: string | null
  financial_product_name: string | null
  catalog_cost: number | null
  cost: number | null
  cost_overridden: boolean
  total_cost: number | null
  fully_shipped: boolean
  /** 该合并行的所有明细行是否都已结算（进入“已结算订单”）。 */
  settled: boolean
  /** 结算归属年月（YYYY-MM）；未结算为 null。 */
  settled_period: string | null
}

export interface CommissionCategoryRate {
  category: DailyOrderShippingCategory
  /** 产品提点（百分数，例如 5 表示 5%）。 */
  product_commission_rate: number
}

export interface CustomerCommissionTag {
  /** 标记颜色（十六进制 #RRGGBB），与 customers.tag_color 对应。 */
  tag_color: string
  /** 标记含义（图例文字）。 */
  label: string
  /** 该标记的产品提点（百分数，例如 5 表示 5%）。 */
  product_commission_rate: number
  /** 展示排序。 */
  sort_order: number
}

export interface CustomerCustomOrderCommissionRate {
  /** 累计定制订单数不超过此值时适用；取满足条件的最低上限。 */
  maximum_custom_order_count: number
  /** 产品提点（百分数，例如 5 表示 5%）。 */
  product_commission_rate: number
}

export type BusinessOrderCommissionRateSource =
  | 'override'
  | 'customer_tag'
  | 'custom_order_count'
  | 'shipping_category'
  | 'none'

export interface BusinessOrderCommissionRow {
  order_id: string
  item_id: string
  /** 合并行对应的底层明细行 ID；单行时与 item_id 相同。 */
  item_ids: string[]
  order_date: string
  shipping_date: string | null
  shop_name: string | null
  shop_group_name: string | null
  salesperson_name: string
  order_number: string
  external_order_number: string | null
  customer_name: string | null
  /** 是否已关联客户；未关联时保留订单展示但不能计算或结清提成。 */
  commission_calculable: boolean
  customer_tag_color: string | null
  /** 客户标记含义（图例文字），无标记或标记未定义时为 null。 */
  customer_tag_label: string | null
  /** 客户库中该客户的定制订单数（匹配客户列表口径）。 */
  custom_order_count: number
  shipping_category: DailyOrderShippingCategory | null
  product_name: string
  product_sku: string
  image_url: string | null
  quantity: number
  unit_price: number
  product_received_amount: number
  currency: CurrencyCode
  order_total_amount: number
  /** 产品提点（百分数，优先级：手动逐行覆盖 > 客户标记 > 定制订单数 > 发货分类默认 > 0）。 */
  product_commission_rate: number
  /** 实际生效的产品提点来源。 */
  product_commission_rate_source: BusinessOrderCommissionRateSource
  /** 该行是否单独设置过产品提点（覆盖）。 */
  product_commission_rate_overridden: boolean
  /** 该行发货分类的默认产品提点（百分数），无默认时为 null。 */
  category_default_rate: number | null
  /** 仅定制发货分类按定制订单数匹配到的提点（百分数），未命中时为 null。 */
  custom_order_count_rate: number | null
  /** 产品提成 = 产品实收金额 × 产品提点% ÷ 100。 */
  product_commission_amount: number
  /** 运费实收金额（订单级）。 */
  freight_received_amount: number
  /** 运费成本（订单级，人工填）。 */
  freight_cost: number
  /** 运费利润 = 运费实收 − 运费成本（订单级）。 */
  freight_profit: number
  /** 运费提点（百分数，订单级，人工填）。 */
  freight_commission_rate: number
  /** 运费提成 = 运费利润 × 运费提点% ÷ 100（订单级）。 */
  freight_commission_amount: number
  /** 美元订单结算时保存的 USD→CNY 汇率；运费成本始终以人民币保存。 */
  settlement_exchange_rate_to_cny: number | null
  /** 是否为该订单在当前结果中的首行（用于运费列合并渲染）。 */
  is_order_lead_row: boolean
  /** 该订单在当前结果中占据的产品行数（用于运费列 rowspan）。 */
  order_row_span: number
  /** 该产品行的提成结清状态；未提交时为 null。 */
  clearance_status: BusinessOrderCommissionClearanceStatus | null
  /** 提成结清归属年月（YYYY-MM）；未提交时为 null。 */
  clearance_period: string | null
}

export type CommissionClearanceStatus = 'pending' | 'confirmed' | 'rejected'
export type BusinessOrderCommissionClearanceStatus = CommissionClearanceStatus

export interface BusinessOrderCommissionClearance {
  business_order_item_id: string
  period: string
  status: CommissionClearanceStatus
  submitted_by: string | null
  submitted_at: string
  confirmed_by: string | null
  confirmed_at: string | null
  rejected_reason: string | null
  created_at: string
  updated_at: string
}

export type DailyOrderShippingCategory = 'stock' | 'sample' | 'custom' | 'purchase'
export type DailyOrderPaymentCategory = 'full' | 'deposit' | 'balance'

export interface DailyOrderShop {
  id: string
  name: string
  group_id: string | null
  is_active: boolean
  default_currency: CurrencyCode
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface DailyOrderShopGroup {
  id: string
  name: string
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface DailyOrderShopSalesperson {
  shop_id: string
  salesperson_id: string
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface PaymentAccount {
  id: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface DailyOrderScreenshot {
  id: string
  order_id: string
  object_path: string
  original_name: string | null
  mime_type: 'image/jpeg' | 'image/png'
  size_bytes: number
  status: FinanceRecordStatus
  created_by: string | null
  removed_by: string | null
  removed_at: string | null
  created_at: string
}

export interface DailyOrder {
  id: string
  version: number
  status: FinanceRecordStatus
  order_date: string
  shop_id: string | null
  shop_name_snapshot: string
  salesperson_id: string | null
  salesperson_name_snapshot: string
  order_number: string
  shipping_date: string
  shipping_number: string | null
  shipping_category: DailyOrderShippingCategory
  product_id: string | null
  product_name_snapshot: string
  product_sku_snapshot: string
  quantity: number
  sales_unit_price_amount: number
  sales_unit_price_currency: CurrencyCode
  product_received_amount: number
  product_received_currency: CurrencyCode
  logistics_fee_amount: number
  logistics_fee_currency: CurrencyCode
  sales_total_amount: number
  sales_total_currency: CurrencyCode
  payment_category: DailyOrderPaymentCategory
  remarks: string | null
  workflow_id: string | null
  created_by: string | null
  updated_by: string | null
  voided_by: string | null
  voided_at: string | null
  created_at: string
  updated_at: string
  finance_daily_order_screenshots?: DailyOrderScreenshot[]
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export type DailyOrderWorkflowStatus =
  | 'unclaimed'
  | 'claimed'
  | 'submitted'
  | 'approved'
  | 'rejected'
export type DailyOrderChangeStatus = 'pending' | 'approved' | 'rejected' | 'cancelled'
export type DailyOrderWorkflowAuditAction =
  | 'claim'
  | 'bind_customer'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'commission_saved'
  | 'change_requested'
  | 'change_approved'
  | 'change_rejected'
  | 'change_cancelled'

export interface DailyOrderWorkflow {
  id: string
  version: number
  status: DailyOrderWorkflowStatus
  salesperson_id: string
  salesperson_name_snapshot: string
  order_number: string
  customer_id: string | null
  customer_name_snapshot: string | null
  customer_tag_color: string | null
  total_product_received_amount: number
  total_product_received_currency: CurrencyCode
  total_product_received_overridden: boolean
  total_shipping_received_amount: number
  total_shipping_received_currency: CurrencyCode
  total_shipping_received_overridden: boolean
  total_sales_amount: number
  total_sales_currency: CurrencyCode
  total_sales_overridden: boolean
  claimed_at: string | null
  submitted_at: string | null
  reviewed_at: string | null
  reviewed_by: string | null
  review_reason: string | null
  created_by: string | null
  created_at: string
  updated_at: string
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface DailyOrderCommission {
  id: string
  workflow_id: string
  commission_amount: number
  commission_currency: CurrencyCode
  remarks: string | null
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface DailyOrderChangeRequest {
  id: string
  order_id: string
  workflow_id: string
  status: DailyOrderChangeStatus
  payload: Record<string, string | number>
  requested_by: string | null
  requested_at: string
  reviewed_by: string | null
  reviewed_at: string | null
  review_reason: string | null
  created_at: string
  updated_at: string
}

export interface DailyOrderWorkflowAuditLog {
  id: string
  workflow_id: string
  action: DailyOrderWorkflowAuditAction
  actor_id: string | null
  detail: Record<string, unknown>
  created_at: string
}

export interface BusinessOrder {
  id: string
  order_number: string
  status: BusinessOrderStatus
  approval_status: BusinessApprovalStatus
  payment_status: BusinessPaymentStatus
  fulfillment_status: BusinessFulfillmentStatus
  version: number
  completion_gate_version: 1 | 2
  customer_id: string | null
  customer_snapshot: CustomerSnapshot
  shop_id: string | null
  shop_name_snapshot: string | null
  shop_group_id: string | null
  shop_group_name_snapshot: string | null
  salesperson_id: string | null
  salesperson_name_snapshot: string | null
  salesperson_display_name_snapshot: string | null
  external_order_number: string | null
  order_date: string
  payment_due_date: string | null
  daily_shipping_date: string | null
  daily_shipping_number: string | null
  daily_payment_category: DailyOrderPaymentCategory | null
  fulfillment_type: BusinessFulfillmentType
  currency: CurrencyCode
  exchange_rate_to_cny: number | null
  items_subtotal: number
  shipping_fee: number
  /** 订单手续费：仅用于利润核算扣减，不参与应收或实收。 */
  order_fee: number | null
  total_amount: number
  total_cny: number | null
  total_product_received_amount: number | null
  total_product_received_overridden: boolean
  total_shipping_received_amount: number | null
  total_shipping_received_overridden: boolean
  total_sales_amount: number | null
  total_sales_overridden: boolean
  receivable_received_difference_reason: string | null
  tracking_number: string | null
  payment_account: string | null
  sales_notes: string | null
  review_note: string | null
  submitted_by: string | null
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  completed_by: string | null
  completed_at: string | null
  closed_at: string | null
  closed_by: string | null
  close_reason: string | null
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  created_at: string
  updated_at: string
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
  /** Linked customer's current country, attached server-side for flag rendering so
   *  the flag reflects the live customer record rather than the frozen snapshot.
   *  Undefined when not attached; null when the order has no linked customer. */
  current_customer_country?: string | null
}

export interface BusinessOrderItem {
  id: string
  order_id: string
  source_type: BusinessOrderItemSourceType
  product_id: string | null
  custom_product_id: string | null
  custom_product_version_id: string | null
  sku_snapshot: string
  name_snapshot: string
  description_snapshot: string | null
  specification_snapshot: string | null
  unit_snapshot: string
  image_url_snapshot: string | null
  quantity: number
  unit_price: number
  line_amount: number
  daily_shipping_category: DailyOrderShippingCategory | null
  product_received_amount: number | null
  product_received_overridden: boolean
  logistics_fee_amount: number | null
  sales_total_amount: number | null
  sales_total_overridden: boolean
  /** 明细来源：original=首次下单（不可改删），append=追加加单（可改删） */
  origin: 'original' | 'append'
  sort_order: number
  created_at: string
  updated_at: string
}

export interface BusinessOrderAttachment {
  id: string
  order_id: string
  object_path: string
  original_name: string | null
  mime_type: 'image/jpeg' | 'image/png'
  size_bytes: number
  status: FinanceRecordStatus
  created_by: string | null
  removed_by: string | null
  removed_at: string | null
  created_at: string
}

/**
 * Legacy read-only payment row retained for existing screens.
 * @deprecated New writes use BusinessCustomerTransfer and BusinessOrderPaymentAllocation.
 */
export interface BusinessOrderPayment {
  id: string
  order_id: string
  payment_type: BusinessPaymentType
  amount: number
  currency: CurrencyCode
  exchange_rate_to_cny: number
  received_at: string
  proof_path: string
  notes: string | null
  created_by: string | null
  updated_by: string | null
  voided_at: string | null
  voided_by: string | null
  created_at: string
  updated_at: string
}

export interface BusinessCustomProduct {
  id: string
  is_archived: boolean
  created_by: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface BusinessCustomProductVersion {
  id: string
  custom_product_id: string
  version_no: number
  product_group_id: string | null
  code: string
  name: string
  description: string | null
  specification: string | null
  unit: string
  image_url: string | null
  quantity: number | null
  default_unit_price: number
  default_currency: CurrencyCode
  order_amount: number | null
  received_amount: number | null
  outstanding_amount: number | null
  created_by: string | null
  created_at: string
}

export interface BusinessCustomProductListItem {
  custom_product_id: string
  is_archived: boolean
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
  version_id: string
  version_no: number
  product_group_id: string | null
  product_group_name: string | null
  code: string
  name: string
  description: string | null
  specification: string | null
  unit: string
  image_url: string | null
  quantity: number | null
  default_unit_price: number
  default_currency: CurrencyCode
  order_amount: number | null
  received_amount: number | null
  outstanding_amount: number | null
}

export interface BusinessCustomProductOrderHistoryItem {
  code: string
  name: string
  unit: string
  image_url: string | null
  quantity: number
  order_date: string
  order_number: string
  external_order_number: string | null
  currency: CurrencyCode
  order_amount: number
}

export interface BusinessCustomProductOrderAmount {
  currency: CurrencyCode
  amount: number
}

export interface BusinessCustomProductLibraryItem {
  custom_product_id: string
  is_archived: boolean
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
  latest_version_id: string | null
  latest_version_no: number | null
  version_count: number
  product_group_id: string | null
  product_group_name: string | null
  code: string | null
  name: string | null
  description: string | null
  specification: string | null
  unit: string | null
  image_url: string | null
  quantity: number | null
  default_unit_price: number | null
  default_currency: CurrencyCode | null
  order_amount: number | null
  received_amount: number | null
  outstanding_amount: number | null
  order_history: BusinessCustomProductOrderHistoryItem[]
  total_order_quantity: number
  total_order_amounts: BusinessCustomProductOrderAmount[]
}

export interface BusinessCustomerTransfer {
  id: string
  customer_id: string | null
  order_id: string | null
  currency: CurrencyCode
  amount: number
  exchange_rate_to_cny: number | null
  received_at: string
  payment_type: BusinessPaymentType
  proof_path: string
  notes: string | null
  idempotency_key: string | null
  payload_hash: string | null
  created_by: string | null
  created_at: string
  updated_by: string | null
  updated_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  legacy_payment_id: string | null
}

export type BusinessOrderPaymentAllocationTarget = 'order' | 'item' | 'shipping'

export interface BusinessOrderPaymentAllocation {
  id: string
  transfer_id: string
  order_id: string
  order_item_id: string | null
  allocation_target: BusinessOrderPaymentAllocationTarget
  amount: number
  payment_type: BusinessPaymentType
  created_by: string | null
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
  legacy_payment_id: string | null
}

export interface BusinessOrderShipment {
  id: string
  order_id: string
  shipped_at: string
  tracking_number: string | null
  notes: string | null
  created_by: string | null
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export interface BusinessOrderShipmentItem {
  id: string
  shipment_id: string
  order_item_id: string
  quantity: number
  created_at: string
}

export interface BusinessOrderReturn {
  id: string
  order_id: string
  returned_at: string
  notes: string | null
  idempotency_key: string | null
  payload_hash: string | null
  created_by: string | null
  created_at: string
  voided_at: string | null
  voided_by: string | null
  void_reason: string | null
}

export interface BusinessOrderReturnItem {
  id: string
  return_id: string
  order_id: string
  shipment_item_id: string
  order_item_id: string
  quantity: number
  created_at: string
}

export interface BusinessOrderItemEditConstraint {
  order_item_id: string
  source_type: BusinessOrderItemSourceType
  product_id: string | null
  custom_product_id: string | null
  custom_product_version_id: string | null
  ordered_quantity: number
  gross_shipped_quantity: number
  returned_quantity: number
  net_shipped_quantity: number
  minimum_quantity: number
  can_delete: boolean
  can_replace_product: boolean
  can_change_unit_price: boolean
}

export interface BusinessOrderEditConstraints {
  order_id: string
  version: number
  status: BusinessOrderStatus
  is_closed: boolean
  is_completed: boolean
  has_active_allocation: boolean
  active_allocated_amount: number
  can_edit_order: boolean
  can_add_allocation: boolean
  can_add_shipment: boolean
  items: BusinessOrderItemEditConstraint[]
}

export interface BusinessOrderPaymentAllocationWithTransfer
  extends BusinessOrderPaymentAllocation {
  transfer: BusinessCustomerTransfer
}

export interface BusinessOrderShipmentWithItems extends BusinessOrderShipment {
  business_order_shipment_items: BusinessOrderShipmentItem[]
}

export interface BusinessOrderReturnWithItems extends BusinessOrderReturn {
  business_order_return_items: BusinessOrderReturnItem[]
}

export interface BusinessCustomerTransferWithAllocations extends BusinessCustomerTransfer {
  business_order_payment_allocations: BusinessOrderPaymentAllocation[]
}

export interface BusinessCustomerPrepayment {
  currency: CurrencyCode
  total_received: number
  total_allocated: number
  available_balance: number
}

export interface BusinessOrderSettlementSummary {
  order_id: string
  currency: CurrencyCode
  total_amount: number
  allocated_amount: number
  outstanding_amount: number
  payment_status: BusinessPaymentStatus
  payment_due_date: string | null
  item_quantity: number
  shipped_quantity: number
  fulfillment_status: BusinessFulfillmentStatus
}

export interface BusinessOrderFinanceDetail {
  order_id: string
  wage_amount_cny: number
  calculation_notes: string
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type BusinessLifecycleEntityType =
  | 'custom_product'
  | 'custom_product_version'
  | 'transfer'
  | 'allocation'
  | 'shipment'
  | 'return'
  | 'closure'
  | 'order_void'

export type BusinessLifecycleAuditAction =
  | 'create'
  | 'version_create'
  | 'state_change'
  | 'void'
  | 'special_close'

export interface BusinessLifecycleAuditLog {
  id: number
  order_id: string | null
  customer_id: string | null
  entity_type: BusinessLifecycleEntityType
  entity_id: string
  action: BusinessLifecycleAuditAction
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  reason: string | null
  actor_id: string | null
  actor_snapshot: {
    id: string
    email: string | null
    full_name: string | null
    role: UserRole
  }
  actor_display_name_snapshot: string | null
  created_at: string
  actor?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface BusinessOrderAuditLog {
  id: number
  order_id: string
  entity_type: 'order' | 'item' | 'payment'
  entity_id: string
  action: BusinessAuditAction
  from_status: BusinessOrderStatus | null
  to_status: BusinessOrderStatus | null
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  reason: string | null
  actor_id: string | null
  actor_snapshot: {
    id: string
    email: string | null
    full_name: string | null
    role: UserRole
  }
  actor_display_name_snapshot: string | null
  created_at: string
  /** Current actor profile is only a fallback for legacy rows without a snapshot. */
  actor?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface BusinessOrderWithDetails extends BusinessOrder {
  business_order_items: BusinessOrderItem[]
  business_order_attachments?: BusinessOrderAttachment[]
  /** @deprecated Legacy rows retained only for historical compatibility. */
  business_order_payments: BusinessOrderPayment[]
  business_order_payment_allocations?: BusinessOrderPaymentAllocationWithTransfer[]
  business_order_shipments?: BusinessOrderShipmentWithItems[]
  business_order_returns?: BusinessOrderReturnWithItems[]
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  chinese_name: string | null
  role: UserRole
  status: UserStatus
  supervisor_id: string | null
  disabled_at: string | null
  disabled_by: string | null
  created_at: string
  updated_at: string
}

export interface CompanySettings {
  id: number
  company_name: string
  address: string | null
  phone: string | null
  email: string | null
  website: string | null
  logo_url: string | null
  accent_color: string | null
  bank_name: string | null
  bank_account: string | null
  bank_swift: string | null
  bank_address: string | null
  default_terms: string | null
  updated_at: string
}

/** Pure company + bank data snapshotted onto a PI and fed to the PDF. */
export interface CompanySnapshot {
  company_name: string
  address: string | null
  phone: string | null
  email: string | null
  website: string | null
  logo_url: string | null
  accent_color: string | null
  bank_name: string | null
  bank_account: string | null
  bank_swift: string | null
  bank_address: string | null
  default_terms: string | null
}

/** Per-account saved company profile; one may be marked active. */
export interface CompanyProfile {
  id: string
  created_by: string
  label: string
  company_name: string
  address: string | null
  phone: string | null
  email: string | null
  website: string | null
  logo_url: string | null
  accent_color: string | null
  bank_name: string | null
  bank_account: string | null
  bank_swift: string | null
  bank_address: string | null
  default_terms: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface Product {
  id: string
  sku: string
  name: string
  description: string | null
  specification: string | null
  /** Product weight in grams (g). Not shown in PI by default. */
  weight_g: number | null
  unit: string
  unit_price: number
  currency: CurrencyCode
  image_url: string | null
  category: string | null
  group_id: string | null
  is_active: boolean
  /** Joined from product_financials for search/display; null when not fetched or no access. */
  financial_number?: string | null
  financial_product_name?: string | null
  created_at: string
  updated_at: string
}

export interface ProductFinancial {
  product_id: string
  financial_number: string | null
  product_name: string | null
  cost: number | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export interface ProductGroup {
  id: string
  name: string
  description: string | null
  sort_order: number
  created_by: string | null
  created_at: string
}

export interface CustomerGroup {
  id: string
  name: string
  description: string | null
  created_by: string | null
  created_at: string
}

export interface Customer {
  id: string
  name: string
  company: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  contact_person: string | null
  remarks: string | null
  group_id: string | null
  tag_color: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CustomerSnapshot {
  name: string
  company: string | null
  email: string | null
  phone: string | null
  address: string | null
  city: string | null
  state: string | null
  postal_code: string | null
  country: string | null
  contact_person: string | null
  tag_color: string | null
}

export interface PiItem {
  id: string
  pi_id: string
  product_id: string | null
  sku: string
  name: string
  description: string | null
  image_url: string | null
  remark_image_url: string | null
  /** Product specification snapshot for this line, e.g. "34g*4pcs/box". */
  specification: string | null
  /** Product weight snapshot in grams (g) for this line. */
  weight_g: number | null
  unit: string
  unit_price: number
  quantity: number
  line_total: number
  sort_order: number
}

export interface ProformaInvoice {
  id: string
  pi_number: string
  customer_id: string | null
  customer_snapshot: CustomerSnapshot
  company_snapshot: CompanySnapshot | null
  currency: CurrencyCode
  subtotal: number
  tax_rate: number
  tax_amount: number
  shipping_fee: number
  discount: number
  total: number
  /** Transport method + lead time snapshot, e.g. "Sea Transportation, 22~40 Days". */
  shipping_method: string | null
  /** Whether this PI shows the SPECIFICATION column. */
  show_specification: boolean
  /** Whether this PI shows the weight (克重) column. Default false. */
  show_weight: boolean
  notes: string | null
  terms: string | null
  status: PiStatus
  pdf_path: string | null
  /** Soft-delete marker. null = active, non-null = in recycle bin. */
  deleted_at: string | null
  created_by: string | null
  creator_display_name_snapshot: string | null
  created_at: string
  updated_at: string
}

export interface ProformaInvoiceWithItems extends ProformaInvoice {
  pi_items: PiItem[]
}

/** A PI history row enriched with the current account's favorite state. */
export interface PiHistoryRow {
  id: string
  pi_number: string
  customer_snapshot: CustomerSnapshot
  currency: CurrencyCode
  total: number
  status: PiStatus
  deleted_at: string | null
  created_by: string | null
  creator_display_name_snapshot: string | null
  created_at: string
  is_favorite: boolean
}

/** Cart line item used before the PI is persisted. */
export interface PiLineItem {
  /** Stable unique id for this cart line (a product can be added multiple times). */
  line_id: string
  /** Product id in the library; null when the source product was deleted. */
  product_id: string | null
  sku: string
  name: string
  description: string | null
  image_url: string | null
  remark_image_url: string | null
  specification: string | null
  weight_g: number | null
  unit: string
  unit_price: number | null
  currency: CurrencyCode
  quantity: number | null
  /** True when this line's replaced image was auto-saved as a new library product. */
  auto_saved_product?: boolean
}

/** Charges applied at PI level in "simple mode". */
export interface PiCharges {
  tax_rate: number
  shipping_fee: number
  discount: number
}

export interface PiTotals {
  subtotal: number
  tax_amount: number
  total: number
}

// ---------------- 计算重量（Weight Calculation）----------------

/** A saved weight-calculation header. */
export interface WeightCalculation {
  id: string
  calc_number: string
  title: string | null
  source_pi_id: string | null
  total_quantity: number
  total_weight_g: number
  created_by: string | null
  creator_display_name_snapshot: string | null
  created_at: string
}

/** A line inside a saved weight calculation. */
export interface WeightCalcItem {
  id: string
  calc_id: string
  product_id: string | null
  sku: string | null
  name: string
  image_url: string | null
  weight_g: number
  quantity: number
  line_weight_g: number
  sort_order: number
}

export interface WeightCalculationWithItems extends WeightCalculation {
  weight_calc_items: WeightCalcItem[]
}

/** History list row for weight calculations. */
export interface WeightCalcHistoryRow {
  id: string
  calc_number: string
  title: string | null
  total_quantity: number
  total_weight_g: number
  created_by: string | null
  creator_display_name_snapshot: string | null
  created_at: string
}

/** Cart line used while building a weight calculation (before persistence). */
export interface WeightCalcLineItem {
  product_id: string
  sku: string | null
  name: string
  image_url: string | null
  weight_g: number | null
  quantity: number | null
}
