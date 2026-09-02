export type UserRole = 'admin' | 'finance' | 'sales'
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
}

export interface FinanceOrderCost {
  id: string
  finance_order_id: string
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

export interface Profile {
  id: string
  email: string
  full_name: string | null
  role: UserRole
  status: UserStatus
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
