begin;

create table if not exists public.rich_campaign_ads (
  ad_code text primary key,
  source text not null,
  medium text not null,
  campaign text not null,
  ad_title text not null,
  target_city text not null
);

alter table public.rich_campaign_ads enable row level security;
revoke all on public.rich_campaign_ads from public, anon, authenticated, service_role;
grant select on public.rich_campaign_ads to service_role;

insert into public.rich_campaign_ads (ad_code, source, medium, campaign, ad_title, target_city)
values
  ('vault-v1-miami', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'Miami'),
  ('vault-v1-dubai', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'Dubai'),
  ('vault-v1-london', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'London'),
  ('vault-v1-singapore', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'Singapore'),
  ('vault-v1-sydney', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'Sydney')
on conflict (ad_code) do nothing;

alter table public.rich_analytics_events
  add column if not exists campaign_ad text references public.rich_campaign_ads(ad_code)
    check (campaign_ad is null or
      (event_type = 'page_view' and page = 'home' and gift_kind is null and gift_id is null));
alter table public.rich_gift_orders
  add column if not exists campaign_ad text references public.rich_campaign_ads(ad_code);

create index if not exists rich_analytics_campaign_date_idx
  on public.rich_analytics_events (created_at, campaign_ad) where campaign_ad is not null;
create index if not exists rich_gift_campaign_date_idx
  on public.rich_gift_orders (created_at, campaign_ad) where campaign_ad is not null;

create or replace function public.rich_campaign_report()
returns table (
  campaign text, ad_code text, ad_title text, target_city text,
  home_views bigint, checkout_starts bigint, paid_gifts bigint
)
language sql stable security invoker
set search_path = ''
set timezone = 'UTC'
as $report$
  with visits as (
    select e.campaign_ad, count(*) as views
    from public.rich_analytics_events e
    where e.campaign_ad is not null and e.event_type = 'page_view' and e.page = 'home'
      and e.created_at >= current_date - 29 and e.created_at <= now()
    group by e.campaign_ad
  ), orders as (
    select o.campaign_ad, count(*) as starts,
      count(*) filter (
        where o.status = 'paid' and o.paid_at is not null
          and o.amount_cents > 0 and lower(o.currency) = 'eur'
      ) as paid
    from public.rich_gift_orders o
    where o.campaign_ad is not null and starts_with(o.stripe_checkout_session_id, 'cs_live_')
      and o.created_at >= current_date - 29 and o.created_at <= now()
    group by o.campaign_ad
  )
  select a.campaign, a.ad_code, a.ad_title, a.target_city,
    coalesce(v.views, 0), coalesce(o.starts, 0), coalesce(o.paid, 0)
  from public.rich_campaign_ads a
  left join visits v on v.campaign_ad = a.ad_code
  left join orders o on o.campaign_ad = a.ad_code
  order by a.campaign, a.target_city, a.ad_code;
$report$;

revoke all on function public.rich_campaign_report() from public, anon, authenticated;
grant execute on function public.rich_campaign_report() to service_role;

commit;
