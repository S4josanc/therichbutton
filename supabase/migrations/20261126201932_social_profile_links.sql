BEGIN;

-- The three Christmas profiles already exist. Preserve all historical post and sale labels.
INSERT INTO public.rich_organic_posts (source, campaign, content, post_title)
SELECT source, campaign, 'profile', 'Profile link · post unknown'
FROM unnest(ARRAY['instagram', 'tiktok', 'youtube']) AS sources(source)
CROSS JOIN unnest(ARRAY['black_friday_2026', 'evergreen']) AS campaigns(campaign)
ON CONFLICT (source, campaign, content) DO NOTHING;

DO $check$
BEGIN
  IF (SELECT count(*) FROM public.rich_organic_posts
      WHERE source IN ('instagram', 'tiktok', 'youtube')
        AND campaign IN ('black_friday_2026', 'christmas_2026', 'evergreen')
        AND content = 'profile' AND post_title = 'Profile link · post unknown') <> 9 THEN
    RAISE EXCEPTION 'Unexpected social profile catalogue; check the original organic attribution migration';
  END IF;
END;
$check$;

COMMIT;
