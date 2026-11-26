'use client'

import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { ArrowLeft, Braces, Eye, Loader2, Plus, RotateCcw, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  CATEGORIES,
  applyQuoteOverrides,
  deepMerge,
  defaultsFor,
  quoteDefaults,
  type CategoryId,
  type QuoteOverrides,
} from '@/lib/quote/data'
import { compute, type QuoteResult } from '@/lib/quote/engine'
import { saveQuoteParams } from '@/lib/actions/quote-params'
import { cn } from '@/lib/utils'

type TabId = 'globals' | CategoryId

const fmt2 = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function hasAnyOverride(ov: QuoteOverrides): boolean {
  return Object.values(ov).some((v) => v !== undefined && v !== null)
}

// ---------------------------------------------------------------- primitives

function Row({ label, en, children }: { label: string; en?: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <div className="flex w-[136px] shrink-0 flex-col gap-0.5">
        <span className="text-[12.5px] font-semibold leading-tight">{label}</span>
        {en && (
          <span className="text-[9px] leading-tight tracking-[.05em] text-muted-foreground/60">
            {en}
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function Section({
  title,
  en,
  children,
}: {
  title: string
  en?: string
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b bg-muted px-3.5 py-2">
        <span className="h-3 w-[3px] rounded-full bg-primary/70" />
        <span className="text-[11px] font-semibold tracking-[.1em] text-foreground/75">
          {title}
        </span>
        {en && (
          <span className="ml-auto text-[9px] tracking-[.06em] text-muted-foreground/60">
            {en}
          </span>
        )}
      </div>
      <div className="divide-y divide-[hsl(214_16%_84%)]">{children}</div>
    </section>
  )
}

/** Draft-backed number cell: typing "1." or clearing never fights the parser. */
function Num({
  value,
  onCommit,
  allowInf,
  className,
}: {
  value: number
  onCommit: (v: number) => void
  allowInf?: boolean
  className?: string
}) {
  const shown = Number.isFinite(value) ? String(value) : ''
  const [draft, setDraft] = useState(shown)
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(Number.isFinite(value) ? String(value) : '')
  }
  return (
    <Input
      value={draft}
      inputMode="decimal"
      aria-label="数值"
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d.]/g, '')
        setDraft(raw)
        if (raw === '') {
          if (allowInf) onCommit(Infinity)
          return
        }
        const n = Number(raw)
        if (Number.isFinite(n)) onCommit(n)
      }}
      onBlur={() => {
        if (draft === '') {
          if (!allowInf) setDraft(shown)
          return
        }
        const n = Number(draft)
        if (!Number.isFinite(n)) setDraft(shown)
      }}
      className={cn('h-8 font-mono text-[12.5px] tabular-nums', className)}
    />
  )
}

function Txt({
  value,
  onCommit,
  className,
}: {
  value: string
  onCommit: (v: string) => void
  className?: string
}) {
  const [draft, setDraft] = useState(value)
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    setSynced(value)
    setDraft(value)
  }
  return (
    <Input
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value)
        onCommit(e.target.value)
      }}
      onBlur={() => setDraft(value)}
      className={cn('h-8 text-[12.5px]', className)}
    />
  )
}

