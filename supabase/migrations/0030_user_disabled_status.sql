-- 0030_user_disabled_status.sql
-- 独立增加停用状态；新枚举值必须在后续事务中使用。

alter type public.user_status add value if not exists 'disabled';
