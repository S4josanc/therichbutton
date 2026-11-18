-- Run after order-wall-of-wealth.sql. All temporary order changes, the fixture
-- and audit entries are rolled back; visitors never see the uncommitted order.
begin;
set local statement_timeout = '15s';
set local lock_timeout = '3s';
set local role service_role;
do $checks$
declare
  original_ids uuid[];
  requested_ids uuid[];
  current_ids uuid[];
  fixture_id uuid;
  next_fixture_id uuid;
  result jsonb;
begin
  assert not has_function_privilege('anon','public.rich_wall_reorder(uuid[],uuid[],text)','EXECUTE'), 'Public sessions cannot reorder';
  assert not has_function_privilege('authenticated','public.rich_wall_reorder(uuid[],uuid[],text)','EXECUTE'), 'Ordinary users cannot reorder';
  assert has_function_privilege('service_role','public.rich_wall_reorder(uuid[],uuid[],text)','EXECUTE'), 'Server can reorder';
  assert has_table_privilege('anon','public.rich_wall_entries','SELECT'), 'Public wall stays readable';
  assert not has_table_privilege('anon','public.rich_wall_entries','UPDATE'), 'Public writes stay disabled';
  assert not has_table_privilege('authenticated','public.rich_wall_entries','TRUNCATE'), 'Ordinary sessions cannot truncate the wall';

  lock table public.rich_wall_entries in share row exclusive mode;
  select coalesce(array_agg(id order by display_order asc nulls last,created_at asc,id),'{}'::uuid[])
    into original_ids from public.rich_wall_entries;

  insert into public.rich_wall_entries(display_name,edition,country_code)
    values('Wall ordering verification','rich-gift','ES') returning id into fixture_id;
  insert into public.rich_wall_entries(display_name,edition,country_code,created_at)
    values('Second wall verification','gold','DE',clock_timestamp()+interval '1 second') returning id into next_fixture_id;
  select array_agg(id order by display_order asc nulls last,created_at asc,id)
    into current_ids from public.rich_wall_entries;
  assert current_ids[cardinality(current_ids)-1] = fixture_id, 'A new entry follows the saved selection';
  assert current_ids[cardinality(current_ids)] = next_fixture_id, 'Later additions do not displace earlier additions';
  requested_ids := array_append(array_prepend(fixture_id,original_ids),next_fixture_id);

  result := public.rich_wall_reorder(requested_ids,current_ids,'someone-else@example.com');
  assert result->>'error'='access_denied', 'Audit actor must be the authorized administrator';

  result := public.rich_wall_reorder(requested_ids,current_ids,'info@akademiaene.com');
  assert (result->>'ok')::boolean, 'Valid full reordering succeeds';
  assert (result->'entries'->0->>'id')::uuid = fixture_id, 'A lower entry can become the first highlighted person';
  assert (select display_order=1 from public.rich_wall_entries where id=fixture_id), 'Position is persisted';
  assert exists(select 1 from public.rich_admin_audit where action='wall_reordered' and new_value->'order_ids'->>0=fixture_id::text), 'Reorder is audited';

  result := public.rich_wall_reorder(current_ids,current_ids,'info@akademiaene.com');
  assert result->>'error'='wall_changed', 'A stale browser cannot overwrite a newer order';

  current_ids := requested_ids;
  result := public.rich_wall_reorder(array_append(current_ids,fixture_id),current_ids,'info@akademiaene.com');
  assert result->>'error'='invalid_order', 'Duplicate IDs are rejected';
  result := public.rich_wall_reorder(original_ids,current_ids,'info@akademiaene.com');
  assert result->>'error'='invalid_order', 'Omitting entries is rejected';
  requested_ids := current_ids;
  requested_ids[1] := gen_random_uuid();
  result := public.rich_wall_reorder(requested_ids,current_ids,'info@akademiaene.com');
  assert result->>'error'='invalid_order', 'Foreign IDs are rejected';
  result := public.rich_wall_reorder(current_ids,current_ids,'info@akademiaene.com');
  assert (result->>'ok')::boolean, 'A no-change retry is safe';
end;
$checks$;
rollback;
select 'Wall ordering checks passed; entries and public order restored' as result;
