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
drop policy if exists "youth can read own profile" on public.youth_profiles;
create policy "youth can read own profile"
  on public.youth_profiles for select
  using (auth.uid() = id);

drop policy if exists "youth can insert own profile" on public.youth_profiles;
create policy "youth can insert own profile"
  on public.youth_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "youth can update own profile" on public.youth_profiles;
create policy "youth can update own profile"
  on public.youth_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Senior profiles: same pattern, mirrored — no cross-role visibility.
drop policy if exists "senior can read own profile" on public.senior_profiles;
create policy "senior can read own profile"
  on public.senior_profiles for select
  using (auth.uid() = id);

drop policy if exists "senior can insert own profile" on public.senior_profiles;
create policy "senior can insert own profile"
  on public.senior_profiles for insert
  with check (auth.uid() = id);

drop policy if exists "senior can update own profile" on public.senior_profiles;
create policy "senior can update own profile"
  on public.senior_profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Matches: a user may only read rows where they are one of the two parties.
-- (Superseded further down by a version that also requires the youth
-- side of the match to be interview-approved — kept here, with its own
-- drop-if-exists, so this section is still independently re-runnable.)
drop policy if exists "participants can read own matches" on public.matches;
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
-- This function's return shape changes further down in this same file
-- (avatar_url is added to it in the "Profile photos" section below),
-- and unlike the other functions here, it's never referenced inside a
-- policy expression — so a plain drop-then-create is both necessary
-- (create or replace can't change a return type) and safe (nothing
-- else depends on it, so no CASCADE / policy-recreation is needed).
drop function if exists public.get_match_partner(uuid);
create function public.get_match_partner(p_match_id uuid)
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

-- =========================================================
-- Profile photos: avatar_url columns, Storage bucket, and RLS
--
-- Run just this section if everything above is already applied.
-- =========================================================

alter table public.youth_profiles add column if not exists avatar_url text;
alter table public.senior_profiles add column if not exists avatar_url text;

-- get_match_partner's return columns are changing (adding avatar_url),
-- and Postgres won't let create-or-replace change a function's return
-- shape — it has to be dropped and recreated.
drop function if exists public.get_match_partner(uuid);

create function public.get_match_partner(p_match_id uuid)
returns table (display_name text, interests text, avatar_url text)
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
      select sp.full_name, sp.interests, sp.avatar_url
      from public.senior_profiles sp
      where sp.id = m.senior_id;
  else
    return query
      select (yp.first_name || ' ' || coalesce(yp.last_name, ''))::text, yp.interests, yp.avatar_url
      from public.youth_profiles yp
      where yp.id = m.youth_id;
  end if;
end;
$$;

grant execute on function public.get_match_partner(uuid) to authenticated;

-- Private bucket for profile photos. Nobody gets a bare public URL —
-- viewing a photo requires a signed URL minted through the Storage
-- API, which itself only succeeds if this SELECT policy allows it.
-- "on conflict do update" forces public back to false even if an
-- earlier run of this file already created the bucket as public.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', false)
on conflict (id) do update set public = false;

-- A user may view (and therefore get a signed URL for) their own
-- photo, or their matched partner's — nobody else's. Path convention
-- is avatars/<owning user id>/avatar.<ext>, so the folder name is the
-- owner's id; is_matched_with() is the same helper the availability
-- table's RLS already uses for this exact "own or matched" check.
drop policy if exists "avatar images are publicly readable" on storage.objects;
drop policy if exists "owner or match can view avatar" on storage.objects;
create policy "owner or match can view avatar"
  on storage.objects for select
  using (
    bucket_id = 'avatars'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.is_matched_with(((storage.foldername(name))[1])::uuid)
    )
  );

-- A user may only write inside their own folder: avatars/<user id>/...
drop policy if exists "users can upload their own avatar" on storage.objects;
create policy "users can upload their own avatar"
  on storage.objects for insert
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can update their own avatar" on storage.objects;
create policy "users can update their own avatar"
  on storage.objects for update
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users can delete their own avatar" on storage.objects;
create policy "users can delete their own avatar"
  on storage.objects for delete
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- =========================================================
-- Youth interview approval lifecycle, volunteer hours, and
-- gating matches/messages/visits/availability on approval
--
-- Run just this section if everything above is already applied.
-- =========================================================

