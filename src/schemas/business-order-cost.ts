import { z } from 'zod'

export const businessOrderCostFilterSchema = z.object({
  q: z.string().trim().max(200).optional().default(''),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  shops: z.array(z.string().uuid()).optional().default([]),
  salespeople: z.array(z.string().uuid()).optional().default([]),
  shopGroups: z.array(z.string().uuid()).optional().default([]),
})

export type BusinessOrderCostFilters = z.infer<typeof businessOrderCostFilterSchema>
