BEGIN;

-- The paid context check must already be in place before extending the event vocabulary.
DO $prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.rich_analytics_events'::regclass
      AND conname = 'rich_analytics_events_campaign_context_check'
  ) THEN
    RAISE EXCEPTION 'Missing paid event constraints: apply 20261125163941_allow_gift_buyer_event_types.sql before organic attribution';
  END IF;
END;
$prerequisite$;

CREATE TABLE public.rich_organic_posts (
  source text NOT NULL,
  campaign text NOT NULL,
  content text NOT NULL,
  post_title text NOT NULL,
  post_id text GENERATED ALWAYS AS (source || '_' || campaign || '_' || content) STORED PRIMARY KEY,
  UNIQUE (source, campaign, content)
);
ALTER TABLE public.rich_organic_posts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rich_organic_posts FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.rich_organic_posts TO service_role;

-- Actual destination tags from Calendario_The_Rich_Button.xlsx. Use the publishing
-- title if present, otherwise the creative headline. A shared profile has no post.
INSERT INTO public.rich_organic_posts (source, campaign, content, post_title) VALUES
  ('pinterest', 'black_friday_2026', 'black-friday', 'A Black Friday gift for the person who asks for nothing'),
  ('facebook', 'black_friday_2026', 'black-friday', 'Half price on 27 November.'),
  ('instagram', 'black_friday_2026', 'black-friday', 'Half price on 27 November.'),
  ('youtube', 'black_friday_2026', 'black-friday', 'We cut the price of doing nothing in half'),
  ('tiktok', 'black_friday_2026', 'black-friday', 'Half price on 27 November.'),
  ('pinterest', 'christmas_2026', 'day-01', 'A Christmas gift for the person who has everything'),
  ('facebook', 'christmas_2026', 'day-01', 'A digital button.'),
  ('instagram', 'christmas_2026', 'day-01', 'A digital button.'),
  ('youtube', 'christmas_2026', 'day-01', 'A Christmas gift for someone who owns absolutely everything'),
  ('tiktok', 'christmas_2026', 'day-01', 'A digital button.'),
  ('pinterest', 'christmas_2026', 'day-02', 'Meet The Rich Button and try the free demo'),
  ('facebook', 'christmas_2026', 'day-02', 'Much ado about nothing.'),
  ('instagram', 'christmas_2026', 'day-02', 'Much ado about nothing.'),
  ('youtube', 'christmas_2026', 'day-02', 'What was important enough to put behind this vault door?'),
  ('tiktok', 'christmas_2026', 'day-02', 'Much ado about nothing.'),
  ('pinterest', 'christmas_2026', 'day-03', 'A Christmas gift for the dad who asks for nothing'),
  ('facebook', 'christmas_2026', 'day-03', 'He’s getting it in writing.'),
  ('instagram', 'christmas_2026', 'day-03', 'He’s getting it in writing.'),
  ('youtube', 'christmas_2026', 'day-03', 'Dad asked for nothing. I found his Christmas present.'),
  ('tiktok', 'christmas_2026', 'day-03', 'He’s getting it in writing.'),
  ('pinterest', 'christmas_2026', 'day-04', 'The €499 Gold Edition of The Rich Button'),
  ('facebook', 'christmas_2026', 'day-04', 'Quietly €499.'),
  ('instagram', 'christmas_2026', 'day-04', 'Quietly €499.'),
  ('youtube', 'christmas_2026', 'day-04', 'What does a €499 Gold Button actually do?'),
  ('tiktok', 'christmas_2026', 'day-04', 'Quietly €499.'),
  ('pinterest', 'christmas_2026', 'day-05', 'Would you give someone a digital button for Christmas?'),
  ('facebook', 'christmas_2026', 'day-05', 'Who said “nothing”?'),
  ('instagram', 'christmas_2026', 'day-05', 'Who said “nothing”?'),
  ('youtube', 'christmas_2026', 'day-05', 'Who says “don’t get me anything” in your family?'),
  ('tiktok', 'christmas_2026', 'day-05', 'Who said “nothing”?'),
  ('pinterest', 'christmas_2026', 'day-06', 'Try The Rich Gift button demo for free'),
  ('facebook', 'christmas_2026', 'day-06', 'Test result: still a button.'),
  ('instagram', 'christmas_2026', 'day-06', 'Test result: still a button.'),
  ('youtube', 'christmas_2026', 'day-06', 'Testing a button that promises to do absolutely nothing'),
  ('tiktok', 'christmas_2026', 'day-06', 'Test result: still a button.'),
  ('pinterest', 'christmas_2026', 'day-07', 'A digital Christmas gift with your own inside joke'),
  ('facebook', 'christmas_2026', 'day-07', 'This is for the olive jar.'),
  ('instagram', 'christmas_2026', 'day-07', 'This is for the olive jar.'),
  ('youtube', 'christmas_2026', 'day-07', 'The Christmas gift that only makes sense to two people'),
  ('tiktok', 'christmas_2026', 'day-07', 'This is for the olive jar.'),
  ('pinterest', 'christmas_2026', 'day-08', 'The €9,999 Diamond Button and one awkward expense claim'),
  ('facebook', 'christmas_2026', 'day-08', 'A button. It was for a button.'),
  ('instagram', 'christmas_2026', 'day-08', 'A button. It was for a button.'),
  ('youtube', 'christmas_2026', 'day-08', 'How do you explain a €9,999 button to your accountant?'),
  ('tiktok', 'christmas_2026', 'day-08', 'A button. It was for a button.'),
  ('pinterest', 'christmas_2026', 'day-09', 'A digital Christmas gift that needs no wrapping paper'),
  ('facebook', 'christmas_2026', 'day-09', 'Put the scissors down.'),
  ('instagram', 'christmas_2026', 'day-09', 'Put the scissors down.'),
  ('youtube', 'christmas_2026', 'day-09', 'One Christmas present you can wrap without scissors'),
  ('tiktok', 'christmas_2026', 'day-09', 'Put the scissors down.'),
  ('pinterest', 'christmas_2026', 'day-10', 'Gold, Platinum and Diamond: compare The Rich Button editions'),
  ('facebook', 'christmas_2026', 'day-10', 'Same job. Three budgets.'),
  ('instagram', 'christmas_2026', 'day-10', 'Same job. Three budgets.'),
  ('youtube', 'christmas_2026', 'day-10', '€499 or €9,999? Compare the three Rich Button editions'),
  ('tiktok', 'christmas_2026', 'day-10', 'Same job. Three budgets.'),
  ('pinterest', 'christmas_2026', 'day-11', 'How to send The Rich Gift without interrupting Christmas dinner'),
  ('facebook', 'christmas_2026', 'day-11', 'Pass it under the table.'),
  ('instagram', 'christmas_2026', 'day-11', 'Pass it under the table.'),
  ('youtube', 'christmas_2026', 'day-11', 'How to pass a Christmas present under the table'),
  ('tiktok', 'christmas_2026', 'day-11', 'Pass it under the table.'),
  ('pinterest', 'christmas_2026', 'day-12', 'Gold, Platinum or Diamond? Try the Platinum Button demo'),
  ('facebook', 'christmas_2026', 'day-12', 'The dress code is Platinum.'),
  ('instagram', 'christmas_2026', 'day-12', 'The dress code is Platinum.'),
  ('youtube', 'christmas_2026', 'day-12', 'Who invited a €1,999 button to a black-tie dinner?'),
  ('tiktok', 'christmas_2026', 'day-12', 'The dress code is Platinum.'),
  ('pinterest', 'christmas_2026', 'day-13', 'The Rich Gift comes with a printable gift certificate'),
  ('facebook', 'christmas_2026', 'day-13', 'This deserves a frame.'),
  ('instagram', 'christmas_2026', 'day-13', 'This deserves a frame.'),
  ('youtube', 'christmas_2026', 'day-13', 'What’s the framed certificate for? A button.'),
  ('tiktok', 'christmas_2026', 'day-13', 'This deserves a frame.'),
  ('pinterest', 'christmas_2026', 'day-14', 'The unexpected €49 Christmas present for someone with everything'),
  ('facebook', 'christmas_2026', 'day-14', 'This, on the other hand, is €49.'),
  ('instagram', 'christmas_2026', 'day-14', 'This, on the other hand, is €49.'),
  ('youtube', 'christmas_2026', 'day-14', 'Money can’t buy happiness. What does €49 buy?'),
  ('tiktok', 'christmas_2026', 'day-14', 'This, on the other hand, is €49.'),
  ('pinterest', 'christmas_2026', 'day-15', 'Open The Rich Gift’s digital envelope in the free preview'),
  ('facebook', 'christmas_2026', 'day-15', 'Touch the seal.'),
  ('instagram', 'christmas_2026', 'day-15', 'Touch the seal.'),
  ('youtube', 'christmas_2026', 'day-15', 'What happens when you tap the seal on The Rich Gift?'),
  ('tiktok', 'christmas_2026', 'day-15', 'Touch the seal.'),
  ('pinterest', 'christmas_2026', 'day-16', 'A digital Christmas gift for someone in another time zone'),
  ('facebook', 'christmas_2026', 'day-16', 'Two time zones. One envelope.'),
  ('instagram', 'christmas_2026', 'day-16', 'Two time zones. One envelope.'),
  ('youtube', 'christmas_2026', 'day-16', 'She wanted nothing for Christmas. I found it.'),
  ('tiktok', 'christmas_2026', 'day-16', 'Two time zones. One envelope.'),
  ('pinterest', 'christmas_2026', 'day-17', 'A Christmas wish-list idea for the person who guesses every gift'),
  ('facebook', 'christmas_2026', 'day-17', 'I can explain the socks.'),
  ('instagram', 'christmas_2026', 'day-17', 'I can explain the socks.'),
  ('youtube', 'christmas_2026', 'day-17', 'They always guess the socks. Let them guess this.'),
  ('tiktok', 'christmas_2026', 'day-17', 'I can explain the socks.'),
  ('pinterest', 'christmas_2026', 'day-18', 'A Christmas gift wrapped in a digital envelope'),
  ('facebook', 'christmas_2026', 'day-18', 'I wrapped the link.'),
  ('instagram', 'christmas_2026', 'day-18', 'I wrapped the link.'),
  ('youtube', 'christmas_2026', 'day-18', 'How do you wrap a link for Christmas?'),
  ('tiktok', 'christmas_2026', 'day-18', 'I wrapped the link.'),
  ('pinterest', 'christmas_2026', 'day-19', 'Still looking for a Christmas gift? Preview your note for free'),
  ('facebook', 'christmas_2026', 'day-19', 'A dress rehearsal for Christmas.'),
  ('instagram', 'christmas_2026', 'day-19', 'A dress rehearsal for Christmas.'),
  ('youtube', 'christmas_2026', 'day-19', 'Last-minute Christmas gift? Try writing the note first.'),
  ('tiktok', 'christmas_2026', 'day-19', 'A dress rehearsal for Christmas.'),
  ('pinterest', 'christmas_2026', 'day-20', 'A ridiculously rich Christmas from The Rich Button'),
  ('facebook', 'christmas_2026', 'day-20', 'A ridiculously rich Christmas.'),
  ('instagram', 'christmas_2026', 'day-20', 'A ridiculously rich Christmas.'),
  ('youtube', 'christmas_2026', 'day-20', 'A ridiculously rich Christmas from The Rich Button'),
  ('tiktok', 'christmas_2026', 'day-20', 'A ridiculously rich Christmas.'),
  ('instagram', 'christmas_2026', 'profile', 'Profile link · post unknown'),
  ('tiktok', 'christmas_2026', 'profile', 'Profile link · post unknown'),
  ('youtube', 'christmas_2026', 'profile', 'Profile link · post unknown');