-- youth_profiles.interview_status already existed as pending/verified
-- (see the very first create table above). Widen it to the full
-- pending -> scheduled -> approved/rejected lifecycle the youth member
-- dashboard now gates on. Existing 'verified' rows become 'approved' so
-- already-vetted volunteers don't lose access when this runs.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.youth_profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%interview_status%'
  loop
    execute format('alter table public.youth_profiles drop constraint %I', c.conname);
  end loop;
end $$;

update public.youth_profiles set interview_status = 'approved' where interview_status = 'verified';

alter table public.youth_profiles
  add constraint youth_profiles_interview_status_check
  check (interview_status in ('pending', 'scheduled', 'approved', 'rejected'));

-- Set when a youth books a slot on youth-interview.html (via
-- /api/schedule-interview — see below), so member.html can show
-- "scheduled for [date]" without a separate interviews table.
alter table public.youth_profiles add column if not exists interview_scheduled_at timestamptz;

-- Only staff may move a youth's interview to 'approved' or 'rejected' —
-- those are the two decisions that unlock (or permanently lock) the
-- dashboard, so a youth can never grant that to themselves, including
-- via a direct API call. Moving from 'pending' to 'scheduled' is still
-- allowed through the existing "youth can update own profile" policy
-- below (that's the normal self-service booking flow) — this trigger
-- only blocks the approve/reject transition, and only for callers who
-- are neither staff, the SQL editor (current_user = 'postgres'), nor a
-- service-role request (/api/schedule-interview, or future admin tools).
create or replace function public.enforce_interview_status_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.interview_status is distinct from old.interview_status
     and new.interview_status in ('approved', 'rejected')
     and current_user <> 'postgres'
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_staff() then
    raise exception 'Only CareQuest staff can approve or reject an interview.';
  end if;
  return new;
end;
$$;

drop trigger if exists youth_profiles_interview_status_guard on public.youth_profiles;
create trigger youth_profiles_interview_status_guard
  before update on public.youth_profiles
  for each row
  execute function public.enforce_interview_status_change();

-- To approve or reject someone by hand, run (as the SQL editor's
-- postgres user, so the trigger above allows it):
--   update public.youth_profiles set interview_status = 'approved' where email = 'someone@example.com';
--   update public.youth_profiles set interview_status = 'rejected' where email = 'someone@example.com';

-- ---------------------------------------------------------
-- is_youth_approved: SECURITY DEFINER helper — true only if p_youth_id
-- is a youth whose interview_status is 'approved'. Used below to keep
-- an unapproved youth's matches/messages/visits/availability (and,
-- transitively, avatar photos — see is_matched_with) locked down at
-- the RLS layer itself, not just by member.html hiding the dashboard.
-- A youth's OWN rows (their own availability, their own logged hours)
-- are never gated by this — only access that depends on a match with
-- someone else is.
-- ---------------------------------------------------------
create or replace function public.is_youth_approved(p_youth_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.youth_profiles
    where id = p_youth_id and interview_status = 'approved'
  );
$$;

grant execute on function public.is_youth_approved(uuid) to authenticated;

