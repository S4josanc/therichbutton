insert into public.rich_campaign_ads (ad_code, source, medium, campaign, ad_title, target_city, active)
values ('envelope-v2-london','meta','paid_social','christmas_2026','Envelope reveal','London',true),
       ('button-v2-london','meta','paid_social','christmas_2026','The button','London',true)
on conflict (ad_code) do nothing;
