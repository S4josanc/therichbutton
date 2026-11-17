-- Richest Button activation. Run as one transaction through the approved database
-- workflow. This file never changes Gift tables, functions, email or its webhook.
begin;

alter table public.rich_throne_orders
  add column if not exists request_id uuid,
  add column if not exists crowned_at timestamptz,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version text,
  add column if not exists checkout_expires_at timestamptz,
  add column if not exists stripe_refund_id text,
  add column if not exists refund_status text,
  add column if not exists refunded_at timestamptz,
  add column if not exists last_checked_at timestamptz;

create unique index if not exists rich_throne_orders_request_id_key on public.rich_throne_orders (request_id);
create unique index if not exists rich_throne_orders_stripe_refund_id_key on public.rich_throne_orders (stripe_refund_id);
alter table public.rich_throne_state add column if not exists current_order_id uuid references public.rich_throne_orders(id);
-- The actual inaugural row stays Michael Merz / EUR100 / unverified. Prevent the
-- old placeholder from being resurrected by an accidental insert in the future.
alter table public.rich_throne_state alter column owner_name drop default;

create table if not exists public.rich_throne_integration (
  id integer primary key default 1 check (id = 1),
  generation uuid not null default gen_random_uuid(),
  webhook_endpoint_id text,
  vault_secret_id uuid unique references vault.secrets(id),
  stripe_account_id text,
  setup_lease_token uuid,
  setup_lease_until timestamptz,
  registration_started_at timestamptz,
  ready_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.rich_throne_request_limits (
  scope text not null check (scope in ('checkout','status')),
  subject_hash text not null check (subject_hash ~ '^[0-9a-f]{64}$'),
  bucket bigint not null,
  requests integer not null default 1,
  primary key (scope, subject_hash, bucket)
);
create index if not exists rich_throne_request_limits_bucket_idx on public.rich_throne_request_limits(bucket);

alter table public.rich_throne_orders enable row level security;
alter table public.rich_throne_state enable row level security;
alter table public.rich_throne_integration enable row level security;
alter table public.rich_throne_request_limits enable row level security;
revoke all on public.rich_throne_orders, public.rich_throne_state,
  public.rich_throne_integration, public.rich_throne_request_limits from anon, authenticated, public;
grant select, insert, update, delete on public.rich_throne_orders, public.rich_throne_state,
  public.rich_throne_integration, public.rich_throne_request_limits to service_role;

create or replace function public.rich_throne_get_state()
returns jsonb language sql security invoker set search_path = '' as $$
  select to_jsonb(s) from public.rich_throne_state s where id = 1;
$$;

create or replace function public.rich_throne_get_order(p_order_token uuid default null, p_order_id uuid default null)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders;
begin
  if (p_order_token is null) = (p_order_id is null) then raise exception 'Exactly one order selector is required'; end if;
  if p_order_token is not null then
    select * into v_order from public.rich_throne_orders where access_token = p_order_token;
  else
    select * into v_order from public.rich_throne_orders where id = p_order_id;
  end if;
  if not found then return null; end if;
  return to_jsonb(v_order);
end; $$;

create or replace function public.rich_throne_rate_limit(p_scope text, p_subject_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_bucket bigint; v_count integer; v_window integer; v_limit integer;
begin
  if p_scope is null or p_subject_hash is null or p_scope not in ('checkout','status') or p_subject_hash !~ '^[0-9a-f]{64}$' then raise exception 'Invalid rate limit scope'; end if;
  v_window := case when p_scope = 'checkout' then 600 else 60 end;
  v_limit := case when p_scope = 'checkout' then 15 else 120 end;
  v_bucket := floor(extract(epoch from clock_timestamp()) / v_window)::bigint * v_window;
  insert into public.rich_throne_request_limits(scope,subject_hash,bucket)
    values (p_scope,p_subject_hash,v_bucket)
    on conflict(scope,subject_hash,bucket) do update set requests = public.rich_throne_request_limits.requests + 1
    returning requests into v_count;
  delete from public.rich_throne_request_limits where bucket < extract(epoch from clock_timestamp())::bigint - 7200;
  return jsonb_build_object('allowed',v_count <= v_limit,'retry_after',v_window - (extract(epoch from clock_timestamp())::bigint - v_bucket));
end; $$;

create or replace function public.rich_throne_prepare_order(
  p_request_id uuid, p_display_name text, p_country text, p_amount_cents integer, p_terms_version text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders; v_amount integer;
begin
  if p_request_id is null or p_amount_cents is null or p_amount_cents < 10100 or p_amount_cents > 99999999
    or (p_display_name is not null and char_length(btrim(p_display_name)) not between 1 and 60)
    or (p_country is not null and char_length(btrim(p_country)) not between 1 and 80)
    or p_display_name ~ '[[:cntrl:]]' or p_country ~ '[[:cntrl:]]'
    or p_terms_version is distinct from 'richest-2026-11-17' then raise exception 'Invalid order details'; end if;
  select * into v_order from public.rich_throne_orders where request_id = p_request_id;
  if found then
    if v_order.display_name is distinct from btrim(p_display_name) or v_order.country is distinct from btrim(p_country) or v_order.amount_cents <> p_amount_cents then
      return jsonb_build_object('error','request_reused');
    end if;
    return jsonb_build_object('order',to_jsonb(v_order),'reused',true);
  end if;
  select amount_cents into v_amount from public.rich_throne_state where id = 1;
  if not found then raise exception 'Throne state unavailable'; end if;
  if p_amount_cents < v_amount + 100 then return jsonb_build_object('error','minimum_changed','next_minimum',(v_amount+100)::numeric/100); end if;
  insert into public.rich_throne_orders(request_id,display_name,country,amount_cents,terms_accepted_at,terms_version)
    values(p_request_id,btrim(p_display_name),btrim(p_country),p_amount_cents,clock_timestamp(),p_terms_version)
    on conflict(request_id) do nothing returning * into v_order;
  if not found then
    select * into v_order from public.rich_throne_orders where request_id = p_request_id;
    if v_order.display_name is distinct from btrim(p_display_name) or v_order.country is distinct from btrim(p_country) or v_order.amount_cents <> p_amount_cents then
      return jsonb_build_object('error','request_reused');
    end if;
  end if;
  return jsonb_build_object('order',to_jsonb(v_order),'reused',false);
end; $$;

create or replace function public.rich_throne_attach_session(p_order_id uuid,p_session_id text,p_expires_at timestamptz)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders;
begin
  if p_session_id is null or p_session_id !~ '^cs_live_[A-Za-z0-9]+$' then raise exception 'Invalid live session'; end if;
  select * into v_order from public.rich_throne_orders where id=p_order_id for update;
  if not found then raise exception 'Unknown order'; end if;
  if v_order.stripe_checkout_session_id is not null and v_order.stripe_checkout_session_id <> p_session_id then raise exception 'Session mismatch'; end if;
  update public.rich_throne_orders set stripe_checkout_session_id=p_session_id,checkout_expires_at=p_expires_at
    where id=p_order_id returning * into v_order;
  return to_jsonb(v_order);
end; $$;

create or replace function public.rich_throne_confirm_payment(
  p_order_id uuid,p_session_id text,p_payment_intent_id text,p_amount_cents integer,p_currency text,p_livemode boolean)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders; v_state public.rich_throne_state; v_now timestamptz := clock_timestamp();
begin
  -- Lock the singleton first on every settlement. Network/Stripe calls happen
  -- BEFORE this RPC, so these locks are held only for the database transaction.
  select * into v_state from public.rich_throne_state where id=1 for update;
  if not found then raise exception 'Throne state unavailable'; end if;
  select * into v_order from public.rich_throne_orders where id=p_order_id for update;
  if not found then raise exception 'Unknown order'; end if;
  if p_livemode is distinct from true or p_currency is distinct from 'eur'
    or p_session_id is null or p_session_id !~ '^cs_live_[A-Za-z0-9]+$'
    or p_session_id is distinct from v_order.stripe_checkout_session_id
    or p_amount_cents is distinct from v_order.amount_cents
    or p_payment_intent_id is null or p_payment_intent_id !~ '^pi_[A-Za-z0-9]+$'
    or (v_order.stripe_payment_intent_id is not null and v_order.stripe_payment_intent_id <> p_payment_intent_id)
    then raise exception 'Payment verification mismatch'; end if;
  if v_order.status in ('paid','superseded','refunded') or v_order.crowned_at is not null then
    return jsonb_build_object('order',to_jsonb(v_order),'current',to_jsonb(v_state),'changed',false);
  end if;
  if v_order.amount_cents >= v_state.amount_cents + 100 then
    update public.rich_throne_orders set status='paid',stripe_payment_intent_id=p_payment_intent_id,
      paid_at=coalesce(paid_at,v_now),crowned_at=v_now,last_checked_at=v_now where id=p_order_id returning * into v_order;
    update public.rich_throne_state set owner_name=coalesce(v_order.display_name,'Anonymous'),country=coalesce(v_order.country,'COUNTRY NOT DISCLOSED'),
      amount_cents=v_order.amount_cents,verified_payment=true,current_order_id=v_order.id,updated_at=v_now
      where id=1 returning * into v_state;
  else
    update public.rich_throne_orders set status='superseded',stripe_payment_intent_id=p_payment_intent_id,
      paid_at=coalesce(paid_at,v_now),refund_status='pending',last_checked_at=v_now
      where id=p_order_id returning * into v_order;
  end if;
  return jsonb_build_object('order',to_jsonb(v_order),'current',to_jsonb(v_state),'changed',true);
end; $$;

create or replace function public.rich_throne_mark_expired(p_order_id uuid,p_session_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders;
begin
  select * into v_order from public.rich_throne_orders where id=p_order_id for update;
  if not found or p_session_id is distinct from v_order.stripe_checkout_session_id then raise exception 'Session mismatch'; end if;
  if v_order.status='pending' then
    update public.rich_throne_orders set status='expired',last_checked_at=clock_timestamp() where id=p_order_id returning * into v_order;
  end if;
  return to_jsonb(v_order);
end; $$;

create or replace function public.rich_throne_record_refund(p_order_id uuid,p_refund_id text,p_refund_status text,p_amount_cents integer,p_payment_intent_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.rich_throne_orders;
begin
  select * into v_order from public.rich_throne_orders where id=p_order_id for update;
  if not found or v_order.crowned_at is not null or v_order.status not in ('superseded','refunded')
    or p_refund_id is null or p_refund_id !~ '^re_[A-Za-z0-9]+$'
    or p_amount_cents is distinct from v_order.amount_cents
    or p_payment_intent_id is distinct from v_order.stripe_payment_intent_id
    or p_refund_status is null or p_refund_status not in ('pending','requires_action','succeeded','failed','canceled')
    or (v_order.stripe_refund_id is not null and v_order.stripe_refund_id<>p_refund_id)
    then raise exception 'Refund verification mismatch'; end if;
  -- Never regress a successful refund because of an older webhook event.
  if v_order.status='refunded' then return to_jsonb(v_order); end if;
  update public.rich_throne_orders set stripe_refund_id=p_refund_id,refund_status=p_refund_status,
    status=case when p_refund_status='succeeded' then 'refunded' else 'superseded' end,
    refunded_at=case when p_refund_status='succeeded' then clock_timestamp() else refunded_at end,
    last_checked_at=clock_timestamp() where id=p_order_id returning * into v_order;
  return to_jsonb(v_order);
end; $$;

create or replace function public.rich_throne_acquire_webhook_setup(p_lease_token uuid)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_config public.rich_throne_integration; v_now timestamptz := clock_timestamp();
begin
  if p_lease_token is null then raise exception 'Invalid lease'; end if;
  insert into public.rich_throne_integration(id) values(1) on conflict(id) do nothing;
  select * into v_config from public.rich_throne_integration where id=1 for update;
  if v_config.ready_at is not null and v_config.vault_secret_id is not null then return jsonb_build_object('ready',true); end if;
  -- Stripe keeps idempotency results for at least24h. Fail closed rather than
  -- silently creating another endpoint after an unrecovered, day-old setup.
  if v_config.registration_started_at < v_now-interval '22 hours' then return jsonb_build_object('error','setup_expired'); end if;
  if v_config.setup_lease_until > v_now and v_config.setup_lease_token is distinct from p_lease_token then
    return jsonb_build_object('acquired',false,'retry_after',3);
  end if;
  update public.rich_throne_integration set setup_lease_token=p_lease_token,setup_lease_until=v_now+interval '90 seconds',
    registration_started_at=coalesce(registration_started_at,v_now),updated_at=v_now where id=1 returning * into v_config;
  return jsonb_build_object('acquired',true,'generation',v_config.generation);
end; $$;

create or replace function public.rich_throne_save_webhook_setup(
  p_lease_token uuid,p_generation uuid,p_endpoint_id text,p_signing_secret text,p_account_id text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_config public.rich_throne_integration; v_secret_id uuid;
begin
  if p_endpoint_id is null or p_signing_secret is null or p_account_id is null
    or p_endpoint_id !~ '^we_[A-Za-z0-9]+$' or p_signing_secret !~ '^whsec_[A-Za-z0-9]+$'
    or p_account_id !~ '^acct_[A-Za-z0-9]+$' then raise exception 'Invalid integration details'; end if;
  select * into v_config from public.rich_throne_integration where id=1 for update;
  if not found or v_config.generation is distinct from p_generation then raise exception 'Integration generation mismatch'; end if;
  if v_config.ready_at is not null then
    if v_config.webhook_endpoint_id<>p_endpoint_id then raise exception 'Integration endpoint mismatch'; end if;
    return jsonb_build_object('ready',true);
  end if;
  if v_config.setup_lease_token is distinct from p_lease_token then raise exception 'Setup lease mismatch'; end if;
  v_secret_id := vault.create_secret(p_signing_secret,'rich-throne-webhook-'||p_generation::text,'Signing secret for The Richest Button only');
  update public.rich_throne_integration set webhook_endpoint_id=p_endpoint_id,vault_secret_id=v_secret_id,stripe_account_id=p_account_id,
    ready_at=clock_timestamp(),setup_lease_token=null,setup_lease_until=null,updated_at=clock_timestamp() where id=1;
  return jsonb_build_object('ready',true);
end; $$;

create or replace function public.rich_throne_release_webhook_setup(p_lease_token uuid)
returns void language sql security invoker set search_path = '' as $$
  update public.rich_throne_integration set setup_lease_token=null,setup_lease_until=null,updated_at=clock_timestamp()
    where id=1 and setup_lease_token=p_lease_token and ready_at is null;
$$;

-- PRIVATE RPC: returns one dedicated signing secret only to service_role.
-- Never call this RPC from the browser or print its response in deployment logs.
create or replace function public.rich_throne_webhook_configuration()
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_config public.rich_throne_integration; v_secret text;
begin
  select * into v_config from public.rich_throne_integration where id=1;
  if not found or v_config.ready_at is null or v_config.vault_secret_id is null then return jsonb_build_object('ready',false); end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id=v_config.vault_secret_id;
  if v_secret is null then return jsonb_build_object('ready',false); end if;
  return jsonb_build_object('ready',true,'endpoint_id',v_config.webhook_endpoint_id,
    'stripe_account_id',v_config.stripe_account_id,'signing_secret',v_secret);
end; $$;

-- These functions remain INVOKER. Public and authenticated sessions cannot call
-- them; only Edge Functions holding service_role can settle payments or use Vault.
do $permissions$
declare r record;
begin
  for r in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'rich_throne_get_state','rich_throne_get_order','rich_throne_rate_limit','rich_throne_prepare_order',
      'rich_throne_attach_session','rich_throne_confirm_payment','rich_throne_mark_expired','rich_throne_record_refund',
      'rich_throne_acquire_webhook_setup','rich_throne_save_webhook_setup','rich_throne_release_webhook_setup','rich_throne_webhook_configuration')
  loop
    execute format('revoke all on function %s from public,anon,authenticated',r.signature);
    execute format('grant execute on function %s to service_role',r.signature);
  end loop;
end;
$permissions$;

commit;
