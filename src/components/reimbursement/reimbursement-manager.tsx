'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Ban, Check, CircleCheckBig, Download, Eye, Pencil, Plus, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  completeReimbursementRequest,
  createReimbursementRequest,
  deleteReimbursementRequest,
  reviewReimbursementRequest,
  updateReimbursementRequest,
} from '@/lib/actions/reimbursement'
import { formatCny } from '@/lib/finance'
import { useFileDrop, useFilePaste, validateImageFile } from '@/lib/hooks/use-file-drop'
import { createClient } from '@/lib/supabase/client'
import { cn, displayProfileName, formatDate } from '@/lib/utils'
import type { FinanceReimbursementRequest, FinanceReimbursementStatus } from '@/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ImagePreview } from '@/components/ui/image-preview'

const RECEIPT_BUCKET = 'finance-reimbursement-receipts'

const STATUS_LABELS: Record<FinanceReimbursementStatus, string> = {
  pending: '待审批',
  approved: '已通过',
  rejected: '已驳回',
  completed: '已完成',
}

const STATUS_VARIANTS: Record<FinanceReimbursementStatus, 'secondary' | 'success' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  approved: 'success',
  rejected: 'destructive',
  completed: 'outline',
}

const STATUS_FILTERS: Array<{ value: FinanceReimbursementStatus | 'all'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待审批' },
  { value: 'approved', label: '已通过' },
  { value: 'rejected', label: '已驳回' },
  { value: 'completed', label: '已完成' },
]

interface ReimbursementManagerProps {
  requests: FinanceReimbursementRequest[]
  canViewAll: boolean
  canReview: boolean
  currentUserId: string
  today: string
}

