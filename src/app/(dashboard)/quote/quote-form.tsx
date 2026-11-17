'use client'

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CATEGORIES, type CategoryId, type QuoteInput } from '@/lib/quote/data'
import { NUMERIC_KEYS, fieldsFor, type FormField } from '@/lib/quote/form'
import { pct } from '@/lib/quote/text'

/** Number inputs keep a string draft so typing / clearing never fights the parser. */
function NumberField({
  field,
  value,
  onCommit,
}: {
  field: FormField
  value: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(String(value))
  }
  const min = Math.max(1, field.min ?? 1)

  return (
    <div className="flex gap-2">
      <Input
        id={`qf-${field.key}`}
        inputMode="numeric"
        value={draft}
        min={min}
        list={field.datalist ? `qf-${field.key}-list` : undefined}
        aria-label={field.label}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d]/g, '')
          setDraft(raw)
          const n = Math.floor(Number(raw))
          // Commit only sane values while typing; the min bound is applied on blur so
          // that typing "5" toward "5000" is not rewritten to the 100-piece floor.
          if (raw !== '' && n >= 1) onCommit(Math.min(10_000_000, n))
        }}
        onBlur={() => {
          const n = Math.floor(Number(draft))
          const next =
            draft === '' || !Number.isFinite(n)
              ? value
              : Math.min(10_000_000, Math.max(min, n))
          setDraft(String(next))
          setSynced(next)
          if (next !== value) onCommit(next)
        }}
        className="font-mono text-[15px] font-semibold tracking-wide"
      />
      {field.datalist && (
        <datalist id={`qf-${field.key}-list`}>
          {field.datalist.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      )}
      <span className="flex shrink-0 items-center text-xs text-muted-foreground">
        {field.unit}
      </span>
    </div>
  )
}

/** Draft-backed percentage input: typing "35." or clearing never fights the parser. */
function MarginField({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const shown = Math.round(value * 1000) / 10
  const [draft, setDraft] = useState(String(shown))
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(String(Math.round(value * 1000) / 10))
  }

  return (
    <div className="flex items-center gap-1">
      <Input
        inputMode="decimal"
        aria-label="目标毛利率百分比"
        value={draft}
        onChange={(e) => {
          const raw = e.target.value.replace(/[^\d.]/g, '')
          setDraft(raw)
          const v = Number(raw)
          if (raw !== '' && Number.isFinite(v) && v <= 94) onChange(Math.round(v * 10) / 1000)
        }}
        onBlur={() => {
          const v = Number(draft)
          const pv = Number.isFinite(v) && draft !== '' ? Math.min(94, Math.max(0, v)) : shown
          const next = pv / 100
          setDraft(String(pv))
          setSynced(next)
          if (next !== value) onChange(next)
        }}
        className="h-8 w-20 font-mono text-sm"
      />
      <span className="text-xs text-muted-foreground">%</span>
    </div>
  )
}

export function QuoteForm({
  categoryId,
  input,
  auto,
  manual,
  onChange,
  onManualChange,
  onReset,
}: {
  categoryId: CategoryId
  input: QuoteInput
  auto: number
  manual: number | null
  onChange: (key: string, value: string | number) => void
  onManualChange: (v: number | null) => void
  onReset: () => void
}) {
  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  const fields = fieldsFor(categoryId, input).filter((f) => !f.visible || f.visible(input))
  const shown = manual == null ? auto : manual

  return (
    <div className="rounded-lg border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="text-[13px] font-semibold">参数录入</div>
        <div className="text-[11px] text-muted-foreground">
          {cat.cn} · {cat.en}
        </div>
      </div>

      <div className="px-4 pb-4">
        {fields.map((f) => (
          <div key={f.key} className="border-b border-dashed py-3 last:border-0">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <label className="text-[12.5px] font-semibold" htmlFor={`qf-${f.key}`}>
                {f.label}
              </label>
              <span className="text-[9.5px] uppercase tracking-[.35px] text-muted-foreground">
                {f.labelEn}
              </span>
            </div>

            {f.type === 'select' ? (
              <Select
                value={String(input[f.key] ?? '')}
                onValueChange={(v) => onChange(f.key, NUMERIC_KEYS.has(f.key) ? Number(v) : v)}
              >
                <SelectTrigger id={`qf-${f.key}`} className="h-9">
                  <SelectValue placeholder="请选择" />
                </SelectTrigger>
                <SelectContent>
                  {(f.options ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <NumberField
                field={f}
                value={Number(input[f.key] ?? 0)}
                onCommit={(v) => onChange(f.key, v)}
              />
            )}

            {f.presets && f.presets.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {f.presets.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => onChange(f.key, p)}
                    className={cn(
                      'rounded-full border px-2.5 py-1 font-mono text-[10.5px] transition-colors',
                      Number(input[f.key]) === p
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'bg-background text-muted-foreground hover:border-primary/30 hover:text-primary',
                    )}
                  >
                    {p.toLocaleString('en-US')}
                  </button>
                ))}
              </div>
            )}

            {f.hint && (
              <p className="mt-1.5 text-[10.8px] leading-relaxed text-muted-foreground">{f.hint}</p>
            )}
          </div>
        ))}

        <div className="pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[12.5px] font-semibold">目标毛利率</span>
            <span className="text-[9.5px] uppercase tracking-[.35px] text-muted-foreground">
              Target margin
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-primary"
                checked={manual != null}
                onChange={(e) => onManualChange(e.target.checked ? shown : null)}
              />
              手动指定
            </label>
            {manual != null ? (
              <MarginField value={manual} onChange={onManualChange} />
            ) : (
              <span className="font-mono text-sm font-semibold text-primary">{pct(auto)}</span>
            )}
          </div>
          <p className="mt-1.5 text-[10.8px] leading-relaxed text-muted-foreground">
            官方自动毛利：{pct(auto)}
            {manual != null ? ' · 已改为手动值，阶梯表仍按官方档位测算' : '（随订量档位自动切换）'}
          </p>
        </div>

        <div className="flex items-center justify-between pt-4">
          <Badge variant="muted" className="font-normal">
            {fields.length} 项参数
          </Badge>
          <Button variant="outline" size="sm" onClick={onReset}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" />
            重置本页
          </Button>
        </div>
      </div>
    </div>
  )
}
