-- Preserve the current wall while allowing the verified administrator to choose
-- its order. The public page features the first three entries in this order.
begin;

alter table public.rich_wall_entries
  add column if not exists display_order integer check (display_order > 0);

-- Existing entries retain their current order. Future entries have a null rank,
-- so they follow the administrator's saved selection until explicitly moved.
with ranked as (
  select id, row_number() over (order by created_at desc, id)::integer as position
  from public.rich_wall_entries
)
update public.rich_wall_entries as entry
set display_order = ranked.position
from ranked
where entry.id = ranked.id and entry.display_order is null
  and not exists (select 1 from public.rich_wall_entries where display_order is not null);

create index if not exists rich_wall_entries_display_order_idx
  on public.rich_wall_entries(display_order asc nulls last, created_at asc, id);

-- The public wall remains readable. All writes continue through rich-admin,
-- which authenticates the verified administrator before using service_role.
revoke all on public.rich_wall_entries from public, anon, authenticated;
grant select on public.rich_wall_entries to anon, authenticated;

create or replace function public.rich_wall_reorder(
  p_order_ids uuid[], p_expected_ids uuid[], p_actor_email text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '3s'
as $$
declare
  v_current_ids uuid[];
  v_entries jsonb;
begin
  if lower(coalesce(p_actor_email, '')) <> 'info@akademiaene.com' then
    return jsonb_build_object('error', 'access_denied');
  end if;
  if p_order_ids is null or p_expected_ids is null
    or coalesce(array_ndims(p_order_ids), 1) <> 1
    or coalesce(array_ndims(p_expected_ids), 1) <> 1
    or cardinality(p_order_ids) > 1000 or cardinality(p_expected_ids) > 1000 then
    return jsonb_build_object('error', 'invalid_order');
  end if;

  -- Serialize changes against other reorders, additions and removals. Public
  -- readers keep seeing the previous committed order until this call commits.
  lock table public.rich_wall_entries in share row exclusive mode;
  select coalesce(array_agg(id order by display_order asc nulls last, created_at asc, id), '{}'::uuid[])
    into v_current_ids from public.rich_wall_entries;
  if v_current_ids is distinct from p_expected_ids then
    return jsonb_build_object('error', 'wall_changed');
  end if;
  -- Exact permutation: no omitted, duplicate, null or unrelated entry IDs.
  if array(select id from unnest(p_order_ids) as requested(id) order by id)
    is distinct from array(select id from unnest(v_current_ids) as current_entry(id) order by id) then
    return jsonb_build_object('error', 'invalid_order');
  end if;

  if p_order_ids is distinct from v_current_ids then
    update public.rich_wall_entries as entry set display_order = requested.position::integer
    from unnest(p_order_ids) with ordinality as requested(id, position)
    where entry.id = requested.id;

    insert into public.rich_admin_audit(actor_email, action, old_value, new_value, reason)
    values(p_actor_email, 'wall_reordered',
      jsonb_build_object('order_ids', v_current_ids),
      jsonb_build_object('order_ids', p_order_ids),
      'Manual Wall of Wealth order; the first three entries appear on the homepage');
  end if;

  select coalesce(jsonb_agg(to_jsonb(entry) order by display_order asc nulls last, created_at asc, id), '[]'::jsonb)
    into v_entries from public.rich_wall_entries as entry;
  return jsonb_build_object('ok', true, 'entries', v_entries);
end;
$$;

revoke all on function public.rich_wall_reorder(uuid[],uuid[],text) from public,anon,authenticated;
grant execute on function public.rich_wall_reorder(uuid[],uuid[],text) to service_role;

commit;
