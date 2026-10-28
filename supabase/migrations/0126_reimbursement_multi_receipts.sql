-- 0126_reimbursement_multi_receipts.sql
-- 报销明细凭证从单张 receipt_path 升级为 receipt_paths 数组（每明细最多 9 张）；
-- 重建 save_finance_reimbursement_request 的校验、写入与旧凭证清理逻辑。
-- 存储桶与路径规则不变：{uid}/{uuid}.jpg|png，storage 策略无需调整。

begin;

alter table public.finance_reimbursement_items
  add column if not exists receipt_paths text[] not null default '{}';

-- 回填仅在有旧列时执行（迁移重放安全）
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'finance_reimbursement_items' and column_name = 'receipt_path'
  ) then
    update public.finance_reimbursement_items
      set receipt_paths = array[receipt_path]
      where receipt_path is not null;
    alter table public.finance_reimbursement_items drop column receipt_path;
  end if;
end $$;

create or replace function public.save_finance_reimbursement_request(
  p_request_id uuid,
  p_expense_date date,
  p_project_name text,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  v_request_id uuid;
  previous_request public.finance_reimbursement_requests%rowtype;
  v_project_name text := nullif(btrim(p_project_name), '');
  item jsonb;
  unit_price numeric;
  quantity numeric;
  receipt_path text;
  old_receipt_paths text[] := array[]::text[];
  unused_receipt_paths text[];
begin
  if actor_id is null or not public.is_approved_user() then
    raise exception 'An approved authenticated user is required';
  end if;
  if p_expense_date is null or not isfinite(p_expense_date) then
    raise exception 'A valid expense date is required';
  end if;
  if v_project_name is not null and char_length(v_project_name) > 200 then
    raise exception 'Project name must not exceed 200 characters';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'Reimbursement items must be an array';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'A reimbursement must contain 1 to 100 items';
  end if;

  -- 在任何写入前验证；不依赖 numeric(18,4) 的隐式四舍五入来接受非法精度。
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) <> 'object'
       or jsonb_typeof(item -> 'summary') is distinct from 'string'
       or char_length(btrim(item ->> 'summary')) not between 1 and 500
       or jsonb_typeof(item -> 'unit_price') is distinct from 'number'
       or jsonb_typeof(item -> 'quantity') is distinct from 'number' then
      raise exception 'Invalid reimbursement item';
    end if;
    unit_price := (item ->> 'unit_price')::numeric;
    quantity := (item ->> 'quantity')::numeric;
    if unit_price <= 0 or unit_price > 999999999999
       or quantity <= 0 or quantity > 999999999999
       or unit_price <> round(unit_price, 4) or quantity <> round(quantity, 4) then
      raise exception 'Unit price and quantity must be positive, in range and have at most 4 decimals';
    end if;
    if unit_price * quantity >= 100000000000000
       or round(unit_price * quantity, 4) >= 100000000000000 then
      raise exception 'Reimbursement item amount exceeds numeric(18,4) range';
    end if;
    if item ? 'receipt_paths' and jsonb_typeof(item -> 'receipt_paths') <> 'array' then
      raise exception 'Invalid reimbursement receipt paths';
    end if;
    if jsonb_array_length(coalesce(item -> 'receipt_paths', '[]'::jsonb)) > 9 then
      raise exception 'A reimbursement item accepts at most 9 receipt images';
    end if;
    for receipt_path in
      select value from jsonb_array_elements_text(coalesce(item -> 'receipt_paths', '[]'::jsonb))
    loop
      if split_part(receipt_path, '/', 1) <> actor_id::text
         or receipt_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$' then
        raise exception 'Receipt path must be a valid image belonging to the applicant';
      end if;
    end loop;
  end loop;

  if p_request_id is null then
    insert into public.finance_reimbursement_requests (applicant_id, expense_date, project_name)
    values (actor_id, p_expense_date, v_project_name)
    returning id into v_request_id;
  else
    select r.* into previous_request
    from public.finance_reimbursement_requests r
    where r.id = p_request_id
    for update;
    if not found then
      raise exception 'Reimbursement request does not exist or is not accessible';
    end if;
    if previous_request.applicant_id is distinct from actor_id
       or previous_request.status not in ('pending', 'rejected') then
      raise exception 'Only the applicant can save a pending or rejected reimbursement';
    end if;
    v_request_id := previous_request.id;
    select coalesce(array_agg(distinct p), array[]::text[]) into old_receipt_paths
    from public.finance_reimbursement_items i
    cross join lateral unnest(i.receipt_paths) as p
    where i.request_id = v_request_id;

    update public.finance_reimbursement_requests r
    set expense_date = p_expense_date, project_name = v_project_name
    where r.id = v_request_id;
    delete from public.finance_reimbursement_items i where i.request_id = v_request_id;
  end if;

  insert into public.finance_reimbursement_items (request_id, summary, unit_price, quantity, receipt_paths, sort_order)
  select v_request_id, btrim(value ->> 'summary'), (value ->> 'unit_price')::numeric,
         (value ->> 'quantity')::numeric,
         coalesce((
           select array_agg(p order by ord)
           from jsonb_array_elements_text(coalesce(value -> 'receipt_paths', '[]'::jsonb)) with ordinality as t(p, ord)
         ), '{}'::text[]),
         (ordinality - 1)::int
  from jsonb_array_elements(p_items) with ordinality;

  -- 单独状态 UPDATE，内容保存与重提仍属于本 RPC 的同一事务。
  if previous_request.status = 'rejected' then
    update public.finance_reimbursement_requests r set status = 'pending' where r.id = v_request_id;
  end if;

  -- 凭证可能被本人其他报销单复用，仍被引用的路径不能清理。
  select coalesce(array_agg(path), array[]::text[]) into unused_receipt_paths
  from unnest(old_receipt_paths) as paths(path)
  where not exists (
    select 1 from public.finance_reimbursement_items i where i.receipt_paths @> array[path]::text[]
  );
  return jsonb_build_object('request_id', v_request_id, 'receipt_paths', to_jsonb(unused_receipt_paths));
end;
$$;

commit;
