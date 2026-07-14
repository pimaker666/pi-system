import { z } from 'zod'

export const customerSchema = z.object({
  name: z.string().trim().min(1, '客户名称不能为空').max(200),
  company: z.string().trim().max(200).optional().or(z.literal('')),
  email: z.string().trim().email('邮箱格式错误').optional().or(z.literal('')),
  phone: z.string().trim().max(64).optional().or(z.literal('')),
  address: z.string().trim().max(1000).optional().or(z.literal('')),
  country: z.string().trim().max(100).optional().or(z.literal('')),
  contact_person: z.string().trim().max(200).optional().or(z.literal('')),
  group_id: z.string().uuid().optional().nullable().or(z.literal('')),
})

export const customerGroupSchema = z.object({
  name: z.string().trim().min(1, '分组名称不能为空').max(100),
  description: z.string().trim().max(500).optional().or(z.literal('')),
})

export type CustomerInput = z.infer<typeof customerSchema>
export type CustomerGroupInput = z.infer<typeof customerGroupSchema>
