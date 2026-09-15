-- 0032_user_disabled_status.sql
-- PostgreSQL enum 新值需要在独立迁移提交后，后续迁移才能安全使用。

alter type public.user_status add value if not exists 'disabled';
