'use client'

import { useState, useTransition, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { Sparkles, MapPin } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createCustomer, updateCustomer } from '@/lib/actions/customers'
import { parseCustomerText } from '@/lib/parse-customer'
import { usePostalLookup, type PostalResult } from '@/hooks/use-postal-lookup'
import type { Customer, CustomerGroup } from '@/types'

const NO_GROUP = '__none__'

interface CustomerFormProps {
  customer?: Customer
  groups: CustomerGroup[]
  onSuccess?: (id?: string) => void
}

interface FormState {
  name: string
  company: string
  contact_person: string
  country: string
  email: string
  phone: string
  address: string
  city: string
  state: string
  postal_code: string
}

export function CustomerFormFields({ customer, groups, onSuccess }: CustomerFormProps) {
  const [pending, startTransition] = useTransition()
  const [groupId, setGroupId] = useState(customer?.group_id ?? NO_GROUP)

  const [form, setForm] = useState<FormState>({
    name: customer?.name ?? '',
    company: customer?.company ?? '',
    contact_person: customer?.contact_person ?? '',
    country: customer?.country ?? '',
    email: customer?.email ?? '',
    phone: customer?.phone ?? '',
    address: customer?.address ?? '',
    city: customer?.city ?? '',
    state: customer?.state ?? '',
    postal_code: customer?.postal_code ?? '',
  })

  const [showPaste, setShowPaste] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [showCitySuggestions, setShowCitySuggestions] = useState(false)
  const [showPostalSuggestions, setShowPostalSuggestions] = useState(false)
  const cityRef = useRef<HTMLDivElement>(null)
  const postalRef = useRef<HTMLDivElement>(null)

  const { cityResults, postalResults, lookupByCity, lookupByPostal, parseAddress, clearResults } =
    usePostalLookup({ country: form.country })

  function update(field: keyof FormState, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  // Auto-lookup when city changes
  function handleCityChange(value: string) {
    update('city', value)
    if (value.length >= 2 && form.country) {
      lookupByCity(value)
      setShowCitySuggestions(true)
    } else {
      setShowCitySuggestions(false)
    }
  }

  // Auto-lookup when postal code changes
  function handlePostalChange(value: string) {
    update('postal_code', value)
    if (value.length >= 3 && form.country) {
      lookupByPostal(value)
      setShowPostalSuggestions(true)
    } else {
      setShowPostalSuggestions(false)
    }
  }

  // Select a suggestion from city lookup -> fill postal code
  function selectCitySuggestion(result: PostalResult) {
    setForm((prev) => ({
      ...prev,
      city: result.place_name,
      postal_code: result.postal_code,
      state: result.state_name || prev.state,
    }))
    setShowCitySuggestions(false)
    clearResults()
  }

  // Select a suggestion from postal lookup -> fill city/state
  function selectPostalSuggestion(result: PostalResult) {
    setForm((prev) => ({
      ...prev,
      postal_code: result.postal_code,
      city: result.place_name,
      state: result.state_name || prev.state,
    }))
    setShowPostalSuggestions(false)
    clearResults()
  }

  // Auto-detect postal code from address field on blur
  async function handleAddressBlur() {
    if (!form.address || form.postal_code) return
    const result = await parseAddress(form.address)
    if (result?.postal_code) {
      setForm((prev) => ({
        ...prev,
        postal_code: result.postal_code || prev.postal_code,
        city: result.city || prev.city,
        state: result.state || prev.state,
      }))
      toast.success('已从地址中识别邮编')
    }
  }

  // Close suggestions on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (cityRef.current && !cityRef.current.contains(e.target as Node)) {
        setShowCitySuggestions(false)
      }
      if (postalRef.current && !postalRef.current.contains(e.target as Node)) {
        setShowPostalSuggestions(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  function handleRecognize() {
    const parsed = parseCustomerText(pasteText)
    const keys = Object.keys(parsed) as (keyof typeof parsed)[]
    if (keys.length === 0) {
      toast.error('未识别到任何信息，请检查粘贴内容')
      return
    }
    setForm((prev) => {
      const next = { ...prev }
      for (const k of keys) {
        const v = parsed[k]
        if (v && k in next) (next as Record<string, string>)[k] = v
      }
      return next
    })
    toast.success(`已识别并填入：${keys.length} 项`)
  }

  function handleSubmit(formData: FormData) {
    formData.set('group_id', groupId === NO_GROUP ? '' : groupId)
    startTransition(async () => {
      const result = customer
        ? await updateCustomer(customer.id, formData)
        : await createCustomer(formData)
      if (result.ok) {
        toast.success(customer ? '客户已更新' : '客户已创建')
        onSuccess?.(result.id)
      } else {
        toast.error(result.error ?? '保存失败')
      }
    })
  }

  return (
    <form action={handleSubmit} className="space-y-4">
      <div className="space-y-2 rounded-md border border-dashed bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-1.5 text-sm">
            <Sparkles className="h-4 w-4" />
            智能识别
          </Label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowPaste((v) => !v)}
          >
            {showPaste ? '收起' : '粘贴一段信息自动填入'}
          </Button>
        </div>
        {showPaste && (
          <div className="space-y-2">
            <Textarea
              rows={5}
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={
                '把客户的完整信息粘贴到这里，例如：\n公司: ABC Trading Co., Ltd.\n联系人: John Smith\n邮箱: john@abc.com\n电话: +1 555 123 4567\n地址: 123 Main Street, New York, NY 10001, USA'
              }
            />
            <div className="flex gap-2">
              <Button type="button" size="sm" onClick={handleRecognize}>
                识别并填入
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPasteText('')}
              >
                清空
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              识别后请核对下方字段，可手动修改。支持自动识别邮编。
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="name">客户名称 *</Label>
          <Input
            id="name"
            name="name"
            value={form.name}
            onChange={(e) => update('name', e.target.value)}
            required
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="company">公司</Label>
          <Input
            id="company"
            name="company"
            value={form.company}
            onChange={(e) => update('company', e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="contact_person">联系人</Label>
          <Input
            id="contact_person"
            name="contact_person"
            value={form.contact_person}
            onChange={(e) => update('contact_person', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="country">国家/地区</Label>
          <Input
            id="country"
            name="country"
            value={form.country}
            onChange={(e) => update('country', e.target.value)}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            name="email"
            type="email"
            value={form.email}
            onChange={(e) => update('email', e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">电话</Label>
          <Input
            id="phone"
            name="phone"
            value={form.phone}
            onChange={(e) => update('phone', e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="address">地址</Label>
        <Textarea
          id="address"
          name="address"
          rows={2}
          value={form.address}
          onChange={(e) => update('address', e.target.value)}
          onBlur={handleAddressBlur}
        />
      </div>

      {/* City / State / Postal Code row */}
      <div className="grid grid-cols-3 gap-3">
        <div className="relative space-y-2" ref={cityRef}>
          <Label htmlFor="city" className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            城市
          </Label>
          <Input
            id="city"
            name="city"
            value={form.city}
            onChange={(e) => handleCityChange(e.target.value)}
            onFocus={() => { if (cityResults.length) setShowCitySuggestions(true) }}
            placeholder="输入城市自动匹配邮编"
            autoComplete="off"
          />
          {showCitySuggestions && cityResults.length > 0 && (
            <div className="absolute top-full left-0 z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
              {cityResults.map((r, i) => (
                <button
                  key={`${r.postal_code}-${i}`}
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-accent flex justify-between"
                  onClick={() => selectCitySuggestion(r)}
                >
                  <span>{r.place_name}</span>
                  <span className="text-muted-foreground">{r.postal_code}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="state">州/省</Label>
          <Input
            id="state"
            name="state"
            value={form.state}
            onChange={(e) => update('state', e.target.value)}
          />
        </div>

        <div className="relative space-y-2" ref={postalRef}>
          <Label htmlFor="postal_code" className="flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" />
            邮编
          </Label>
          <Input
            id="postal_code"
            name="postal_code"
            value={form.postal_code}
            onChange={(e) => handlePostalChange(e.target.value)}
            onFocus={() => { if (postalResults.length) setShowPostalSuggestions(true) }}
            placeholder="输入邮编自动匹配城市"
            autoComplete="off"
          />
          {showPostalSuggestions && postalResults.length > 0 && (
            <div className="absolute top-full left-0 z-50 mt-1 w-full max-h-48 overflow-y-auto rounded-md border bg-popover shadow-md">
              {postalResults.map((r, i) => (
                <button
                  key={`${r.postal_code}-${i}`}
                  type="button"
                  className="w-full px-3 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => selectPostalSuggestion(r)}
                >
                  <span className="font-medium">{r.postal_code}</span>
                  <span className="ml-2 text-muted-foreground">
                    {r.place_name}{r.state_name ? `, ${r.state_name}` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label>分组</Label>
        <Select value={groupId} onValueChange={setGroupId}>
          <SelectTrigger>
            <SelectValue placeholder="选择分组" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP}>未分组</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? '保存中…' : '保存'}
      </Button>
    </form>
  )
}
