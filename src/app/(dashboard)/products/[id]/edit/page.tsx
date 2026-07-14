import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import { ProductForm } from '@/components/products/product-form'
import type { Product } from '@/types'

export default async function EditProductPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAdmin()
  const { id } = await params
  const supabase = await createClient()
  const { data } = await supabase.from('products').select('*').eq('id', id).single()
  if (!data) notFound()

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">编辑产品</h1>
      <ProductForm product={data as Product} />
    </div>
  )
}
