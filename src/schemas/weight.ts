import { z } from 'zod'

export const weightCalcItemSchema = z.object({
  product_id: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  name: z.string().min(1),
  image_url: z.string().nullable().optional(),
  weight_g: z.coerce.number().min(0, '克重不能为负').default(0),
  quantity: z.coerce.number().min(0, '数量不能为负').default(0),
})

export const createWeightCalcSchema = z.object({
  title: z.string().trim().max(200).optional().or(z.literal('')),
  source_pi_id: z.string().uuid().nullable().optional(),
  items: z.array(weightCalcItemSchema).min(1, '至少添加一个产品'),
})

export type CreateWeightCalcInput = z.infer<typeof createWeightCalcSchema>
export type WeightCalcItemInput = z.infer<typeof weightCalcItemSchema>
