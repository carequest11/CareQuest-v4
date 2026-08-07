-- =========================================================
-- CareQuest — Supabase schema, Row-Level Security, and the
-- get_match_partner() RPC.
--
-- Paste this whole file into the Supabase SQL editor (your
-- project -> SQL Editor -> New query) and run it once.
-- =========================================================

-- Youth (volunteer) profiles — one row per auth.users row.
create table if not exists public.youth_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  first_name text not null,
  last_name text,
  email text not null,
  phone text,
  age int,
  interests text,
  interview_status text not null default 'pending' check (interview_status in ('pending', 'verified')),
  created_at timestamptz not null default now()
);

-- Senior profiles — one row per auth.users row.
create table if not exists public.senior_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  email text not null,
  phone text,
  past_career text,
  interests text,
  created_at timestamptz not null default now()
);

-- A match links exactly one youth to exactly one senior.
-- Matches are created by CareQuest staff (via the Supabase dashboard or
-- the service-role key) — this app's matching step is a manual, human
-- review, not something end users trigger themselves.
create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  youth_id uuid not null references public.youth_profiles (id) on delete cascade,
  senior_id uuid not null references public.senior_profiles (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'ended')),
  daily_room_url text,
  cal_booking_uid text,
  scheduled_at timestamptz,
  created_at timestamptz not null default now(),
  unique (youth_id, senior_id)
);

alter table public.youth_profiles enable row level security;
alter table public.senior_profiles enable row level security;
alter table public.matches enable row level security;

-- Youth profiles: a user may only read/write their own row. There is no
-- policy that lets anyone select the whole table, and seniors have no
-- policy on this table at all — they cannot list or browse youth profiles.
create policy "youth can read own profile"
  on public.youth_profiles for select
  using (auth.uid() = id);

create policy "youth can insert own profile"
  on public.youth_profiles for insert
  with check (auth.uid() = id);

create policy "youth can update own profile"
  on public.youth_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Senior profiles: same pattern, mirrored — no cross-role visibility.
create policy "senior can read own profile"
  on public.senior_profiles for select
  using (auth.uid() = id);

create policy "senior can insert own profile"
  on public.senior_profiles for insert
  with check (auth.uid() = id);

create policy "senior can update own profile"
  on public.senior_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Matches: a user may only read rows where they are one of the two parties.
create policy "participants can read own matches"
  on public.matches for select
  using (auth.uid() = youth_id or auth.uid() = senior_id);

-- Deliberately no insert/update/delete policy for regular users on
-- public.matches. Rows are written by:
--   - CareQuest staff, using the service role key (bypasses RLS), or
--   - the /api/daily-room and /api/cal-webhook serverless functions,
--     which also use the service role key and independently verify
--     the caller is a participant in the match before writing.

-- ---------------------------------------------------------
-- get_match_partner: lets a matched user see a *small, safe*
-- slice of their partner's profile (display name + interests)
-- without ever granting a select policy on the other role's
-- full table.
--
-- SECURITY DEFINER means this function runs with the owner's
-- privileges (bypassing RLS internally), but it only returns
-- data for the single match_id passed in, and only after
-- confirming the caller is actually one of the two matched
-- parties. This is the one intentional, narrow exception to
-- "no cross-role reads" — everything else stays locked down,
-- and a user still can never list the other role's full table.
-- ---------------------------------------------------------
create or replace function public.get_match_partner(p_match_id uuid)
returns table (display_name text, interests text)
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select youth_id, senior_id into m
  from public.matches
  where id = p_match_id
    and (youth_id = auth.uid() or senior_id = auth.uid());

  if not found then
    return; -- caller isn't part of this match: return zero rows
  end if;

  if m.youth_id = auth.uid() then
    return query
      select sp.full_name, sp.interests
      from public.senior_profiles sp
      where sp.id = m.senior_id;
  else
    return query
      select (yp.first_name || ' ' || coalesce(yp.last_name, ''))::text, yp.interests
      from public.youth_profiles yp
      where yp.id = m.youth_id;
  end if;
end;
$$;

grant execute on function public.get_match_partner(uuid) to authenticated;

-- =========================================================
-- Messaging: staff role, messages table, and RLS
--
-- Run just this section if the tables/policies above are already
-- applied — every statement here is safe to re-run on its own.
-- =========================================================

-- Staff accounts (CareQuest team members) get read access to every
-- message for moderation/support. Rows are added by an admin directly
-- in the SQL editor (see instructions below) — never through the app —
-- so this table has zero insert/update/select policies for end users.
-- It's only ever read through the is_staff() function below.
create table if not exists public.staff_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.staff_users enable row level security;

create or replace function public.is_staff()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.staff_users where user_id = auth.uid()
  );
$$;

grant execute on function public.is_staff() to authenticated;

