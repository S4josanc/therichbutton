-- Run only in an empty, disposable PostgreSQL instance:
-- psql -X -v ON_ERROR_STOP=1 -f supabase/tests/organic-report.sql
-- This existing fixture creates the roles and paid schema and verifies the paid funnel.
\ir campaign-report.sql
\ir ../migrations/20261125163751_gift_purchase_event_id.sql

-- Add the remaining production columns to the paid-report fixture, not the live schema.
ALTER TABLE public.rich_gift_orders ADD COLUMN referral_kind text, ADD COLUMN referral_token uuid;
ALTER TABLE public.rich_edition_orders
  ADD COLUMN status text NOT NULL DEFAULT 'pending',
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN stripe_session_id text UNIQUE;
ALTER TABLE public.rich_edition_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.rich_edition_orders TO service_role;

\ir ../migrations/20261125170000_organic_attribution.sql

BEGIN;
INSERT INTO public.rich_analytics_events (event_type,page,organic_post_id,created_at) VALUES
  ('organic_landing','rich-gift','pinterest_black_friday_2026_black-friday',now() - interval '60 days'),
  ('organic_checkout_click','gift','pinterest_black_friday_2026_black-friday',now() - interval '60 days'),
  ('organic_landing','rich-gift','pinterest_christmas_2026_day-01',now()),
  ('organic_landing','home','instagram_christmas_2026_profile',now()),
  ('organic_landing','home','instagram_christmas_2026_profile',now()),
  ('organic_checkout_click','diamond','youtube_christmas_2026_day-02',now()),
  ('gift_open','open-gift',NULL,now()),
  ('page_view','home',NULL,now());

INSERT INTO public.rich_analytics_events (event_type,page,campaign_ad)
  VALUES ('page_view','home','vault-v1-miami');
INSERT INTO public.rich_gift_orders (campaign_ad,status,paid_at,stripe_checkout_session_id)
  VALUES ('vault-v1-miami','paid',now(),'cs_live_paid_ad');

INSERT INTO public.rich_gift_orders (organic_post_id,status,paid_at,stripe_checkout_session_id,organic_verified_at,amount_cents) VALUES
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_live_gift',now(),2450),
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_test_gift',now(),2450),
  ('pinterest_black_friday_2026_black-friday','paid',NULL,'cs_live_no_paid_date',now(),2450),
  ('pinterest_black_friday_2026_black-friday','paid',now(),NULL,now(),2450),
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_live_no_verification',NULL,2450),
  ('pinterest_black_friday_2026_black-friday','refunded',now(),'cs_live_refunded',now(),2450),
  ('pinterest_black_friday_2026_black-friday','pending',NULL,'cs_live_pending',NULL,2450),
  (NULL,'paid',now(),'cs_live_unattributed',now(),4900);

INSERT INTO public.rich_edition_orders (organic_post_id,status,paid_at,stripe_session_id,organic_verified_at,edition,amount_cents) VALUES
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_live_edition',now(),'gold',24950),
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_test_edition',now(),'gold',24950),
  ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_live_unverified_ed',NULL,'platinum',99950),
  ('pinterest_black_friday_2026_black-friday','pending',NULL,'cs_live_pending_ed',NULL,'diamond',499950),
  ('pinterest_black_friday_2026_black-friday','refunded',now(),'cs_live_returned_ed',now(),'diamond',499950),
  ('instagram_christmas_2026_profile','paid',now(),'cs_live_bio',now(),'diamond',999900);

-- Exercise replay of a verified write, including an anomalous same-session duplicate across products.
UPDATE public.rich_gift_orders SET organic_verified_at = now() WHERE stripe_checkout_session_id = 'cs_live_gift';
INSERT INTO public.rich_edition_orders (organic_post_id,status,paid_at,stripe_session_id,organic_verified_at,edition,amount_cents)
  VALUES ('pinterest_black_friday_2026_black-friday','paid',now(),'cs_live_gift',now(),'gold',24950);
INSERT INTO public.rich_gift_orders (organic_post_id,status,paid_at,stripe_checkout_session_id,organic_verified_at,amount_cents)
  VALUES ('facebook_christmas_2026_day-20','paid',now(),'cs_live_conflict',now(),4900);
