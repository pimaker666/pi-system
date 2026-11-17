'use client'

import { useEffect, useMemo, useState } from 'react'
import { Calculator } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { CATEGORIES, FX_DEFAULT, defaultsFor, type CategoryId, type QuoteInput } from '@/lib/quote/data'
import { autoMargin, compute } from '@/lib/quote/engine'
import { normalizeInput } from '@/lib/quote/form'
import { todayLocal } from '@/lib/quote/text'
import { QuoteForm } from './quote-form'
import { QuoteResult } from './quote-result'
import { cn } from '@/lib/utils'

const STORE_KEY = 'pi-quote-v1'
const DEFAULT_CLIENT = '海外采购商 / 跨境电商买家'

interface Stored {
  cat: CategoryId
  inputs: Record<string, QuoteInput>
  manual: Record<string, number | null>
  client: string
  date: string
  fx: number
}

function freshInputs(): Record<CategoryId, QuoteInput> {
  const out = {} as Record<CategoryId, QuoteInput>
  CATEGORIES.forEach((c) => {
    out[c.id] = defaultsFor(c.id)
  })
  return out
}

const isCat = (v: unknown): v is CategoryId => CATEGORIES.some((c) => c.id === v)

function loadStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Partial<Stored>
    const base = freshInputs()
    if (s.inputs && typeof s.inputs === 'object') {
      CATEGORIES.forEach((c) => {
        const saved = s.inputs?.[c.id]
        if (saved && typeof saved === 'object') {
          base[c.id] = normalizeInput(c.id, { ...base[c.id], ...saved })
        }
      })
    }
    const manual: Record<string, number | null> = {}
    CATEGORIES.forEach((c) => {
      const m = s.manual?.[c.id]
      manual[c.id] =
        typeof m === 'number' && Number.isFinite(m) && m >= 0 && m < 0.95 ? m : null
    })
    return {
      cat: isCat(s.cat) ? s.cat : 'mask',
      inputs: base,
      manual,
      client: typeof s.client === 'string' ? s.client : DEFAULT_CLIENT,
      date: typeof s.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.date) ? s.date : todayLocal(),
      fx: typeof s.fx === 'number' && s.fx > 0 && s.fx < 20 ? s.fx : FX_DEFAULT,
    }
  } catch {
    return null
  }
}

export function QuoteClient() {
  const [categoryId, setCategoryId] = useState<CategoryId>('mask')
  const [inputs, setInputs] = useState<Record<CategoryId, QuoteInput>>(freshInputs)
  const [manual, setManual] = useState<Record<string, number | null>>({})
  const [client, setClient] = useState(DEFAULT_CLIENT)
  const [date, setDate] = useState(todayLocal)
  const [fx, setFx] = useState(FX_DEFAULT)
  const [fxDraft, setFxDraft] = useState(String(FX_DEFAULT))

  useEffect(() => {
    const stored = loadStored()
    if (stored) {
      setCategoryId(stored.cat)
      setInputs(stored.inputs as Record<CategoryId, QuoteInput>)
      setManual(stored.manual)
      setClient(stored.client)
      setDate(stored.date)
      setFx(stored.fx)
      setFxDraft(String(stored.fx))
    }
    document.documentElement.dataset.quotePrint = '1'
    return () => {
      delete document.documentElement.dataset.quotePrint
    }
  }, [])

  useEffect(() => {
    const payload: Stored = { cat: categoryId, inputs, manual, client, date, fx }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(payload))
    } catch {
      /* quota / private mode — calculation still works without persistence */
    }
  }, [categoryId, inputs, manual, client, date, fx])

  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  const input = inputs[categoryId]
  const auto = autoMargin(categoryId, input)
  const manualMargin = manual[categoryId] ?? null
  const result = useMemo(
    () => compute(categoryId, input, { fx, margin: manualMargin }),
    [categoryId, input, fx, manualMargin],
  )
  const curQty = Number(input[cat.qtyKey])

  return (
    <div className="quote-page mx-auto max-w-[1440px] space-y-4">
      <div className="print-hidden flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Calculator className="h-5 w-5 text-primary" />
            报价计算
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            京妍 OEM / ODM 报价台 · 出厂成本拆解、阶梯毛利与 FOB 测算
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[180px] flex-1 text-[11px] text-muted-foreground sm:flex-none">
            客户 Client
            <Input
              value={client}
              onChange={(e) => setClient(e.target.value)}
              className="mt-1 h-8 w-full text-[12.5px] sm:w-56"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            报价日期
            <Input
              type="date"
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className="mt-1 h-8 w-[132px] text-[12.5px]"
            />
          </label>
          <label className="text-[11px] text-muted-foreground">
            汇率 USD/CNY
            <Input
              inputMode="decimal"
              value={fxDraft}
              onChange={(e) => {
                const raw = e.target.value.replace(/[^\d.]/g, '')
                setFxDraft(raw)
                const n = Number(raw)
                if (Number.isFinite(n) && n > 0 && n < 20) setFx(n)
              }}
              onBlur={() => {
                const n = Number(fxDraft)
                const next = Number.isFinite(n) && n > 0 && n < 20 ? n : fx
                setFx(next)
                setFxDraft(String(next))
              }}
              className="mt-1 h-8 w-20 font-mono text-[12.5px]"
            />
          </label>
        </div>
      </div>

      <div className="print-hidden flex flex-wrap gap-1.5" role="tablist" aria-label="产品品类">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={c.id === categoryId}
            onClick={() => setCategoryId(c.id)}
            className={cn(
              'rounded-md border px-3 py-1.5 text-[12.5px] font-medium transition-colors',
              c.id === categoryId
                ? 'border-primary bg-primary text-primary-foreground'
                : 'bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground',
            )}
          >
            {c.cn}
            <span className="ml-1.5 text-[10px] opacity-70">{c.en}</span>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-[1280px]:grid-cols-[340px_minmax(0,1fr)] min-[1280px]:items-start">
        <div className="print-hidden min-w-0 min-[1280px]:sticky min-[1280px]:top-0">
          <QuoteForm
            categoryId={categoryId}
            input={input}
            auto={auto}
            manual={manualMargin}
            onChange={(key, value) =>
              setInputs((prev) => ({
                ...prev,
                [categoryId]: normalizeInput(categoryId, { ...prev[categoryId], [key]: value }),
              }))
            }
            onManualChange={(v) =>
              setManual((prev) => ({ ...prev, [categoryId]: v }))
            }
            onReset={() => {
              setInputs((prev) => ({ ...prev, [categoryId]: defaultsFor(categoryId) }))
              setManual((prev) => ({ ...prev, [categoryId]: null }))
            }}
          />
        </div>

        <QuoteResult
          categoryId={categoryId}
          input={input}
          result={result}
          meta={{ client, date, fx }}
          curQty={curQty}
        />
      </div>
    </div>
  )
}