-- One row per chat message sent within a match.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  sender_id uuid not null references auth.users (id) on delete cascade,
  body text not null check (char_length(btrim(body)) > 0 and char_length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index if not exists messages_match_id_created_at_idx
  on public.messages (match_id, created_at);

alter table public.messages enable row level security;

-- Either match participant, or any staff account, can read a match's
-- messages. Nobody outside the match (and not staff) can read anything.
drop policy if exists "participants and staff can read messages" on public.messages;
create policy "participants and staff can read messages"
  on public.messages for select
  using (
    public.is_staff()
    or exists (
      select 1 from public.matches m
      where m.id = messages.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
    )
  );

-- A user may only insert a message as themselves, and only into a match
-- they're actually part of. Staff has no special insert privilege here —
-- they can't post as someone else, and they aren't match participants,
-- so this policy alone keeps them from inserting at all.
drop policy if exists "participants can send their own messages" on public.messages;
create policy "participants can send their own messages"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = messages.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
    )
  );

-- Deliberately no update or delete policy for anyone — every message is
-- permanent once sent, for both participants and staff.

-- Let Supabase Realtime broadcast INSERTs on this table to subscribed
-- clients (still filtered per-row by the select policy above). Wrapped
-- in a DO block so re-running this file doesn't error if it's already
-- been added.
do $$
begin
  execute 'alter publication supabase_realtime add table public.messages';
exception
  when others then
    raise notice 'messages may already be in the supabase_realtime publication: %', sqlerrm;
end $$;

-- =========================================================
-- Scheduling: availability, visits, and RLS
--
-- Run just this section if the tables/policies above are already
-- applied — every statement here is safe to re-run on its own.
-- =========================================================

-- is_matched_with: SECURITY DEFINER helper so availability's SELECT
-- policy can check "is this row's owner someone I'm matched with?"
-- without ever granting a broader SELECT policy on matches or on the
-- other role's profile table (same narrow-exception pattern as
-- is_staff() and get_match_partner() above).
create or replace function public.is_matched_with(p_other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
    where (m.youth_id = auth.uid() and m.senior_id = p_other_user)
       or (m.senior_id = auth.uid() and m.youth_id = p_other_user)
  );
$$;

grant execute on function public.is_matched_with(uuid) to authenticated;

-- One row per recurring weekly time block a user marks themselves free.
-- day_of_week: 0 = Sunday .. 6 = Saturday (matches JS Date#getDay()).
create table if not exists public.availability (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 0 and 6),
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create index if not exists availability_user_id_idx on public.availability (user_id);

alter table public.availability enable row level security;

-- A user reads their own rows (to render their own grid) plus their
-- matched partner's rows (to compute overlap when booking) — nobody
-- else's, and never the full list of either role.
drop policy if exists "read own or matched availability" on public.availability;
create policy "read own or matched availability"
  on public.availability for select
  using (auth.uid() = user_id or public.is_matched_with(user_id));

drop policy if exists "manage own availability insert" on public.availability;
create policy "manage own availability insert"
  on public.availability for insert
  with check (auth.uid() = user_id);

drop policy if exists "manage own availability update" on public.availability;
create policy "manage own availability update"
  on public.availability for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "manage own availability delete" on public.availability;
create policy "manage own availability delete"
  on public.availability for delete
  using (auth.uid() = user_id);

-- One row per booked (or cancelled/completed) visit between a match's
-- two people. scheduled_at is always stored in UTC — the app assumes
-- America/Vancouver wall-clock time when generating and displaying
-- slots, so correcting that assumption later (per-user timezones) is
-- a display/generation-layer change, not a data migration.
create table if not exists public.visits (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  scheduled_at timestamptz not null,
  duration_minutes int not null default 120 check (duration_minutes > 0),
  created_by uuid not null references auth.users (id),
  status text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed')),
  created_at timestamptz not null default now()
);

create index if not exists visits_match_id_scheduled_at_idx on public.visits (match_id, scheduled_at);

alter table public.visits enable row level security;

drop policy if exists "participants can read visits" on public.visits;
create policy "participants can read visits"
  on public.visits for select
  using (exists (
    select 1 from public.matches m
    where m.id = visits.match_id
      and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
  ));

drop policy if exists "participants can create visits" on public.visits;
create policy "participants can create visits"
  on public.visits for insert
  with check (
    created_by = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = visits.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
    )
  );

-- Either participant can cancel a scheduled visit — but this policy
-- only ever allows flipping status to 'cancelled'. It can't be used to
-- edit the time/duration or to un-cancel a visit.
drop policy if exists "participants can cancel visits" on public.visits;
create policy "participants can cancel visits"
  on public.visits for update
  using (
    status = 'scheduled'
    and exists (
      select 1 from public.matches m
      where m.id = visits.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
    )
  )
  with check (
    status = 'cancelled'
    and exists (
      select 1 from public.matches m
      where m.id = visits.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
    )
  );

-- Deliberately no delete policy on visits — the booking/cancellation
-- history is kept permanently.

-- NOTE ON matches.scheduled_at: this migration does not add a trigger
-- to keep matches.scheduled_at in sync with visits. The app instead
-- looks up "the next upcoming visit" directly from public.visits
-- (status = 'scheduled', scheduled_at > now(), ordered ascending) —
-- one source of truth, no denormalization to keep consistent.
