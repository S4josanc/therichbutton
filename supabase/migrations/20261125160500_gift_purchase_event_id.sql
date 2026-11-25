begin;

-- Existing orders stay untracked. Each new order has an unrelated, stable marketing event ID.
alter table public.rich_gift_orders add column if not exists marketing_event_id uuid;
alter table public.rich_gift_orders alter column marketing_event_id set default gen_random_uuid();
create unique index if not exists rich_gift_orders_marketing_event_id_key
  on public.rich_gift_orders (marketing_event_id) where marketing_event_id is not null;

commit;