export function ReimbursementManager({
  requests,
  canViewAll,
  canReview,
  currentUserId,
  today,
}: ReimbursementManagerProps) {
  const [statusFilter, setStatusFilter] = useState<FinanceReimbursementStatus | 'all'>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<FinanceReimbursementRequest | null>(null)
  const [detailTarget, setDetailTarget] = useState<FinanceReimbursementRequest | null>(null)
  const [rejectTarget, setRejectTarget] = useState<FinanceReimbursementRequest | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [pending, setPending] = useState(false)

  const counts = useMemo(() => {
    const map = new Map<FinanceReimbursementStatus, number>()
    for (const request of requests) {
      map.set(request.status, (map.get(request.status) ?? 0) + 1)
    }
    return map
  }, [requests])

  const filtered = useMemo(
    () =>
      statusFilter === 'all'
        ? requests
        : requests.filter((request) => request.status === statusFilter),
    [requests, statusFilter],
  )

  // detailTarget 只是打开时的快照，审批/完成后的最新状态要从刷新后的 requests 里取回
  const detailRequest = useMemo(
    () => (detailTarget ? requests.find((request) => request.id === detailTarget.id) ?? null : null),
    [requests, detailTarget],
  )

  async function runAction(action: () => Promise<{ ok: boolean; error?: string }>, success: string) {
    setPending(true)
    try {
      const result = await action()
      if (result.ok) {
        toast.success(success)
      } else {
        toast.error(result.error ?? '操作失败')
      }
      return result.ok
    } catch {
      toast.error('操作失败，请重试')
      return false
    } finally {
      setPending(false)
    }
  }

  function openCreate() {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(request: FinanceReimbursementRequest) {
    setEditing(request)
    setFormOpen(true)
  }

  async function handleSubmit(payload: ReimbursementFormPayload) {
    const ok = editing
      ? await runAction(
          () => updateReimbursementRequest(editing.id, payload),
          editing.status === 'rejected' ? '已保存并重新提交审批' : '报销单已保存',
        )
      : await runAction(() => createReimbursementRequest(payload), '报销单已提交，等待管理员审批')
    if (ok) setFormOpen(false)
  }

  async function handleApprove(request: FinanceReimbursementRequest) {
    await runAction(
      () => reviewReimbursementRequest({ request_id: request.id, decision: 'approve' }),
      '已通过该报销单',
    )
  }

  async function handleConfirmReject() {
    if (!rejectTarget) return
    const ok = await runAction(
      () =>
        reviewReimbursementRequest({
          request_id: rejectTarget.id,
          decision: 'reject',
          reject_reason: rejectReason,
        }),
      '已驳回该报销单',
    )
    if (ok) {
      setRejectTarget(null)
      setRejectReason('')
    }
  }

  async function handleComplete(request: FinanceReimbursementRequest) {
    await runAction(() => completeReimbursementRequest(request.id), '已确认报销完成')
  }

  async function handleDelete(request: FinanceReimbursementRequest) {
    if (!window.confirm(`确定删除 ${displayProfileName(request.applicant)} ${formatDate(request.expense_date)} 的报销单吗？`)) {
      return
    }
    await runAction(() => deleteReimbursementRequest(request.id), '报销单已删除')
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((filter) => (
              <SelectItem key={filter.value} value={filter.value}>
                {filter.label}
                {filter.value !== 'all' ? `（${counts.get(filter.value) ?? 0}）` : `（${requests.length}）`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新建报销单
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-28">报销日期</TableHead>
              <TableHead>报销人</TableHead>
              <TableHead>项目名称</TableHead>
              <TableHead className="text-right">明细数</TableHead>
              <TableHead className="text-right">合计金额</TableHead>
              <TableHead className="w-24">状态</TableHead>
              <TableHead>审批信息</TableHead>
              <TableHead className="w-44" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((request) => {
              const total = (request.items ?? []).reduce((sum, item) => sum + Number(item.amount), 0)
              const editable = request.applicant_id === currentUserId && ['pending', 'rejected'].includes(request.status)
              return (
                <TableRow key={request.id}>
                  <TableCell>{formatDate(request.expense_date)}</TableCell>
                  <TableCell className="font-medium">{displayProfileName(request.applicant)}</TableCell>
                  <TableCell>{request.project_name ?? '—'}</TableCell>
                  <TableCell className="text-right">{request.items?.length ?? 0}</TableCell>
                  <TableCell className="text-right font-medium">{formatCny(total)}</TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANTS[request.status]}>{STATUS_LABELS[request.status]}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {request.status === 'rejected' && request.reject_reason
                      ? `驳回：${request.reject_reason}`
                      : request.status === 'completed' && request.completed_at
                        ? `确认报销：${displayProfileName(request.completer)} · ${formatDate(request.completed_at, true)}`
                        : request.reviewed_at
                          ? `审批：${displayProfileName(request.reviewer)} · ${formatDate(request.reviewed_at, true)}`
                          : '—'}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => setDetailTarget(request)}
                        aria-label="查看明细"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={pending}
                        onClick={() => window.open(`/api/reimbursement/export?request_id=${request.id}`, '_blank')}
                        aria-label="下载报销单"
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      {editable && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            onClick={() => openEdit(request)}
                            aria-label="编辑报销单"
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={pending}
                            onClick={() => handleDelete(request)}
                            aria-label="删除报销单"
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {filtered.length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-12 text-center text-muted-foreground">
                  暂无报销单
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <ReimbursementFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        today={today}
        currentUserId={currentUserId}
        pending={pending}
        onSubmit={handleSubmit}
      />

      <ReimbursementDetailDialog
        request={detailRequest}
        onClose={() => setDetailTarget(null)}
        canReview={canReview}
        pending={pending}
        onApprove={handleApprove}
        onReject={(request) => {
          setRejectReason('')
          setRejectTarget(request)
        }}
        onComplete={handleComplete}
      />

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>驳回报销单</DialogTitle>
            <DialogDescription>
              {rejectTarget
                ? `${displayProfileName(rejectTarget.applicant)} · ${formatDate(rejectTarget.expense_date)}`
                : ''}
              ，请填写驳回原因，申请人修改后可重新提交。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="reject_reason">驳回原因</Label>
            <Input
              id="reject_reason"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="例如：缺少发票凭证"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)} disabled={pending}>
              取消
            </Button>
            <Button variant="destructive" onClick={handleConfirmReject} disabled={pending || !rejectReason.trim()}>
              确认驳回
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 新建 / 编辑报销单
// ---------------------------------------------------------------------------

interface ReimbursementFormPayload {
  expense_date: string
  project_name: string
  items: Array<{ summary: string; unit_price: number; quantity: number; receipt_paths: string[] }>
}

interface FormItem {
  key: string
  summary: string
  unitPrice: string
  quantity: string
  receiptPaths: string[]
  receiptUrls: Record<string, string>
}

function randomHexNibble() {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint8Array(1)
    crypto.getRandomValues(buffer)
    return buffer[0] % 16
  }
  return Math.floor(Math.random() * 16)
}

/**
 * 局域网 http 访问属于非安全上下文，crypto.randomUUID 不可用；
 * 凭证对象路径还要通过 Storage RLS 的 UUID 正则，回退必须仍是合法 v4 UUID。
 */
function newUuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (token) => {
    const random = randomHexNibble()
    const value = token === 'x' ? random : (random & 0x3) | 0x8
    return value.toString(16)
  })
}

function emptyFormItem(): FormItem {
  return {
    key: newUuid(),
    summary: '',
    unitPrice: '',
    quantity: '1',
    receiptPaths: [],
    receiptUrls: {},
  }
}

interface ReimbursementFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  editing: FinanceReimbursementRequest | null
  today: string
  currentUserId: string
  pending: boolean
  onSubmit: (payload: ReimbursementFormPayload) => Promise<void>
}

function ReimbursementFormDialog({
  open,
  onOpenChange,
  editing,
  today,
  currentUserId,
  pending,
  onSubmit,
}: ReimbursementFormDialogProps) {
  const [expenseDate, setExpenseDate] = useState(today)
  const [projectName, setProjectName] = useState('')
  const [items, setItems] = useState<FormItem[]>([emptyFormItem()])

  useEffect(() => {
    if (!open) return
    if (editing) {
      setExpenseDate(editing.expense_date)
      setProjectName(editing.project_name ?? '')
      setItems(
        (editing.items ?? []).map((item) => ({
          key: item.id,
          summary: item.summary,
          unitPrice: String(item.unit_price),
          quantity: String(item.quantity),
          receiptPaths: item.receipt_paths ?? [],
          receiptUrls: {},
        })),
      )
    } else {
      setExpenseDate(today)
      setProjectName('')
      setItems([emptyFormItem()])
    }
  }, [open, editing, today])

  // 编辑已有报销单时，为已上传的凭证批量签发临时链接用于预览
  useEffect(() => {
    if (!open || !editing) return
    const paths = (editing.items ?? []).flatMap((item) => item.receipt_paths ?? [])
    if (paths.length === 0) return
    let cancelled = false
    const supabase = createClient()
    supabase.storage
      .from(RECEIPT_BUCKET)
      .createSignedUrls(paths, 60 * 60)
      .then(({ data }) => {
        if (cancelled || !data) return
        const map: Record<string, string> = {}
        for (const entry of data) {
          if (entry.path && entry.signedUrl) map[entry.path] = entry.signedUrl
        }
        setItems((rows) =>
          rows.map((row) => {
            if (row.receiptPaths.length === 0) return row
            const nextUrls = { ...row.receiptUrls }
            for (const path of row.receiptPaths) {
              if (map[path]) nextUrls[path] = map[path]
            }
            return { ...row, receiptUrls: nextUrls }
          }),
        )
      })
    return () => {
      cancelled = true
    }
  }, [open, editing])

  function patchItem(key: string, patch: Partial<FormItem>) {
    setItems((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))
  }

  function handleSubmit() {
    const filled = items.filter((row) => row.summary.trim())
    if (!expenseDate) {
      toast.error('请选择报销日期')
      return
    }
    if (filled.length === 0) {
      toast.error('至少填写一条报销明细')
      return
    }
    const payload: ReimbursementFormPayload = {
      expense_date: expenseDate,
      project_name: projectName.trim(),
      items: filled.map((row) => ({
        summary: row.summary.trim(),
        unit_price: Number(row.unitPrice),
        quantity: Number(row.quantity),
        receipt_paths: row.receiptPaths,
      })),
    }
    void onSubmit(payload)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑报销单' : '新建报销单'}</DialogTitle>
          <DialogDescription>
            按行填写报销明细（摘要 / 单价 / 数量），每行可附最多 9 张凭证图片；提交后由管理员审批。
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="expense_date">报销日期</Label>
            <Input
              id="expense_date"
              type="date"
              value={expenseDate}
              onChange={(event) => setExpenseDate(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project_name">项目名称（可选）</Label>
            <Input
              id="project_name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="如：国际站 / 1688 / 办公室"
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>报销明细</Label>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[36%]">摘要</TableHead>
                  <TableHead className="w-28 text-right">单价（CNY）</TableHead>
                  <TableHead className="w-24 text-right">数量</TableHead>
                  <TableHead className="w-28 text-right">金额</TableHead>
                  <TableHead className="w-52">凭证图片</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((row) => (
                  <FormItemRow
                    key={row.key}
                    row={row}
                    currentUserId={currentUserId}
                    disabled={pending}
                    onPatch={(patch) => patchItem(row.key, patch)}
                    onRemove={() => setItems((rows) => rows.filter((item) => item.key !== row.key))}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setItems((rows) => [...rows, emptyFormItem()])}
            disabled={pending || items.length >= 100}
          >
            <Plus className="mr-2 h-4 w-4" />
            添加明细行
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {editing ? (editing.status === 'rejected' ? '保存并重新提交' : '保存') : '提交审批'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FormItemRow({
  row,
  currentUserId,
  disabled,
  onPatch,
  onRemove,
}: {
  row: FormItem
  currentUserId: string
  disabled: boolean
  onPatch: (patch: Partial<FormItem>) => void
  onRemove: () => void
}) {
  const unitPrice = Number(row.unitPrice)
  const quantity = Number(row.quantity)
  const amount = Number.isFinite(unitPrice) && Number.isFinite(quantity) ? unitPrice * quantity : null

  return (
    <TableRow>
      <TableCell>
        <Input
          value={row.summary}
          onChange={(event) => onPatch({ summary: event.target.value })}
          placeholder="如：吉宇物流运费"
          disabled={disabled}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min="0"
          step="0.0001"
          className="text-right"
          value={row.unitPrice}
          onChange={(event) => onPatch({ unitPrice: event.target.value })}
          disabled={disabled}
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          min="0"
          step="0.0001"
          className="text-right"
          value={row.quantity}
          onChange={(event) => onPatch({ quantity: event.target.value })}
          disabled={disabled}
        />
      </TableCell>
      <TableCell className="text-right font-medium">
        {amount !== null && amount > 0 ? formatCny(amount) : '—'}
      </TableCell>
      <TableCell>
        <ReceiptUploader
          paths={row.receiptPaths}
          urls={row.receiptUrls}
          currentUserId={currentUserId}
          disabled={disabled}
          onChange={(paths, urls) => onPatch({ receiptPaths: paths, receiptUrls: urls })}
        />
      </TableCell>
      <TableCell>
        <Button variant="ghost" size="icon" onClick={onRemove} disabled={disabled} aria-label="删除明细行">
          <X className="h-4 w-4 text-destructive" />
        </Button>
      </TableCell>
    </TableRow>
  )
}

const MAX_RECEIPTS_PER_ITEM = 9

function ReceiptUploader({
  paths,
  urls,
  currentUserId,
  disabled,
  onChange,
}: {
  paths: string[]
  urls: Record<string, string>
  currentUserId: string
  disabled: boolean
  onChange: (paths: string[], urls: Record<string, string>) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const { dragging, dropProps } = useFileDrop({
    disabled: disabled || uploading,
    onFile: (file) => void handleFiles([file]),
  })

  const { pasteRef } = useFilePaste({
    disabled: disabled || uploading,
    onFiles: (files) => void handleFiles(files),
  })

  async function handleFiles(files: File[]) {
    const room = MAX_RECEIPTS_PER_ITEM - paths.length
    if (room <= 0) {
      toast.error(`每行凭证最多 ${MAX_RECEIPTS_PER_ITEM} 张`)
      return
    }
    if (files.length > room) toast.error(`超出上限，仅上传前 ${room} 张`)
    const supabase = createClient()
    setUploading(true)
    const nextPaths = [...paths]
    const nextUrls = { ...urls }
    let failed = 0
    try {
      for (const file of files.slice(0, room)) {
        const invalid = validateImageFile(file, ['image/jpeg', 'image/png'])
        if (invalid) {
          failed += 1
          continue
        }
        const extension = file.name.split('.').pop()?.toLowerCase() ?? 'png'
        const path = `${currentUserId}/${newUuid()}.${extension}`
        const { error: uploadError } = await supabase.storage
          .from(RECEIPT_BUCKET)
          .upload(path, file, { contentType: file.type })
        if (uploadError) {
          failed += 1
          continue
        }
        const { data, error: urlError } = await supabase.storage
          .from(RECEIPT_BUCKET)
          .createSignedUrl(path, 60 * 60)
        if (urlError) {
          failed += 1
          continue
        }
        nextPaths.push(path)
        nextUrls[path] = data.signedUrl
      }
      if (nextPaths.length > paths.length) onChange(nextPaths, nextUrls)
      if (failed > 0) toast.error(`${failed} 张凭证上传失败，请重试`)
    } finally {
      setUploading(false)
    }
  }

  function handleRemove(path: string) {
    const nextUrls = { ...urls }
    delete nextUrls[path]
    onChange(
      paths.filter((p) => p !== path),
      nextUrls,
    )
  }

  return (
    <div
      ref={pasteRef}
      {...dropProps}
      className={cn(
        'rounded-md border border-dashed p-1 text-xs transition-colors',
        dragging ? 'border-primary bg-primary/5' : 'border-input',
        disabled && 'opacity-50',
      )}
    >
      {paths.length > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {paths.map((path) => (
            <div key={path} className="relative">
              <ImagePreview src={urls[path] ?? null} alt="凭证预览" size="h-11 w-11" sizes="44px" rawSrc />
              {!disabled && (
                <button
                  type="button"
                  onClick={() => handleRemove(path)}
                  className="absolute -right-1 -top-1 rounded-full bg-background/90 p-0.5 shadow"
                  aria-label="移除凭证"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {paths.length < MAX_RECEIPTS_PER_ITEM && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || uploading}
          className="flex h-8 w-full flex-col items-center justify-center gap-0.5 text-muted-foreground"
        >
          <Upload className="h-4 w-4" />
          {uploading ? '上传中…' : paths.length > 0 ? '继续添加（点击或拖入）' : '点击或拖入'}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) void handleFiles(files)
          event.target.value = ''
        }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// 明细查看（含凭证图、审批操作）
// ---------------------------------------------------------------------------

function ReimbursementDetailDialog({
  request,
  onClose,
  canReview,
  pending,
  onApprove,
  onReject,
  onComplete,
}: {
  request: FinanceReimbursementRequest | null
  onClose: () => void
  canReview: boolean
  pending: boolean
  onApprove: (request: FinanceReimbursementRequest) => void
  onReject: (request: FinanceReimbursementRequest) => void
  onComplete: (request: FinanceReimbursementRequest) => void
}) {
  const [receiptUrls, setReceiptUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!request) {
      setReceiptUrls({})
      return
    }
    const paths = (request.items ?? []).flatMap((item) => item.receipt_paths ?? [])
    if (paths.length === 0) return
    let cancelled = false
    const supabase = createClient()
    supabase.storage
      .from(RECEIPT_BUCKET)
      .createSignedUrls(paths, 60 * 60)
      .then(({ data }) => {
        if (cancelled || !data) return
        const map: Record<string, string> = {}
        for (const entry of data) {
          if (entry.path && entry.signedUrl) map[entry.path] = entry.signedUrl
        }
        setReceiptUrls(map)
      })
    return () => {
      cancelled = true
    }
  }, [request])

  const total = (request?.items ?? []).reduce((sum, item) => sum + Number(item.amount), 0)

  return (
    <Dialog open={!!request} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            费用报销单 · {request ? displayProfileName(request.applicant) : ''}
          </DialogTitle>
          <DialogDescription>
            {request ? `报销日期：${formatDate(request.expense_date)}` : ''}
            {request?.project_name ? ` · 项目名称：${request.project_name}` : ''}
          </DialogDescription>
        </DialogHeader>
        {request && (
          <div className="space-y-4">
            <div className="rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>摘要</TableHead>
                    <TableHead className="w-24 text-right">单价</TableHead>
                    <TableHead className="w-20 text-right">数量</TableHead>
                    <TableHead className="w-24 text-right">金额</TableHead>
                    <TableHead className="w-44">凭证</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(request.items ?? []).map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="whitespace-pre-wrap font-medium">{item.summary}</TableCell>
                      <TableCell className="text-right">{formatCny(Number(item.unit_price))}</TableCell>
                      <TableCell className="text-right">{Number(item.quantity)}</TableCell>
                      <TableCell className="text-right font-medium">{formatCny(Number(item.amount))}</TableCell>
                      <TableCell>
                        {(item.receipt_paths ?? []).length > 0 ? (
                          <div className="flex flex-wrap gap-1.5">
                            {(item.receipt_paths ?? []).map((path) =>
                              receiptUrls[path] ? (
                                <ImagePreview
                                  key={path}
                                  src={receiptUrls[path]}
                                  alt="报销凭证"
                                  size="h-14 w-20"
                                  sizes="80px"
                                  rawSrc
                                />
                              ) : (
                                <span key={path} className="text-xs text-muted-foreground">
                                  凭证加载中…
                                </span>
                              ),
                            )}
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground">无凭证</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  <TableRow>
                    <TableCell colSpan={3} className="font-medium">
                      合计
                    </TableCell>
                    <TableCell className="text-right font-semibold">{formatCny(total)}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm text-muted-foreground">
              <span>
                状态：<Badge variant={STATUS_VARIANTS[request.status]}>{STATUS_LABELS[request.status]}</Badge>
              </span>
              {request.reviewed_at && (
                <span>
                  审批人:{displayProfileName(request.reviewer)} · {formatDate(request.reviewed_at, true)}
                </span>
              )}
              {request.status === 'rejected' && request.reject_reason && (
                <span className="text-destructive">驳回原因：{request.reject_reason}</span>
              )}
            </div>

            {canReview && (
              <DialogFooter className="gap-2 sm:gap-2">
                {request.status === 'pending' && (
                  <>
                    <Button variant="outline" onClick={() => onReject(request)} disabled={pending}>
                      <Ban className="mr-2 h-4 w-4" />
                      驳回
                    </Button>
                    <Button onClick={() => onApprove(request)} disabled={pending}>
                      <Check className="mr-2 h-4 w-4" />
                      通过
                    </Button>
                  </>
                )}
                {request.status === 'approved' && (
                  <Button onClick={() => onComplete(request)} disabled={pending}>
                    <CircleCheckBig className="mr-2 h-4 w-4" />
                    确认报销完成
                  </Button>
                )}
              </DialogFooter>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
