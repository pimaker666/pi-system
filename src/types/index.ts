export type UserRole = 'admin' | 'sales'
export type CurrencyCode = 'USD' | 'EUR' | 'CNY' | 'GBP' | 'JPY'
export type PiStatus = 'active' | 'void'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  role: UserRole
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
  bank_name: string | null
  bank_account: string | null
  bank_swift: string | null
  bank_address: string | null
  default_terms: string | null
  updated_at: string
}

export interface Product {
  id: string
  sku: string
  name: string
  description: string | null
  unit: string
  unit_price: number
  currency: CurrencyCode
  image_url: string | null
  is_active: boolean
  created_at: string
  updated_at: string
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
  currency: CurrencyCode
  subtotal: number
  tax_rate: number
  tax_amount: number
  shipping_fee: number
  discount: number
  total: number
  notes: string | null
  terms: string | null
  status: PiStatus
  pdf_path: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ProformaInvoiceWithItems extends ProformaInvoice {
  pi_items: PiItem[]
}

/** Cart line item used before the PI is persisted. */
export interface PiLineItem {
  product_id: string
  sku: string
  name: string
  description: string | null
  unit: string
  unit_price: number
  currency: CurrencyCode
  quantity: number
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