INSERT INTO public.rich_edition_orders (organic_post_id,status,paid_at,stripe_session_id,organic_verified_at,edition,amount_cents)
  VALUES ('youtube_christmas_2026_day-20','paid',now(),'cs_live_conflict',now(),'gold',49900);

DO $checks$
DECLARE
  id constant text := 'facebook_christmas_2026_day-01';
  invalid record;
BEGIN
  IF has_function_privilege('anon', 'public.rich_organic_report(boolean)', 'execute')
    OR has_function_privilege('authenticated','public.rich_organic_report(boolean)', 'execute')
    OR has_table_privilege('anon','public.rich_organic_posts','select')
    OR has_table_privilege('authenticated','public.rich_organic_posts','select')
    OR has_table_privilege('service_role','public.rich_organic_posts','insert')
    OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.rich_organic_posts'::regclass) THEN
    RAISE EXCEPTION 'Catalog or report permissions changed';
  END IF;
  BEGIN
    INSERT INTO public.rich_gift_orders (organic_post_id) VALUES ('unregistered');
    RAISE EXCEPTION 'Unknown post accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
  FOR invalid IN SELECT * FROM (VALUES
    ('organic_landing','home',NULL,NULL,NULL,NULL),
    ('organic_landing','open-gift',id,NULL,NULL,NULL),
    ('gift_open','open-gift',id,NULL,NULL,NULL),
    ('page_view','home',id,NULL,NULL,NULL),
    ('organic_checkout_click','gift',id,'paid',NULL,NULL),
    ('organic_checkout_click','gift',id,NULL,'00000000-0000-4000-8000-000000000001',NULL),
    ('organic_checkout_click','gift',id,NULL,NULL,'vault-v1-miami')
  ) AS x(event_type,page,organic_post_id,gift_kind,gift_id,campaign_ad) LOOP
    BEGIN
      INSERT INTO public.rich_analytics_events(event_type,page,organic_post_id,gift_kind,gift_id,campaign_ad)
        VALUES (invalid.event_type,invalid.page,invalid.organic_post_id,invalid.gift_kind,invalid.gift_id::uuid,invalid.campaign_ad);
      RAISE EXCEPTION 'Invalid event accepted: %', invalid;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
  FOR invalid IN SELECT * FROM (VALUES
    ('vault-v1-miami',NULL,NULL),
    (NULL,'paid',NULL),
    (NULL,NULL,'00000000-0000-4000-8000-000000000001')
  ) AS x(ad,kind,token) LOOP
    BEGIN
      INSERT INTO public.rich_gift_orders(organic_post_id,campaign_ad,referral_kind,referral_token)
        VALUES (id,invalid.ad,invalid.kind,invalid.token::uuid);
      RAISE EXCEPTION 'Mixed credit accepted: %',invalid;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
END;
$checks$;

