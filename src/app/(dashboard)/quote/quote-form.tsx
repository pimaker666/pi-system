'use client'

import { useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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

/** Fields that belong to the packaging / printing group; everything else is product spec. */
const PACK_KEYS = new Set(['colorBox', 'innerTray', 'piecesPerBox', 'colors', 'plateColors', 'print', 'packMode'])

/** Number inputs keep a string draft so typing / clearing never fights the parser. */
function NumberField({
  field,
  value,
  emphasis,
  onCommit,
}: {
  field: FormField
  value: number
  emphasis?: boolean
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
    <div className="relative">
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
        className={cn(
          'h-10 rounded-lg pr-14 font-mono font-semibold tabular-nums',
          emphasis ? 'text-[17px] tracking-wide' : 'text-[13.5px]',
        )}
      />
      {field.datalist && (
        <datalist id={`qf-${field.key}-list`}>
          {field.datalist.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
      )}
      <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-muted-foreground">
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

  const qtyFields = fields.filter((f) => f.key === cat.qtyKey)
  const packFields = fields.filter((f) => f.key !== cat.qtyKey && PACK_KEYS.has(f.key))
  const specFields = fields.filter((f) => f.key !== cat.qtyKey && !PACK_KEYS.has(f.key))
  const groups = [
    { id: 'spec', title: '产品规格', fields: specFields },
    { id: 'order', title: '订量与档位', fields: qtyFields },
    { id: 'pack', title: '包装与印刷', fields: packFields },
  ].filter((g) => g.fields.length > 0)

  const renderField = (f: FormField) => {
    const isQty = f.key === cat.qtyKey
    return (
      <div key={f.key} className="flex items-start gap-3 px-3.5 py-3">
        <div className="flex w-[104px] shrink-0 flex-col gap-0.5 pt-2.5">
          <label className="text-[12.5px] font-semibold leading-tight" htmlFor={`qf-${f.key}`}>
            {f.label}
          </label>
          <span className="text-[9px] leading-tight tracking-[.05em] text-muted-foreground/60">
            {f.labelEn}
          </span>
        </div>

        <div className="min-w-0 flex-1">
        {f.type === 'select' ? (
          <Select
            value={String(input[f.key] ?? '')}
            onValueChange={(v) => onChange(f.key, NUMERIC_KEYS.has(f.key) ? Number(v) : v)}
          >
            <SelectTrigger id={`qf-${f.key}`} className="h-10 rounded-lg text-[13px]">
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
            emphasis={isQty}
            onCommit={(v) => onChange(f.key, v)}
          />
        )}

        {f.presets && f.presets.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {f.presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => onChange(f.key, p)}
                className={cn(
                  'rounded-full border px-2.5 py-0.5 font-mono text-[10.5px] leading-5 transition-colors',
                  Number(input[f.key]) === p
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-primary',
                )}
              >
                {p.toLocaleString('en-US')}
              </button>
            ))}
          </div>
        )}

        {f.hint && (
          <p className="mt-2 border-l-2 border-border pl-2 text-[10.5px] leading-relaxed text-muted-foreground">
            {f.hint}
          </p>
        )}
        </div>
      </div>
    )
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <div className="text-[14px] font-semibold">参数录入</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {cat.cn} · {cat.en}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] font-normal text-muted-foreground"
          onClick={onReset}
          title="重置本页参数"
        >
          <RotateCcw className="h-3 w-3" />
          重置
        </Button>
      </div>

      <div className="space-y-3 px-4 py-4">
        {groups.map((g) => (
          <section key={g.id} className="overflow-hidden rounded-lg border bg-card">
            <div className="flex items-center gap-2 border-b bg-muted px-3.5 py-2">
              <span className="h-3 w-[3px] rounded-full bg-primary/70" />
              <span className="text-[11px] font-semibold tracking-[.1em] text-foreground/75">
                {g.title}
              </span>
            </div>
            <div className="divide-y divide-[hsl(214_16%_84%)]">{g.fields.map(renderField)}</div>
          </section>
        ))}

        <div className="overflow-hidden rounded-lg border bg-card">
          <div className="flex items-center gap-2 border-b bg-muted px-3.5 py-2">
            <span className="h-3 w-[3px] rounded-full bg-primary/70" />
            <span className="text-[11px] font-semibold tracking-[.1em] text-foreground/75">
              目标毛利率
            </span>
            <span className="ml-auto text-[9px] tracking-[.06em] text-muted-foreground/60">
              Target margin
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 px-3.5 pt-3">
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
              <span className="font-mono text-[15px] font-semibold text-primary">{pct(auto)}</span>
            )}
          </div>
          <p className="px-3.5 pb-3 pt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
            官方自动毛利：{pct(auto)}
            {manual != null ? ' · 已改为手动值，阶梯表仍按官方档位测算' : '（随订量档位自动切换）'}
          </p>
        </div>
      </div>
    </div>
  )
}
