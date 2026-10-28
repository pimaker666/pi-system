begin;

do $$
declare
  v_account uuid;
  v_cat uuid;
  v_entry uuid;
  v_ok boolean;
begin
  insert into public.finance_journal_accounts (name, currency, initial_balance)
  values ('演练账户A', 'CNY', 1000) returning id into v_account;
  insert into public.finance_journal_categories (name, kind) values ('演练分类', 'expense') returning id into v_cat;

  begin
    insert into public.finance_journal_entries
      (account_id, category_id, entry_date, kind, amount_original, currency, exchange_rate_to_cny, summary)
    values (v_account, v_cat, current_date, 'expense', 10, 'USD', 7.1, '混币种应拒绝');
    raise notice 'FAIL 混币种分录未被拒绝';
  exception when others then
    raise notice 'PASS 混币种分录被拒绝: %', sqlerrm;
  end;

  begin
    update public.finance_journal_categories set kind = 'income' where id = v_cat;
    raise notice 'PASS 未被使用的分类可改类型';
  exception when others then
    raise notice 'FAIL 未使用的分类被错误拦截: %', sqlerrm;
  end;
  update public.finance_journal_categories set kind = 'expense' where id = v_cat;

  insert into public.finance_journal_entries
    (account_id, category_id, entry_date, kind, amount_original, currency, exchange_rate_to_cny, summary)
  values (v_account, v_cat, current_date, 'expense', 10.1234, 'CNY', 1, '正常分录') returning id into v_entry;

  raise notice '生成列 amount_cny = %', (select amount_cny from public.finance_journal_entries where id = v_entry);

  begin
    update public.finance_journal_accounts set currency = 'USD' where id = v_account;
    raise notice 'FAIL 已有分录账户改币种未被拒绝';
  exception when others then
    raise notice 'PASS 已有分录账户改币种被拒绝: %', sqlerrm;
  end;

  begin
    update public.finance_journal_categories set kind = 'income' where id = v_cat;
    raise notice 'FAIL 已使用分类改类型未被拒绝';
  exception when others then
    raise notice 'PASS 已使用分类改类型被拒绝: %', sqlerrm;
  end;

  begin
    update public.finance_journal_entries set summary = '改摘要' where id = v_entry;
    raise notice 'PASS 未作废分录可修改';
  exception when others then
    raise notice 'FAIL 未作废分录被错误拦截: %', sqlerrm;
  end;

  update public.finance_journal_entries set voided_at = now(), voided_by = (select id from public.profiles limit 1), void_reason = '演练作废' where id = v_entry;
  begin
    update public.finance_journal_entries set summary = '改作废摘要' where id = v_entry;
    raise notice 'FAIL 已作废分录仍可修改';
  exception when others then
    raise notice 'PASS 已作废分录不可修改: %', sqlerrm;
  end;

  select has_function_privilege('authenticated', 'public.save_finance_reimbursement_request(uuid,date,text,jsonb)', 'execute') into v_ok;
  raise notice 'authenticated 可执行 save RPC(应 true): %', v_ok;
  select has_function_privilege('anon', 'public.save_finance_reimbursement_request(uuid,date,text,jsonb)', 'execute') into v_ok;
  raise notice 'anon 可执行 save RPC(应 false): %', v_ok;
  select has_table_privilege('authenticated', 'public.finance_journal_entries', 'delete') into v_ok;
  raise notice 'authenticated 可删日记账(应 false): %', v_ok;
end $$;

rollback;
