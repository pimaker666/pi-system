export type UserRole = 'admin' | 'finance' | 'sales' | 'supervisor'
export type UserStatus = 'pending' | 'approved'
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
export type BusinessPaymentType = 'full' | 'deposit' | 'balance'
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

export interface FinanceOrder {
  id: string
  pi_id: string | null
  pi_number_snapshot: string
  customer_name_snapshot: string | null
  salesperson_id: string | null
  salesperson_name_snapshot: string | null
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
  salesperson_id: string | null
  salesperson_name_snapshot: string | null
  order_date: string
  payment_due_date: string | null
  fulfillment_type: BusinessFulfillmentType
  currency: CurrencyCode
  exchange_rate_to_cny: number
  items_subtotal: number
  shipping_fee: number
  total_amount: number
  total_cny: number
  tracking_number: string | null
  sales_notes: string | null
  review_note: string | null
  submitted_by: string | null
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  completed_by: string | null
  completed_at: string | null
  created_at: string
  updated_at: string
  /** Live-joined salesperson profile (PostgREST embed on salesperson_id) used to
   *  render the current chinese_name; null when the user was deleted. */
  salesperson?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
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
  sort_order: number
  created_at: string
  updated_at: string
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
  customer_id: string
  is_shared: boolean
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
  code: string
  name: string
  description: string | null
  specification: string | null
  unit: string
  image_url: string | null
  default_unit_price: number
  default_currency: CurrencyCode
  created_by: string | null
  created_at: string
}

export interface BusinessCustomProductListItem {
  custom_product_id: string
  owner_customer_id: string
  is_shared: boolean
  is_archived: boolean
  version_id: string
  version_no: number
  code: string
  name: string
  description: string | null
  specification: string | null
  unit: string
  image_url: string | null
  default_unit_price: number
  default_currency: CurrencyCode
}

export interface BusinessCustomerTransfer {
  id: string
  customer_id: string
  currency: CurrencyCode
  amount: number
  exchange_rate_to_cny: number
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

export interface BusinessOrderPaymentAllocation {
  id: string
  transfer_id: string
  order_id: string
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

export interface BusinessOrderPaymentAllocationWithTransfer
  extends BusinessOrderPaymentAllocation {
  transfer: BusinessCustomerTransfer
}

export interface BusinessOrderShipmentWithItems extends BusinessOrderShipment {
  business_order_shipment_items: BusinessOrderShipmentItem[]
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

export interface BusinessLifecycleAuditLog {
  id: number
  order_id: string | null
  customer_id: string | null
  entity_type: BusinessLifecycleEntityType
  entity_id: string
  action: 'create' | 'version_create' | 'state_change' | 'void'
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
  created_at: string
  /** Live-joined actor profile (PostgREST embed on actor_id) used to render the
   *  current chinese_name; null when the user was deleted. */
  actor?: Pick<Profile, 'id' | 'chinese_name' | 'full_name' | 'email'> | null
}

export interface BusinessOrderWithDetails extends BusinessOrder {
  business_order_items: BusinessOrderItem[]
  /** @deprecated Legacy rows retained only for historical compatibility. */
  business_order_payments: BusinessOrderPayment[]
  business_order_payment_allocations?: BusinessOrderPaymentAllocationWithTransfer[]
  business_order_shipments?: BusinessOrderShipmentWithItems[]
}

export interface Profile {
  id: string
  email: string
  full_name: string | null
  chinese_name: string | null
  role: UserRole
  status: UserStatus
  supervisor_id: string | null
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
  group_id: string | null
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
