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
-- Impact hours: youth-logged volunteer hours ("My Impact" card's
-- Log Hours feature on member.html)
--
-- Run just this section if everything above is already applied.
-- =========================================================

-- One row per logged volunteering session. Personal tracking data —
-- not shared with a youth's matched senior, staff, or anyone else;
-- RLS below only ever lets a youth see/manage their own rows, same
-- "own rows only" pattern as youth_profiles/senior_profiles.
create table if not exists public.impact_hours (
  id uuid primary key default gen_random_uuid(),
  youth_id uuid not null references public.youth_profiles (id) on delete cascade,
  entry_date date not null,
  description text,
  -- Mirrors the client-side 0.25-24 validation in member.html as a
  -- defense-in-depth check, not a replacement for it. A same-style
  -- check that entry_date isn't in the future isn't possible here —
  -- Postgres requires CHECK constraints to use only IMMUTABLE
  -- functions, and current_date is STABLE, not IMMUTABLE — so that
  -- rule stays client-side only, same as the rest of this app's
  -- validation.
  hours numeric(4,2) not null check (hours >= 0.25 and hours <= 24),
  created_at timestamptz not null default now()
);

create index if not exists impact_hours_youth_id_idx on public.impact_hours (youth_id);

alter table public.impact_hours enable row level security;

drop policy if exists "youth can read own impact hours" on public.impact_hours;
create policy "youth can read own impact hours"
  on public.impact_hours for select
  using (auth.uid() = youth_id);

drop policy if exists "youth can insert own impact hours" on public.impact_hours;
create policy "youth can insert own impact hours"
  on public.impact_hours for insert
  with check (auth.uid() = youth_id);

drop policy if exists "youth can update own impact hours" on public.impact_hours;
create policy "youth can update own impact hours"
  on public.impact_hours for update
  using (auth.uid() = youth_id)
  with check (auth.uid() = youth_id);

drop policy if exists "youth can delete own impact hours" on public.impact_hours;
create policy "youth can delete own impact hours"
  on public.impact_hours for delete
  using (auth.uid() = youth_id);

-- =========================================================
-- Languages: free-text "Language(s)" field, both roles — captured at
-- signup (youth-account.html / senior-account.html) and editable
-- afterward from member.html's Your Details card. Same free-text
-- style as `interests`, not a controlled list.
--
-- Run just this section if everything above is already applied.
-- =========================================================

alter table public.youth_profiles add column if not exists languages text;
alter table public.senior_profiles add column if not exists languages text;

-- =========================================================
-- Call recording (safeguarding)
--
-- Video calls are recorded by Daily.co so that a recording exists
-- if a safeguarding concern is later raised. Recordings are never
-- visible to the two people on the call — only to staff, and every
-- staff view is logged.
--
-- Run just this section if everything above is already applied.
-- =========================================================

-- Recording consent, captured at signup. NULL = has not consented,
-- which blocks that user from starting or joining a call at all
-- (enforced server-side in /api/daily-room, not just in the UI).
-- A timestamp rather than a boolean so we can always answer "when
-- did this person agree, and to which version of the wording?".
alter table public.youth_profiles add column if not exists recording_consent_at timestamptz;
alter table public.senior_profiles add column if not exists recording_consent_at timestamptz;

-- How long a recording is kept before /api/purge-recordings deletes
-- it from both Daily and this table. Single-row table (the `id`
-- boolean primary key with a `check (id)` allows exactly one row) so
-- the retention period is a configuration value an admin can change
-- in the SQL editor without a redeploy.
create table if not exists public.recording_settings (
  id boolean primary key default true check (id),
  retention_days int not null default 30 check (retention_days between 1 and 3650),
  updated_at timestamptz not null default now()
);

insert into public.recording_settings (id) values (true) on conflict (id) do nothing;

alter table public.recording_settings enable row level security;

drop policy if exists "staff can read recording settings" on public.recording_settings;
create policy "staff can read recording settings"
  on public.recording_settings for select
  using (public.is_staff());

-- No insert/update/delete policy: change the retention period by
-- running this in the SQL editor (service role bypasses RLS):
--   update public.recording_settings
--      set retention_days = 60, updated_at = now()
--    where id;

