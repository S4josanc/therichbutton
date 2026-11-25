-- Only non-identifying buyer-side events can carry a campaign label.
ALTER TABLE public.rich_analytics_events
  DROP CONSTRAINT rich_analytics_events_event_type_check,
  DROP CONSTRAINT rich_analytics_events_check,
  ADD CONSTRAINT rich_analytics_events_event_type_check CHECK (
    event_type IN ('page_view', 'gift_open', 'gift_reveal', 'gift_cta_click',
                   'gift_personalize_start', 'gift_checkout_click')
  ),
  ADD CONSTRAINT rich_analytics_events_buyer_action_check CHECK (
    event_type NOT IN ('gift_personalize_start', 'gift_checkout_click')
    OR (page IS NOT NULL AND page = 'gift' AND gift_kind IS NULL AND gift_id IS NULL)
  ),
  ADD CONSTRAINT rich_analytics_events_campaign_context_check CHECK (
    campaign_ad IS NULL OR (
      gift_kind IS NULL AND gift_id IS NULL AND page IS NOT NULL AND (
        (event_type = 'page_view' AND page IN ('home', 'rich-gift', 'gift'))
        OR (event_type IN ('gift_personalize_start', 'gift_checkout_click') AND page = 'gift')
      )
    )
  );

INSERT INTO public.rich_campaign_ads (ad_code, source, medium, campaign, ad_title, target_city, active)
VALUES
  ('envelope-v2-london', 'meta', 'paid_social', 'christmas_2026', 'Envelope reveal', 'London', true),
  ('button-v2-london', 'meta', 'paid_social', 'christmas_2026', 'The button', 'London', true);

-- Replace the return signature atomically, retaining existing field names and access.
DROP FUNCTION public.rich_campaign_report();
CREATE FUNCTION public.rich_campaign_report()
RETURNS TABLE (
  campaign text, ad_code text, ad_title text, target_city text,
  home_views bigint, checkout_starts bigint, paid_gifts bigint,
  gift_offer_views bigint, gift_form_views bigint,
  personalization_starts bigint, checkout_clicks bigint
)
LANGUAGE sql STABLE SET search_path = '' SET timezone = 'UTC' AS $report$
  WITH visits AS (
    SELECT e.campaign_ad,
      count(*) FILTER (WHERE e.event_type = 'page_view' AND e.page = 'home') AS home_views,
      count(*) FILTER (WHERE e.event_type = 'page_view' AND e.page = 'rich-gift') AS offer_views,
      count(*) FILTER (WHERE e.event_type = 'page_view' AND e.page = 'gift') AS form_views,
      count(*) FILTER (WHERE e.event_type = 'gift_personalize_start') AS personalizations,
      count(*) FILTER (WHERE e.event_type = 'gift_checkout_click') AS checkout_clicks
    FROM public.rich_analytics_events e
    WHERE e.campaign_ad IS NOT NULL AND e.created_at BETWEEN current_date - 29 AND now()
    GROUP BY e.campaign_ad
  ), orders AS (
    SELECT o.campaign_ad, count(*) AS starts,
      count(*) FILTER (WHERE o.status = 'paid' AND o.paid_at IS NOT NULL
        AND o.amount_cents > 0 AND lower(o.currency) = 'eur') AS paid
    FROM public.rich_gift_orders o
    WHERE o.campaign_ad IS NOT NULL AND starts_with(o.stripe_checkout_session_id, 'cs_live_')
      AND o.created_at BETWEEN current_date - 29 AND now()
    GROUP BY o.campaign_ad
  )
  SELECT a.campaign, a.ad_code, a.ad_title, a.target_city,
    coalesce(v.home_views, 0), coalesce(o.starts, 0), coalesce(o.paid, 0),
    coalesce(v.offer_views, 0), coalesce(v.form_views, 0),
    coalesce(v.personalizations, 0), coalesce(v.checkout_clicks, 0)
  FROM public.rich_campaign_ads a
  LEFT JOIN visits v ON v.campaign_ad = a.ad_code
  LEFT JOIN orders o ON o.campaign_ad = a.ad_code
  WHERE a.active OR v.campaign_ad IS NOT NULL OR o.campaign_ad IS NOT NULL
  ORDER BY a.campaign, a.target_city, a.ad_code;
$report$;
REVOKE ALL ON FUNCTION public.rich_campaign_report() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rich_campaign_report() TO service_role;
