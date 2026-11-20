'use client'

import { AlertTriangle, ClipboardList, Copy, Download, Info, Printer } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { CATEGORIES, type CategoryId, type QuoteInput } from '@/lib/quote/data'
import type { QuoteResult } from '@/lib/quote/engine'
import {
  TIER_NOTES,
  buyerText,
  fmt,
  fmtInt,
  hasPacks,
  internalText,
  money2,
  money3,
  pct,
  qtyText,
  quoteNo,
  secondaryKpi,
  showMini,
  tierCsv,
  tierQtyHead,
  type QuoteMeta,
} from '@/lib/quote/text'

function copyText(text: string, okMsg: string) {
  const fallback = () => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    document.body.removeChild(ta)
    toast(ok ? okMsg : '复制失败，请手动选择文本')
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback)
  } else {
    fallback()
  }
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  toast('CSV 已导出')
}

export function QuoteResult({
  categoryId,
  input,
  result,
  meta,
  curQty,
}: {
  categoryId: CategoryId
  input: QuoteInput
  result: QuoteResult
  meta: QuoteMeta
  curQty: number
}) {
  const cat = CATEGORIES.find((c) => c.id === categoryId)!
  const no = quoteNo(meta.date, categoryId)

  const printHead = (
    <div className="quote-print-head">
      <div className="flex items-start gap-3">
        <div className="quote-mark">JY</div>
        <div>
          <h1 className="text-[14px] font-semibold leading-tight">佛山京妍生物制品有限公司</h1>
          <p className="text-[9px] leading-snug text-muted-foreground">
            Foshan Jingyan Biological Products Co., Ltd. · OEM / ODM · ISO 22716 / GMPC
          </p>
        </div>
      </div>
      <div className="text-right text-[9.5px] leading-relaxed text-muted-foreground">
        <b className="text-foreground">QUOTATION 报价单</b>
        <br />
        No. {no}
        <br />
        Date {meta.date}
        <br />
        Client {meta.client || '-'}
      </div>
    </div>
  )

  if (!result.ok) {
    return (
      <div className="quote-doc flex flex-col gap-4">
        {printHead}
        <div className="print-card rounded-lg border border-destructive/40 bg-card shadow-sm">
          <div className="flex items-start gap-2 px-4 py-4 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div>
              <div className="font-semibold">无法核算本组参数</div>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {result.errors.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const secondary = secondaryKpi(categoryId, result)
  const packed = hasPacks(categoryId, result)
  const mini = showMini(result)
  const perMiniCol = (categoryId === 'mask' || categoryId === 'eyemask') && mini
  const packFirst = categoryId === 'mask' && mini
  const miniRmb = categoryId === 'eyemask'
  const miniDp = miniRmb ? 3 : 2
  const miniCost = (n: number) => fmt(n, miniDp)

  return (
    <div className="quote-doc flex flex-col gap-4">
      {printHead}

      <div className="print-card rounded-lg border bg-card shadow-sm">
        <div className="quote-head-block px-4 py-4">
          <div className="quote-head-kicker font-mono text-[10px] uppercase tracking-[.4px] text-muted-foreground">
            Quotation · 报价单 {no}
          </div>
          <h2 className="quote-title mt-1 text-lg font-semibold leading-snug">{result.description}</h2>
          <div className="mt-1 text-[11.5px] text-muted-foreground">
            {cat.cn} / {cat.en} · FOB（可改 EXW）· 汇率 1 USD = {fmt(meta.fx, 2)} CNY
          </div>
          <div className="quote-chips mt-2.5 flex flex-wrap gap-1.5">
            {result.specs.map(([k, v]) => (
              <span
                key={k}
                className="rounded-md border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                <b className="font-medium text-foreground">{k}</b> {v}
              </span>
            ))}
          </div>
          <div className="quote-actions mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.print()}>
              <Printer className="mr-1.5 h-3.5 w-3.5" />
              打印 / 导出 PDF
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copyText(buyerText(categoryId, input, result, meta), '客户报价已复制')}
            >
              <Copy className="mr-1.5 h-3.5 w-3.5" />
              复制客户报价
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => copyText(internalText(categoryId, result, meta), '内部核算已复制')}
            >
              <ClipboardList className="mr-1.5 h-3.5 w-3.5" />
              复制内部核算
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                downloadCsv(
                  `京妍报价阶梯_${cat.cn.replace(/\s|\//g, '')}_${meta.date}.csv`,
                  tierCsv(categoryId, result),
                )
              }
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              导出阶梯 CSV
            </Button>
          </div>
        </div>

        <div className="quote-kpis">
          <div className="quote-kpi is-fob">
            <div className="text-[10.5px] font-medium text-muted-foreground">
              单{result.unitLabel}报价{' '}
              <span className="text-[9px] uppercase tracking-[.3px]">unit price (USD)</span>
            </div>
            <div className="k-value mt-1 font-mono text-xl font-semibold tracking-tight">
              {money3(result.unitFob)}
              <small className="ml-1 text-[11px] font-normal text-muted-foreground">
                / {result.unitLabel}
              </small>
            </div>
            <div className="mt-1 text-[10.5px] text-muted-foreground">
              出厂价 ¥{fmt(result.unitPrice)} / {result.unitLabel}
            </div>
          </div>
          <div className="quote-kpi is-boxfob">
            <div className="text-[10.5px] font-medium text-muted-foreground">
              {secondary.label}{' '}
              <span className="text-[9px] uppercase tracking-[.3px]">{secondary.en}</span>
            </div>
            <div className="k-value mt-1 font-mono text-xl font-semibold tracking-tight">
              {secondary.value}
            </div>
            <div className="mt-1 text-[10.5px] text-muted-foreground">{secondary.foot}</div>
          </div>
          <div className="quote-kpi is-accent">
            <div className="text-[10.5px] font-medium text-muted-foreground">
              订单总货值 <span className="text-[9px] uppercase tracking-[.3px]">order value</span>
            </div>
            <div className="k-value mt-1 font-mono text-xl font-semibold tracking-tight">
              {money2(result.revenueUSD)}
            </div>
            <div className="mt-1 text-[10.5px] text-muted-foreground">
              ¥{fmt(result.revenueRMB)} · {qtyText(categoryId, result)}
            </div>
          </div>
          <div className="quote-kpi is-profit">
            <div className="text-[10.5px] font-medium text-muted-foreground">
              毛利总额 <span className="text-[9px] uppercase tracking-[.3px]">gross profit</span>
            </div>
            <div className="k-value mt-1 font-mono text-xl font-semibold tracking-tight">
              {money2(result.profitUSD)}
            </div>
            <div className="mt-1 text-[10.5px] text-muted-foreground">
              毛利率 {pct(result.margin)}
              {result.marginManual ? '（手动）' : '（自动）'} · ¥{fmt(result.profitRMB)}
            </div>
          </div>
        </div>
      </div>

      <div className="print-card quote-block rounded-lg border bg-card shadow-sm">
        <div className="quote-block-head flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
          <h3 className="text-[13px] font-semibold">
            出厂成本明细 <span className="font-normal text-muted-foreground">/ Cost breakdown</span>
          </h3>
          <div className="text-[11px] text-muted-foreground">
            {packFirst && `单${result.miniLabel}成本 = 单${result.unitLabel}成本 × ${result.packPerUnit}　·　`}
            单{result.unitLabel}成本 = 总成本 ÷ {fmtInt(result.qty)}　·　报价 = 成本 ÷ (1 − 毛利率)
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="quote-table min-w-[560px]">
            <thead>
              <tr>
                <th>成本项目</th>
                <th className="is-left print-col hidden min-[1440px]:table-cell">计价依据 / 阶梯逻辑</th>
                {packFirst ? (
                  <>
                    <th>单{result.miniLabel}成本 ¥</th>
                    <th>折合{result.unitLabel}成本 ¥</th>
                  </>
                ) : (
                  <>
                    <th>单{result.unitLabel}成本 ¥</th>
                    {perMiniCol && <th>折合{result.miniLabel}成本 ¥</th>}
                  </>
                )}
                <th>总成本 ¥</th>
                <th className="print-col">总成本 USD</th>
                <th>占比</th>
              </tr>
            </thead>
            <tbody>
              {result.costs.map((c) => (
                <tr key={c.key}>
                  <td>
                    <div className="font-medium text-foreground">{c.name}</div>
                    <small className="text-[10px] text-muted-foreground">{c.nameEn}</small>
                  </td>
                  <td className="is-left print-col hidden min-[1440px]:table-cell text-[11px] text-muted-foreground">{c.basis}</td>
                  {packFirst ? (
                    <>
                      <td>{miniCost(c.perMini)}</td>
                      <td>{fmt(c.perUnit)}</td>
                    </>
                  ) : (
                    <>
                      <td>{fmt(c.perUnit)}</td>
                      {perMiniCol && <td>{miniCost(c.perMini)}</td>}
                    </>
                  )}
                  <td className="font-medium">{fmt(c.total)}</td>
                  <td className="print-col">{fmt(c.total / result.fx)}</td>
                  <td>
                    <div className="flex items-center justify-end gap-2">
                      <span className="w-11 text-right">{pct(c.share)}</span>
                      <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted md:block">
                        <i
                          className="block h-full rounded-full bg-primary/60"
                          style={{ width: `${Math.min(100, c.share * 100).toFixed(1)}%` }}
                        />
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
              <tr className="is-total">
                <td>出厂总成本</td>
                <td className="is-left print-col text-[11px] text-muted-foreground">
                  各项分项严格汇总（互斥项目已自动清零）
                </td>
                {packFirst ? (
                  <>
                    <td>{miniCost(result.miniCost)}</td>
                    <td>{fmt(result.unitCost)}</td>
                  </>
                ) : (
                  <>
                    <td>{fmt(result.unitCost)}</td>
                    {perMiniCol && <td>{miniCost(result.miniCost)}</td>}
                  </>
                )}
                <td>{fmt(result.costTotal)}</td>
                <td className="print-col">{fmt(result.costTotal / result.fx)}</td>
                <td>100%</td>
              </tr>
            </tbody>
          </table>
        </div>
        {(result.warnings.length > 0 || result.notes.length > 0) && (
          <div className="quote-notices space-y-1.5 px-4 py-3">
            {result.warnings.map((w) => (
              <div
                key={w}
                className="flex items-start gap-1.5 rounded-md border border-amber-300/60 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-900"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{w}</span>
              </div>
            ))}
            {result.notes.map((n) => (
              <div
                key={n}
                className="flex items-start gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1.5 text-[11.5px] text-muted-foreground"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{n}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="print-card quote-block rounded-lg border bg-card shadow-sm">
        <div className="quote-block-head flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
          <h3 className="text-[13px] font-semibold">
            阶梯采购对比 <span className="font-normal text-muted-foreground">/ Volume tiers</span>
          </h3>
          <div className="text-[11px] text-muted-foreground">
            阶梯行按官方自动毛利率测算；当前行为 {qtyText(categoryId, result)}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="quote-table is-tight min-w-[560px]">
            <thead>
              <tr>
                <th>梯队</th>
                <th>{tierQtyHead(categoryId)}</th>
                {packed && <th>折合{result.packLabel}</th>}
                <th>毛利率</th>
                <th>单{result.unitLabel}成本 ¥</th>
                <th className="is-usd">{result.unitLabel}报价 $</th>
                {mini && <th className={miniRmb ? undefined : 'is-usd'}>{miniRmb ? `折合单${result.miniLabel}价 ¥` : `${result.miniLabel}报价 $`}</th>}
                <th>总货值 USD</th>
                <th className="is-left print-col hidden min-[1440px]:table-cell min-w-[130px]">谈判与锁客策略</th>
              </tr>
            </thead>
            <tbody>
              {result.tiers.map((t, i) => {
                const cur = Math.abs(t.qty - curQty) < 1e-9
                const note = (TIER_NOTES[categoryId] || [])[i] || ''
                return (
                  <tr key={t.qty} className={cur ? 'is-current' : undefined}>
                    <td>
                      <div className="flex items-center gap-1.5 font-medium text-foreground">
                        {t.label}
                        {cur && (
                          <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-normal">
                            当前
                          </Badge>
                        )}
                      </div>
                      <small className="text-[10px] text-muted-foreground">{t.labelEn}</small>
                    </td>
                    <td>{fmtInt(t.qty)}</td>
                    {packed && <td>{fmtInt(t.packs)}</td>}
                    <td>{pct(t.margin)}</td>
                    <td>{fmt(t.unitCost)}</td>
                    <td className="is-usd font-medium">{fmt(t.unitFob, 3)}</td>
                    {mini && <td className={miniRmb ? undefined : 'is-usd'}>{miniRmb ? fmt(t.miniPrice) : fmt(t.miniPrice / result.fx, 3)}</td>}
                    <td>{fmt(t.totalUSD)}</td>
                    <td className="is-left print-col hidden min-[1440px]:table-cell min-w-[130px] max-w-[180px] text-[10.5px] leading-relaxed text-muted-foreground">
                      {note}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="quote-terms">
        <b>Terms &amp; Conditions 交易条款</b>
        <br />
        1. Price basis: FOB / EXW, USD. Exchange rate 1 USD = {fmt(meta.fx, 2)} CNY.
        <br />
        2. Lead time: 25–35 days after deposit and artwork approval.
        <br />
        3. Payment: 30% T/T deposit, 70% balance before shipment.
        <br />
        4. Validity: 30 days from quotation date.
        <br />
        5. Packaging: export carton; OEM artwork / formula to be confirmed before production.
        <br />
        6. Quality: ISO 22716 / GMPC certified production; third-party testing on request.
      </div>
      <div className="quote-sign">
        <div>Seller 卖方：佛山京妍生物制品有限公司</div>
        <div>Buyer 买方：____________________________</div>
      </div>
    </div>
  )
}
