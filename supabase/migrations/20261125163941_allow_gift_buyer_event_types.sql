set local lock_timeout='3s';
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
