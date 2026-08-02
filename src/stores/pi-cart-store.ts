'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  PiLineItem,
  PiCharges,
  CurrencyCode,
  Product,
  Customer,
  ProformaInvoiceWithItems,
} from '@/types'

/** Generate a unique id for a cart line. */
function newLineId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `line-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PiCartState {
  items: PiLineItem[]
  charges: PiCharges
  currency: CurrencyCode
  notes: string
  customer: Customer | null
  terms: string
  /** Transport method + lead time, e.g. "Sea Transportation, 22~40 Days". */
  shippingMethod: string
  /** Whether this PI includes the SPECIFICATION column. */
  showSpecification: boolean
  /** Whether this PI includes the 克重 (weight) column. Default off. */
  showWeight: boolean
  addProduct: (product: Product, quantity?: number | null) => void
  removeLine: (lineId: string) => void
  reorderItem: (from: number, to: number) => void
  setQuantity: (lineId: string, quantity: number | null) => void
  setUnitPrice: (lineId: string, unitPrice: number | null) => void
  setAllQuantity: (quantity: number | null) => void
  setAllUnitPrice: (unitPrice: number | null) => void
  setName: (lineId: string, name: string) => void
  setDescription: (lineId: string, description: string) => void
  setImage: (lineId: string, imageUrl: string | null) => void
  setRemarkImage: (lineId: string, remarkImageUrl: string | null) => void
  setSpecification: (lineId: string, specification: string | null) => void
  /** After the replaced image was auto-saved as a new product, bind this line to it. */
  linkLineToProduct: (lineId: string, productId: string, sku: string) => void
  setCharges: (charges: Partial<PiCharges>) => void
  setNotes: (notes: string) => void
  setCustomer: (customer: Customer | null) => void
  setTerms: (terms: string) => void
  setShippingMethod: (shippingMethod: string) => void
  setShowSpecification: (show: boolean) => void
  setShowWeight: (show: boolean) => void
  hydrateFromPi: (pi: ProformaInvoiceWithItems) => void
  has: (productId: string) => boolean
  countOf: (productId: string) => number
  reset: () => void
}

const defaultCharges: PiCharges = {
  tax_rate: 0,
  shipping_fee: 0,
  discount: 0,
}

export const usePiCartStore = create<PiCartState>()(
  persist(
    (set, get) => ({
      items: [],
      charges: defaultCharges,
      currency: 'USD',
      notes: '',
      customer: null,
      terms: '',
      shippingMethod: '',
      showSpecification: true,
      showWeight: false,

      addProduct: (product) =>
        set((state) => {
          const nextItem: PiLineItem = {
            line_id: newLineId(),
            product_id: product.id,
            sku: product.sku,
            name: product.name,
            description: null,
            image_url: product.image_url,
            remark_image_url: null,
            specification: product.specification ?? null,
            weight_g: product.weight_g ?? null,
            unit: product.unit,
            unit_price: null,
            currency: product.currency,
            quantity: null,
          }
          // First item locks the PI currency.
          const currency = state.items.length === 0 ? product.currency : state.currency
          return { items: [...state.items, nextItem], currency }
        }),

      removeLine: (lineId) =>
        set((state) => {
          const items = state.items.filter((i) => i.line_id !== lineId)
          const currency = items.length === 0 ? 'USD' : state.currency
          return { items, currency }
        }),

      reorderItem: (from, to) =>
        set((state) => {
          const n = state.items.length
          if (
            from === to ||
            from < 0 ||
            to < 0 ||
            from >= n ||
            to >= n
          ) {
            return state
          }
          const items = [...state.items]
          const [moved] = items.splice(from, 1)
          items.splice(to, 0, moved)
          return { items }
        }),

      setQuantity: (lineId, quantity) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId
              ? {
                  ...i,
                  quantity:
                    quantity === null || Number.isNaN(quantity)
                      ? null
                      : Math.max(1, Math.floor(quantity)),
                }
              : i,
          ),
        })),

      setUnitPrice: (lineId, unitPrice) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId
              ? {
                  ...i,
                  unit_price:
                    unitPrice === null || Number.isNaN(unitPrice)
                      ? null
                      : Math.max(0, unitPrice),
                }
              : i,
          ),
        })),

      setAllQuantity: (quantity) =>
        set((state) => {
          const normalized =
            quantity === null || Number.isNaN(quantity)
              ? null
              : Math.max(1, Math.floor(quantity))
          return { items: state.items.map((i) => ({ ...i, quantity: normalized })) }
        }),

      setAllUnitPrice: (unitPrice) =>
        set((state) => {
          const normalized =
            unitPrice === null || Number.isNaN(unitPrice)
              ? null
              : Math.max(0, unitPrice)
          return { items: state.items.map((i) => ({ ...i, unit_price: normalized })) }
        }),

      setName: (lineId, name) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId ? { ...i, name } : i,
          ),
        })),

      setDescription: (lineId, description) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId ? { ...i, description } : i,
          ),
        })),

      setImage: (lineId, imageUrl) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId ? { ...i, image_url: imageUrl } : i,
          ),
        })),

      setRemarkImage: (lineId, remarkImageUrl) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId
              ? { ...i, remark_image_url: remarkImageUrl }
              : i,
          ),
        })),

      setSpecification: (lineId, specification) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId ? { ...i, specification } : i,
          ),
        })),

      linkLineToProduct: (lineId, productId, sku) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.line_id === lineId
              ? { ...i, product_id: productId, sku, auto_saved_product: true }
              : i,
          ),
        })),

      setCharges: (charges) =>
        set((state) => ({ charges: { ...state.charges, ...charges } })),

      setNotes: (notes) => set({ notes }),

      setCustomer: (customer) => set({ customer }),

      setTerms: (terms) => set({ terms }),

      setShippingMethod: (shippingMethod) => set({ shippingMethod }),

      setShowSpecification: (show) => set({ showSpecification: show }),

      setShowWeight: (show) => set({ showWeight: show }),

      hydrateFromPi: (pi) =>
        set(() => {
          const items: PiLineItem[] = [...pi.pi_items]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((it) => ({
              line_id: newLineId(),
              // Deleted products keep null product_id.
              product_id: it.product_id ?? null,
              sku: it.sku,
              name: it.name,
              description: it.description,
              image_url: it.image_url,
              remark_image_url: it.remark_image_url ?? null,
              specification: it.specification ?? null,
              weight_g: it.weight_g ?? null,
              unit: it.unit,
              unit_price: it.unit_price,
              currency: pi.currency,
              quantity: it.quantity,
            }))

          const customer: Customer | null = pi.customer_snapshot
            ? {
                id: pi.customer_id ?? '',
                name: pi.customer_snapshot.name,
                company: pi.customer_snapshot.company,
                email: pi.customer_snapshot.email,
                phone: pi.customer_snapshot.phone,
                address: pi.customer_snapshot.address,
                city: pi.customer_snapshot.city ?? null,
                state: pi.customer_snapshot.state ?? null,
                postal_code: pi.customer_snapshot.postal_code ?? null,
                country: pi.customer_snapshot.country,
                contact_person: pi.customer_snapshot.contact_person,
                group_id: null,
                created_by: null,
                created_at: '',
                updated_at: '',
              }
            : null

          return {
            items,
            charges: {
              tax_rate: pi.tax_rate,
              shipping_fee: pi.shipping_fee,
              discount: pi.discount,
            },
            currency: pi.currency,
            notes: pi.notes ?? '',
            terms: pi.terms ?? '',
            shippingMethod: pi.shipping_method ?? '',
            showSpecification: pi.show_specification ?? true,
            showWeight: pi.show_weight ?? false,
            customer,
          }
        }),

      has: (productId) => get().items.some((i) => i.product_id === productId),

      countOf: (productId) =>
        get().items.filter((i) => i.product_id === productId).length,

      reset: () =>
        set({
          items: [],
          charges: defaultCharges,
          currency: 'USD',
          notes: '',
          customer: null,
          terms: '',
          shippingMethod: '',
          showSpecification: true,
          showWeight: false,
        }),
    }),
    {
      name: 'pi-cart',
      version: 2,
      // v1 carts (before duplicate-line support) lack line_id and may hold
      // synthetic "clone-*" product ids; patch them so the UI keys stay stable.
      migrate: (persisted) => {
        const state = persisted as Partial<PiCartState> | undefined
        if (state?.items) {
          state.items = state.items.map((i) => ({
            ...i,
            line_id: i.line_id ?? newLineId(),
            product_id:
              i.product_id && UUID_RE.test(i.product_id) ? i.product_id : null,
          }))
        }
        return state as PiCartState
      },
    },
  ),
)
