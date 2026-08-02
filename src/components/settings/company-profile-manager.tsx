'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import { toast } from 'sonner'
import { Plus, Pencil, Trash2, CheckCircle2 } from 'lucide-react'
import {
  createCompanyProfile,
  updateCompanyProfile,
  deleteCompanyProfile,
  setActiveCompanyProfile,
} from '@/lib/actions/company'
import { useImageUpload } from '@/lib/hooks/use-image-upload'
import { toImageSrc } from '@/lib/supabase/image'
import { AccentColorField } from '@/components/settings/accent-color-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import type { CompanyProfile, CompanySettings } from '@/types'

export function CompanyProfileManager({
  profiles,
  defaultCompany,
}: {
  profiles: CompanyProfile[]
  defaultCompany?: CompanySettings | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<CompanyProfile | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CompanyProfile | null>(null)

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(profile: CompanyProfile) {
    setEditing(profile)
    setFormOpen(true)
  }

  function handleActivate(profile: CompanyProfile) {
    if (profile.is_active) return
    startTransition(async () => {
      const result = await setActiveCompanyProfile(profile.id)
      if (result.ok) {
        toast.success(`已切换为「${profile.label}」`)
        router.refresh()
      } else {
        toast.error(result.error ?? '切换失败')
      }
    })
  }

  function handleDelete() {
    if (!deleteTarget) return
    const target = deleteTarget
    startTransition(async () => {
      const result = await deleteCompanyProfile(target.id)
      if (result.ok) {
        toast.success('公司信息已删除')
        setDeleteTarget(null)
        router.refresh()
      } else {
        toast.error(result.error ?? '删除失败')
      }
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium">我的公司信息</h2>
          <p className="text-sm text-muted-foreground">
            每个账号可保存多份公司信息，选择「生效中」的那份用于生成 PI。仅对你的账号生效。
          </p>
        </div>
        <Button onClick={openCreate} disabled={pending}>
          <Plus className="mr-1 h-4 w-4" />
          新增公司
        </Button>
      </div>

      {profiles.length === 0 ? (
        <Card>
          {defaultCompany ? (
            <CardContent className="space-y-4 py-6">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">系统默认公司信息</p>
                    <Badge variant="secondary" className="shrink-0">
                      当前生效
                    </Badge>
                  </div>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {defaultCompany.company_name}
                  </p>
                  {defaultCompany.address && (
                    <p className="truncate text-sm text-muted-foreground">{defaultCompany.address}</p>
                  )}
                  {defaultCompany.email && (
                    <p className="truncate text-sm text-muted-foreground">{defaultCompany.email}</p>
                  )}
                  {defaultCompany.bank_name && (
                    <p className="truncate text-sm text-muted-foreground">
                      开户行：{defaultCompany.bank_name}
                    </p>
                  )}
                </div>
                {defaultCompany.logo_url && (
                  <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded border bg-white">
                    <Image
                      src={toImageSrc(defaultCompany.logo_url)}
                      alt={defaultCompany.company_name}
                      fill
                      className="object-contain"
                      sizes="64px"
                    />
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                你还没有自己的公司信息，当前生成的 PI 会使用上面这份系统默认。你可以基于它创建一份属于自己的，之后的修改只对你的账号生效，不影响他人。
              </p>
              <Button onClick={openCreate} disabled={pending}>
                <Plus className="mr-1 h-4 w-4" />
                以系统默认为基础创建
              </Button>
            </CardContent>
          ) : (
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              你还没有添加公司信息。新增前，生成的 PI 会使用系统默认公司信息。
            </CardContent>
          )}
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {profiles.map((profile) => (
            <Card key={profile.id} className={profile.is_active ? 'border-primary' : undefined}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
                <div className="min-w-0">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <span className="truncate">{profile.label}</span>
                    {profile.is_active && (
                      <Badge variant="success" className="shrink-0">
                        生效中
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {profile.company_name}
                  </p>
                </div>
                {profile.logo_url && (
                  <div className="relative h-10 w-16 shrink-0 overflow-hidden rounded border bg-white">
                    <Image
                      src={toImageSrc(profile.logo_url)}
                      alt={profile.label}
                      fill
                      className="object-contain"
                      sizes="64px"
                    />
                  </div>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="space-y-0.5 text-sm text-muted-foreground">
                  {profile.address && <p className="truncate">{profile.address}</p>}
                  {profile.email && <p className="truncate">{profile.email}</p>}
                  {profile.bank_name && <p className="truncate">开户行：{profile.bank_name}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant={profile.is_active ? 'secondary' : 'default'}
                    onClick={() => handleActivate(profile)}
                    disabled={pending || profile.is_active}
                  >
                    <CheckCircle2 className="mr-1 h-4 w-4" />
                    {profile.is_active ? '已生效' : '设为生效'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => openEdit(profile)}
                    disabled={pending}
                  >
                    <Pencil className="mr-1 h-4 w-4" />
                    编辑
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDeleteTarget(profile)}
                    disabled={pending}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    删除
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CompanyProfileForm
        key={editing?.id ?? 'new'}
        open={formOpen}
        onOpenChange={setFormOpen}
        profile={editing}
        defaultCompany={defaultCompany}
      />

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{deleteTarget?.label}」？</AlertDialogTitle>
            <AlertDialogDescription>
              删除后不可恢复。若删除的是生效中的公司，后续开单会回退到系统默认公司信息。已生成的
              PI 不受影响。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} disabled={pending}>
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CompanyProfileForm({
  open,
  onOpenChange,
  profile,
  defaultCompany,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: CompanyProfile | null
  defaultCompany?: CompanySettings | null
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // When creating a new profile, pre-fill shared fields from the system default
  // so the user starts from the default company info and only tweaks what differs.
  const src = profile ?? defaultCompany ?? null
  const [logoUrl, setLogoUrl] = useState(src?.logo_url ?? '')
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
      const result = profile
        ? await updateCompanyProfile(profile.id, formData)
        : await createCompanyProfile(formData)
      if (result.ok) {
        toast.success(profile ? '公司信息已更新' : '公司信息已添加')
        onOpenChange(false)
        router.refresh()
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{profile ? '编辑公司信息' : '新增公司信息'}</DialogTitle>
        </DialogHeader>

        <form action={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="label">档案名 *</Label>
            <Input
              id="label"
              name="label"
              placeholder="便于区分，如「主体公司」「香港公司」"
              defaultValue={profile?.label ?? defaultCompany?.company_name ?? ''}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="company_name">公司名称 *</Label>
            <Input
              id="company_name"
              name="company_name"
              defaultValue={src?.company_name ?? ''}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="address">地址</Label>
            <Textarea id="address" name="address" rows={2} defaultValue={src?.address ?? ''} />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="phone">电话</Label>
              <Input id="phone" name="phone" defaultValue={src?.phone ?? ''} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">邮箱</Label>
              <Input id="email" name="email" type="email" defaultValue={src?.email ?? ''} />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="website">网站</Label>
            <Input id="website" name="website" defaultValue={src?.website ?? ''} />
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

          <AccentColorField defaultValue={src?.accent_color ?? undefined} logoUrl={logoUrl || undefined} />

          <div className="space-y-3 rounded-md border p-4">
            <p className="text-sm font-medium">银行信息（用于 PI 收款）</p>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bank_name">银行名称</Label>
                <Input id="bank_name" name="bank_name" defaultValue={src?.bank_name ?? ''} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank_account">账号</Label>
                <Input
                  id="bank_account"
                  name="bank_account"
                  defaultValue={src?.bank_account ?? ''}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bank_swift">SWIFT</Label>
                <Input id="bank_swift" name="bank_swift" defaultValue={src?.bank_swift ?? ''} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bank_address">银行地址</Label>
                <Input
                  id="bank_address"
                  name="bank_address"
                  defaultValue={src?.bank_address ?? ''}
                />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="default_terms">默认条款</Label>
            <Textarea
              id="default_terms"
              name="default_terms"
              rows={3}
              placeholder="例如：50% 预付款，余款发货前结清；报价有效期 30 天。"
              defaultValue={src?.default_terms ?? ''}
            />
          </div>

          <DialogFooter>
            <Button type="submit" disabled={pending || uploading}>
              {pending ? '保存中…' : profile ? '保存修改' : '添加公司'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