-- One row per cloud recording Daily produces, written only by the
-- /api/daily-webhook serverless function using the service role.
create table if not exists public.call_recordings (
  id uuid primary key default gen_random_uuid(),
  match_id uuid not null references public.matches (id) on delete cascade,
  daily_recording_id text not null unique,
  started_at timestamptz not null,
  -- Length in seconds. Null until Daily fires recording.ready-to-download;
  -- the earlier recording.started event doesn't know it yet.
  duration int check (duration >= 0),
  download_path text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists call_recordings_match_id_started_at_idx
  on public.call_recordings (match_id, started_at desc);

create index if not exists call_recordings_expires_at_idx
  on public.call_recordings (expires_at);

alter table public.call_recordings enable row level security;

-- Staff only. The two people on the call have no policy here at all,
-- so they cannot list their own recordings, let alone anyone else's —
-- and since there is no policy granting insert/update/delete to
-- anyone, rows can only be written by the service role.
drop policy if exists "only staff can read recordings" on public.call_recordings;
create policy "only staff can read recordings"
  on public.call_recordings for select
  using (public.is_staff());

-- Audit trail: one row per time a staff account obtains a playback
-- link for a recording, written by /api/recording-access.
create table if not exists public.recording_access_log (
  id uuid primary key default gen_random_uuid(),
  -- Nulled rather than cascade-deleted when a recording is purged: an
  -- audit trail has to outlive the thing it describes, which is also
  -- why daily_recording_id is snapshotted here as plain text.
  recording_id uuid references public.call_recordings (id) on delete set null,
  daily_recording_id text not null,
  match_id uuid,
  staff_user_id uuid not null references auth.users (id) on delete cascade,
  accessed_at timestamptz not null default now()
);

create index if not exists recording_access_log_accessed_at_idx
  on public.recording_access_log (accessed_at desc);

alter table public.recording_access_log enable row level security;

-- Staff can read the audit trail. Nobody — staff included — has an
-- insert, update or delete policy: entries are written only by the
-- service role inside /api/recording-access, so a staff account can
-- neither forge an access entry nor erase its own.
drop policy if exists "staff can read recording access log" on public.recording_access_log;
create policy "staff can read recording access log"
  on public.recording_access_log for select
  using (public.is_staff());

-- ---------------------------------------------------------
-- match_recording_consent: lets the call UI tell a user *why* the
-- call button is unavailable ("you haven't agreed yet" vs "your
-- match hasn't agreed yet") without exposing any other part of the
-- partner's profile. Same narrow-slice SECURITY DEFINER pattern as
-- get_match_partner().
-- ---------------------------------------------------------
create or replace function public.match_recording_consent(p_match_id uuid)
returns table (self_consented boolean, partner_consented boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  youth_ok boolean;
  senior_ok boolean;
begin
  select youth_id, senior_id into m
  from public.matches
  where id = p_match_id
    and (youth_id = auth.uid() or senior_id = auth.uid());

  if not found then
    return; -- caller isn't part of this match: return zero rows
  end if;

  select (yp.recording_consent_at is not null) into youth_ok
  from public.youth_profiles yp where yp.id = m.youth_id;

  select (sp.recording_consent_at is not null) into senior_ok
  from public.senior_profiles sp where sp.id = m.senior_id;

  if m.youth_id = auth.uid() then
    return query select coalesce(youth_ok, false), coalesce(senior_ok, false);
  else
    return query select coalesce(senior_ok, false), coalesce(youth_ok, false);
  end if;
end;
$$;

grant execute on function public.match_recording_consent(uuid) to authenticated;

-- ---------------------------------------------------------
-- record_recording_consent: a user agreeing to call recording after
-- signup (anyone who created their account before this feature
-- existed). Writes only to the caller's own profile row, and only
-- ever sets the timestamp — it cannot be used to clear consent or to
-- touch anyone else's row.
-- ---------------------------------------------------------
create or replace function public.record_recording_consent()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  ts timestamptz;
begin
  -- coalesce, not a plain assignment: re-agreeing keeps the original
  -- timestamp, so the record always says when consent was *first*
  -- given. A user's role is whichever table has their row (there is no
  -- role flag), so this tries youth, then senior.
  update public.youth_profiles
     set recording_consent_at = coalesce(recording_consent_at, now())
   where id = auth.uid()
  returning recording_consent_at into ts;

  if found then
    return ts;
  end if;

  update public.senior_profiles
     set recording_consent_at = coalesce(recording_consent_at, now())
   where id = auth.uid()
  returning recording_consent_at into ts;

  if not found then
    raise exception 'no profile for current user';
  end if;

  return ts;
end;
$$;

grant execute on function public.record_recording_consent() to authenticated;