ALTER TABLE public.rich_analytics_events
  ADD COLUMN organic_post_id text REFERENCES public.rich_organic_posts(post_id),
  DROP CONSTRAINT rich_analytics_events_event_type_check,
  ADD CONSTRAINT rich_analytics_events_event_type_check CHECK (event_type IN (
    'page_view', 'gift_open', 'gift_reveal', 'gift_cta_click',
    'gift_personalize_start', 'gift_checkout_click', 'organic_landing', 'organic_checkout_click'
  )),
  ADD CONSTRAINT rich_analytics_events_organic_context_check CHECK (
    (event_type IN ('organic_landing','organic_checkout_click')) = (organic_post_id IS NOT NULL)
    AND (organic_post_id IS NULL OR (
      campaign_ad IS NULL AND gift_kind IS NULL AND gift_id IS NULL AND page IS NOT NULL
      AND page IN ('home','gift','rich-gift','rich-gift-button','gold','platinum','diamond')
    ))
  );

ALTER TABLE public.rich_gift_orders
  ADD COLUMN organic_post_id text REFERENCES public.rich_organic_posts(post_id),
  ADD COLUMN organic_verified_at timestamptz,
  ADD CONSTRAINT rich_gift_orders_organic_context_check CHECK (
    organic_post_id IS NULL OR
      (campaign_ad IS NULL AND referral_kind IS NULL AND referral_token IS NULL)
  );
