-- Run with psql -X -v ON_ERROR_STOP=1 -f supabase/tests/campaign-report.sql
-- Use a fresh, isolated PostgreSQL instance as its local administrator (roles are cluster-wide).
-- This file creates the minimal roles and schema used by the production RPC.
\set ON_ERROR_STOP on
do $guard$
begin
  if to_regclass('public.rich_gift_orders') is not null
    or to_regclass('public.rich_analytics_events') is not null then
    raise exception 'Use an empty disposable database';
  end if;
end;
$guard$;
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.rich_analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null, page text not null, gift_kind text, gift_id uuid,
  created_at timestamptz not null default now()
);
create table public.rich_gift_orders (
  id bigint generated always as identity primary key,
  status text not null default 'pending', amount_cents int not null default 4900,
  currency text not null default 'eur', paid_at timestamptz,
  stripe_checkout_session_id text unique, created_at timestamptz not null default now()
);
alter table public.rich_analytics_events enable row level security;
alter table public.rich_gift_orders enable row level security;
grant select on public.rich_analytics_events, public.rich_gift_orders to service_role;

\ir ../sql/campaign-attribution.sql
\ir ../sql/campaign-attribution.sql

begin;
set local timezone to 'America/Los_Angeles';

-- Legacy, untagged events and orders still insert normally after migration.
insert into public.rich_analytics_events (event_type, page, gift_kind, gift_id)
values ('gift_open', 'open-gift', 'preview', '00000000-0000-4000-8000-000000000001');
insert into public.rich_gift_orders (stripe_checkout_session_id) values ('cs_live_legacy');

do $checks$
begin
  if has_function_privilege('anon', 'public.rich_campaign_report()', 'execute')
    or has_function_privilege('authenticated', 'public.rich_campaign_report()', 'execute')
    or has_table_privilege('anon', 'public.rich_campaign_ads', 'select')
    or has_table_privilege('authenticated', 'public.rich_campaign_ads', 'select') then
    raise exception 'Campaign catalogue or report is exposed';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.rich_campaign_ads'::regclass) then
    raise exception 'Catalogue RLS is disabled';
  end if;
  begin
    insert into public.rich_gift_orders (campaign_ad) values ('unregistered');
    raise exception 'Free text unexpectedly accepted';
  exception when foreign_key_violation then null;
  end;
  begin
    insert into public.rich_analytics_events (event_type, page, campaign_ad)
      values ('gift_open', 'open-gift', 'vault-v1-dubai');
    raise exception 'Gift opens unexpectedly accepted campaign attribution';
  exception when check_violation then null;
  end;
end;
$checks$;

-- Include exactly the first UTC instant of the 30-date window, but nothing earlier or in the future.
insert into public.rich_analytics_events (event_type, page, campaign_ad, created_at)
select 'page_view', 'home', 'vault-v1-miami', sample_time
from (values
  (((((now() at time zone 'UTC')::date - 29)::timestamp) at time zone 'UTC')),
  (((((now() at time zone 'UTC')::date - 29)::timestamp) at time zone 'UTC') - interval '1 microsecond'),
  (now() + interval '1 day')
) sample(sample_time);
insert into public.rich_analytics_events (event_type, page, campaign_ad)
select 'page_view', 'home', 'vault-v1-miami' from generate_series(1, 10001);
insert into public.rich_gift_orders (campaign_ad, stripe_checkout_session_id)
select 'vault-v1-miami', 'cs_live_pending_' || n from generate_series(1, 101) n;
insert into public.rich_gift_orders (campaign_ad, status, stripe_checkout_session_id, paid_at)
values
  ('vault-v1-miami', 'pending', null, null),
  ('vault-v1-miami', 'paid', 'cs_test_fixture', now()),
  ('vault-v1-miami', 'refunded', 'cs_live_refunded', now());
insert into public.rich_gift_orders (campaign_ad, status, stripe_checkout_session_id, created_at, paid_at)
values ('vault-v1-miami', 'paid', 'cs_live_old', now() - interval '31 days', now());
-- A confirmed payment on the same order must count once even after webhook replay.
update public.rich_gift_orders set status = 'paid', paid_at = now()
where stripe_checkout_session_id = 'cs_live_pending_1';
update public.rich_gift_orders set status = 'paid', paid_at = now()
where stripe_checkout_session_id = 'cs_live_pending_1';

set local role service_role;
do $checks$
declare result record;
begin
  if (select count(*) from public.rich_campaign_report()) <> 5 then
    raise exception 'Expected a row for every registered ad';
  end if;
  select * into strict result from public.rich_campaign_report() where ad_code = 'vault-v1-miami';
  if (result.home_views, result.checkout_starts, result.paid_gifts) <> (10002, 102, 1) then
    raise exception 'Wrong Miami totals: %', row_to_json(result);
  end if;
  if exists (select from public.rich_campaign_report()
    where ad_code <> 'vault-v1-miami' and (home_views, checkout_starts, paid_gifts) <> (0, 0, 0)) then
    raise exception 'Untagged traffic or another city leaked into totals';
  end if;
end;
$checks$;
reset role;
update public.rich_gift_orders set status = 'refunded' where stripe_checkout_session_id = 'cs_live_pending_1';
set local role service_role;
do $checks$
begin
  if (select paid_gifts from public.rich_campaign_report() where ad_code = 'vault-v1-miami') <> 0 then
    raise exception 'Refund was still included in paid gifts';
  end if;
end;
$checks$;
rollback;
