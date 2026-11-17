-- Apply activate-rich-throne.sql first. Execute this entire file together.
-- These are real RPC tests; all fixtures and singleton changes are rolled back.
-- No Stripe calls, charges, webhook registration, Vault writes or email occur.
begin;
set local lock_timeout = '3s';
set local statement_timeout = '15s';
do $test$
declare
  initial_state public.rich_throne_state;
  a jsonb; b jsonb; result jsonb; same jsonb;
  request_a uuid := gen_random_uuid(); request_b uuid := gen_random_uuid();
  id_a uuid; id_b uuid; caught boolean;
begin
  select * into initial_state from public.rich_throne_state where id=1 for update;
  assert initial_state.id=1, 'Singleton exists';
  assert not has_function_privilege('anon','public.rich_throne_confirm_payment(uuid,text,text,integer,text,boolean)','EXECUTE'), 'anon must not settle';
  assert not has_function_privilege('authenticated','public.rich_throne_confirm_payment(uuid,text,text,integer,text,boolean)','EXECUTE'), 'authenticated must not settle';
  assert not has_function_privilege('anon','public.rich_throne_webhook_configuration()','EXECUTE'), 'anon must not read the signing secret';
  assert has_function_privilege('service_role','public.rich_throne_confirm_payment(uuid,text,text,integer,text,boolean)','EXECUTE'), 'service role can settle';
  assert not has_table_privilege('anon','public.rich_throne_orders','SELECT'), 'orders stay private';

  -- Isolated baseline inside this transaction; the actual inaugural record is
  -- restored automatically by ROLLBACK, including its original verification.
  update public.rich_throne_state set amount_cents=10000,current_order_id=null,verified_payment=false where id=1;
  a := public.rich_throne_prepare_order(request_a,null,null,10100,'richest-2026-11-17');
  same := public.rich_throne_prepare_order(request_a,null,null,10100,'richest-2026-11-17');
  assert a->'order'->>'id'=same->'order'->>'id', 'A retry must reuse the order';
  same := public.rich_throne_prepare_order(request_a,null,null,10200,'richest-2026-11-17');
  assert same->>'error'='request_reused', 'Same request cannot change amount';
  id_a := (a->'order'->>'id')::uuid;
  b := public.rich_throne_prepare_order(request_b,'Regression test','Test',50000,'richest-2026-11-17');
  id_b := (b->'order'->>'id')::uuid;
  perform public.rich_throne_attach_session(id_a,'cs_live_regressionLow',null);
  perform public.rich_throne_attach_session(id_b,'cs_live_regressionHigh',null);

  caught := false;
  begin
    perform public.rich_throne_confirm_payment(id_a,'cs_live_regressionHigh','pi_regressionForgery',10100,'eur',true);
  exception when others then caught := true; end;
  assert caught, 'Foreign session cannot settle an order';
  caught := false;
  begin
    perform public.rich_throne_confirm_payment(id_a,null,'pi_regressionForgery',10100,'eur',true);
  exception when others then caught := true; end;
  assert caught, 'Missing session cannot settle';
  caught := false;
  begin
    perform public.rich_throne_confirm_payment(id_a,'cs_live_regressionLow','pi_regressionForgery',10100,'eur',false);
  exception when others then caught := true; end;
  assert caught, 'Test-mode payment cannot settle';

  -- High payment wins the lock first. The lower one never gets crowned.
  result := public.rich_throne_confirm_payment(id_b,'cs_live_regressionHigh','pi_regressionHigh',50000,'eur',true);
  assert result->'order'->>'status'='paid', 'High purchase is accepted';
  result := public.rich_throne_confirm_payment(id_a,'cs_live_regressionLow','pi_regressionLow',10100,'eur',true);
  assert result->'order'->>'status'='superseded', 'Losing payment requires a refund';
  assert result->'order'->>'crowned_at' is null, 'Losing payment was never crowned';
  assert (result->'current'->>'current_order_id')::uuid=id_b, 'Lower payment cannot overwrite the winner';
  result := public.rich_throne_record_refund(id_a,'re_regressionLow','pending',10100,'pi_regressionLow');
  assert result->>'status'='superseded', 'Pending refund is not complete';
  result := public.rich_throne_record_refund(id_a,'re_regressionLow','succeeded',10100,'pi_regressionLow');
  assert result->>'status'='refunded', 'Successful refund is complete';
  result := public.rich_throne_record_refund(id_a,'re_regressionLow','pending',10100,'pi_regressionLow');
  assert result->>'status'='refunded', 'Old webhook must not regress a refund';
  result := public.rich_throne_prepare_order(gen_random_uuid(),null,null,50050,'richest-2026-11-17');
  assert result->>'error'='minimum_changed' and (result->>'next_minimum')::numeric=501, 'Dynamic minimum enforces a whole euro increment';

  -- Opposite ordering: both purchasers legitimately get crowned in sequence.
  update public.rich_throne_state set amount_cents=10000,current_order_id=null,verified_payment=false where id=1;
  a := public.rich_throne_prepare_order(gen_random_uuid(),null,null,10100,'richest-2026-11-17');
  b := public.rich_throne_prepare_order(gen_random_uuid(),null,null,50000,'richest-2026-11-17');
  id_a := (a->'order'->>'id')::uuid; id_b := (b->'order'->>'id')::uuid;
  perform public.rich_throne_attach_session(id_a,'cs_live_regressionFirst',null);
  perform public.rich_throne_attach_session(id_b,'cs_live_regressionSecond',null);
  result := public.rich_throne_confirm_payment(id_a,'cs_live_regressionFirst','pi_regressionFirst',10100,'eur',true);
  assert result->'order'->>'crowned_at' is not null, 'First purchaser receives their keepsake';
  assert result->'current'->>'owner_name'='Anonymous', 'Optional name has a public fallback';
  perform public.rich_throne_confirm_payment(id_b,'cs_live_regressionSecond','pi_regressionSecond',50000,'eur',true);
  result := public.rich_throne_confirm_payment(id_a,'cs_live_regressionFirst','pi_regressionFirst',10100,'eur',true);
  assert result->>'changed'='false', 'Retry cannot crown a previous owner again';
  assert (result->'current'->>'current_order_id')::uuid=id_b, 'Latest higher owner remains';
  caught := false;
  begin
    perform public.rich_throne_record_refund(id_a,'re_forbiddenPreviousOwner','succeeded',10100,'pi_regressionFirst');
  exception when others then caught := true; end;
  assert caught, 'Never automatically refund a previously crowned owner';

  a := public.rich_throne_prepare_order(gen_random_uuid(),null,null,50100,'richest-2026-11-17');
  id_a := (a->'order'->>'id')::uuid;
  perform public.rich_throne_attach_session(id_a,'cs_live_regressionExpired',null);
  result := public.rich_throne_mark_expired(id_a,'cs_live_regressionExpired');
  assert result->>'status'='expired', 'Unpaid expired checkout can close';
  assert (select current_order_id=id_b from public.rich_throne_state where id=1), 'Expiry does not change ownership';
  assert public.rich_throne_get_order(gen_random_uuid(),null) is null, 'Unknown token returns no order';
end;
$test$;
rollback;
select 'Richest RPC checks passed; all fixtures rolled back' as result;
