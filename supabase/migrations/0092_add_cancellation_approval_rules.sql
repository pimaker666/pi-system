alter table public.order_edit_approval_rules
  drop constraint if exists order_edit_approval_rules_trigger_actions_check;

alter table public.order_edit_approval_rules
  add constraint order_edit_approval_rules_trigger_actions_check check (
    cardinality(trigger_actions) > 0
    and trigger_actions <@ array[
      'order_edit',
      'amount_or_rate_change',
      'shipment_change',
      'void_order',
      'commission_clearance_cancel',
      'item_settlement_cancel'
    ]::text[]
  );

insert into public.order_edit_approval_rules (
  name,
  enabled,
  target,
  trigger_actions,
  conditions,
  reviewer_roles,
  reviewer_ids,
  approval_mode
) values
  (
    '已结清订单取消结清审核',
    false,
    'business_order',
    array['commission_clearance_cancel']::text[],
    '{}'::jsonb,
    array['admin', 'finance']::public.user_role[],
    '{}'::uuid[],
    'any'
  ),
  (
    '已结算订单取消结算审核',
    false,
    'business_order',
    array['item_settlement_cancel']::text[],
    '{}'::jsonb,
    array['admin', 'finance']::public.user_role[],
    '{}'::uuid[],
    'any'
  )
on conflict (name) do nothing;
