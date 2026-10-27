-- 0117 图片附件统一元数据与订单附件改名
--
-- 背景：全站图片上传点需要统一的「预览 / 改名 / 上传时间」。
--   * 订单截图存于 business_order_attachments，本身已有 original_name / created_at，
--     只需补一个受权限校验的改名 RPC；
--   * 收款截图、发货截图、客户 Logo 以存储路径或公开 URL 直接挂在业务行上，
--     没有文件名与上传时间，这里用 (bucket, object_path) 维度的元数据表补齐。
--
-- 权限：仅已审批账号可读写；桶名限定在三个图片桶内，避免被当成任意 key-value 表使用。

begin;

create table if not exists public.image_asset_meta (
  bucket text not null,
  object_path text not null,
  display_name text,
  -- 新上传默认取写入时间；历史文件首次改名时可能已知不了真实上传时间，允许为空并显示「未记录」。
  uploaded_at timestamptz default now(),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (bucket, object_path),
  constraint image_asset_meta_bucket_check check (
    bucket in ('business-payment-proofs', 'business-shipment-screenshots', 'customer-assets')
  ),
  constraint image_asset_meta_name_check check (
    display_name is null or char_length(display_name) between 1 and 255
  ),
  constraint image_asset_meta_path_check check (char_length(object_path) between 1 and 1024)
);

comment on table public.image_asset_meta is
  '图片附件展示元数据：业务行只存存储路径/公开 URL 时，用该表补文件名与上传时间。';

alter table public.image_asset_meta enable row level security;

revoke all on table public.image_asset_meta from public, anon;
grant select, insert, update on table public.image_asset_meta to authenticated;

drop policy if exists "image_asset_meta_select" on public.image_asset_meta;
create policy "image_asset_meta_select" on public.image_asset_meta
  for select to authenticated
  using (public.is_approved_user());

drop policy if exists "image_asset_meta_insert" on public.image_asset_meta;
create policy "image_asset_meta_insert" on public.image_asset_meta
  for insert to authenticated
  with check (
    public.is_approved_user()
    and uploaded_by = (select auth.uid())
  );

drop policy if exists "image_asset_meta_update" on public.image_asset_meta;
create policy "image_asset_meta_update" on public.image_asset_meta
  for update to authenticated
  using (public.is_approved_user())
  with check (public.is_approved_user());

-- 订单截图改名：与 bind/remove 同一套角色、归属与订单状态校验。
create or replace function public.rename_business_order_attachment(
  p_attachment_id uuid,
  p_original_name text
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
  v_result public.business_order_attachments%rowtype;
begin
  select * into v_actor from public.profiles p where p.id = v_uid;
  if not found or v_actor.status::text <> 'approved'
     or v_actor.role::text not in ('sales', 'supervisor', 'admin', 'finance') then
    raise exception 'Approved sales, supervisor, admin, or finance account required';
  end if;

  select * into v_result
  from public.business_order_attachments a
  where a.id = p_attachment_id;
  if not found or v_result.status::text <> 'active' then
    raise exception 'Business order attachment does not exist';
  end if;

  select * into v_order
  from public.business_orders bo
  where bo.id = v_result.order_id
  for update;
  if not found then raise exception 'Business order does not exist'; end if;
  if not public.business_order_accepts_entry_edits(v_order.id, v_actor.role::text) then
    raise exception 'Business order attachments cannot be changed in current status';
  end if;
  if v_actor.role::text in ('sales', 'supervisor')
     and v_order.salesperson_id is distinct from v_uid then
    raise exception 'Sales user cannot edit another owner business order';
  end if;

  if char_length(btrim(coalesce(p_original_name, ''))) not between 1 and 255 then
    raise exception 'Attachment name must be between 1 and 255 characters';
  end if;

  update public.business_order_attachments
     set original_name = btrim(p_original_name)
   where id = p_attachment_id
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.rename_business_order_attachment(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rename_business_order_attachment(uuid, text)
  to authenticated;

commit;