-- ---------------------------------------------------------
-- Volunteer hours — logged by the youth themselves from the My Impact
-- card. `verified` lets staff mark an entry as confirmed later (e.g.
-- against a sign-in sheet); it does not gate anything — unverified
-- hours still count toward the youth's own displayed total.
-- ---------------------------------------------------------
create table if not exists public.volunteer_hours (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.youth_profiles (id) on delete cascade,
  logged_date date not null,
  hours numeric(5,2) not null check (hours > 0 and hours <= 24),
  note text,
  verified boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists volunteer_hours_user_id_idx on public.volunteer_hours (user_id);

alter table public.volunteer_hours enable row level security;

-- A youth reads only their own logged hours; staff can read everyone's
-- for review. Nobody else (not even a matched senior) can see this.
drop policy if exists "youth can read own hours" on public.volunteer_hours;
create policy "youth can read own hours"
  on public.volunteer_hours for select
  using (auth.uid() = user_id or public.is_staff());

-- A youth may only log hours for themselves, and only once their
-- interview is approved (is_youth_approved is defined below) — same
-- "no interaction before approval" rule applied to matches/messages/
-- visits/availability further down.
drop policy if exists "youth can log own hours" on public.volunteer_hours;
create policy "youth can log own hours"
  on public.volunteer_hours for insert
  with check (auth.uid() = user_id and public.is_youth_approved(user_id));

-- Deliberately no update/delete policy for youth — once logged, an
-- entry can only be corrected by staff directly (SQL editor or service
-- role), the same permanence pattern as `messages`.

-- Matches: add the approval gate on top of the existing "participant"
-- check. Every match has exactly one youth_id, so this one call covers
-- the whole match row.
drop policy if exists "participants can read own matches" on public.matches;
create policy "participants can read own matches"
  on public.matches for select
  using (
    (auth.uid() = youth_id or auth.uid() = senior_id)
    and public.is_youth_approved(youth_id)
  );

-- Messages: same gate added to both the read and the send policy.
drop policy if exists "participants and staff can read messages" on public.messages;
create policy "participants and staff can read messages"
  on public.messages for select
  using (
    public.is_staff()
    or exists (
      select 1 from public.matches m
      where m.id = messages.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
        and public.is_youth_approved(m.youth_id)
    )
  );

drop policy if exists "participants can send their own messages" on public.messages;
create policy "participants can send their own messages"
  on public.messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.matches m
      where m.id = messages.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
        and public.is_youth_approved(m.youth_id)
    )
  );

-- Visits: same gate added to read, create, and cancel.
drop policy if exists "participants can read visits" on public.visits;
create policy "participants can read visits"
  on public.visits for select
  using (exists (
    select 1 from public.matches m
    where m.id = visits.match_id
      and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
      and public.is_youth_approved(m.youth_id)
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
        and public.is_youth_approved(m.youth_id)
    )
  );

drop policy if exists "participants can cancel visits" on public.visits;
create policy "participants can cancel visits"
  on public.visits for update
  using (
    status = 'scheduled'
    and exists (
      select 1 from public.matches m
      where m.id = visits.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
        and public.is_youth_approved(m.youth_id)
    )
  )
  with check (
    status = 'cancelled'
    and exists (
      select 1 from public.matches m
      where m.id = visits.match_id
        and (m.youth_id = auth.uid() or m.senior_id = auth.uid())
        and public.is_youth_approved(m.youth_id)
    )
  );

-- Availability: is_matched_with() is the one function that decides
-- whether you can see a matched partner's availability rows (your own
-- rows are always readable regardless of approval — see the policy
-- itself, unchanged). Adding the gate here, in the shared helper,
-- keeps it in exactly one place and also transitively protects avatar
-- photos, since storage.objects' "owner or match can view avatar"
-- policy reuses this same function.
create or replace function public.is_matched_with(p_other_user uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
    where ((m.youth_id = auth.uid() and m.senior_id = p_other_user)
        or (m.senior_id = auth.uid() and m.youth_id = p_other_user))
      and public.is_youth_approved(m.youth_id)
  );
$$;

-- get_match_partner is SECURITY DEFINER, so it bypasses the matches
-- select policy above internally — it needs its own copy of the same
-- check, or an unapproved youth's staff-facing RPC call would still
-- leak the partner's name/interests/avatar even though the matches
-- table itself is now locked down.
create or replace function public.get_match_partner(p_match_id uuid)
returns table (display_name text, interests text, avatar_url text)
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
    and (youth_id = auth.uid() or senior_id = auth.uid())
    and public.is_youth_approved(youth_id);

  if not found then
    return; -- caller isn't part of this match, or it isn't approved yet: zero rows
  end if;

  if m.youth_id = auth.uid() then
    return query
      select sp.full_name, sp.interests, sp.avatar_url
      from public.senior_profiles sp
      where sp.id = m.senior_id;
  else
    return query
      select (yp.first_name || ' ' || coalesce(yp.last_name, ''))::text, yp.interests, yp.avatar_url
      from public.youth_profiles yp
      where yp.id = m.youth_id;
  end if;
end;
$$;
