import { z } from 'zod'

export const companySchema = z.object({
  company_name: z.string().trim().min(1, '公司名称不能为空').max(200),
  address: z.string().trim().max(1000).optional().or(z.literal('')),
  phone: z.string().trim().max(64).optional().or(z.literal('')),
  email: z.string().trim().email('邮箱格式错误').optional().or(z.literal('')),
  website: z.string().trim().max(200).optional().or(z.literal('')),
  logo_url: z.string().url('Logo 地址无效').optional().or(z.literal('')),
  accent_color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, '品牌色需为 #RRGGBB 格式')
    .optional()
    .or(z.literal('')),
  bank_name: z.string().trim().max(200).optional().or(z.literal('')),
  bank_account: z.string().trim().max(100).optional().or(z.literal('')),
  bank_swift: z.string().trim().max(50).optional().or(z.literal('')),
  bank_address: z.string().trim().max(500).optional().or(z.literal('')),
  default_terms: z.string().trim().max(4000).optional().or(z.literal('')),
})

export type CompanyInput = z.infer<typeof companySchema>

export const companyProfileSchema = companySchema.extend({
  label: z.string().trim().min(1, '档案名不能为空').max(100),
})

export type CompanyProfileInput = z.infer<typeof companyProfileSchema>
