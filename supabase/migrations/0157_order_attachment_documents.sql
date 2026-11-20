-- 0157_order_attachment_documents.sql
-- 订单附件（沿用 finance-daily-order-screenshots 私有桶）从仅 JPEG/PNG 扩展到 PDF、Excel、Word、CSV。
-- 单张 20MB、每单最多 10 个的限制保持不变；已绑定对象的不可变审计语义不变。
-- 前端 src/lib/attachment-mime.ts 的白名单与路径正则必须与本迁移保持一致。

begin;

-- -----------------------------------------------------------------------------
-- 1. 私有桶 MIME 白名单
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'finance-daily-order-screenshots',
  'finance-daily-order-screenshots',
  false,
  20971520,
  array[
    'image/jpeg',
    'image/png',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-excel',
    'text/csv',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword'
  ]::text[]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- -----------------------------------------------------------------------------
-- 2. business_order_attachments：mime 与路径约束放宽
-- -----------------------------------------------------------------------------
alter table public.business_order_attachments
  drop constraint if exists business_order_attachments_mime_type_check;
alter table public.business_order_attachments
  add constraint business_order_attachments_mime_type_check
  check (
    mime_type in (
      'image/jpeg',
      'image/png',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword'
    )
  );

alter table public.business_order_attachments
  drop constraint if exists business_order_attachment_path_check;
alter table public.business_order_attachments
  add constraint business_order_attachment_path_check check (
    object_path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|pdf|xlsx|xls|csv|docx|doc)$'
  );

comment on table public.business_order_attachments is
  'Private order attachments (JPEG/PNG/PDF/XLSX/XLS/CSV/DOCX/DOC) for canonical business orders; removed rows are retained for audit.';

-- -----------------------------------------------------------------------------
-- 3. 存储策略：路径正则放宽，其余条件与 0035 / 0040 保持一致
-- -----------------------------------------------------------------------------
drop policy if exists "finance_daily_order_screenshots_insert" on storage.objects;
create policy "finance_daily_order_screenshots_insert"
  on storage.objects for insert to authenticated
with check (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and (storage.foldername(name))[1] = (select auth.uid())::text
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|pdf|xlsx|xls|csv|docx|doc)$'
    then exists (
      select 1
      from public.business_orders bo
      join public.profiles actor on actor.id = (select auth.uid())
      where bo.id = ((storage.foldername(name))[2])::uuid
        and actor.status::text = 'approved'
        and actor.role::text in ('sales', 'supervisor', 'admin', 'finance')
        and public.business_order_accepts_entry_edits(bo.id, actor.role::text)
        and (actor.role::text in ('admin', 'finance') or bo.salesperson_id = actor.id)
    )
    else false
  end
);

drop policy if exists "finance_daily_order_screenshots_select" on storage.objects;
create policy "finance_daily_order_screenshots_select"
  on storage.objects for select to authenticated
using (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and case
    when array_length(storage.foldername(name), 1) = 2
      and name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|pdf|xlsx|xls|csv|docx|doc)$'
    then (
      public.is_finance_or_admin()
      or exists (
        select 1
        from public.finance_daily_orders legacy_order
        where legacy_order.id = ((storage.foldername(name))[2])::uuid
          and (
            legacy_order.salesperson_id = (select auth.uid())
            or public.is_my_subordinate(legacy_order.salesperson_id)
          )
      )
      or public.can_view_business_order(((storage.foldername(name))[2])::uuid)
    )
    else false
  end
);

drop policy if exists "finance_daily_order_screenshots_delete_unbound" on storage.objects;
create policy "finance_daily_order_screenshots_delete_unbound"
  on storage.objects for delete to authenticated
using (
  public.is_approved_user()
  and bucket_id = 'finance-daily-order-screenshots'
  and array_length(storage.foldername(name), 1) = 2
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and public.daily_order_screenshot_object_is_unbound(storage.objects.name)
);

-- -----------------------------------------------------------------------------
-- 4. bind RPC：MIME 白名单与路径正则同步放宽
-- -----------------------------------------------------------------------------
create or replace function public.bind_business_order_attachment(
  p_order_id uuid,
  p_object_path text,
  p_original_name text,
  p_mime_type text,
  p_size_bytes bigint
)
returns public.business_order_attachments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_actor public.profiles%rowtype;
  v_order public.business_orders%rowtype;
  v_object storage.objects%rowtype;
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = p_order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if not public.business_order_accepts_entry_edits(v_order.id, v_actor.role::text) then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  if p_mime_type not in (
       'image/jpeg',
       'image/png',
       'application/pdf',
       'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
       'application/vnd.ms-excel',
       'text/csv',
       'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
       'application/msword'
     )
     or p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 20971520 then
    raise exception 'Invalid attachment type or size';
  end if;
  if char_length(coalesce(p_original_name, '')) > 255 then
    raise exception 'Attachment name cannot exceed 255 characters';
  end if;
  if p_object_path !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(jpe?g|png|pdf|xlsx|xls|csv|docx|doc)$'
     or split_part(p_object_path, '/', 1) <> v_uid::text
     or split_part(p_object_path, '/', 2) <> p_order_id::text then
    raise exception 'Invalid attachment path';
  end if;

  select * into v_object
  from storage.objects o
  where o.bucket_id = 'finance-daily-order-screenshots'
    and o.name = p_object_path;
  if not found then raise exception 'Attachment object does not exist'; end if;
  if lower(coalesce(v_object.metadata->>'mimetype', '')) <> p_mime_type
     or coalesce(v_object.metadata->>'size', '') !~ '^\d+$'
     or (v_object.metadata->>'size')::bigint <> p_size_bytes then
    raise exception 'Attachment object metadata does not match';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.object_path = p_object_path;
  if found then
    if v_result.order_id is distinct from p_order_id
       or v_result.created_by is distinct from v_uid
       or v_result.status::text <> 'active'
       or v_result.mime_type <> p_mime_type
       or v_result.size_bytes <> p_size_bytes then
      raise exception 'Attachment path is already bound';
    end if;
    return v_result;
  end if;

  if (
    select count(*)
    from public.business_order_attachments a
    where a.order_id = p_order_id and a.status::text = 'active'
  ) >= 10 then
    raise exception 'Business order cannot have more than 10 attachments';
  end if;

  insert into public.business_order_attachments (
    order_id, object_path, original_name, mime_type, size_bytes, created_by
  ) values (
    p_order_id, p_object_path, nullif(btrim(p_original_name), ''),
    p_mime_type, p_size_bytes, v_uid
  ) returning * into v_result;

  return v_result;
end;
$$;
revoke all on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_business_order_attachment(uuid, text, text, text, bigint)
  to authenticated;

commit;
