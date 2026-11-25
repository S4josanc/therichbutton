-- Run with psql -X -v ON_ERROR_STOP=1 -f supabase/tests/campaign-report.sql
-- Use a fresh, isolated PostgreSQL instance as its local administrator (roles are cluster-wide).
-- This file creates the minimal roles and schema used by the production RPC.
\set ON_ERROR_STOP on
do $guard$
begin
  if to_regclass('public.rich_gift_orders') is not null
    or to_regclass('public.rich_analytics_events') is not null
    or to_regclass('public.rich_edition_orders') is not null then
    raise exception 'Use an empty disposable database';
  end if;
end;
$guard$;
create role anon;
create role authenticated;
create role service_role bypassrls;
create table public.rich_analytics_events (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in ('page_view', 'gift_open', 'gift_reveal', 'gift_cta_click')),
  page text not null, gift_kind text, gift_id uuid,
  created_at timestamptz not null default now()
);
create table public.rich_gift_orders (
  id bigint generated always as identity primary key,
  status text not null default 'pending', amount_cents int not null default 4900 check (amount_cents = 4900),
  currency text not null default 'eur', paid_at timestamptz,
  stripe_checkout_session_id text unique, created_at timestamptz not null default now()
);
create table public.rich_edition_orders (
  edition text not null, amount_cents integer not null,
  constraint rich_edition_orders_check check (
    (edition = 'gold' and amount_cents = 49900) or
    (edition = 'platinum' and amount_cents = 199900) or
    (edition = 'diamond' and amount_cents = 999900))
);
alter table public.rich_analytics_events enable row level security;
alter table public.rich_gift_orders enable row level security;
grant select on public.rich_analytics_events, public.rich_gift_orders to service_role;

\ir ../sql/campaign-attribution.sql
\ir ../sql/campaign-attribution.sql

\ir ../sql/christmas-2026-cities.sql
\ir ../sql/christmas-2026-cities.sql

\ir ../sql/black-friday-2026.sql
\ir ../sql/black-friday-2026.sql

\ir ../migrations/20261125155000_gift_campaign_funnel.sql

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

insert into public.rich_analytics_events (event_type, page, campaign_ad) values
  ('page_view','rich-gift','envelope-v2-london'),('page_view','gift','envelope-v2-london'),
  ('gift_personalize_start','gift','envelope-v2-london'),('gift_checkout_click','gift','envelope-v2-london');
set local role service_role;
do $checks$
declare result record;
begin
  if (select array_agg(distinct target_city order by target_city) from public.rich_campaign_report())
    is distinct from array['Dubai','London','Los Angeles','Miami','New York'] then
    raise exception 'The dashboard must show the five active cities';
  end if;
  if (select count(*) from public.rich_campaign_ads where not active) <> 2 then
    raise exception 'The two original labels must remain archived';
  end if;
  select * into strict result from public.rich_campaign_report() where ad_code = 'envelope-v2-london';
  if (result.home_views,result.gift_offer_views,result.gift_form_views,result.personalization_starts,
      result.checkout_clicks,result.checkout_starts,result.paid_gifts) <> (0,1,1,1,1,0,0) then
    raise exception 'Wrong real-purchase funnel counts: %', row_to_json(result);
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
reset role;
insert into public.rich_analytics_events (event_type, page, campaign_ad)
values ('page_view', 'home', 'vault-v1-sydney');
insert into public.rich_gift_orders (campaign_ad, stripe_checkout_session_id, status, paid_at)
values ('vault-v1-singapore', 'cs_live_historical', 'paid', now());
set local role service_role;
do $checks$
begin
  if (select home_views from public.rich_campaign_report() where ad_code = 'vault-v1-sydney') is distinct from 1
    or (select paid_gifts from public.rich_campaign_report() where ad_code = 'vault-v1-singapore') is distinct from 1 then
    raise exception 'Archiving must preserve attributable history';
  end if;
end;
$checks$;
reset role;

-- Discounted sales retain the actual price and use the same reporting rules.
insert into public.rich_edition_orders (edition, amount_cents)
values ('gold',24950),('platinum',99950),('diamond',499950);
insert into public.rich_gift_orders (campaign_ad, amount_cents, stripe_checkout_session_id, status, paid_at)
values ('vault-v1-miami',2450,'cs_live_black_friday','paid',now());
do $checks$
begin
  if (select paid_gifts from public.rich_campaign_report() where ad_code = 'vault-v1-miami') <> 1 then
    raise exception 'Discounted paid gift was missing from report';
  end if;
  begin
    insert into public.rich_edition_orders (edition,amount_cents) values ('diamond',24950);
    raise exception 'Tier mismatch accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.rich_gift_orders (amount_cents) values (2400);
    raise exception 'Unexpected gift amount accepted';
  exception when check_violation then null;
  end;
end;
$checks$;
rollback;
