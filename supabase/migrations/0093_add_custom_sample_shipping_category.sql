-- 0093_add_custom_sample_shipping_category.sql
-- 发货分类新增独立的“定制打样”分类。
-- PostgreSQL 要求新增 enum 值与首次使用该值分开提交，后续同步在 0094 完成。

alter type public.daily_order_shipping_category add value if not exists 'custom_sample';