function Sel({
  value,
  options,
  onChange,
}: {
  value: string
  options: string[]
  onChange: (v: string) => void
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8 text-[12.5px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>
            {o}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function Del({ onClick, title }: { onClick: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? '删除'}
      className="flex h-8 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-destructive"
    >
      <Trash2 className="h-3.5 w-3.5" />
    </button>
  )
}

function Add({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={onClick}>
      <Plus className="h-3 w-3" />
      {label}
    </Button>
  )
}

/** Price tier rows: [threshold, price]. asc rows may use ∞ (Infinity) threshold. */
function TierTable({
  rows,
  onChange,
  desc,
  thresholdLabel,
  unit,
}: {
  rows: readonly (readonly [number, number])[]
  onChange: (r: [number, number][]) => void
  desc?: boolean
  thresholdLabel: string
  unit?: string
}) {
  const list = rows.map((r) => [r[0], r[1]] as [number, number])
  const update = (i: number, col: 0 | 1, v: number) => {
    const next = list.map((r, j) => (j === i ? ([col === 0 ? v : r[0], col === 1 ? v : r[1]] as [number, number]) : r))
    onChange(next)
  }
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_1fr_28px] items-center gap-2 text-[10px] text-muted-foreground">
        <span>{thresholdLabel}</span>
        <span>单价{unit ? `（${unit}）` : ''}</span>
        <span />
      </div>
      {list.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
          <Num value={r[0]} allowInf={!desc} onCommit={(v) => update(i, 0, v)} />
          <Num value={r[1]} onCommit={(v) => update(i, 1, v)} />
          <Del onClick={() => onChange(list.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Add
        label="添加档位"
        onClick={() => onChange([...list, desc ? [0, 0] : [Infinity, 0]])}
      />
    </div>
  )
}

/** Volume tier labels: [qty, cn, en]. */
function TierMetaTable({
  rows,
  onChange,
}: {
  rows: readonly (readonly [number, string, string])[]
  onChange: (r: [number, string, string][]) => void
}) {
  const list = rows.map((r) => [r[0], r[1], r[2]] as [number, string, string])
  const update = (i: number, col: 0 | 1 | 2, v: string | number) => {
    const next = list.map((r, j) =>
      j === i ? ([col === 0 ? Number(v) : r[0], col === 1 ? String(v) : r[1], col === 2 ? String(v) : r[2]] as [number, string, string]) : r,
    )
    onChange(next)
  }
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[88px_1fr_1fr_28px] items-center gap-2 text-[10px] text-muted-foreground">
        <span>起订量</span>
        <span>名称</span>
        <span>英文</span>
        <span />
      </div>
      {list.map((r, i) => (
        <div key={i} className="grid grid-cols-[88px_1fr_1fr_28px] items-center gap-2">
          <Num value={r[0]} onCommit={(v) => update(i, 0, v)} />
          <Txt value={r[1]} onCommit={(v) => update(i, 1, v)} />
          <Txt value={r[2]} onCommit={(v) => update(i, 2, v)} />
          <Del onClick={() => onChange(list.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Add label="添加阶梯" onClick={() => onChange([...list, [0, '', '']])} />
    </div>
  )
}

const MEMBRANE_KINDS = ['jar', 'waterbag', 'gelbag', 'silicone']

// ------------------------------------------------------------------ manager

export function QuoteParamsManager({ saved, initialTab }: { saved: QuoteOverrides; initialTab?: TabId }) {
  const defaults = quoteDefaults()

  const [tab, setTab] = useState<TabId>(initialTab ?? 'mask')
  const [savedOv, setSavedOv] = useState<QuoteOverrides>(saved)
  const [draft, setDraft] = useState<QuoteOverrides>(() => {
    // Per-category deep merge so rows saved by older versions (missing newer
    // keys like costs) fall back to code defaults instead of breaking the form.
    const out: QuoteOverrides = {
      FX_DEFAULT: Number(saved.FX_DEFAULT) > 0 ? Number(saved.FX_DEFAULT) : defaults.FX_DEFAULT,
    }
    for (const c of CATEGORIES) {
      out[c.id] = deepMerge(structuredClone(defaults[c.id]), saved[c.id])
    }
    return out
  })
  const [jsonTab, setJsonTab] = useState<TabId | null>(null)
  const [jsonText, setJsonText] = useState('')
  const [preview, setPreview] = useState<{ before: (QuoteResult | null)[]; after: (QuoteResult | null)[] } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [newBottle, setNewBottle] = useState('')
  const [selBottle, setSelBottle] = useState('')
  const [newContainer, setNewContainer] = useState('')
  const [selContainer, setSelContainer] = useState('')

  const restoreSaved = () => applyQuoteOverrides(hasAnyOverride(savedOv) ? savedOv : null)

  const patchCat = (cat: CategoryId, fn: (d: Record<string, any>) => void) => {
    setDraft((prev) => {
      const next = { ...prev, [cat]: structuredClone(prev[cat]) }
      fn(next[cat] as Record<string, any>)
      return next
    })
  }

  const patchGlobals = (fn: (g: QuoteOverrides) => void) => {
    setDraft((prev) => {
      const next = { ...prev }
      fn(next)
      return next
    })
  }

  function runPreview() {
    setNotice(null)
    restoreSaved()
    const runAll = () =>
      CATEGORIES.map((c) => {
        try {
          return compute(c.id, defaultsFor(c.id), {})
        } catch (e) {
          return null
        }
      })
    const before = runAll()
    try {
      applyQuoteOverrides(draft)
    } catch (e) {
      restoreSaved()
      setNotice({ kind: 'error', text: `编辑值无法应用：${(e as Error).message}` })
      return
    }
    const after = runAll()
    restoreSaved()
    setPreview({ before, after })
  }

  async function handleSave() {
    setNotice(null)
    setSaving(true)
    try {
      const entries = [
        ...CATEGORIES.map((c) => ({
          category: c.id,
          overrides: (draft[c.id] ?? {}) as Record<string, unknown>,
        })),
        {
          category: 'globals',
          overrides: { FX_DEFAULT: draft.FX_DEFAULT },
        },
      ]
      const res = await saveQuoteParams(entries)
      if (!res.ok) {
        setNotice({ kind: 'error', text: res.error ?? '保存失败' })
        return
      }
      setSavedOv(draft)
      applyQuoteOverrides(draft)
      setPreview(null)
      setNotice({ kind: 'success', text: '已保存，报价计算页刷新后生效。' })
    } finally {
      setSaving(false)
    }
  }

  function resetTab() {
    if (tab === 'globals') {
      patchGlobals((g) => {
        g.FX_DEFAULT = defaults.FX_DEFAULT
      })
      return
    }
    setDraft((prev) => ({ ...prev, [tab]: structuredClone(defaults[tab as CategoryId]) }))
  }

  function openJson() {
    const value = tab === 'globals' ? { FX_DEFAULT: draft.FX_DEFAULT } : draft[tab]
    setJsonText(JSON.stringify(value, null, 2))
    setJsonTab(tab)
  }

  function applyJson() {
    if (jsonTab == null) return
    try {
      const v = JSON.parse(jsonText)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        setNotice({ kind: 'error', text: '顶层必须是 JSON 对象' })
        return
      }
      if (jsonTab === 'globals') {
        patchGlobals((g) => Object.assign(g, v))
      } else {
        setDraft((prev) => ({ ...prev, [jsonTab]: v }))
      }
      setJsonTab(null)
      setNotice(null)
    } catch (e) {
      setNotice({ kind: 'error', text: `JSON 解析失败：${(e as Error).message}` })
    }
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'globals', label: '全局' },
    ...CATEGORIES.map((c) => ({ id: c.id as TabId, label: c.cn })),
  ]

  const boxBand = (d: any, key: 'small' | 'mid' | 'large', title: string, hasCap: boolean) => (
    <div className="rounded-md border p-2.5">
      <div className="mb-1.5 text-[11px] font-semibold">{title}</div>
      <div className="space-y-1.5">
        {hasCap && (
          <div className="grid grid-cols-[96px_1fr] items-center gap-2 text-[10px] text-muted-foreground">
            <span>容量上限 ml</span>
            <Num value={d.box[key].maxCap ?? 0} onCommit={(v) => (d.box[key].maxCap = v)} />
          </div>
        )}
        <div className="grid grid-cols-[96px_1fr] items-center gap-2 text-[10px] text-muted-foreground">
          <span>≤500 固定费 ¥</span>
          <Num value={d.box[key].fixed} onCommit={(v) => (d.box[key].fixed = v)} />
        </div>
        <TierTable
          rows={d.box[key].tiers}
          thresholdLabel="≤ 数量（盒）"
          unit="¥/盒"
          onChange={(r) => (d.box[key].tiers = r)}
        />
      </div>
    </div>
  )

  /** 铝箔袋成本：不足起订量按总价平摊，达到后走 ≥ 阶梯单价。 */
  const foilCostEditor = (c: any, qtyUnit: string, priceUnit: string) => (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-muted-foreground">
          起订数量（{qtyUnit}）
          <Num value={Number(c.minQty)} onCommit={(v) => (c.minQty = v)} />
        </label>
        <label className="text-[10px] text-muted-foreground">
          不足起订按总价 ¥
          <Num value={Number(c.minTotal)} onCommit={(v) => (c.minTotal = v)} />
        </label>
      </div>
      <TierTable
        rows={c.tiers}
        desc
        thresholdLabel={`≥ 数量（${qtyUnit}）`}
        unit={priceUnit}
        onChange={(r) => (c.tiers = r)}
      />
    </div>
  )

  /** 开机费成本：≤ setupQty 按开机费平摊，超过后走 ≥ 阶梯单价。 */
  const setupCostEditor = (c: any, qtyUnit: string, priceUnit: string) => (
    <div className="space-y-1.5">
      <div className="grid grid-cols-2 gap-2">
        <label className="text-[10px] text-muted-foreground">
          ≤数量平摊开机费（{qtyUnit}）
          <Num value={Number(c.setupQty)} onCommit={(v) => (c.setupQty = v)} />
        </label>
        <label className="text-[10px] text-muted-foreground">
          开机费 ¥
          <Num value={Number(c.setupFee)} onCommit={(v) => (c.setupFee = v)} />
        </label>
      </div>
      <TierTable
        rows={c.tiers}
        desc
        thresholdLabel={`≥ 数量（${qtyUnit}）`}
        unit={priceUnit}
        onChange={(r) => (c.tiers = r)}
      />
    </div>
  )

  /** 人工/多档固定成本：每个场景一个数值。 */
  const laborEditor = (c: any, items: [string, string][], cols: 2 | 3 = 3) => (
    <div className={cn('grid gap-2', cols === 3 ? 'grid-cols-3' : 'grid-cols-2')}>
      {items.map(([k, label]) => (
        <label key={k} className="text-[10px] text-muted-foreground">
          {label}
          <Num value={Number(c[k])} onCommit={(v) => (c[k] = v)} />
        </label>
      ))}
    </div>
  )

  const renderGlobals = () => (
    <>
      <Section title="全局参数" en="Globals">
        <Row label="默认汇率" en="FX_DEFAULT">
          <Num value={Number(draft.FX_DEFAULT)} onCommit={(v) => patchGlobals((g) => (g.FX_DEFAULT = v))} />
        </Row>
      </Section>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        报价页顶部的汇率输入框仍可临时改单次的值，这里改的是每次打开的默认值。
      </p>
    </>
  )

  const renderMask = (d: any) => (
    <>
      <Section title="默认参数" en="Defaults">
        <Row label="定制总量" en="totalPieces">
          <Num value={Number(d.defaults.totalPieces)} onCommit={(v) => (d.defaults.totalPieces = v)} />
        </Row>
        <Row label="每盒片数" en="piecesPerBox">
          <Sel
            value={String(d.defaults.piecesPerBox)}
            options={Object.keys(d.box)}
            onChange={(v) => (d.defaults.piecesPerBox = Number(v))}
          />
        </Row>
        <Row label="配备彩盒" en="colorBox">
          <Sel value={String(d.defaults.colorBox)} options={['是', '否']} onChange={(v) => (d.defaults.colorBox = v)} />
        </Row>
        <Row label="吸塑内托" en="innerTray">
          <Sel value={String(d.defaults.innerTray)} options={['是', '否']} onChange={(v) => (d.defaults.innerTray = v)} />
        </Row>
        <Row label="印刷色数" en="colors">
          <Num value={Number(d.defaults.colors)} onCommit={(v) => (d.defaults.colors = v)} />
        </Row>
      </Section>
      <Section title="装盒人工" en="laborPerBox">
        <Row label="每盒人工" en="元/盒">
          <Num value={Number(d.laborPerBox)} onCommit={(v) => (d.laborPerBox = v)} />
        </Row>
      </Section>
      <Section title="印刷色版费" en="plateColorPrice">
        <Row label="每色版费" en="元/色">
          <Num value={Number(d.plateColorPrice)} onCommit={(v) => (d.plateColorPrice = v)} />
        </Row>
      </Section>
      <Section title="彩盒阶梯" en="box · 从高到低命中">
        {Object.keys(d.box).map((ppb) => (
          <Row key={ppb} label={`${ppb} 片/盒`}>
            <TierTable
              rows={d.box[ppb]}
              desc
              thresholdLabel="≥ 数量（盒）"
              unit="¥/盒"
              onChange={(r) => (d.box[ppb] = r)}
            />
          </Row>
        ))}
      </Section>
      <Section title="成本参数" en="costs · 引擎成本价">
        <Row label="膜布" en="film · 元/片">
          <TierTable
            rows={d.costs.film.tiers}
            desc
            thresholdLabel="≥ 数量（片）"
            unit="¥/片"
            onChange={(r) => (d.costs.film.tiers = r)}
          />
        </Row>
        <Row label="铝箔袋" en="bag">
          {foilCostEditor(d.costs.bag, '个', '¥/个')}
        </Row>
        <Row label="吸塑内托" en="tray · 按装盒数">
          <TierTable
            rows={d.costs.tray.tiers}
            thresholdLabel="≤ 数量（盒）"
            unit="¥/个"
            onChange={(r) => (d.costs.tray.tiers = r)}
          />
        </Row>
      </Section>
      <Section title="订量阶梯" en="tiers">
        <div className="px-3.5 py-3">
          <TierMetaTable rows={d.tiers} onChange={(r) => (d.tiers = r)} />
        </div>
      </Section>
    </>
  )

  const renderCotton = (d: any) => (
    <>
      <Section title="默认参数" en="Defaults">
        <Row label="包装形态" en="packForm">
          <Sel value={String(d.defaults.packForm)} options={['罐装', '袋装']} onChange={(v) => (d.defaults.packForm = v)} />
        </Row>
        <Row label="每件片数" en="padsPerUnit">
          <Num value={Number(d.defaults.padsPerUnit)} onCommit={(v) => (d.defaults.padsPerUnit = v)} />
        </Row>
        <Row label="基布材质" en="material">
          <Sel
            value={String(d.defaults.material)}
            options={Object.keys(d.padPrice)}
            onChange={(v) => (d.defaults.material = v)}
          />
        </Row>
        <Row label="定制数量" en="qty">
          <Num value={Number(d.defaults.qty)} onCommit={(v) => (d.defaults.qty = v)} />
        </Row>
        <Row label="彩盒 / 内托" en="colorBox / innerTray">
          <div className="flex gap-2">
            <Sel value={String(d.defaults.colorBox)} options={['是', '否']} onChange={(v) => (d.defaults.colorBox = v)} />
            <Sel value={String(d.defaults.innerTray)} options={['是', '否']} onChange={(v) => (d.defaults.innerTray = v)} />
          </div>
        </Row>
        <Row label="印刷工艺" en="print">
          <Sel value={String(d.defaults.print)} options={['瓶标', '丝印']} onChange={(v) => (d.defaults.print = v)} />
        </Row>
      </Section>
      <Section title="密封罐阶梯" en="jarTiers">
        <div className="px-3.5 py-3">
          <TierTable rows={d.jarTiers} desc thresholdLabel="≥ 数量（个）" unit="¥/个" onChange={(r) => (d.jarTiers = r)} />
        </div>
      </Section>
      <Section title="棉片基布" en="padPrice · 元/片">
        {Object.keys(d.padPrice).map((k) => (
          <Row key={k} label={k}>
            <div className="flex items-center gap-2">
              <Num value={Number(d.padPrice[k])} onCommit={(v) => (d.padPrice[k] = v)} />
              <Del onClick={() => delete d.padPrice[k]} />
            </div>
          </Row>
        ))}
        <AddMaterialRow
          placeholder="新基布材质名，如：珍珠棉"
          onAdd={(name) => {
            if (name && !(name in d.padPrice)) d.padPrice[name] = 0
          }}
        />
      </Section>
      <Section title="精华液料体" en="lotion">
        <Row label="固定规格价" en="ready · 片数 → 元/件">
          <div className="space-y-1.5">
            {Object.keys(d.lotion.ready).map((k) => (
              <div key={k} className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
                <Num
                  value={Number(k)}
                  onCommit={(v) => {
                    const old = d.lotion.ready[k]
                    delete d.lotion.ready[k]
                    d.lotion.ready[String(v)] = old
                  }}
                />
                <Num value={Number(d.lotion.ready[k])} onCommit={(v) => (d.lotion.ready[k] = v)} />
                <Del onClick={() => delete d.lotion.ready[k]} />
              </div>
            ))}
            <Add label="添加规格" onClick={() => (d.lotion.ready[String(Number(Object.keys(d.lotion.ready).pop() ?? 60) + 10)] = 0)} />
          </div>
        </Row>
        <Row label="阶梯公式" en="formula">
          <div className="grid grid-cols-3 gap-2">
            <label className="text-[10px] text-muted-foreground">
              基准价 ¥
              <Num value={Number(d.lotion.formula.base)} onCommit={(v) => (d.lotion.formula.base = v)} />
            </label>
            <label className="text-[10px] text-muted-foreground">
              基准片数
              <Num value={Number(d.lotion.formula.basePads)} onCommit={(v) => (d.lotion.formula.basePads = v)} />
            </label>
            <label className="text-[10px] text-muted-foreground">
              每 40 片加价
              <Num value={Number(d.lotion.formula.step) * 40} onCommit={(v) => (d.lotion.formula.step = v / 40)} />
            </label>
          </div>
        </Row>
      </Section>
      <Section title="外彩盒阶梯" en="box · 从低到高命中">
        <div className="px-3.5 py-3">
          <TierTable rows={d.box} thresholdLabel="≤ 数量（盒）" unit="¥/盒" onChange={(r) => (d.box = r)} />
        </div>
      </Section>
      <Section title="装盒人工" en="laborPerBox">
        <Row label="每盒人工" en="元/盒">
          <Num value={Number(d.laborPerBox)} onCommit={(v) => (d.laborPerBox = v)} />
        </Row>
      </Section>
      <Section title="成本参数" en="costs · 引擎成本价">
        <Row label="铝箔袋" en="bag">
          {foilCostEditor(d.costs.bag, '个', '¥/个')}
        </Row>
        <Row label="吸塑内托" en="tray · 按装盒数">
          <TierTable
            rows={d.costs.tray.tiers}
            thresholdLabel="≤ 数量（盒）"
            unit="¥/个"
            onChange={(r) => (d.costs.tray.tiers = r)}
          />
        </Row>
        <Row label="瓶标" en="label · 仅罐装">
          {setupCostEditor(d.costs.label, '件', '¥/张')}
        </Row>
        <Row label="丝印" en="silk · 仅罐装">
          {setupCostEditor(d.costs.silk, '件', '¥/个')}
        </Row>
      </Section>
      <Section title="订量阶梯" en="tiers">
        <div className="px-3.5 py-3">
          <TierMetaTable rows={d.tiers} onChange={(r) => (d.tiers = r)} />
        </div>
      </Section>
    </>
  )

  const renderOil = (d: any) => {
    const bottles = Object.keys(d.bottles ?? {})
    const cur = curKey(bottles, selBottle)
    const caps = cur ? Object.keys(d.bottles[cur]).map(Number).sort((a, b) => a - b) : []
    return (
      <>
        <Section title="默认参数" en="Defaults">
          <Row label="产品品类" en="category">
            <Sel value={String(d.defaults.category)} options={Object.keys(d.bulk)} onChange={(v) => (d.defaults.category = v)} />
          </Row>
          <Row label="定制数量" en="qty">
            <Num value={Number(d.defaults.qty)} onCommit={(v) => (d.defaults.qty = v)} />
          </Row>
          <Row label="彩盒 / 内托" en="colorBox / innerTray">
            <div className="flex gap-2">
              <Sel value={String(d.defaults.colorBox)} options={['是', '否']} onChange={(v) => (d.defaults.colorBox = v)} />
              <Sel value={String(d.defaults.innerTray)} options={['是', '否']} onChange={(v) => (d.defaults.innerTray = v)} />
            </div>
          </Row>
          <Row label="印刷工艺" en="print">
            <Sel value={String(d.defaults.print)} options={['瓶标', '丝印', '无']} onChange={(v) => (d.defaults.print = v)} />
          </Row>
        </Section>
        <Section title="瓶子价格" en="bottles · 元/套">
          <Row label="瓶型" en="点击切换">
            <div className="flex flex-wrap gap-1">
              {bottles.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setSelBottle(b)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                    b === cur
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/40',
                  )}
                >
                  {b}
                </button>
              ))}
            </div>
          </Row>
          {cur && (
            <Row label="容量价格" en="ml → 元/套">
              <div className="space-y-1.5">
                {caps.map((cap) => (
                  <div key={cap} className="grid grid-cols-[88px_1fr_28px] items-center gap-2">
                    <span className="font-mono text-[12px] tabular-nums">{cap} ml</span>
                    <Num value={Number(d.bottles[cur][cap])} onCommit={(v) => (d.bottles[cur][cap] = v)} />
                    <Del
                      onClick={() => {
                        delete d.bottles[cur][cap]
                      }}
                    />
                  </div>
                ))}
                <Add label="添加容量" onClick={() => (d.bottles[cur][String((caps.pop() ?? 0) + 10)] = 0)} />
                <Del title={`删除「${cur}」瓶型`} onClick={() => { delete d.bottles[cur]; setSelBottle('') }} />
              </div>
            </Row>
          )}
          <Row label="新增瓶型" en="输入名称后添加">
            <div className="flex items-center gap-2">
              <Txt value={newBottle} onCommit={setNewBottle} className="flex-1" />
              <Add
                label="添加"
                onClick={() => {
                  if (newBottle && !(newBottle in (d.bottles ?? {}))) {
                    d.bottles[newBottle] = {}
                    setSelBottle(newBottle)
                    setNewBottle('')
                  }
                }}
              />
            </div>
          </Row>
        </Section>
        <Section title="料体价格" en="bulk · 元/ml">
          {Object.keys(d.bulk).map((k) => (
            <Row key={k} label={k}>
              <div className="flex items-center gap-2">
                <Num value={Number(d.bulk[k])} onCommit={(v) => (d.bulk[k] = v)} />
                <Del onClick={() => delete d.bulk[k]} />
              </div>
            </Row>
          ))}
          <AddMaterialRow
            placeholder="新品类名，如：按摩油类"
            onAdd={(name) => {
              if (name && !(name in d.bulk)) d.bulk[name] = 0
            }}
          />
        </Section>
        <Section title="外彩盒" en="box · 按容量分段">
          <div className="space-y-2 px-3.5 py-3">
            {boxBand(d, 'small', '小瓶段（≤ 容量上限）', true)}
            {boxBand(d, 'mid', '中瓶段（≤ 容量上限）', true)}
            {boxBand(d, 'large', '大瓶段（其余）', false)}
          </div>
        </Section>
        <Section title="成本参数" en="costs · 引擎成本价">
          <Row label="瓶标" en="label">
            {setupCostEditor(d.costs.label, '瓶', '¥/张')}
          </Row>
          <Row label="丝印" en="silk">
            {setupCostEditor(d.costs.silk, '瓶', '¥/个')}
          </Row>
          <Row label="防护内托" en="tray · 按容量">
            <TierTable
              rows={d.costs.tray.tiers}
              thresholdLabel="≤ 容量（ml）"
              unit="¥/个"
              onChange={(r) => (d.costs.tray.tiers = r)}
            />
          </Row>
          <Row label="装配人工" en="labor · 元/瓶">
            {laborEditor(d.costs.labor, [
              ['boxed', '配彩盒'],
              ['plain', '裸瓶·无印刷'],
              ['decorated', '裸瓶·带印刷'],
            ])}
          </Row>
        </Section>
        <Section title="订量阶梯" en="tiers">
          <div className="px-3.5 py-3">
            <TierMetaTable rows={d.tiers} onChange={(r) => (d.tiers = r)} />
          </div>
        </Section>
      </>
    )
  }

  const renderCream = (d: any) => {
    const containers = Object.keys(d.containers ?? {})
    const cur = curKey(containers, selContainer)
    const caps = cur ? Object.keys(d.containers[cur]).map(Number).sort((a, b) => a - b) : []
    return (
      <>
        <Section title="默认参数" en="Defaults">
          <Row label="料体品类" en="bulkType">
            <Sel value={String(d.defaults.bulkType)} options={Object.keys(d.bulk)} onChange={(v) => (d.defaults.bulkType = v)} />
          </Row>
          <Row label="容器器型" en="container">
            <Sel value={String(d.defaults.container)} options={containers} onChange={(v) => (d.defaults.container = v)} />
          </Row>
          <Row label="定制数量" en="qty">
            <Num value={Number(d.defaults.qty)} onCommit={(v) => (d.defaults.qty = v)} />
          </Row>
          <Row label="彩盒 / 内托" en="colorBox / innerTray">
            <div className="flex gap-2">
              <Sel value={String(d.defaults.colorBox)} options={['是', '否']} onChange={(v) => (d.defaults.colorBox = v)} />
              <Sel value={String(d.defaults.innerTray)} options={['是', '否']} onChange={(v) => (d.defaults.innerTray = v)} />
            </div>
          </Row>
          <Row label="印刷工艺" en="print">
            <Sel value={String(d.defaults.print)} options={['瓶标', '丝印']} onChange={(v) => (d.defaults.print = v)} />
          </Row>
        </Section>
        <Section title="料体价格" en="bulk · 元/kg">
          {Object.keys(d.bulk).map((k) => (
            <Row key={k} label={k}>
              <div className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
                <label className="text-[10px] text-muted-foreground">
                  元/kg
                  <Num value={Number(d.bulk[k].kg)} onCommit={(v) => (d.bulk[k].kg = v)} />
                </label>
                <label className="text-[10px] text-muted-foreground">
                  元/g
                  <Num value={Number(d.bulk[k].perG)} onCommit={(v) => (d.bulk[k].perG = v)} />
                </label>
                <Del onClick={() => delete d.bulk[k]} />
              </div>
            </Row>
          ))}
          <AddMaterialRow
            placeholder="新料体名，如：睡眠面膜"
            onAdd={(name) => {
              if (name && !(name in d.bulk)) d.bulk[name] = { kg: 0, perG: 0 }
            }}
          />
        </Section>
        <Section title="容器价格" en="containers · 容量 → 元/个">
          <Row label="器型" en="点击切换">
            <div className="flex flex-wrap gap-1">
              {containers.map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => setSelContainer(b)}
                  className={cn(
                    'rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
                    b === cur
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-muted-foreground hover:border-primary/40',
                  )}
                >
                  {b}
                </button>
              ))}
            </div>
          </Row>
          {cur && (
            <Row label={`「${cur}」规格`} en="容量 → 元/个">
              <div className="space-y-1.5">
                <div className="grid grid-cols-[88px_1fr_28px] items-center gap-2 text-[10px] text-muted-foreground">
                  <span>容量 ml/g</span>
                  <span>单价（元/个）</span>
                  <span />
                </div>
                {caps.map((cap) => (
                  <div key={cap} className="grid grid-cols-[88px_1fr_28px] items-center gap-2">
                    <Num
                      value={cap}
                      onCommit={(v) => {
                        const old = d.containers[cur][cap]
                        delete d.containers[cur][cap]
                        d.containers[cur][v] = old
                      }}
                    />
                    <Num value={Number(d.containers[cur][cap])} onCommit={(v) => (d.containers[cur][cap] = v)} />
                    <Del onClick={() => delete d.containers[cur][cap]} />
                  </div>
                ))}
                <Add
                  label="添加规格"
                  onClick={() => {
                    const last = caps[caps.length - 1] ?? 0
                    d.containers[cur][String(last + 10)] = 0
                  }}
                />
                {caps.length === 0 && (
                  <p className="text-[10.5px] text-muted-foreground">
                    还没有规格，点击「添加规格」录入第一个容量与单价。
                  </p>
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px] font-normal text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    delete d.containers[cur]
                    setSelContainer('')
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  删除「{cur}」器型
                </Button>
              </div>
            </Row>
          )}
          <Row label="新增器型" en="输入名称后添加">
            <div className="flex items-center gap-2">
              <Txt value={newContainer} onCommit={setNewContainer} className="flex-1" />
              <Add
                label="添加"
                onClick={() => {
                  if (newContainer && !(newContainer in (d.containers ?? {}))) {
                    d.containers[newContainer] = {}
                    setSelContainer(newContainer)
                    setNewContainer('')
                  }
                }}
              />
            </div>
          </Row>
        </Section>
        <Section title="外彩盒" en="box · 按容量分段">
          <div className="space-y-2 px-3.5 py-3">
            {boxBand(d, 'small', '小容量段（≤ 容量上限）', true)}
            {boxBand(d, 'mid', '中容量段（≤ 容量上限）', true)}
            {boxBand(d, 'large', '大容量段（其余）', false)}
          </div>
        </Section>
        <Section title="成本参数" en="costs · 引擎成本价">
          <Row label="包材折扣" en="discount · 数量→折扣系数">
            <TierTable
              rows={d.costs.discount.tiers}
              desc
              thresholdLabel="≥ 数量（支）"
              unit="折扣"
              onChange={(r) => (d.costs.discount.tiers = r)}
            />
          </Row>
          <Row label="瓶标" en="label">
            {setupCostEditor(d.costs.label, '支', '¥/张')}
          </Row>
          <Row label="丝印" en="silk">
            {setupCostEditor(d.costs.silk, '支', '¥/个')}
          </Row>
          <Row label="彩盒内托" en="tray · 按容量">
            <TierTable
              rows={d.costs.tray.tiers}
              thresholdLabel="≤ 容量（ml/g）"
              unit="¥/个"
              onChange={(r) => (d.costs.tray.tiers = r)}
            />
          </Row>
          <Row label="灌装人工" en="labor · 元/支">
            {laborEditor(
              d.costs.labor,
              [
                ['boxed', '配彩盒'],
                ['plain', '裸瓶/简装'],
              ],
              2,
            )}
          </Row>
        </Section>
        <Section title="订量阶梯" en="tiers">
          <div className="px-3.5 py-3">
            <TierMetaTable rows={d.tiers} onChange={(r) => (d.tiers = r)} />
          </div>
        </Section>
      </>
    )
  }

  const renderEyemask = (d: any) => (
    <>
      <Section title="默认参数" en="Defaults">
        <Row label="产品" en="product">
          <Sel value={String(d.defaults.product)} options={['眼膜', '唇膜']} onChange={(v) => (d.defaults.product = v)} />
        </Row>
        <Row label="膜材" en="material">
          <Sel value={String(d.defaults.material)} options={Object.keys(d.membranes)} onChange={(v) => (d.defaults.material = v)} />
        </Row>
        <Row label="罐型" en="jar · 罐装膜材用">
          <Sel value={String(d.defaults.jar)} options={Object.keys(d.jars)} onChange={(v) => (d.defaults.jar = v)} />
        </Row>
        <Row label="袋装包材" en="bagPack">
          <Sel value={String(d.defaults.bagPack ?? '是')} options={['是', '否']} onChange={(v) => (d.defaults.bagPack = v)} />
        </Row>
        <Row label="包装形式" en="packMode">
          <Sel value={String(d.defaults.packMode)} options={['盒装', '单袋散装', '裸片散装']} onChange={(v) => (d.defaults.packMode = v)} />
        </Row>
        <Row label="每盒对数" en="pairsPerBox">
          <Num value={Number(d.defaults.pairsPerBox)} onCommit={(v) => (d.defaults.pairsPerBox = v)} />
        </Row>
        <Row label="定制对数" en="qtyPairs">
          <Num value={Number(d.defaults.qtyPairs)} onCommit={(v) => (d.defaults.qtyPairs = v)} />
        </Row>
        <Row label="彩盒 / 内托" en="colorBox / innerTray">
          <div className="flex gap-2">
            <Sel value={String(d.defaults.colorBox)} options={['是', '否']} onChange={(v) => (d.defaults.colorBox = v)} />
            <Sel value={String(d.defaults.innerTray)} options={['是', '否']} onChange={(v) => (d.defaults.innerTray = v)} />
          </div>
        </Row>
      </Section>
      <Section title="膜材" en="membranes">
        {Object.keys(d.membranes).map((k) => (
          <div key={k} className="px-3.5 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[12.5px] font-semibold">{k}</span>
              <Sel
                value={String(d.membranes[k].kind)}
                options={MEMBRANE_KINDS}
                onChange={(v) => (d.membranes[k].kind = v)}
              />
              <span className="ml-auto" />
              <Del title={`删除「${k}」`} onClick={() => delete d.membranes[k]} />
            </div>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-[10px] text-muted-foreground">
                批次底价 ¥
                <Num value={Number(d.membranes[k].floorTotal)} onCommit={(v) => (d.membranes[k].floorTotal = v)} />
              </label>
              <label className="text-[10px] text-muted-foreground">
                底价/对 ¥
                <Num value={Number(d.membranes[k].floorPrice)} onCommit={(v) => (d.membranes[k].floorPrice = v)} />
              </label>
              <label className="text-[10px] text-muted-foreground">
                起订量（对）
                <Num value={Number(d.membranes[k].moq)} onCommit={(v) => (d.membranes[k].moq = v)} />
              </label>
            </div>
          </div>
        ))}
        <div className="px-3.5 py-3">
          <AddMaterialRow
            placeholder="新膜材名"
            onAdd={(name) => {
              if (name && !(name in d.membranes)) d.membranes[name] = { floorTotal: 0, floorPrice: 0, moq: 0, kind: 'gelbag' }
            }}
          />
        </div>
      </Section>
      <Section title="罐型包材" en="jars">
        {Object.keys(d.jars).map((k) => (
          <Row key={k} label={k}>
            <div className="grid grid-cols-[1fr_1fr_28px] items-center gap-2">
              <label className="text-[10px] text-muted-foreground">
                装对数
                <Num value={Number(d.jars[k].pairs)} onCommit={(v) => (d.jars[k].pairs = v)} />
              </label>
              <label className="text-[10px] text-muted-foreground">
                元/罐
                <Num value={Number(d.jars[k].price)} onCommit={(v) => (d.jars[k].price = v)} />
              </label>
              <Del onClick={() => delete d.jars[k]} />
            </div>
          </Row>
        ))}
        <AddMaterialRow
          placeholder="新罐型名"
          onAdd={(name) => {
            if (name && !(name in d.jars)) d.jars[name] = { pairs: 30, price: 0 }
          }}
        />
      </Section>
      <Section title="袋装袋价" en="bagPrice · 元/对">
        {(['water', 'gel'] as const).map((kind) => (
          <div key={kind} className="px-3.5 py-3">
            <div className="mb-1.5 text-[11px] font-semibold">{kind === 'water' ? '水凝胶袋' : '凝胶/硅胶袋'}</div>
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[10px] text-muted-foreground">
                不足起订对数
                <Num value={Number(d.bagPrice[kind].minQty)} onCommit={(v) => (d.bagPrice[kind].minQty = v)} />
              </label>
              <label className="text-[10px] text-muted-foreground">
                不足时总价 ¥
                <Num value={Number(d.bagPrice[kind].minTotal)} onCommit={(v) => (d.bagPrice[kind].minTotal = v)} />
              </label>
            </div>
            <div className="mt-2">
              <TierTable
                rows={d.bagPrice[kind].tiers}
                desc
                thresholdLabel="≥ 对数"
                unit="¥/对"
                onChange={(r) => (d.bagPrice[kind].tiers = r)}
              />
            </div>
          </div>
        ))}
      </Section>
      <Section title="其他" en="plate / box / labor">
        <Row label="袋子版费" en="元/色">
          <Num value={Number(d.platePerColor)} onCommit={(v) => (d.platePerColor = v)} />
        </Row>
        <Row label="装盒人工" en="元/件">
          <Num value={Number(d.laborPerBox)} onCommit={(v) => (d.laborPerBox = v)} />
        </Row>
        <Row label="外彩盒阶梯" en="box">
          <TierTable rows={d.box} thresholdLabel="≤ 数量（件）" unit="¥/件" onChange={(r) => (d.box = r)} />
        </Row>
      </Section>
      <Section title="成本参数" en="costs · 引擎成本价">
        <Row label="硅胶膜材" en="silicone · 元/对">
          <TierTable
            rows={d.costs.silicone.tiers}
            desc
            thresholdLabel="≥ 对数"
            unit="¥/对"
            onChange={(r) => (d.costs.silicone.tiers = r)}
          />
        </Row>
        <Row label="瓶标" en="label · 罐装">
          {setupCostEditor(d.costs.label, '件', '¥/张')}
        </Row>
        <Row label="丝印" en="silk · 罐装">
          {setupCostEditor(d.costs.silk, '件', '¥/个')}
        </Row>
        <Row label="吸塑内托" en="tray">
          <TierTable
            rows={d.costs.tray.tiers}
            thresholdLabel="≤ 数量（件）"
            unit="¥/件"
            onChange={(r) => (d.costs.tray.tiers = r)}
          />
        </Row>
      </Section>
      <Section title="订量阶梯" en="tiers">
        <div className="px-3.5 py-3">
          <TierMetaTable rows={d.tiers} onChange={(r) => (d.tiers = r)} />
        </div>
      </Section>
    </>
  )

  const renderCategory = (cat: CategoryId) => {
    const d = draft[cat] as Record<string, any>
    switch (cat) {
      case 'mask':
        return renderMask(d)
      case 'cotton':
        return renderCotton(d)
      case 'oil':
        return renderOil(d)
      case 'cream':
        return renderCream(d)
      case 'eyemask':
        return renderEyemask(d)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">报价参数</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            修改后直接保存即可覆盖代码默认值，报价计算页刷新后生效；未保存的修改不影响线上。
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/quote">
            <ArrowLeft className="mr-1.5 h-3.5 w-3.5" />
            返回报价页
          </Link>
        </Button>
      </div>

      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="参数分组">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              tab === t.id
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {jsonTab === tab ? (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <div className="text-[14px] font-semibold">高级 JSON 编辑</div>
            <div className="flex gap-1.5">
              <Button variant="outline" size="sm" className="h-7 text-[11px]" onClick={() => setJsonTab(null)}>
                取消
              </Button>
              <Button size="sm" className="h-7 text-[11px]" onClick={applyJson}>
                应用 JSON
              </Button>
            </div>
          </div>
          <div className="px-4 py-4">
            <Textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              spellCheck={false}
              className="min-h-[420px] resize-y font-mono text-[12px] leading-relaxed"
            />
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
              与逐项编辑同一份数据；应用后回到表单视图。
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] font-normal text-muted-foreground"
              onClick={openJson}
            >
              <Braces className="h-3 w-3" />
              高级 JSON 编辑
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] font-normal text-muted-foreground"
              onClick={resetTab}
            >
              <RotateCcw className="h-3 w-3" />
              恢复代码默认
            </Button>
          </div>
          {tab === 'globals' ? renderGlobals() : renderCategory(tab)}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" className="gap-1.5" onClick={runPreview}>
          <Eye className="h-3.5 w-3.5" />
          校验并预览对比
        </Button>
        <Button size="sm" className="gap-1.5" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          保存并生效
        </Button>
        {notice && (
          <span
            className={cn(
              'text-[12px]',
              notice.kind === 'error' ? 'text-destructive' : 'text-emerald-600',
            )}
          >
            {notice.text}
          </span>
        )}
      </div>

      {preview && (
        <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <div className="text-[14px] font-semibold">试算对比（各品类默认参数）</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              用当前保存值 vs 编辑后的值各跑一遍引擎；参数结构有问题会在对应行给出提示。
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b bg-muted text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">品类</th>
                  <th className="px-4 py-2 text-right font-medium">单片成本 ¥</th>
                  <th className="px-4 py-2 text-right font-medium">单片报价 ¥</th>
                  <th className="px-4 py-2 text-right font-medium">FOB $</th>
                  <th className="px-4 py-2 text-right font-medium">总成本 ¥</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {CATEGORIES.map((c, i) => {
                  const b = preview.before[i]
                  const a = preview.after[i]
                  if (!b || !a) {
                    return (
                      <tr key={c.id}>
                        <td className="px-4 py-2 font-medium">{c.cn}</td>
                        <td className="px-4 py-2 text-destructive" colSpan={5}>
                          编辑值导致引擎报错，请检查本页参数结构
                        </td>
                      </tr>
                    )
                  }
                  const changed =
                    b.ok && a.ok && (b.unitPrice !== a.unitPrice || b.costTotal !== a.costTotal)
                  const err = !a.ok ? a.errors.join('；') : !b.ok ? b.errors.join('；') : null
                  return (
                    <tr key={c.id}>
                      <td className="px-4 py-2 font-medium">{c.cn}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {b.ok ? `${fmt2(b.unitCost)} → ${fmt2(a.unitCost)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {a.ok ? `${fmt2(b.unitPrice)} → ${fmt2(a.unitPrice)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {a.ok ? `${b.unitFob.toFixed(3)} → ${a.unitFob.toFixed(3)}` : '—'}
                      </td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">
                        {a.ok ? `${fmt2(b.costTotal)} → ${fmt2(a.costTotal)}` : '—'}
                      </td>
                      <td className="px-4 py-2">
                        {err ? (
                          <span className="text-destructive">{err}</span>
                        ) : changed ? (
                          <span className="text-amber-600">有变化</span>
                        ) : (
                          <span className="text-muted-foreground">无变化</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

/** Inline "add named entry" row with a text input + add button. */
function AddMaterialRow({
  placeholder,
  onAdd,
}: {
  placeholder: string
  onAdd: (name: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <div className="px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          placeholder={placeholder}
          onChange={(e) => setName(e.target.value)}
          className="h-8 flex-1 text-[12.5px]"
        />
        <Add
          label="添加"
          onClick={() => {
            if (name.trim()) onAdd(name.trim())
            setName('')
          }}
        />
      </div>
    </div>
  )
}

/** Pick the selected key if still present, else the first key (self-heals after deletes). */
function curKey(keys: string[], sel: string): string {
  return sel && keys.includes(sel) ? sel : keys[0]
}
