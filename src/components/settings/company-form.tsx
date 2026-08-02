'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { toast } from 'sonner'
import { upsertCompanySettings } from '@/lib/actions/company'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { toImageSrc } from '@/lib/supabase/image'
import { AccentColorField } from '@/components/settings/accent-color-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { CompanySettings } from '@/types'

export function CompanyForm({ settings }: { settings: CompanySettings | null }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [logoUrl, setLogoUrl] = useState(settings?.logo_url ?? '')
  const { upload, uploading } = useImageUpload({ bucket: 'company-assets' })

  async function handleLogo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const url = await upload(file)
      setLogoUrl(url)
      toast.success('Logo 已上传')
    } catch {
      toast.error('Logo 上传失败')
    }
  }

  function handleSubmit(formData: FormData) {
    formData.set('logo_url', logoUrl)
    startTransition(async () => {
      const result = await upsertCompanySettings(formData)
      if (result.ok) {
        toast.success('公司信息已保存')
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <form action={handleSubmit} className="max-w-3xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="company_name">公司名称 *</Label>
            <Input
              id="company_name"
              name="company_name"
              defaultValue={settings?.company_name}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="address">地址</Label>
            <Textarea id="address" name="address" rows={2} defaultValue={settings?.address ?? ''} />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="phone">电话</Label>
              <Input id="phone" name="phone" defaultValue={settings?.phone ?? ''} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input id="email" name="email" type="email" defaultValue={settings?.email ?? ''} />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="website">网站</Label>
            <Input id="website" name="website" defaultValue={settings?.website ?? ''} />
          </div>

          <div className="space-y-2">
            <Label htmlFor="logo">Logo</Label>
            <Input id="logo" type="file" accept="image/*" onChange={handleLogo} disabled={uploading} />
            {uploading && <p className="text-sm text-muted-foreground">上传中…</p>}
            {logoUrl && (
              <div className="relative mt-2 h-20 w-40 overflow-hidden rounded-md border bg-white">
                <Image src={toImageSrc(logoUrl)} alt="Logo" fill className="object-contain" sizes="160px" />
              </div>
            )}
          </div>

          <AccentColorField defaultValue={settings?.accent_color} logoUrl={logoUrl || undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">银行信息（用于 PI 收款）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bank_name">银行名称</Label>
              <Input id="bank_name" name="bank_name" defaultValue={settings?.bank_name ?? ''} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bank_account">账号</Label>
              <Input
                id="bank_account"
                name="bank_account"
                defaultValue={settings?.bank_account ?? ''}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="bank_swift">SWIFT</Label>
              <Input id="bank_swift" name="bank_swift" defaultValue={settings?.bank_swift ?? ''} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="bank_address">银行地址</Label>
              <Input
                id="bank_address"
                name="bank_address"
                defaultValue={settings?.bank_address ?? ''}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">默认条款</CardTitle>
        </CardHeader>
        <CardContent>
          <Textarea
            name="default_terms"
            rows={4}
            placeholder="例如：50% 预付款，余款发货前结清；报价有效期 30 天。"
            defaultValue={settings?.default_terms ?? ''}
          />
        </CardContent>
      </Card>

      <Button type="submit" disabled={pending || uploading}>
        {pending ? '保存中…' : '保存设置'}
      </Button>
    </form>
  )
}
