'use client'

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { PiLineItem, PiCharges, CurrencyCode, Product } from '@/types'

interface PiCartState {
  items: PiLineItem[]
  charges: PiCharges
  currency: CurrencyCode
  notes: string
  addProduct: (product: Product, quantity?: number) => void
  removeProduct: (productId: string) => void
  setQuantity: (productId: string, quantity: number) => void
  setCharges: (charges: Partial<PiCharges>) => void
  setNotes: (notes: string) => void
  has: (productId: string) => boolean
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

      addProduct: (product, quantity = 1) =>
        set((state) => {
          if (state.items.some((i) => i.product_id === product.id)) {
            return state
          }
          const nextItem: PiLineItem = {
            product_id: product.id,
            sku: product.sku,
            name: product.name,
            description: product.description,
            unit: product.unit,
            unit_price: product.unit_price,
            currency: product.currency,
            quantity,
          }
          // First item locks the PI currency.
          const currency = state.items.length === 0 ? product.currency : state.currency
          return { items: [...state.items, nextItem], currency }
        }),

      removeProduct: (productId) =>
        set((state) => {
          const items = state.items.filter((i) => i.product_id !== productId)
          const currency = items.length === 0 ? 'USD' : state.currency
          return { items, currency }
        }),

      setQuantity: (productId, quantity) =>
        set((state) => ({
          items: state.items.map((i) =>
            i.product_id === productId
              ? { ...i, quantity: Math.max(1, Math.floor(quantity) || 1) }
              : i,
          ),
        })),

      setCharges: (charges) =>
        set((state) => ({ charges: { ...state.charges, ...charges } })),

      setNotes: (notes) => set({ notes }),

      has: (productId) => get().items.some((i) => i.product_id === productId),

      reset: () => set({ items: [], charges: defaultCharges, currency: 'USD', notes: '' }),
    }),
    { name: 'pi-cart' },
  ),
)
