-- 0023_harden_daily_order_rpc_grants.sql
-- 收紧 0022 新增的每日订单工作流 RPC 执行权限。
--
-- 背景：Supabase 对 public schema 配置了 default privileges，任何新建函数会
-- 自动向 anon / authenticated / service_role 授予 EXECUTE。0022 中这些面向前端的
-- SECURITY DEFINER RPC 仅执行了 `revoke all from public`，无法移除由 default
-- privileges 显式授予 anon / service_role 的执行权，导致与 0021 既定标准
-- （revoke from public, anon, authenticated, service_role 后仅 grant authenticated）
-- 不一致。虽然函数体内部已按 auth.uid() 角色校验（anon 会被拒绝），此处按
-- 纵深防御标准在授权层同样收紧。
--
-- 仅调整授权，不改动任何函数逻辑或数据；幂等，可重复执行。

revoke all on function public.claim_daily_order_workflow(uuid, int) from public, anon, service_role;
grant execute on function public.claim_daily_order_workflow(uuid, int) to authenticated;

revoke all on function public.bind_daily_order_workflow_customer(uuid, int, uuid) from public, anon, service_role;
grant execute on function public.bind_daily_order_workflow_customer(uuid, int, uuid) to authenticated;

revoke all on function public.submit_daily_order_performance(uuid, int) from public, anon, service_role;
grant execute on function public.submit_daily_order_performance(uuid, int) to authenticated;

revoke all on function public.review_daily_order_performance(uuid, int, boolean, text) from public, anon, service_role;
grant execute on function public.review_daily_order_performance(uuid, int, boolean, text) to authenticated;

revoke all on function public.save_daily_order_commission(uuid, numeric, public.currency_code, text) from public, anon, service_role;
grant execute on function public.save_daily_order_commission(uuid, numeric, public.currency_code, text) to authenticated;

revoke all on function public.request_daily_order_change(uuid, jsonb) from public, anon, service_role;
grant execute on function public.request_daily_order_change(uuid, jsonb) to authenticated;

revoke all on function public.review_daily_order_change(uuid, boolean, text) from public, anon, service_role;
grant execute on function public.review_daily_order_change(uuid, boolean, text) to authenticated;

revoke all on function public.cancel_daily_order_change(uuid) from public, anon, service_role;
grant execute on function public.cancel_daily_order_change(uuid) to authenticated;
