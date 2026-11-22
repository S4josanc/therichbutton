-- Apply after campaign-attribution.sql. Keep the original ad labels and every
-- tagged row so a historical checkout can still become a confirmed payment.
begin;

alter table public.rich_campaign_ads
  add column if not exists active boolean not null default true;

insert into public.rich_campaign_ads (ad_code, source, medium, campaign, ad_title, target_city)
values
  ('vault-v1-new-york', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'New York'),
  ('vault-v1-los-angeles', 'meta', 'paid_social', 'christmas_2026', 'Vault Reveal v1', 'Los Angeles')
on conflict (ad_code) do nothing;

update public.rich_campaign_ads set active = false
where campaign = 'christmas_2026' and active and ad_code in ('vault-v1-singapore', 'vault-v1-sydney');

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
          and o.amount_cents = 4900 and lower(o.currency) = 'eur'
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
  -- An archived ad remains visible while its reporting window contains results.
  where a.active or v.views > 0 or o.starts > 0
  order by a.campaign, a.target_city, a.ad_code;
$report$;

commit;
