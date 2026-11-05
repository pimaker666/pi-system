export type JsonObject = Record<string, unknown>

export type PermissionItem = {
  path: string
  label: string
  description: string
}

export const permissionGroups: { title: string; description: string; items: PermissionItem[] }[] = [
  {
    title: '订单管理',
    description: '每日订单的查看、建单、发货和作废权限。',
    items: [
      { path: 'orders.view', label: '查看订单', description: '查看订单列表与详情' },
      { path: 'orders.create', label: '新建订单', description: '创建每日订单' },
      { path: 'orders.edit', label: '编辑订单', description: '修改已有订单信息' },
      { path: 'orders.void', label: '作废订单', description: '将订单标记为已作废' },
      { path: 'orders.approve', label: '审核订单', description: '处理订单审核操作' },
      { path: 'orders.ship', label: '登记发货', description: '创建和修改发货记录' },
      { path: 'orders.export', label: '导出订单', description: '导出订单台账与报表' },
      { path: 'orders.record_transfer', label: '登记订单转账', description: '登记收款和转账记录' },
    ],
  },
  {
    title: '财务与资料',
    description: '财务数据、产品、客户与 PI 的日常维护权限。',
    items: [
      { path: 'finance.page.overview', label: '财务总览', description: '查看财务汇总与最近订单' },
      { path: 'finance.page.journal', label: '财务日记账', description: '查看日记账、收支总览并导出流水' },
      { path: 'finance.page.costs', label: '订单成本', description: '查看订单成本并登记结算' },
      { path: 'finance.page.settled_orders', label: '已结算订单', description: '查看已结算订单列表' },
      { path: 'finance.page.profit', label: '利润核算', description: '查看订单利润与手续费' },
      { path: 'finance.page.commission_settled', label: '已结清订单', description: '查看已结清提成订单' },
      { path: 'finance.financial_number', label: '查看财务编号', description: '显示订单财务编号' },
      { path: 'finance.cost', label: '查看成本', description: '显示成本相关金额' },
      { path: 'finance.profit', label: '查看利润', description: '显示利润核算数据' },
      { path: 'finance.exchange_rate', label: '查看汇率', description: '显示订单和收款汇率' },
      { path: 'products.view', label: '查看产品', description: '浏览产品库和定制产品' },
      { path: 'products.edit', label: '维护产品', description: '新增、编辑产品资料' },
      { path: 'products.delete', label: '删除产品', description: '删除产品库和定制产品库产品' },
      { path: 'customers.view', label: '查看客户', description: '浏览客户资料与订单' },
      { path: 'customers.edit', label: '维护客户', description: '新增、编辑客户资料' },
      { path: 'pi.view', label: '查看 PI', description: '浏览 PI 与历史记录' },
      { path: 'pi.create', label: '新建 PI', description: '创建新的 PI' },
      { path: 'pi.edit', label: '编辑 PI', description: '修改 PI 内容' },
      { path: 'pi.void', label: '作废 PI', description: '将 PI 标记为已作废' },
    ],
  },
  {
    title: '系统管理',
    description: '账号、权限和审计记录的管理权限。',
    items: [
      { path: 'system.manage_users', label: '管理账号', description: '创建、启用和停用账号' },
      { path: 'system.manage_permissions', label: '管理权限', description: '配置角色、账号例外和审核规则' },
      { path: 'system.view_audit', label: '查看审计日志', description: '查看权限与订单操作记录' },
      { path: 'attendance.manage', label: '考勤工资管理', description: '维护考勤表、工资表与审批请假' },
      { path: 'company.settings', label: '公司设置', description: '修改公司资料、收款银行与 PI 默认币种' },
      { path: 'reimbursement.review', label: '报销审批', description: '审批报销单并标记打款完成' },
    ],
  },
]

export const sensitiveFields: PermissionItem[] = [
  { path: 'cost', label: '成本', description: '产品与订单成本金额' },
  { path: 'profit', label: '利润', description: '订单和产品利润金额' },
  { path: 'product_name', label: '产品名称', description: '产品与定制产品名称' },
  { path: 'exchange_rate', label: '汇率', description: '订单和收款汇率' },
  { path: 'financial_number', label: '财务编号', description: '订单财务编号' },
]

export function isEnabled(source: JsonObject, path: string) {
  return path.split('.').reduce<unknown>((value, key) => (
    value && typeof value === 'object' ? (value as JsonObject)[key] : undefined
  ), source) === true
}

export function setEnabled(source: JsonObject, path: string, enabled: boolean): JsonObject {
  const result = structuredClone(source)
  const keys = path.split('.')
  let current = result
  for (const key of keys.slice(0, -1)) {
    const value = current[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) current[key] = {}
    current = current[key] as JsonObject
  }
  current[keys[keys.length - 1]] = enabled
  return result
}
