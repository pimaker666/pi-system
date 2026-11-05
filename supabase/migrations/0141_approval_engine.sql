-- 0141 通用审批引擎
-- 1) 规则：按业务动作配置开关、条件、审核角色/账号、通过方式
-- 2) 请求：命中规则的写入动作先生成审批请求，通过后自动执行原业务逻辑
-- 3) 默认规则沿用上线前的现状：订单审核仅管理员，其余动作不要求审批

begin;

-- -----------------------------------------------------------------------------
-- 1. 规则
-- -----------------------------------------------------------------------------
create table if not exists public.approval_rules (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  action_key text not null unique,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  enabled boolean not null default false,
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions) = 'object'),
  approver_roles public.user_role[] not null default '{}'::public.user_role[],
  approver_ids uuid[] not null default '{}'::uuid[],
  mode text not null default 'any' check (mode in ('any', 'sequential')),
  allow_self_approval boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null,
  constraint approval_rules_requires_approver check (
    not enabled or cardinality(approver_roles) > 0 or cardinality(approver_ids) > 0
  )
);

comment on table public.approval_rules is
  '审批规则：action_key 对应已接入的业务动作，enabled=false 表示直接执行（沿用现状）。';

alter table public.approval_rules enable row level security;
revoke all on table public.approval_rules from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.approval_rules to service_role;

-- -----------------------------------------------------------------------------
-- 2. 请求 / 步骤 / 事件
-- -----------------------------------------------------------------------------
create table if not exists public.approval_requests (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  action_key text not null references public.approval_rules(action_key) on delete restrict,
  entity_type text not null,
  entity_id uuid not null,
  rule_id uuid references public.approval_rules(id) on delete set null,
  rule_snapshot jsonb not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  summary text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'cancelled', 'applied', 'apply_failed')),
  current_step int not null default 1,
  requested_by uuid not null references public.profiles(id) on delete cascade,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  applied_at timestamptz,
  note text,
  apply_error text
);

create unique index if not exists uq_approval_requests_pending_entity
  on public.approval_requests (action_key, entity_id)
  where status = 'pending';
create index if not exists idx_approval_requests_status_requested
  on public.approval_requests (status, requested_at desc);
create index if not exists idx_approval_requests_requester
  on public.approval_requests (requested_by, requested_at desc);

create table if not exists public.approval_steps (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  step_no int not null,
  approver_roles public.user_role[] not null default '{}'::public.user_role[],
  approver_ids uuid[] not null default '{}'::uuid[],
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'skipped')),
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  note text,
  unique (request_id, step_no)
);

create index if not exists idx_approval_steps_request
  on public.approval_steps (request_id, step_no);

