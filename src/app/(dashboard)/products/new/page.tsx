import { requireAdmin } from '@/lib/auth'
import { ProductForm } from '@/components/products/product-form'

export default async function NewProductPage() {
  await requireAdmin()
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">新增产品</h1>
      <ProductForm />
    </div>
  )
}
