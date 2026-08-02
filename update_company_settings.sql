-- ============================================================
-- 填充公司抬头信息（后台 /settings）
-- 来源：Carmen PI .xlsx 抬头
-- 在 Supabase SQL Editor 整段执行
-- 银行信息该文件未提供，先留空，可稍后在 /settings 页面补充
-- ============================================================
insert into public.company_settings (
  id, company_name, address, phone, email, website
) values (
  1,
  'Foshan Jingyan Biological Products Co., Ltd.',
  'No. 279, Leping Avenue, Leping Town, Sanshui District, Foshan City, Guangdong Province',
  '+86 13825527643',
  'jesscang22jj@gmail.com',
  'https://jingyansw.en.alibaba.com/'
)
on conflict (id) do update set
  company_name = excluded.company_name,
  address      = excluded.address,
  phone        = excluded.phone,
  email        = excluded.email,
  website      = excluded.website,
  updated_at   = now();