ALTER TABLE public.rich_edition_orders
  ADD COLUMN organic_post_id text REFERENCES public.rich_organic_posts(post_id),
  ADD COLUMN organic_verified_at timestamptz;

CREATE INDEX rich_organic_events_idx ON public.rich_analytics_events (organic_post_id,event_type)
  WHERE organic_post_id IS NOT NULL;
CREATE INDEX rich_organic_gifts_idx ON public.rich_gift_orders (organic_post_id)
  WHERE organic_post_id IS NOT NULL AND organic_verified_at IS NOT NULL;
CREATE INDEX rich_organic_editions_idx ON public.rich_edition_orders (organic_post_id)
  WHERE organic_post_id IS NOT NULL AND organic_verified_at IS NOT NULL;

-- No rolling cutoff: the complete Black Friday campaign must still be visible
-- beside Christmas. Each recorded landing/click is an event, not a unique user.
CREATE FUNCTION public.rich_organic_report(p_before_deadline boolean DEFAULT false)
RETURNS TABLE (
  source text, campaign text, content text, post_title text,
  landing_views bigint, checkout_clicks bigint, verified_sales bigint
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $report$
  WITH deadline AS (
    SELECT timestamptz '2026-12-24 00:00:00 Europe/Bratislava' AS cutoff
  ), traffic AS (
    SELECT e.organic_post_id,
      count(*) FILTER (WHERE e.event_type = 'organic_landing') AS landings,
      count(*) FILTER (WHERE e.event_type = 'organic_checkout_click') AS clicks
    FROM public.rich_analytics_events e
    WHERE e.organic_post_id IS NOT NULL
      AND (NOT p_before_deadline OR e.created_at < (SELECT cutoff FROM deadline))
    GROUP BY e.organic_post_id
  ), verified_orders AS (
    SELECT g.organic_post_id, g.stripe_checkout_session_id AS session_id
    FROM public.rich_gift_orders g
    WHERE g.organic_post_id IS NOT NULL AND g.organic_verified_at IS NOT NULL
      AND g.status = 'paid' AND g.paid_at IS NOT NULL AND g.amount_cents > 0
      AND (NOT p_before_deadline OR g.organic_verified_at < (SELECT cutoff FROM deadline))
      AND g.currency = 'eur' AND starts_with(g.stripe_checkout_session_id, 'cs_live_')
    UNION ALL
    SELECT e.organic_post_id, e.stripe_session_id AS session_id
    FROM public.rich_edition_orders e
    WHERE e.organic_post_id IS NOT NULL AND e.organic_verified_at IS NOT NULL
      AND e.status = 'paid' AND e.paid_at IS NOT NULL AND e.amount_cents > 0
      AND (NOT p_before_deadline OR e.organic_verified_at < (SELECT cutoff FROM deadline))
      AND starts_with(e.stripe_session_id, 'cs_live_')
  ), paid_sessions AS (
    -- Session IDs are unique within each product table. If a session is also
    -- recorded in the other table, count it once and reject conflicting credit.
    SELECT min(v.organic_post_id) AS organic_post_id
    FROM verified_orders v GROUP BY v.session_id
    HAVING min(v.organic_post_id) = max(v.organic_post_id)
  ), sales AS (
    SELECT s.organic_post_id, count(*) AS paid FROM paid_sessions s GROUP BY s.organic_post_id
  )
  SELECT p.source, p.campaign, p.content, p.post_title, coalesce(t.landings, 0),
    coalesce(t.clicks, 0), coalesce(s.paid, 0)
  FROM public.rich_organic_posts p
  LEFT JOIN traffic t ON t.organic_post_id = p.post_id
  LEFT JOIN sales s ON s.organic_post_id = p.post_id
  ORDER BY p.campaign, p.source, p.content;
$report$;
REVOKE ALL ON FUNCTION public.rich_organic_report(boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rich_organic_report(boolean) TO service_role;
COMMIT;
