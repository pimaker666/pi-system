-- 0103_shipment_screenshots.sql
-- 发货批次截图：business_order_shipments 新增 screenshot_path，新增私有 Storage bucket，
-- 建批次 RPC 升级 v2 接收截图路径；旧 create_business_order_shipment 保持原语义不动。

begin;

alter table public.business_order_shipments
  add column if not exists screenshot_path text;

comment on column public.business_order_shipments.screenshot_path is
  'business-shipment-screenshots 私有 bucket 内的 object name（uid/订单ID/uuid.ext），不存公开 URL';

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'business-shipment-screenshots',
  'business-shipment-screenshots',
  false,
  20971520,
  array['image/jpeg', 'image/png']::text[]
)
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "business_shipment_screenshots_insert" on storage.objects;
create policy "business_shipment_screenshots_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'business-shipment-screenshots'
    and array_length(storage.foldername(name), 1) = 2
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    and public.has_current_permission('orders.ship')
  );

drop policy if exists "business_shipment_screenshots_select" on storage.objects;
create policy "business_shipment_screenshots_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'business-shipment-screenshots'
    and array_length(storage.foldername(name), 1) = 2
    and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
    and public.can_view_business_order(((storage.foldername(name))[2])::uuid)
  );

-- 不创建 Storage UPDATE/DELETE policy：客户端不能覆盖或删除发货截图。

create or replace function public.create_business_order_shipment_v2(
  p_order_id uuid,
  p_shipped_at timestamptz,
  p_tracking_number text,
  p_notes text,
  p_items jsonb,
  p_idempotency_key text,
  p_allow_overship boolean,
  p_overship_reason text,
  p_screenshot_path text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := (select auth.uid());
  v_result jsonb;
  v_shipment_id uuid;
begin
  if not public.has_current_permission('orders.ship') then
    raise exception 'Current account does not have shipment permission';
  end if;

  if p_screenshot_path is not null then
    if p_screenshot_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png)$'
       or (storage.foldername(p_screenshot_path))[1] is distinct from v_uid::text
       or ((storage.foldername(p_screenshot_path))[2])::uuid is distinct from p_order_id
    then
      raise exception 'Invalid shipment screenshot path';
    end if;
  end if;

  v_result := public.create_business_order_shipment_internal_0057(
    p_order_id, p_shipped_at, p_tracking_number, p_notes, p_items,
    p_idempotency_key, p_allow_overship, p_overship_reason
  );
  v_shipment_id := (v_result -> 'shipment' ->> 'id')::uuid;
  if v_shipment_id is not null then
    update public.business_order_shipments
    set screenshot_path = p_screenshot_path
    where id = v_shipment_id;
  end if;
  return case
    when v_shipment_id is not null
      then jsonb_set(v_result, '{shipment,screenshot_path}', to_jsonb(p_screenshot_path))
    else v_result
  end;
end;
$$;

revoke all on function public.create_business_order_shipment_v2(
  uuid, timestamptz, text, text, jsonb, text, boolean, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_business_order_shipment_v2(
  uuid, timestamptz, text, text, jsonb, text, boolean, text, text
) to authenticated;

commit;