create table if not exists public.approval_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.approval_requests(id) on delete cascade,
  event text not null,
  actor_id uuid references public.profiles(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_approval_events_request
  on public.approval_events (request_id, created_at);

alter table public.approval_requests enable row level security;
alter table public.approval_steps enable row level security;
alter table public.approval_events enable row level security;
revoke all on table public.approval_requests from public, anon, authenticated, service_role;
revoke all on table public.approval_steps from public, anon, authenticated, service_role;
revoke all on table public.approval_events from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.approval_requests to service_role;
grant select, insert, update, delete on table public.approval_steps to service_role;
grant select, insert, update, delete on table public.approval_events to service_role;

-- -----------------------------------------------------------------------------
-- 3. 基础判断
-- -----------------------------------------------------------------------------
create or replace function public.approval_profiles_eligible(
  p_roles public.user_role[],
  p_ids uuid[]
)
returns table (profile_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select p.id
  from public.profiles p
  where p.status::text = 'approved'
    and (
      p.role = any(coalesce(p_roles, '{}'::public.user_role[]))
      or p.id = any(coalesce(p_ids, '{}'::uuid[]))
    );
$$;

create or replace function public.approval_actor_eligible(
  p_profile_id uuid,
  p_roles public.user_role[],
  p_ids uuid[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.approval_profiles_eligible(p_roles, p_ids) e
    where e.profile_id = p_profile_id
  );
$$;

create or replace function public.approval_rule_for(p_action_key text)
returns public.approval_rules
language sql
stable
security definer
set search_path = public
as $$
  select * from public.approval_rules where action_key = p_action_key and enabled limit 1;
$$;

create or replace function public.approval_condition_met(
  p_conditions jsonb,
  p_amount numeric
)
returns boolean
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce(p_conditions->>'amount_gte', '')), '') is null then true
    when p_amount is null then false
    else p_amount >= (p_conditions->>'amount_gte')::numeric
  end;
$$;

-- 某个待审批请求当前步骤是否轮到 p_uid；自己提交且无其他审核人时允许自审。
create or replace function public.approval_is_eligible_for_request(
  p_request_id uuid,
  p_uid uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests%rowtype;
  v_step public.approval_steps%rowtype;
  v_eligible uuid[];
  v_allow_self boolean;
begin
  if p_uid is null then return false; end if;
  select * into v_request from public.approval_requests where id = p_request_id;
  if not found or v_request.status <> 'pending' then return false; end if;
  select * into v_step
  from public.approval_steps
  where request_id = p_request_id and step_no = v_request.current_step;
  if not found then return false; end if;

  select coalesce(array_agg(e.profile_id), '{}'::uuid[]) into v_eligible
  from public.approval_profiles_eligible(v_step.approver_roles, v_step.approver_ids) e;

  if p_uid <> all (v_eligible) then return false; end if;
  v_allow_self := coalesce((v_request.rule_snapshot->>'allow_self_approval')::boolean, false);
  if p_uid <> v_request.requested_by or v_allow_self then return true; end if;
  -- 自己是唯一审核人时兜底放行，避免单人团队永久卡死。
  return not exists (select 1 from unnest(v_eligible) e where e <> p_uid);
end;
$$;

-- 业务 RPC 内的强制闸门：规则开启且当前人不是审核人、也不在审批执行上下文中时直接拒绝。
create or replace function public.approval_assert(
  p_action_key text,
  p_entity_id uuid,
  p_amount numeric default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_rule public.approval_rules%rowtype;
  v_request_id uuid;
begin
  if v_uid is null then raise exception 'Approved account required'; end if;
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;

  select * into v_rule from public.approval_rule_for(p_action_key);
  if v_rule.id is null then return; end if;
  if not public.approval_condition_met(v_rule.conditions, p_amount) then return; end if;
  if public.approval_actor_eligible(v_uid, v_rule.approver_roles, v_rule.approver_ids) then return; end if;

  v_request_id := nullif(current_setting('app.approval_request_id', true), '')::uuid;
  if v_request_id is not null and exists (
    select 1 from public.approval_requests r
    where r.id = v_request_id
      and r.action_key = p_action_key
      and r.entity_id = p_entity_id
      and r.status in ('approved', 'apply_failed')
  ) then
    return;
  end if;

  raise exception 'APPROVAL_REQUIRED:%', p_action_key;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. 对外查询 / 提交 / 决策
-- -----------------------------------------------------------------------------
create or replace function public.approval_check(
  p_action_key text,
  p_entity_id uuid,
  p_amount numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_rule public.approval_rules%rowtype;
begin
  if v_uid is null then raise exception 'Approved account required'; end if;
  select * into v_rule from public.approval_rule_for(p_action_key);
  if v_rule.id is null then
    return jsonb_build_object('required', false, 'reason', 'rule_disabled');
  end if;
  if not public.approval_condition_met(v_rule.conditions, p_amount) then
    return jsonb_build_object('required', false, 'reason', 'condition_not_met', 'rule_id', v_rule.id);
  end if;
  if public.approval_actor_eligible(v_uid, v_rule.approver_roles, v_rule.approver_ids) then
    return jsonb_build_object('required', false, 'reason', 'actor_is_approver', 'rule_id', v_rule.id);
  end if;
  return jsonb_build_object(
    'required', true,
    'rule_id', v_rule.id,
    'rule_name', v_rule.name,
    'mode', v_rule.mode,
    'approvers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id,
        'name', coalesce(nullif(btrim(p.chinese_name), ''), nullif(btrim(p.full_name), ''), p.email),
        'role', p.role
      ) order by p.role, p.full_name)
      from public.approval_profiles_eligible(v_rule.approver_roles, v_rule.approver_ids) e
      join public.profiles p on p.id = e.profile_id
      where p.id <> v_uid
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.approval_request_create(
  p_action_key text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb,
  p_summary text,
  p_amount numeric default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_rule public.approval_rules%rowtype;
  v_order public.business_orders%rowtype;
  v_request_id uuid;
  v_role public.user_role;
  v_id uuid;
  v_step int := 0;
  v_total int;
begin
  if v_uid is null then raise exception 'Approved account required'; end if;
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;

  select * into v_rule from public.approval_rule_for(p_action_key);
  if v_rule.id is null then raise exception '该动作未启用审批规则'; end if;
  if jsonb_typeof(p_payload) <> 'object' or nullif(btrim(coalesce(p_summary, '')), '') is null then
    raise exception '审批内容无效';
  end if;

  if p_action_key in ('order_edit', 'item_adjust', 'void_order') then
    select * into v_order from public.business_orders bo where bo.id = p_entity_id;
    if not found then raise exception '业务订单不存在'; end if;
    if v_actor.role::text not in ('admin', 'finance') and v_order.salesperson_id <> v_uid then
      raise exception '只能对本人负责的订单发起审批';
    end if;
    if p_action_key = 'void_order' and v_actor.role::text not in ('admin', 'finance') then
      raise exception '订单作废需管理员或财务发起';
    end if;
    -- 金额以库内订单为准，不信任客户端传入值，保证与闸门判定口径一致。
    p_amount := coalesce(v_order.total_sales_amount, 0);
  elsif p_action_key = 'cost_override' then
    if v_actor.role::text not in ('admin', 'finance') then
      raise exception '成本覆盖需财务或管理员发起';
    end if;
  else
    raise exception '不支持的审批动作';
  end if;

  if not public.approval_condition_met(v_rule.conditions, p_amount) then
    raise exception '该动作未达到审批条件，可直接执行';
  end if;

  if exists (
    select 1 from public.approval_requests r
    where r.action_key = p_action_key and r.entity_id = p_entity_id and r.status = 'pending'
  ) then
    raise exception '该对象已有待审批申请，请先处理';
  end if;

  insert into public.approval_requests (
    action_key, entity_type, entity_id, rule_id, rule_snapshot,
    payload, summary, requested_by
  ) values (
    p_action_key, p_entity_type, p_entity_id, v_rule.id, to_jsonb(v_rule) - 'id' - 'created_at' - 'updated_at',
    p_payload, btrim(p_summary), v_uid
  ) returning id into v_request_id;

  if v_rule.mode = 'any' then
    insert into public.approval_steps (request_id, step_no, approver_roles, approver_ids)
    values (v_request_id, 1, v_rule.approver_roles, v_rule.approver_ids);
  else
    foreach v_role in array v_rule.approver_roles loop
      v_step := v_step + 1;
      insert into public.approval_steps (request_id, step_no, approver_roles)
      values (v_request_id, v_step, array[v_role]);
    end loop;
    foreach v_id in array v_rule.approver_ids loop
      v_step := v_step + 1;
      insert into public.approval_steps (request_id, step_no, approver_ids)
      values (v_request_id, v_step, array[v_id]);
    end loop;
  end if;

  select count(*) into v_total from public.approval_steps where request_id = v_request_id;
  if v_total = 0 then
    raise exception '审批规则没有可用审核人';
  end if;

  insert into public.approval_events (request_id, event, actor_id, detail)
  values (v_request_id, 'submitted', v_uid, jsonb_build_object('summary', p_summary));

  return v_request_id;
end;
$$;

create or replace function public.approval_cancel(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_request public.approval_requests%rowtype;
begin
  select * into v_request from public.approval_requests where id = p_request_id for update;
  if not found then raise exception '审批请求不存在'; end if;
  if v_request.requested_by <> v_uid then raise exception '只能撤回自己提交的申请'; end if;
  if v_request.status <> 'pending' then raise exception '该申请已处理，无法撤回'; end if;
  update public.approval_requests set status = 'cancelled', decided_at = now() where id = p_request_id;
  update public.approval_steps set status = 'skipped' where request_id = p_request_id and status = 'pending';
  insert into public.approval_events (request_id, event, actor_id) values (p_request_id, 'cancelled', v_uid);
  return jsonb_build_object('status', 'cancelled');
end;
$$;

-- 内部执行器：把审批通过的 payload 重放成业务动作。
create or replace function public.approval_apply(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.approval_requests%rowtype;
  v_payload jsonb;
  v_order public.business_orders%rowtype;
  v_edit record;
  v_json jsonb;
begin
  select * into v_request from public.approval_requests where id = p_request_id for update;
  if not found then raise exception '审批请求不存在'; end if;
  if v_request.status not in ('approved', 'apply_failed') then
    raise exception '审批请求当前状态不可执行';
  end if;
  v_payload := v_request.payload;
  perform set_config('app.approval_request_id', p_request_id::text, true);

  case v_request.action_key
    when 'order_edit' then
      select * into v_edit from public.update_business_order_v6(
        (v_payload->>'order_id')::uuid,
        (v_payload->>'expected_version')::int,
        nullif(v_payload->>'customer_id', '')::uuid,
        (v_payload->>'order_date')::date,
        (v_payload->>'fulfillment_type')::public.business_fulfillment_type,
        (v_payload->>'currency')::public.currency_code,
        (v_payload->>'exchange_rate_to_cny')::numeric,
        (v_payload->>'shipping_fee')::numeric,
        nullif(v_payload->>'tracking_number', ''),
        nullif(v_payload->>'sales_notes', ''),
        v_payload->'items',
        nullif(v_payload->>'payment_due_date', '')::date,
        nullif(v_payload->>'reason', ''),
        nullif(v_payload->>'shop_id', '')::uuid,
        nullif(v_payload->>'salesperson_id', '')::uuid,
        nullif(v_payload->>'external_order_number', ''),
        nullif(v_payload->>'daily_shipping_date', '')::date,
        nullif(v_payload->>'daily_shipping_number', ''),
        nullif(v_payload->>'daily_payment_category', '')::public.daily_order_payment_category,
        (v_payload->>'total_product_received_amount')::numeric,
        (v_payload->>'total_product_received_overridden')::boolean,
        (v_payload->>'total_shipping_received_amount')::numeric,
        (v_payload->>'total_shipping_received_overridden')::boolean,
        (v_payload->>'total_sales_amount')::numeric,
        (v_payload->>'total_sales_overridden')::boolean,
        nullif(v_payload->>'receivable_received_difference_reason', ''),
        nullif(v_payload->>'payment_account', ''),
        nullif(v_payload->>'order_fee', '')::numeric
      );
      if v_edit.id is null then raise exception '订单编辑未返回结果'; end if;
    when 'item_adjust' then
      v_json := public.adjust_business_order_items(
        (v_payload->>'order_id')::uuid,
        (v_payload->>'expected_version')::int,
        v_payload->'items',
        nullif(v_payload->>'reason_type', ''),
        nullif(v_payload->>'reason', ''),
        nullif(v_payload->>'idempotency_key', '')
      );
    when 'void_order' then
      select * into v_order from public.void_business_order(
        (v_payload->>'order_id')::uuid,
        (v_payload->>'expected_version')::int,
        v_payload->>'reason',
        v_payload->>'idempotency_key'
      );
    when 'cost_override' then
      if nullif(v_payload->>'cost', '') is null then
        delete from public.finance_business_order_item_cost_overrides
        where business_order_item_id in (
          select (value)::uuid from jsonb_array_elements_text(v_payload->'item_ids')
        );
      else
        insert into public.finance_business_order_item_cost_overrides (
          business_order_item_id, cost, updated_by
        )
        select (value)::uuid, (v_payload->>'cost')::numeric, v_request.requested_by
        from jsonb_array_elements_text(v_payload->'item_ids')
        on conflict (business_order_item_id) do update set
          cost = excluded.cost,
          updated_by = excluded.updated_by,
          updated_at = now();
      end if;
    else
      raise exception '不支持的审批动作：%', v_request.action_key;
  end case;

  perform set_config('app.approval_request_id', '', true);
end;
$$;

create or replace function public.approval_decide(
  p_request_id uuid,
  p_decision text,
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_request public.approval_requests%rowtype;
  v_step public.approval_steps%rowtype;
  v_next public.approval_steps%rowtype;
  v_decision text := lower(btrim(coalesce(p_decision, '')));
begin
  if v_decision not in ('approve', 'reject') then raise exception '审批决定无效'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception '审批说明不能超过 1000 字'; end if;

  select * into v_request from public.approval_requests where id = p_request_id for update;
  if not found then raise exception '审批请求不存在'; end if;
  if v_request.status <> 'pending' then raise exception '该申请已处理'; end if;
  if not public.approval_is_eligible_for_request(p_request_id, v_uid) then
    raise exception '当前账号无权审批该申请';
  end if;

  select * into v_step
  from public.approval_steps
  where request_id = p_request_id and step_no = v_request.current_step
  for update;
  if not found then raise exception '审批步骤不存在'; end if;

  if v_decision = 'reject' then
    if nullif(btrim(coalesce(p_note, '')), '') is null then raise exception '驳回时必须填写原因'; end if;
    update public.approval_steps
    set status = 'rejected', decided_by = v_uid, decided_at = now(), note = btrim(p_note)
    where id = v_step.id;
    update public.approval_requests
    set status = 'rejected', decided_at = now(), note = btrim(p_note)
    where id = p_request_id;
    insert into public.approval_events (request_id, event, actor_id, detail)
    values (p_request_id, 'rejected', v_uid, jsonb_build_object('note', btrim(p_note)));
    return jsonb_build_object('status', 'rejected');
  end if;

  update public.approval_steps
  set status = 'approved', decided_by = v_uid, decided_at = now(), note = nullif(btrim(coalesce(p_note, '')), '')
  where id = v_step.id;

  select * into v_next
  from public.approval_steps
  where request_id = p_request_id and step_no > v_request.current_step
  order by step_no
  limit 1;

  if found and v_request.rule_snapshot->>'mode' = 'sequential' then
    update public.approval_requests set current_step = v_next.step_no where id = p_request_id;
    insert into public.approval_events (request_id, event, actor_id, detail)
    values (p_request_id, 'step_approved', v_uid, jsonb_build_object('step_no', v_step.step_no));
    return jsonb_build_object('status', 'pending', 'current_step', v_next.step_no);
  end if;

  update public.approval_requests
  set status = 'approved', decided_at = now(), note = nullif(btrim(coalesce(p_note, '')), '')
  where id = p_request_id;
  insert into public.approval_events (request_id, event, actor_id, detail)
  values (p_request_id, 'approved', v_uid, jsonb_build_object('note', nullif(btrim(coalesce(p_note, '')), '')));

  begin
    perform public.approval_apply(p_request_id);
  exception when others then
    perform set_config('app.approval_request_id', '', true);
    update public.approval_requests
    set status = 'apply_failed', apply_error = sqlerrm
    where id = p_request_id;
    insert into public.approval_events (request_id, event, actor_id, detail)
    values (p_request_id, 'apply_failed', v_uid, jsonb_build_object('error', sqlerrm));
    return jsonb_build_object('status', 'apply_failed', 'error', sqlerrm);
  end;

  update public.approval_requests set status = 'applied', applied_at = now() where id = p_request_id;
  insert into public.approval_events (request_id, event, actor_id)
  values (p_request_id, 'applied', v_uid);
  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function public.approval_retry(p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_request public.approval_requests%rowtype;
begin
  select * into v_request from public.approval_requests where id = p_request_id for update;
  if not found then raise exception '审批请求不存在'; end if;
  if v_request.status <> 'apply_failed' then raise exception '该申请不需要重试'; end if;
  if not public.approval_actor_eligible(v_uid, '{admin}'::public.user_role[], '{}'::uuid[])
     and not public.approval_is_eligible_for_request(p_request_id, v_uid) then
    raise exception '无权重试该申请';
  end if;

  update public.approval_requests set status = 'approved', apply_error = null where id = p_request_id;
  begin
    perform public.approval_apply(p_request_id);
  exception when others then
    perform set_config('app.approval_request_id', '', true);
    update public.approval_requests set status = 'apply_failed', apply_error = sqlerrm where id = p_request_id;
    return jsonb_build_object('status', 'apply_failed', 'error', sqlerrm);
  end;
  update public.approval_requests set status = 'applied', applied_at = now() where id = p_request_id;
  insert into public.approval_events (request_id, event, actor_id) values (p_request_id, 'applied_retry', v_uid);
  return jsonb_build_object('status', 'applied');
end;
$$;

create or replace function public.approval_inbox(p_scope text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
begin
  if v_uid is null then raise exception 'Approved account required'; end if;
  if p_scope not in ('pending', 'mine', 'done') then raise exception '审批范围无效'; end if;

  select coalesce(jsonb_agg(item order by requested_at desc), '[]'::jsonb)
  into v_result
  from (
    select
      jsonb_build_object(
        'id', r.id,
        'action_key', r.action_key,
        'action_name', coalesce(r.rule_snapshot->>'name', r.action_key),
        'entity_type', r.entity_type,
        'entity_id', r.entity_id,
        'summary', r.summary,
        'status', r.status,
        'requested_by', r.requested_by,
        'requester_name', coalesce(nullif(btrim(p.chinese_name), ''), nullif(btrim(p.full_name), ''), p.email, '未知账号'),
        'requested_at', r.requested_at,
        'decided_at', r.decided_at,
        'applied_at', r.applied_at,
        'note', r.note,
        'apply_error', r.apply_error,
        'current_step', r.current_step,
        'order_number', o.order_number,
        'can_decide', public.approval_is_eligible_for_request(r.id, v_uid),
        'steps', coalesce((
          select jsonb_agg(jsonb_build_object(
            'step_no', s.step_no,
            'status', s.status,
            'approver_roles', s.approver_roles,
            'approver_ids', s.approver_ids,
            'decided_by', s.decided_by,
            'decided_at', s.decided_at,
            'note', s.note
          ) order by s.step_no)
          from public.approval_steps s
          where s.request_id = r.id
        ), '[]'::jsonb)
      ) as item,
      r.requested_at
    from public.approval_requests r
    left join public.profiles p on p.id = r.requested_by
    left join public.business_orders o on r.entity_type = 'business_order' and o.id = r.entity_id
    where case p_scope
      when 'pending' then r.status = 'pending' and public.approval_is_eligible_for_request(r.id, v_uid)
      when 'mine' then r.requested_by = v_uid
      else r.status <> 'pending' and (
        r.requested_by = v_uid
        or exists (
          select 1 from public.approval_steps s2
          where s2.request_id = r.id and s2.decided_by = v_uid
        )
      )
    end
    order by r.requested_at desc
    limit 200
  ) t;

  return v_result;
end;
$$;

create or replace function public.approval_pending_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select count(*)::int
  from public.approval_requests r
  where r.status = 'pending'
    and public.approval_is_eligible_for_request(r.id, (select auth.uid()));
$$;

create or replace function public.can_review_business_order(p_order_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_rule public.approval_rules%rowtype;
  v_order public.business_orders%rowtype;
  v_other_approver boolean;
begin
  if v_uid is null then return false; end if;
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then return false; end if;

  select * into v_rule from public.approval_rule_for('business_order.review');
  if v_rule.id is null then
    return v_actor.role::text = 'admin';
  end if;
  if not public.approval_actor_eligible(v_uid, v_rule.approver_roles, v_rule.approver_ids) then
    return false;
  end if;

  select * into v_order from public.business_orders bo where bo.id = p_order_id;
  if not found then return false; end if;
  if v_rule.allow_self_approval or v_order.submitted_by is distinct from v_uid then
    return true;
  end if;

  select exists (
    select 1 from public.approval_profiles_eligible(v_rule.approver_roles, v_rule.approver_ids) e
    where e.profile_id <> v_uid
  ) into v_other_approver;
  return not v_other_approver;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. 规则配置
-- -----------------------------------------------------------------------------
create or replace function public.approval_rules_for_admin()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.permission_require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'action_key', r.action_key,
      'name', r.name,
      'enabled', r.enabled,
      'conditions', r.conditions,
      'approver_roles', r.approver_roles,
      'approver_ids', r.approver_ids,
      'mode', r.mode,
      'allow_self_approval', r.allow_self_approval,
      'updated_at', r.updated_at,
      'approvers', coalesce((
        select jsonb_agg(jsonb_build_object(
          'id', p.id,
          'name', coalesce(nullif(btrim(p.chinese_name), ''), nullif(btrim(p.full_name), ''), p.email),
          'role', p.role
        ) order by p.role, p.full_name)
        from public.approval_profiles_eligible(r.approver_roles, r.approver_ids) e
        join public.profiles p on p.id = e.profile_id
      ), '[]'::jsonb)
    ) order by r.action_key)
    from public.approval_rules r
  ), '[]'::jsonb);
end;
$$;

create or replace function public.admin_save_approval_rule(
  p_action_key text,
  p_name text,
  p_enabled boolean,
  p_conditions jsonb,
  p_approver_roles public.user_role[],
  p_approver_ids uuid[],
  p_mode text,
  p_allow_self_approval boolean
)
returns public.approval_rules
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old jsonb;
  v_row public.approval_rules%rowtype;
  v_min numeric;
begin
  perform public.permission_require_admin();
  if p_action_key not in ('business_order.review', 'order_edit', 'item_adjust', 'void_order', 'cost_override') then
    raise exception '不支持的审批动作';
  end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null or char_length(btrim(p_name)) > 80 then
    raise exception '请输入规则名称（80 字以内）';
  end if;
  if p_mode not in ('any', 'sequential') then raise exception '通过方式无效'; end if;
  if p_conditions is null or jsonb_typeof(p_conditions) <> 'object' then raise exception '审批条件无效'; end if;
  if p_conditions ? 'amount_gte' and (
    jsonb_typeof(p_conditions->'amount_gte') <> 'number' or (p_conditions->>'amount_gte')::numeric < 0
  ) then
    raise exception '金额阈值必须是不小于 0 的数字';
  end if;
  if p_enabled and coalesce(cardinality(p_approver_roles), 0) = 0 and coalesce(cardinality(p_approver_ids), 0) = 0 then
    raise exception '启用规则时必须指定至少一位审核人';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_approver_ids, '{}'::uuid[])) reviewer_id
    where not exists (select 1 from public.profiles where id = reviewer_id and status::text = 'approved')
  ) then
    raise exception '审核人必须是已通过审核的账号';
  end if;

  select to_jsonb(ar) into v_old from public.approval_rules ar where ar.action_key = p_action_key;

  insert into public.approval_rules (
    action_key, name, enabled, conditions, approver_roles, approver_ids, mode, allow_self_approval, updated_by
  ) values (
    p_action_key, btrim(p_name), p_enabled,
    coalesce(p_conditions, '{}'::jsonb),
    coalesce(p_approver_roles, '{}'::public.user_role[]),
    coalesce(p_approver_ids, '{}'::uuid[]),
    p_mode, p_allow_self_approval, (select auth.uid())
  )
  on conflict (action_key) do update set
    name = excluded.name,
    enabled = excluded.enabled,
    conditions = excluded.conditions,
    approver_roles = excluded.approver_roles,
    approver_ids = excluded.approver_ids,
    mode = excluded.mode,
    allow_self_approval = excluded.allow_self_approval,
    updated_at = now(),
    updated_by = excluded.updated_by
  returning * into v_row;

  perform public.write_permission_audit(
    'order_edit_approval_rule', v_row.id,
    case when v_old is null then 'create' else 'update' end,
    v_old, to_jsonb(v_row)
  );
  return v_row;
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. 业务动作闸门
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_business_order_v6_internal_0141'
  ) then
    alter function public.update_business_order_v6(
      uuid, int, uuid, date, public.business_fulfillment_type,
      public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
      uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
      numeric, boolean, numeric, boolean, text, text, numeric
    ) rename to update_business_order_v6_internal_0141;
  end if;
end;
$$;

create or replace function public.update_business_order_v6(
  p_order_id uuid,
  p_expected_version int,
  p_customer_id uuid,
  p_order_date date,
  p_fulfillment_type public.business_fulfillment_type,
  p_currency public.currency_code,
  p_exchange_rate_to_cny numeric,
  p_shipping_fee numeric,
  p_tracking_number text,
  p_sales_notes text,
  p_items jsonb,
  p_payment_due_date date,
  p_reason text,
  p_shop_id uuid,
  p_salesperson_id uuid,
  p_external_order_number text,
  p_daily_shipping_date date,
  p_daily_shipping_number text,
  p_daily_payment_category public.daily_order_payment_category,
  p_total_product_received_amount numeric,
  p_total_product_received_overridden boolean,
  p_total_shipping_received_amount numeric,
  p_total_shipping_received_overridden boolean,
  p_total_sales_amount numeric,
  p_total_sales_overridden boolean,
  p_receivable_received_difference_reason text,
  p_payment_account text,
  p_order_fee numeric
)
returns table (id uuid, order_number text, version int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
begin
  select coalesce(bo.total_sales_amount, 0) into v_amount
  from public.business_orders bo where bo.id = p_order_id;
  perform public.approval_assert('order_edit', p_order_id, v_amount);
  return query select * from public.update_business_order_v6_internal_0141(
    p_order_id, p_expected_version, p_customer_id, p_order_date,
    p_fulfillment_type, p_currency, p_exchange_rate_to_cny, p_shipping_fee,
    p_tracking_number, p_sales_notes, p_items, p_payment_due_date, p_reason,
    p_shop_id, p_salesperson_id, p_external_order_number, p_daily_shipping_date,
    p_daily_shipping_number, p_daily_payment_category,
    p_total_product_received_amount, p_total_product_received_overridden,
    p_total_shipping_received_amount, p_total_shipping_received_overridden,
    p_total_sales_amount, p_total_sales_overridden,
    p_receivable_received_difference_reason, p_payment_account, p_order_fee
  );
end;
$$;

revoke all on function public.update_business_order_v6_internal_0141(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric
) from public, anon, authenticated, service_role;
revoke all on function public.update_business_order_v6(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric
) from public, anon, authenticated, service_role;

-- 旧版编辑 RPC 仍对 authenticated 开放，会绕过 order_edit 闸门，直接收回。
-- v4 同时存在 26/27 参数两个重载（0108），两个都要收。
revoke all on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text
) from public, anon, authenticated, service_role;
revoke all on function public.update_business_order_v4(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) from public, anon, authenticated, service_role;
revoke all on function public.update_business_order_v5(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_business_order_v6(
  uuid, int, uuid, date, public.business_fulfillment_type,
  public.currency_code, numeric, numeric, text, text, jsonb, date, text, uuid,
  uuid, text, date, text, public.daily_order_payment_category, numeric, boolean,
  numeric, boolean, numeric, boolean, text, text, numeric
) to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'adjust_business_order_items_internal_0141'
  ) then
    alter function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
      rename to adjust_business_order_items_internal_0141;
  end if;
end;
$$;

create or replace function public.adjust_business_order_items(
  p_order_id uuid,
  p_expected_version int,
  p_items jsonb,
  p_reason_type text,
  p_reason text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
begin
  select coalesce(bo.total_sales_amount, 0) into v_amount
  from public.business_orders bo where bo.id = p_order_id;
  perform public.approval_assert('item_adjust', p_order_id, v_amount);
  return public.adjust_business_order_items_internal_0141(
    p_order_id, p_expected_version, p_items, p_reason_type, p_reason, p_idempotency_key
  );
end;
$$;

revoke all on function public.adjust_business_order_items_internal_0141(uuid, int, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.adjust_business_order_items(uuid, int, jsonb, text, text, text)
  to authenticated;

do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'void_business_order_internal_0141'
  ) then
    alter function public.void_business_order(uuid, int, text, text)
      rename to void_business_order_internal_0141;
  end if;
end;
$$;

create or replace function public.void_business_order(
  p_order_id uuid,
  p_expected_version int,
  p_reason text,
  p_idempotency_key text
)
returns public.business_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
  v_row public.business_orders%rowtype;
begin
  select coalesce(bo.total_sales_amount, 0) into v_amount
  from public.business_orders bo where bo.id = p_order_id;
  perform public.approval_assert('void_order', p_order_id, v_amount);
  select * into v_row from public.void_business_order_internal_0141(
    p_order_id, p_expected_version, p_reason, p_idempotency_key
  );
  return v_row;
end;
$$;

revoke all on function public.void_business_order_internal_0141(uuid, int, text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.void_business_order(uuid, int, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.void_business_order(uuid, int, text, text)
  to authenticated;

-- 成本覆盖是直接写表，用触发器把闸门补齐。
create or replace function public.approval_guard_cost_override()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_id uuid := case when tg_op = 'DELETE' then old.business_order_item_id else new.business_order_item_id end;
  v_order_id uuid;
begin
  select oi.order_id into v_order_id
  from public.business_order_items oi
  where oi.id = v_item_id;
  perform public.approval_assert(
    'cost_override',
    coalesce(v_order_id, v_item_id),
    case when tg_op = 'DELETE' then null else new.cost end
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_approval_guard_cost_override
  on public.finance_business_order_item_cost_overrides;
create trigger trg_approval_guard_cost_override
  before insert or update or delete on public.finance_business_order_item_cost_overrides
  for each row execute function public.approval_guard_cost_override();

-- -----------------------------------------------------------------------------
-- 7. 订单审核：审核人改为按规则解析（默认仍然是管理员）
-- -----------------------------------------------------------------------------
create or replace function public.transition_business_order(
  p_order_id uuid,
  p_target public.business_order_status,
  p_note text
)
returns public.business_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_rule public.approval_rules%rowtype;
  v_old jsonb;
  v_action public.business_audit_action;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved' then raise exception 'Approved account required'; end if;
  select * into v_order from public.business_orders bo where bo.id = p_order_id for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if v_order.closed_at is not null then raise exception 'Closed business order cannot be transitioned'; end if;
  if v_order.status::text = 'completed' then raise exception 'Completed business order is immutable'; end if;
  if char_length(coalesce(p_note, '')) > 1000 then raise exception 'Note cannot exceed 1000 characters'; end if;
  v_old := to_jsonb(v_order);

  if v_actor.role::text in ('sales', 'supervisor', 'admin')
     and (v_actor.role::text = 'admin' or v_order.salesperson_id = v_uid)
     and v_order.status::text in ('draft', 'rejected')
     and p_target::text = 'submitted' then
    if not exists (select 1 from public.business_order_items where order_id = v_order.id) then
      raise exception 'At least one order item is required before submission';
    end if;
    update public.business_orders set
      status = 'submitted', approval_status = 'submitted', submitted_by = v_uid,
      submitted_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := 'submit';

    -- 订单审核规则关闭时不再等待人工审核，提交即视为通过。
    -- 直接读表：approval_rule_for 会过滤掉已关闭的规则，无法区分“关闭”和“缺失”。
    select * into v_rule from public.approval_rules where action_key = 'business_order.review';
    if v_rule.id is not null and not v_rule.enabled then
      update public.business_orders set
        status = 'approved', approval_status = 'approved',
        review_note = '订单审核规则已关闭，系统自动通过',
        reviewed_at = now(), version = version + 1
      where id = v_order.id returning * into v_order;
      v_action := 'approve';
    end if;
  elsif v_order.status::text = 'submitted'
        and p_target::text in ('approved', 'rejected')
        and public.can_review_business_order(v_order.id) then
    if p_target::text = 'rejected' and nullif(btrim(p_note), '') is null then
      raise exception 'Rejection note is required';
    end if;
    update public.business_orders set
      status = p_target,
      approval_status = case when p_target::text = 'approved' then 'approved' else 'rejected' end,
      review_note = nullif(btrim(p_note), ''), reviewed_by = v_uid,
      reviewed_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := case when p_target::text = 'approved' then 'approve' else 'reject' end;
  elsif v_actor.role::text = 'finance' and v_order.status::text = 'approved'
        and p_target::text = 'completed' then
    perform public.business_refresh_order_payment_status(v_order.id);
    perform public.business_refresh_order_fulfillment_status(v_order.id);
    select * into v_order from public.business_orders bo where bo.id = p_order_id;
    if v_order.approval_status <> 'approved'
       or v_order.payment_status <> 'fully_paid'
       or v_order.fulfillment_status <> 'fully_shipped' then
      raise exception 'Completion requires approved, fully paid, and fully shipped order';
    end if;
    if not exists (
      select 1 from public.business_order_finance_details f
      where f.order_id = v_order.id and f.wage_amount_cny >= 0
        and nullif(btrim(f.calculation_notes), '') is not null
    ) then raise exception 'Wage amount and calculation notes are required before completion'; end if;
    update public.business_orders set
      status = 'completed', completed_by = v_uid, completed_at = now(), version = version + 1
    where id = v_order.id returning * into v_order;
    v_action := 'complete';
  else
    raise exception 'Invalid business order transition for current role';
  end if;

  perform public.write_business_order_audit(
    v_order.id, 'order', v_order.id, v_action,
    (v_old->>'status')::public.business_order_status, v_order.status,
    v_old, to_jsonb(v_order), p_note, v_uid
  );
  return v_order;
end;
$$;

revoke all on function public.transition_business_order(uuid, public.business_order_status, text)
  from public, anon, authenticated, service_role;
grant execute on function public.transition_business_order(uuid, public.business_order_status, text)
  to authenticated;

-- -----------------------------------------------------------------------------
-- 8. 默认规则：与上线前一致
-- -----------------------------------------------------------------------------
insert into public.approval_rules (
  action_key, name, enabled, conditions, approver_roles, approver_ids, mode, allow_self_approval
) values
  ('business_order.review', '订单审核', true, '{}'::jsonb, '{admin}'::public.user_role[], '{}'::uuid[], 'any', false),
  ('order_edit', '订单编辑', false, '{}'::jsonb, '{admin}'::public.user_role[], '{}'::uuid[], 'any', false),
  ('item_adjust', '订单加单/改行', false, '{}'::jsonb, '{admin}'::public.user_role[], '{}'::uuid[], 'any', false),
  ('void_order', '订单作废', false, '{}'::jsonb, '{admin,finance}'::public.user_role[], '{}'::uuid[], 'any', false),
  ('cost_override', '成本覆盖', false, '{}'::jsonb, '{admin}'::public.user_role[], '{}'::uuid[], 'any', false)
on conflict (action_key) do nothing;

-- -----------------------------------------------------------------------------
-- 9. 授权
-- -----------------------------------------------------------------------------
revoke all on function public.approval_profiles_eligible(public.user_role[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.approval_actor_eligible(uuid, public.user_role[], uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.approval_rule_for(text)
  from public, anon, authenticated, service_role;
revoke all on function public.approval_condition_met(jsonb, numeric)
  from public, anon, authenticated, service_role;
revoke all on function public.approval_apply(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.approval_guard_cost_override()
  from public, anon, authenticated, service_role;

revoke all on function public.approval_is_eligible_for_request(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_is_eligible_for_request(uuid, uuid) to authenticated;

revoke all on function public.approval_assert(text, uuid, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_assert(text, uuid, numeric) to authenticated;

revoke all on function public.approval_check(text, uuid, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_check(text, uuid, numeric) to authenticated;

revoke all on function public.approval_request_create(text, text, uuid, jsonb, text, numeric)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_request_create(text, text, uuid, jsonb, text, numeric)
  to authenticated;

revoke all on function public.approval_cancel(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_cancel(uuid) to authenticated;

revoke all on function public.approval_decide(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_decide(uuid, text, text) to authenticated;

revoke all on function public.approval_retry(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_retry(uuid) to authenticated;

revoke all on function public.approval_inbox(text)
  from public, anon, authenticated, service_role;
grant execute on function public.approval_inbox(text) to authenticated;

revoke all on function public.approval_pending_count()
  from public, anon, authenticated, service_role;
grant execute on function public.approval_pending_count() to authenticated;

revoke all on function public.can_review_business_order(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.can_review_business_order(uuid) to authenticated;

revoke all on function public.approval_rules_for_admin()
  from public, anon, authenticated, service_role;
grant execute on function public.approval_rules_for_admin() to authenticated;

revoke all on function public.admin_save_approval_rule(
  text, text, boolean, jsonb, public.user_role[], uuid[], text, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.admin_save_approval_rule(
  text, text, boolean, jsonb, public.user_role[], uuid[], text, boolean
) to authenticated;

commit;