SET LOCAL ROLE service_role;
DO $checks$
DECLARE r record;
BEGIN
  IF (SELECT marketing_event_id FROM public.rich_gift_orders
      WHERE stripe_checkout_session_id = 'cs_live_paid_ad') IS NULL THEN
    RAISE EXCEPTION 'Existing gift purchase event ID default changed';
  END IF;
  IF (SELECT count(*) FROM public.rich_organic_report()) <> 108
    OR (SELECT count(*) FROM public.rich_organic_report() WHERE campaign = 'black_friday_2026') <> 5
    OR (SELECT count(*) FROM public.rich_organic_report() WHERE campaign = 'christmas_2026' AND content <> 'profile') <> 100
    OR (SELECT array_agg(source ORDER BY source) FROM public.rich_organic_report() WHERE content = 'profile')
      IS DISTINCT FROM ARRAY['instagram','tiktok','youtube'] THEN
    RAISE EXCEPTION 'The editorial calendar or profile coverage changed';
  END IF;
  SELECT * INTO STRICT r FROM public.rich_organic_report() WHERE source = 'pinterest' AND campaign = 'black_friday_2026';
  IF (r.landing_views,r.checkout_clicks,r.verified_sales) IS DISTINCT FROM (1::bigint,1::bigint,2::bigint) THEN
    RAISE EXCEPTION 'Incorrect historical and verified counts: %',r;
  END IF;
  SELECT * INTO STRICT r FROM public.rich_organic_report() WHERE source = 'instagram' AND content = 'profile';
  IF (r.landing_views,r.checkout_clicks,r.verified_sales) IS DISTINCT FROM (2::bigint,0::bigint,1::bigint) THEN
    RAISE EXCEPTION 'Shared profile attribution changed: %',r;
  END IF;
  SELECT * INTO STRICT r FROM public.rich_organic_report() WHERE source = 'youtube' AND content = 'day-02';
  IF (r.landing_views,r.checkout_clicks,r.verified_sales) IS DISTINCT FROM (0::bigint,1::bigint,0::bigint) THEN
    RAISE EXCEPTION 'Checkout click became a purchase: %',r;
  END IF;
  IF (SELECT sum(verified_sales) FROM public.rich_organic_report()) <> 3 THEN
    RAISE EXCEPTION 'Unverified, paid-ad or duplicate session counted';
  END IF;
  SELECT * INTO STRICT r FROM public.rich_campaign_report() WHERE ad_code = 'vault-v1-miami';
  IF (r.home_views,r.paid_gifts) IS DISTINCT FROM (1::bigint,1::bigint) THEN
    RAISE EXCEPTION 'Existing paid attribution changed: %',r;
  END IF;
END;
$checks$;

RESET ROLE;
UPDATE public.rich_edition_orders SET status = 'refunded' WHERE stripe_session_id = 'cs_live_bio';
DO $checks$
BEGIN
  IF (SELECT verified_sales FROM public.rich_organic_report() WHERE content = 'profile' AND source = 'instagram') <> 0 THEN
    RAISE EXCEPTION 'A subsequently refunded order remained credited';
  END IF;
END;
$checks$;
-- The goal is before Dec 24 in Bratislava. Include 23:59:59 CET; exclude midnight,
-- including when Stripe verifies an order after an earlier visit or payment date.
INSERT INTO public.rich_analytics_events(event_type,page,organic_post_id,created_at) VALUES
  ('organic_landing','home','tiktok_christmas_2026_day-19','2026-12-23 22:59:59+00'),
  ('organic_landing','home','tiktok_christmas_2026_day-19','2026-12-23 23:00:00+00'),
  ('organic_checkout_click','gift','tiktok_christmas_2026_day-19','2026-12-23 23:00:00+00');
INSERT INTO public.rich_gift_orders(organic_post_id,status,paid_at,stripe_checkout_session_id,organic_verified_at)
  VALUES ('tiktok_christmas_2026_day-19','paid','2026-12-23 21:00+00','cs_live_one_second','2026-12-23 22:59:59+00'),
         ('tiktok_christmas_2026_day-19','paid','2026-12-23 21:00+00','cs_live_midnight','2026-12-23 23:00:00+00');
INSERT INTO public.rich_edition_orders(organic_post_id,status,paid_at,stripe_session_id,organic_verified_at,edition,amount_cents)
  VALUES ('tiktok_christmas_2026_day-19','paid','2026-12-23 21:00+00','cs_live_late_edition','2026-12-24 08:00+00','platinum',199900);
SET LOCAL timezone TO 'America/New_York';
SET LOCAL ROLE service_role;
DO $checks$
DECLARE r record;
BEGIN
  SELECT * INTO STRICT r FROM public.rich_organic_report(true) WHERE source = 'tiktok' AND content = 'day-19';
  IF (r.landing_views,r.checkout_clicks,r.verified_sales) IS DISTINCT FROM (1::bigint,0::bigint,1::bigint) THEN
    RAISE EXCEPTION 'Bratislava deadline filter changed: %',r;
  END IF;
  SELECT * INTO STRICT r FROM public.rich_organic_report() WHERE source = 'tiktok' AND content = 'day-19';
  IF (r.landing_views,r.checkout_clicks,r.verified_sales) IS DISTINCT FROM (2::bigint,1::bigint,3::bigint) THEN
    RAISE EXCEPTION 'The full campaign should still show late sales: %',r;
  END IF;
END;
$checks$;
ROLLBACK;
