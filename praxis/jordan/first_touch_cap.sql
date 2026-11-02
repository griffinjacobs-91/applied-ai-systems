-- 2026-10-01. The daily cap on first messages, held by the database (Jordan,
-- Session 6).
--
-- GJC's database only (the Supabase project named praxis). Apply AFTER
-- 2026_09_29_jordan_tables.sql (it needs the follow-up schedule's columns);
-- the order is checked below rather than trusted. Idempotent: safe to re-run.
-- Additive: one new table and two functions; nothing existing changes.
--
-- DEPLOY ORDER: apply this BEFORE (or at once with) the code that calls it
-- (src/lib/jordan/store.ts claimFirstTouchSlot, pipeline.ts runSequenceTick).
-- Code first is safe but costs first touches: until this exists the tick
-- sends NO first messages and no revivals (it fails closed: a first touch can
-- wait, a broken cap cannot be taken back), says so in its summary, and runs
-- partial. A partial run raises the cron alarm, which goes at most
-- once per job per Mountain day (src/lib/cron-runs.ts raiseCronAlarm), so
-- Griffin hears once a day; each run's heartbeat line still says it. Waiting
-- first touches move to the next business morning. Day-3, day-7 and closing
-- follow-ups and every reply are unaffected.
--
-- WHY. The cap (pipeline.ts MAX_FIRST_TOUCHES_PER_DAY, 15 per Mountain day,
-- a deliverability warm-up) was a count of stored messages that each tick
-- read for itself. Two overlapping ticks that each read 14 could each send a
-- first message to a different lead, and the day ended over the cap. Now
-- each first touch takes a place from this counter in one atomic call before
-- anything is spent on the lead, and gives it back if the touch does not go.
--
-- WHAT CHANGES
--   * jordan_first_touch_days: one row per Mountain calendar day, the places
--     taken. RLS on, no policy, service role only, like every Jordan table.
--   * jordan_claim_first_touch(day, cap, floor) returns boolean: true and one
--     more place taken only while the day is below the cap. `floor` is the
--     first messages already stored today; the count is the larger of the
--     two, so a day that began before this counter existed is still capped.
--     The row lock serializes two callers: under read committed the second
--     re-reads the row the first changed, and gets false at the cap.
--   * jordan_release_first_touch(day): gives one place back, never below 0.
--   * Both are SECURITY DEFINER (they run as their owner, which owns the
--     table, so RLS with no policy does not stop them) with search_path
--     pinned, and only service_role may EXECUTE them. EXECUTE is revoked
--     from PUBLIC by name: a revoke from anon and authenticated alone leaves
--     the default PUBLIC grant every new function gets.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'jordan_leads' and column_name = 'next_touch_at'
  ) then
    raise exception 'Apply 2026_09_29_jordan_tables.sql first: this file caps the follow-up schedule it creates.';
  end if;
end $$;

create table if not exists jordan_first_touch_days (
  day date primary key,                          -- the Mountain calendar day
  used integer not null default 0 check (used >= 0),
  updated_at timestamptz not null default now()
);

create or replace function jordan_claim_first_touch(p_day date, p_cap integer, p_floor integer default 0)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_used integer;
begin
  if p_day is null or p_cap is null or p_cap < 0 then
    raise exception 'jordan_claim_first_touch needs a day and a cap of zero or more';
  end if;
  insert into jordan_first_touch_days (day, used) values (p_day, 0)
    on conflict (day) do nothing;
  update jordan_first_touch_days
     set used = greatest(used, coalesce(p_floor, 0)) + 1,
         updated_at = now()
   where day = p_day
     and greatest(used, coalesce(p_floor, 0)) < p_cap
  returning used into v_used;
  return v_used is not null;
end;
$$;

create or replace function jordan_release_first_touch(p_day date)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update jordan_first_touch_days
     set used = used - 1,
         updated_at = now()
   where day = p_day
     and used > 0;
end;
$$;

-- ── Access: RLS on, no policy, service role only (same as every Jordan table) ─

alter table jordan_first_touch_days enable row level security;

revoke all on jordan_first_touch_days from anon, authenticated;
grant select, insert, update, delete on jordan_first_touch_days to service_role;

revoke all on function jordan_claim_first_touch(date, integer, integer) from public, anon, authenticated;
revoke all on function jordan_release_first_touch(date) from public, anon, authenticated;
grant execute on function jordan_claim_first_touch(date, integer, integer) to service_role;
grant execute on function jordan_release_first_touch(date) to service_role;
