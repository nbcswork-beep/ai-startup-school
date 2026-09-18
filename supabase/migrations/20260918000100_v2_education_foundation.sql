begin;

create extension if not exists btree_gist;

alter table public.users drop constraint if exists users_kind_check;
alter table public.users add constraint users_kind_check check (kind in ('student','guardian','teacher','admin'));

create table public.teacher_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  title text not null default '',
  timezone text not null default 'Europe/Kyiv',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.guardian_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 80),
  locale text not null default 'uk',
  timezone text not null default 'Europe/Kyiv',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 100),
  timezone text not null default 'Europe/Kyiv',
  starts_on date not null,
  ends_on date,
  status text not null default 'active' check (status in ('planned','active','completed','archived')),
  schedule_context jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_on is null or ends_on >= starts_on)
);

create table public.group_teachers (
  group_id uuid not null references public.groups(id) on delete cascade,
  teacher_id uuid not null references public.users(id) on delete cascade,
  role text not null default 'teacher' check (role in ('teacher','lead_teacher','assistant')),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (group_id,teacher_id,starts_at),
  check (ends_at is null or ends_at > starts_at)
);

create table public.group_memberships (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  status text not null default 'active' check (status in ('pending','active','paused','completed','removed')),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (group_id,student_id),
  check (left_at is null or left_at >= joined_at)
);

create table public.class_sessions (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete restrict,
  module_id uuid references public.modules(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  teacher_id uuid not null references public.users(id) on delete restrict,
  title text not null check (char_length(title) between 1 and 160),
  description text not null default '' check (char_length(description) <= 4000),
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  meeting_url text,
  meeting_provider text,
  status text not null default 'scheduled' check (status in ('scheduled','rescheduled','in_progress','completed','cancelled')),
  teacher_notes text not null default '' check (char_length(teacher_notes) <= 10000),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end > scheduled_start),
  check (meeting_url is null or meeting_url ~* '^https://')
);

create table public.class_session_reschedules (
  id uuid primary key default gen_random_uuid(),
  class_session_id uuid not null references public.class_sessions(id) on delete cascade,
  previous_start timestamptz not null,
  previous_end timestamptz not null,
  new_start timestamptz not null,
  new_end timestamptz not null,
  reason text not null default '',
  changed_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check (new_end > new_start)
);

create table public.file_assets (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete restrict,
  bucket text not null check (char_length(bucket) between 1 and 100),
  object_path text not null check (char_length(object_path) between 1 and 800),
  original_name text not null check (char_length(original_name) between 1 and 255),
  mime_type text not null check (char_length(mime_type) between 1 and 120),
  size_bytes bigint not null check (size_bytes between 1 and 26214400),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','ready','quarantined','deleted')),
  created_at timestamptz not null default now(),
  unique (bucket,object_path)
);

create table public.class_materials (
  id uuid primary key default gen_random_uuid(),
  class_session_id uuid not null references public.class_sessions(id) on delete cascade,
  kind text not null check (kind in ('presentation','document','link','file','reference','other')),
  title text not null check (char_length(title) between 1 and 180),
  external_url text,
  file_asset_id uuid references public.file_assets(id) on delete restrict,
  position integer not null default 1 check (position > 0),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  check ((external_url is null) <> (file_asset_id is null)),
  check (external_url is null or external_url ~* '^https://'),
  unique (class_session_id,position)
);

create table public.attendance (
  id uuid primary key default gen_random_uuid(),
  class_session_id uuid not null references public.class_sessions(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  suggested_status text check (suggested_status in ('present','late','absent','excused')),
  suggestion_source text,
  status text check (status in ('present','late','absent','excused')),
  confirmed_by uuid references public.users(id) on delete restrict,
  confirmed_at timestamptz,
  note text not null default '' check (char_length(note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (class_session_id,student_id),
  check ((status is null and confirmed_by is null and confirmed_at is null) or (status is not null and confirmed_by is not null and confirmed_at is not null))
);

create table public.homework (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete restrict,
  module_id uuid references public.modules(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  class_session_id uuid references public.class_sessions(id) on delete set null,
  group_id uuid not null references public.groups(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 180),
  instructions text not null check (char_length(instructions) between 1 and 20000),
  publish_at timestamptz,
  due_at timestamptz,
  xp_reward integer not null default 0 check (xp_reward >= 0),
  status text not null default 'draft' check (status in ('draft','published','closed','archived')),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'published') or publish_at is not null),
  check (due_at is null or publish_at is null or due_at > publish_at)
);

create table public.homework_resources (
  id uuid primary key default gen_random_uuid(),
  homework_id uuid not null references public.homework(id) on delete cascade,
  kind text not null check (kind in ('presentation','document','link','file','reference','other')),
  title text not null check (char_length(title) between 1 and 180),
  external_url text,
  file_asset_id uuid references public.file_assets(id) on delete restrict,
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now(),
  check ((external_url is null) <> (file_asset_id is null)),
  check (external_url is null or external_url ~* '^https://'),
  unique (homework_id,position)
);

create table public.homework_submissions (
  id uuid primary key default gen_random_uuid(),
  homework_id uuid not null references public.homework(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  attempt_number integer not null check (attempt_number > 0),
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  student_comment text not null default '' check (char_length(student_comment) <= 2000),
  content_text text not null default '' check (char_length(content_text) <= 20000),
  content_url text,
  status text not null default 'in_progress' check (status in ('not_started','in_progress','submitted','needs_revision','completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (homework_id,student_id,attempt_number),
  check (content_url is null or content_url ~* '^https://'),
  check ((status in ('submitted','needs_revision','completed')) = (submitted_at is not null))
);

create table public.submission_attachments (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null references public.homework_submissions(id) on delete cascade,
  file_asset_id uuid not null references public.file_assets(id) on delete restrict,
  kind text not null check (kind in ('image','screenshot','file')),
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now(),
  unique (submission_id,position)
);

create table public.homework_reviews (
  id uuid primary key default gen_random_uuid(),
  submission_id uuid not null unique references public.homework_submissions(id) on delete cascade,
  reviewer_id uuid not null references public.users(id) on delete restrict,
  score integer not null check (score between 0 and 10),
  effort text not null check (effort in ('needs_attention','good_effort','high_effort')),
  status text not null check (status in ('reviewed','needs_revision','completed')),
  feedback text not null default '' check (char_length(feedback) <= 10000),
  reviewed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.homework_review_events (
  id uuid primary key default gen_random_uuid(),
  homework_review_id uuid not null references public.homework_reviews(id) on delete cascade,
  changed_by uuid not null references public.users(id) on delete restrict,
  previous_score integer check (previous_score between 0 and 10),
  new_score integer not null check (new_score between 0 and 10),
  previous_effort text check (previous_effort in ('needs_attention','good_effort','high_effort')),
  new_effort text not null check (new_effort in ('needs_attention','good_effort','high_effort')),
  previous_status text,
  new_status text not null,
  created_at timestamptz not null default now()
);

create table public.skills (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9-]+$'),
  title text not null check (char_length(title) between 1 and 100),
  description text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.project_skills (
  project_id uuid not null references public.projects(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete restrict,
  primary key (project_id,skill_id)
);

create table public.student_skills (
  student_id uuid not null references public.users(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete restrict,
  level smallint not null default 1 check (level between 1 and 5),
  evidence_count integer not null default 0 check (evidence_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (student_id,skill_id)
);

alter table public.projects add column if not exists problem text not null default '';
alter table public.projects add column if not exists target_user text not null default '';
alter table public.projects add column if not exists solution text not null default '';
alter table public.projects add column if not exists project_type text not null default 'other' check (project_type in ('website','ai_assistant','automation','mini_app','game','roblox','business_concept','other'));
alter table public.projects add column if not exists technologies text[] not null default '{}';
alter table public.projects add column if not exists resources jsonb not null default '[]';
alter table public.projects add column if not exists external_links jsonb not null default '[]';
alter table public.projects add column if not exists demo_url text;
alter table public.projects add column if not exists repository_url text;
alter table public.projects add column if not exists cover_path text;
alter table public.projects add constraint projects_demo_url_https check (demo_url is null or demo_url ~* '^https://');
alter table public.projects add constraint projects_repository_url_https check (repository_url is null or repository_url ~* '^https://');

create table public.portfolios (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null unique references public.users(id) on delete cascade,
  title text not null default 'Моє портфоліо',
  visibility text not null default 'private' check (visibility in ('private','shared')),
  share_token_hash text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((visibility='private' and share_token_hash is null) or (visibility='shared' and share_token_hash is not null))
);

create table public.portfolio_projects (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  title_override text,
  short_description text not null default '' check (char_length(short_description) <= 1000),
  reflection text not null default '' check (char_length(reflection) <= 3000),
  learned text not null default '' check (char_length(learned) <= 3000),
  technologies text[] not null default '{}',
  demo_url text,
  cover_path text,
  completion_date date,
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (portfolio_id,project_id),
  check (demo_url is null or demo_url ~* '^https://')
);

create table public.portfolio_project_skills (
  portfolio_project_id uuid not null references public.portfolio_projects(id) on delete cascade,
  skill_id uuid not null references public.skills(id) on delete restrict,
  primary key (portfolio_project_id,skill_id)
);

create table public.portfolio_project_media (
  id uuid primary key default gen_random_uuid(),
  portfolio_project_id uuid not null references public.portfolio_projects(id) on delete cascade,
  file_asset_id uuid not null references public.file_assets(id) on delete restrict,
  object_path text not null,
  alt_text text not null default '',
  position integer not null default 1 check (position > 0),
  created_at timestamptz not null default now(),
  unique (portfolio_project_id,position)
);

alter table public.mentors add column if not exists timezone text not null default 'Europe/Kyiv';
alter table public.mentors add column if not exists default_slot_minutes integer not null default 30 check (default_slot_minutes between 15 and 120);
alter table public.mentors add column if not exists booking_limit_per_week integer not null default 1 check (booking_limit_per_week between 1 and 10);
alter table public.mentors add column if not exists cancellation_policy jsonb not null default '{"minimumNoticeHours":24}' check (jsonb_typeof(cancellation_policy)='object');

create table public.mentor_availability (
  id uuid primary key default gen_random_uuid(),
  mentor_id uuid not null references public.mentors(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  status text not null default 'open' check (status in ('open','blocked','booked','cancelled')),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

create table public.mentor_bookings (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  mentor_id uuid not null references public.mentors(id) on delete restrict,
  availability_id uuid references public.mentor_availability(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null,
  meeting_url text,
  status text not null default 'reserved' check (status in ('reserved','confirmed','completed','cancelled','rescheduled','no_show')),
  cancellation_reason text not null default '',
  rescheduled_from_id uuid references public.mentor_bookings(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (meeting_url is null or meeting_url ~* '^https://'),
  exclude using gist (mentor_id with =, tstzrange(starts_at,ends_at,'[)') with &&) where (status in ('reserved','confirmed','rescheduled')),
  exclude using gist (student_id with =, tstzrange(starts_at,ends_at,'[)') with &&) where (status in ('reserved','confirmed','rescheduled'))
);

create table public.guardian_student_links (
  id uuid primary key default gen_random_uuid(),
  guardian_id uuid not null references public.users(id) on delete cascade,
  student_id uuid not null references public.users(id) on delete cascade,
  relationship_label text not null default 'guardian' check (char_length(relationship_label) between 1 and 40),
  status text not null default 'pending' check (status in ('pending','active','revoked')),
  invited_by uuid not null references public.users(id) on delete restrict,
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (guardian_id,student_id)
);

create table app_private.guardian_link_invitations (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  token_hash text not null unique,
  created_by uuid not null references public.users(id) on delete restrict,
  expires_at timestamptz not null,
  consumed_by uuid references public.users(id) on delete restrict,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.parent_reports (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  payload jsonb not null default '{}',
  teacher_comment text not null default '' check (char_length(teacher_comment) <= 5000),
  status text not null default 'draft' check (status in ('draft','approved','sent','failed')),
  created_by uuid not null references public.users(id) on delete restrict,
  approved_by uuid references public.users(id) on delete restrict,
  approved_at timestamptz,
  sent_at timestamptz,
  failure_reason text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (student_id,period_start,period_end),
  check (period_end >= period_start),
  check ((status='draft') = (approved_by is null and approved_at is null)),
  check (status<>'sent' or sent_at is not null)
);

create table app_private.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references public.users(id) on delete cascade,
  channel text not null check (channel in ('telegram','email','push')),
  event_type text not null,
  payload jsonb not null,
  idempotency_key text not null unique,
  scheduled_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','processing','sent','failed','cancelled')),
  attempts integer not null default 0 check (attempts >= 0),
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create function app_private.current_user_kind() returns text language sql stable security definer set search_path='' as $$
  select kind from public.users where id=app_private.current_user_id()
$$;
create function app_private.is_admin() returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(app_private.current_user_kind()='admin',false)
$$;
create function app_private.teacher_has_group(p_group_id uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.group_teachers gt where gt.group_id=p_group_id and gt.teacher_id=app_private.current_user_id() and gt.ends_at is null)
$$;
create function app_private.teacher_has_student(p_student_id uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.group_memberships gm join public.group_teachers gt on gt.group_id=gm.group_id where gm.student_id=p_student_id and gm.status='active' and gt.teacher_id=app_private.current_user_id() and gt.ends_at is null)
$$;
create function app_private.guardian_has_student(p_student_id uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.guardian_student_links gsl where gsl.guardian_id=app_private.current_user_id() and gsl.student_id=p_student_id and gsl.status='active')
$$;

create function public.reschedule_class(p_session_id uuid,p_new_start timestamptz,p_new_end timestamptz,p_reason text default '') returns void
language plpgsql security definer set search_path='' as $$
declare v public.class_sessions%rowtype; begin
  if p_new_end<=p_new_start then raise exception 'invalid class time' using errcode='22007'; end if;
  select * into v from public.class_sessions where id=p_session_id for update;
  if v.id is null or not (app_private.teacher_has_group(v.group_id) or app_private.is_admin()) then raise exception 'class unavailable' using errcode='42501'; end if;
  if v.status in ('completed','cancelled') then raise exception 'class cannot be rescheduled'; end if;
  insert into public.class_session_reschedules(class_session_id,previous_start,previous_end,new_start,new_end,reason,changed_by)
    values(v.id,v.scheduled_start,v.scheduled_end,p_new_start,p_new_end,left(coalesce(p_reason,''),2000),app_private.current_user_id());
  update public.class_sessions set scheduled_start=p_new_start,scheduled_end=p_new_end,status='rescheduled',updated_at=now() where id=v.id;
end $$;

create function public.confirm_attendance(p_session_id uuid,p_student_id uuid,p_status text,p_note text default '') returns uuid
language plpgsql security definer set search_path='' as $$
declare v_group uuid; v_id uuid; begin
  if p_status not in ('present','late','absent','excused') then raise exception 'invalid attendance status'; end if;
  select group_id into v_group from public.class_sessions where id=p_session_id;
  if v_group is null or not (app_private.teacher_has_group(v_group) or app_private.is_admin()) then raise exception 'class unavailable' using errcode='42501'; end if;
  if not exists(select 1 from public.group_memberships where group_id=v_group and student_id=p_student_id and status='active') then raise exception 'student is not in group' using errcode='42501'; end if;
  insert into public.attendance(class_session_id,student_id,status,confirmed_by,confirmed_at,note)
    values(p_session_id,p_student_id,p_status,app_private.current_user_id(),now(),left(coalesce(p_note,''),2000))
    on conflict(class_session_id,student_id) do update set status=excluded.status,confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,note=excluded.note,updated_at=now()
    returning id into v_id; return v_id;
end $$;

create function public.review_homework_submission(p_submission_id uuid,p_score integer,p_effort text,p_status text,p_feedback text default '') returns uuid
language plpgsql security definer set search_path='' as $$
declare v_student uuid; v_review uuid; begin
  if p_score<0 or p_score>10 then raise exception 'score must be between 0 and 10'; end if;
  if p_effort not in ('needs_attention','good_effort','high_effort') then raise exception 'invalid effort'; end if;
  if p_status not in ('reviewed','needs_revision','completed') then raise exception 'invalid review status'; end if;
  select student_id into v_student from public.homework_submissions where id=p_submission_id for update;
  if v_student is null or not (app_private.teacher_has_student(v_student) or app_private.is_admin()) then raise exception 'submission unavailable' using errcode='42501'; end if;
  insert into public.homework_reviews(submission_id,reviewer_id,score,effort,status,feedback)
    values(p_submission_id,app_private.current_user_id(),p_score,p_effort,p_status,left(coalesce(p_feedback,''),10000))
    on conflict(submission_id) do update set reviewer_id=excluded.reviewer_id,score=excluded.score,effort=excluded.effort,status=excluded.status,feedback=excluded.feedback,reviewed_at=now(),updated_at=now()
    returning id into v_review;
  update public.homework_submissions set status=case when p_status='needs_revision' then 'needs_revision' when p_status='completed' then 'completed' else status end,updated_at=now() where id=p_submission_id;
  return v_review;
end $$;

create function public.book_mentor_slot(p_availability_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare
  v_slot public.mentor_availability%rowtype;
  v_booking_id uuid;
  v_week_start timestamptz;
  v_week_end timestamptz;
  v_weekly_limit integer;
begin
  if app_private.current_user_kind()<>'student' then
    raise exception 'only students can book mentor sessions' using errcode='42501';
  end if;

  select ma.* into v_slot
  from public.mentor_availability ma
  where ma.id=p_availability_id
  for update;

  if v_slot.id is null or v_slot.status<>'open' or v_slot.starts_at<=now() then
    raise exception 'mentor slot unavailable' using errcode='P0002';
  end if;
  if not exists(
    select 1 from public.mentor_assignments assignment
    where assignment.student_user_id=app_private.current_user_id()
      and assignment.mentor_id=v_slot.mentor_id
      and assignment.starts_at<=now()
      and (assignment.ends_at is null or assignment.ends_at>now())
  ) then
    raise exception 'mentor slot unavailable' using errcode='42501';
  end if;

  select booking_limit_per_week into v_weekly_limit from public.mentors where id=v_slot.mentor_id;
  v_week_start := date_trunc('week',v_slot.starts_at at time zone v_slot.timezone) at time zone v_slot.timezone;
  v_week_end := v_week_start + interval '7 days';
  if (select count(*) from public.mentor_bookings booking
      where booking.student_id=app_private.current_user_id()
        and booking.starts_at>=v_week_start and booking.starts_at<v_week_end
        and booking.status in ('reserved','confirmed','rescheduled')) >= v_weekly_limit then
    raise exception 'weekly mentor booking limit reached' using errcode='P0001';
  end if;

  insert into public.mentor_bookings(student_id,mentor_id,availability_id,starts_at,ends_at,timezone,status)
  values(app_private.current_user_id(),v_slot.mentor_id,v_slot.id,v_slot.starts_at,v_slot.ends_at,v_slot.timezone,'reserved')
  returning id into v_booking_id;
  update public.mentor_availability set status='booked',updated_at=now() where id=v_slot.id;
  return v_booking_id;
end $$;

create function app_private.audit_homework_review() returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.homework_review_events(homework_review_id,changed_by,previous_score,new_score,previous_effort,new_effort,previous_status,new_status)
  values(new.id,new.reviewer_id,case when tg_op='UPDATE' then old.score end,new.score,case when tg_op='UPDATE' then old.effort end,new.effort,case when tg_op='UPDATE' then old.status end,new.status);
  return new;
end $$;
create trigger homework_review_audit after insert or update on public.homework_reviews for each row execute function app_private.audit_homework_review();

create index group_memberships_student_status_idx on public.group_memberships(student_id,status);
create index group_teachers_teacher_idx on public.group_teachers(teacher_id) where ends_at is null;
create index class_sessions_group_start_idx on public.class_sessions(group_id,scheduled_start);
create index attendance_student_session_idx on public.attendance(student_id,class_session_id);
create index homework_group_due_idx on public.homework(group_id,due_at) where status='published';
create index homework_submissions_student_idx on public.homework_submissions(student_id,homework_id,attempt_number desc);
create index portfolio_projects_portfolio_idx on public.portfolio_projects(portfolio_id,position);
create index mentor_availability_start_idx on public.mentor_availability(mentor_id,starts_at) where status='open';
create index parent_reports_student_period_idx on public.parent_reports(student_id,period_end desc);

do $$ declare table_name text; begin
  foreach table_name in array array['teacher_profiles','guardian_profiles','groups','group_memberships','class_sessions','attendance','homework','homework_submissions','homework_reviews','student_skills','portfolios','portfolio_projects','mentor_availability','mentor_bookings','guardian_student_links','parent_reports'] loop
    execute format('create trigger %I_touch_updated_at before update on public.%I for each row execute function app_private.touch_updated_at()',table_name,table_name);
  end loop;
end $$;

do $$ declare table_name text; begin
  foreach table_name in array array['teacher_profiles','guardian_profiles','groups','group_teachers','group_memberships','class_sessions','class_session_reschedules','file_assets','class_materials','attendance','homework','homework_resources','homework_submissions','submission_attachments','homework_reviews','homework_review_events','skills','project_skills','student_skills','portfolios','portfolio_projects','portfolio_project_skills','portfolio_project_media','mentor_availability','mentor_bookings','guardian_student_links','parent_reports'] loop
    execute format('alter table public.%I enable row level security',table_name);
  end loop;
end $$;
alter table app_private.guardian_link_invitations enable row level security;
alter table app_private.notification_outbox enable row level security;

create policy groups_student_read on public.groups for select to authenticated using (exists(select 1 from public.group_memberships gm where gm.group_id=groups.id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.teacher_has_group(groups.id) or app_private.is_admin());
create policy group_memberships_read on public.group_memberships for select to authenticated using (group_memberships.student_id=app_private.current_user_id() or app_private.teacher_has_group(group_memberships.group_id) or app_private.is_admin());
create policy group_teachers_read on public.group_teachers for select to authenticated using (group_teachers.teacher_id=app_private.current_user_id() or exists(select 1 from public.group_memberships gm where gm.group_id=group_teachers.group_id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.is_admin());
create policy teacher_profiles_read_assigned on public.teacher_profiles for select to authenticated using (teacher_profiles.user_id=app_private.current_user_id() or exists(select 1 from public.group_teachers gt join public.group_memberships gm on gm.group_id=gt.group_id where gt.teacher_id=teacher_profiles.user_id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.is_admin());
create policy guardian_profiles_read_own on public.guardian_profiles for select to authenticated using (user_id=app_private.current_user_id() or app_private.is_admin());
create policy class_sessions_read_authorized on public.class_sessions for select to authenticated using (exists(select 1 from public.group_memberships gm where gm.group_id=class_sessions.group_id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.teacher_has_group(class_sessions.group_id) or app_private.is_admin());
create policy class_sessions_teacher_insert on public.class_sessions for insert to authenticated with check (
  app_private.is_admin() or (
    app_private.teacher_has_group(class_sessions.group_id)
    and class_sessions.teacher_id=app_private.current_user_id()
    and class_sessions.created_by=app_private.current_user_id()
    and exists(select 1 from public.groups g where g.id=class_sessions.group_id and g.course_id=class_sessions.course_id)
  )
);
create policy class_reschedules_read on public.class_session_reschedules for select to authenticated using (exists(select 1 from public.class_sessions cs where cs.id=class_session_reschedules.class_session_id and (app_private.teacher_has_group(cs.group_id) or exists(select 1 from public.group_memberships gm where gm.group_id=cs.group_id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.is_admin())));
create policy class_materials_read on public.class_materials for select to authenticated using (exists(select 1 from public.class_sessions cs where cs.id=class_materials.class_session_id and (app_private.teacher_has_group(cs.group_id) or exists(select 1 from public.group_memberships gm where gm.group_id=cs.group_id and gm.student_id=app_private.current_user_id() and gm.status='active') or app_private.is_admin())));
create policy attendance_student_read on public.attendance for select to authenticated using (student_id=app_private.current_user_id() or app_private.teacher_has_student(student_id) or app_private.is_admin());
create policy homework_read on public.homework for select to authenticated using ((homework.status='published' and homework.publish_at<=now() and exists(select 1 from public.group_memberships gm where gm.group_id=homework.group_id and gm.student_id=app_private.current_user_id() and gm.status='active')) or app_private.teacher_has_group(homework.group_id) or app_private.is_admin());
create policy homework_teacher_insert on public.homework for insert to authenticated with check (
  app_private.is_admin() or (
    app_private.teacher_has_group(homework.group_id)
    and homework.created_by=app_private.current_user_id()
    and exists(select 1 from public.groups g where g.id=homework.group_id and g.course_id=homework.course_id)
    and (homework.class_session_id is null or exists(select 1 from public.class_sessions cs where cs.id=homework.class_session_id and cs.group_id=homework.group_id))
  )
);
create policy homework_resources_read on public.homework_resources for select to authenticated using (exists(select 1 from public.homework h where h.id=homework_resources.homework_id));
create policy submissions_read on public.homework_submissions for select to authenticated using (student_id=app_private.current_user_id() or app_private.teacher_has_student(student_id) or app_private.is_admin());
create policy submissions_student_insert on public.homework_submissions for insert to authenticated with check (app_private.current_user_kind()='student' and homework_submissions.student_id=app_private.current_user_id() and exists(select 1 from public.homework h join public.group_memberships gm on gm.group_id=h.group_id where h.id=homework_submissions.homework_id and h.status='published' and gm.student_id=app_private.current_user_id() and gm.status='active'));
create policy reviews_read on public.homework_reviews for select to authenticated using (exists(select 1 from public.homework_submissions s where s.id=homework_reviews.submission_id and (s.student_id=app_private.current_user_id() or app_private.teacher_has_student(s.student_id) or app_private.is_admin())));
create policy submission_attachments_read on public.submission_attachments for select to authenticated using (exists(select 1 from public.homework_submissions s where s.id=submission_attachments.submission_id and (s.student_id=app_private.current_user_id() or app_private.teacher_has_student(s.student_id) or app_private.is_admin())));
create policy submission_attachments_student_insert on public.submission_attachments for insert to authenticated with check (exists(select 1 from public.homework_submissions s where s.id=submission_attachments.submission_id and s.student_id=app_private.current_user_id()));
create policy review_events_teacher_read on public.homework_review_events for select to authenticated using (exists(select 1 from public.homework_reviews r join public.homework_submissions s on s.id=r.submission_id where r.id=homework_review_events.homework_review_id and (app_private.teacher_has_student(s.student_id) or app_private.is_admin())));
create policy skills_read on public.skills for select to authenticated using (is_active or app_private.is_admin());
create policy project_skills_read on public.project_skills for select to authenticated using (exists(select 1 from public.projects p where p.id=project_skills.project_id and (p.user_id=app_private.current_user_id() or app_private.teacher_has_student(p.user_id) or app_private.is_admin())));
create policy student_skills_read on public.student_skills for select to authenticated using (student_id=app_private.current_user_id() or app_private.teacher_has_student(student_id) or app_private.is_admin());
create policy portfolios_read on public.portfolios for select to authenticated using (student_id=app_private.current_user_id() or app_private.teacher_has_student(student_id) or app_private.is_admin());
create policy portfolios_student_insert on public.portfolios for insert to authenticated with check (app_private.current_user_kind()='student' and student_id=app_private.current_user_id());
create policy portfolios_student_update on public.portfolios for update to authenticated using (app_private.current_user_kind()='student' and student_id=app_private.current_user_id()) with check (app_private.current_user_kind()='student' and student_id=app_private.current_user_id());
create policy portfolio_projects_read on public.portfolio_projects for select to authenticated using (exists(select 1 from public.portfolios p where p.id=portfolio_projects.portfolio_id));
create policy portfolio_projects_student_write on public.portfolio_projects for all to authenticated using (app_private.current_user_kind()='student' and exists(select 1 from public.portfolios p where p.id=portfolio_projects.portfolio_id and p.student_id=app_private.current_user_id())) with check (app_private.current_user_kind()='student' and exists(select 1 from public.portfolios p join public.projects pr on pr.id=portfolio_projects.project_id and pr.user_id=p.student_id where p.id=portfolio_projects.portfolio_id and p.student_id=app_private.current_user_id()));
create policy portfolio_project_skills_read on public.portfolio_project_skills for select to authenticated using (exists(select 1 from public.portfolio_projects pp where pp.id=portfolio_project_skills.portfolio_project_id));
create policy portfolio_project_media_read on public.portfolio_project_media for select to authenticated using (exists(select 1 from public.portfolio_projects pp where pp.id=portfolio_project_media.portfolio_project_id));
create policy mentor_availability_read on public.mentor_availability for select to authenticated using (
  exists(select 1 from public.mentor_assignments assignment where assignment.mentor_id=mentor_availability.mentor_id and assignment.student_user_id=app_private.current_user_id() and assignment.starts_at<=now() and (assignment.ends_at is null or assignment.ends_at>now()))
  or exists(select 1 from public.mentors m where m.id=mentor_availability.mentor_id and m.user_id=app_private.current_user_id())
  or app_private.is_admin()
);
create policy mentor_bookings_read on public.mentor_bookings for select to authenticated using (mentor_bookings.student_id=app_private.current_user_id() or exists(select 1 from public.mentors m where m.id=mentor_bookings.mentor_id and m.user_id=app_private.current_user_id()) or app_private.is_admin());
create policy guardian_links_read on public.guardian_student_links for select to authenticated using (guardian_id=app_private.current_user_id() or student_id=app_private.current_user_id() or app_private.teacher_has_student(student_id) or app_private.is_admin());
create policy parent_reports_teacher_read on public.parent_reports for select to authenticated using (app_private.teacher_has_student(student_id) or app_private.is_admin() or (status in ('approved','sent') and app_private.guardian_has_student(student_id)));
create policy parent_reports_teacher_insert on public.parent_reports for insert to authenticated with check (
  app_private.is_admin() or (
    app_private.teacher_has_student(parent_reports.student_id)
    and parent_reports.created_by=app_private.current_user_id()
    and parent_reports.status='draft'
    and parent_reports.approved_by is null
    and parent_reports.approved_at is null
  )
);
create policy parent_reports_teacher_update on public.parent_reports for update to authenticated
  using (app_private.teacher_has_student(parent_reports.student_id) or app_private.is_admin())
  with check (
    app_private.is_admin() or (
      app_private.teacher_has_student(parent_reports.student_id)
      and (
        (parent_reports.status='draft' and parent_reports.approved_by is null and parent_reports.approved_at is null)
        or (parent_reports.status='approved' and parent_reports.approved_by=app_private.current_user_id() and parent_reports.approved_at is not null)
      )
    )
  );
create policy file_assets_owner_read on public.file_assets for select to authenticated using (
  owner_user_id=app_private.current_user_id()
  or app_private.teacher_has_student(owner_user_id)
  or exists(select 1 from public.class_materials cm join public.class_sessions cs on cs.id=cm.class_session_id join public.group_memberships gm on gm.group_id=cs.group_id where cm.file_asset_id=file_assets.id and gm.student_id=app_private.current_user_id() and gm.status='active')
  or exists(select 1 from public.homework_resources hr join public.homework h on h.id=hr.homework_id join public.group_memberships gm on gm.group_id=h.group_id where hr.file_asset_id=file_assets.id and gm.student_id=app_private.current_user_id() and gm.status='active')
  or exists(select 1 from public.submission_attachments sa join public.homework_submissions hs on hs.id=sa.submission_id where sa.file_asset_id=file_assets.id and (hs.student_id=app_private.current_user_id() or app_private.teacher_has_student(hs.student_id)))
  or exists(select 1 from public.portfolio_project_media pm join public.portfolio_projects pp on pp.id=pm.portfolio_project_id join public.portfolios portfolio on portfolio.id=pp.portfolio_id where pm.file_asset_id=file_assets.id and (portfolio.student_id=app_private.current_user_id() or app_private.teacher_has_student(portfolio.student_id)))
  or app_private.is_admin()
);
create policy file_assets_owner_insert on public.file_assets for insert to authenticated with check (owner_user_id=app_private.current_user_id());

create policy profiles_authorized_read on public.student_profiles for select to authenticated using (app_private.teacher_has_student(user_id) or app_private.guardian_has_student(user_id) or app_private.is_admin());
create policy users_authorized_read on public.users for select to authenticated using (app_private.teacher_has_student(id) or app_private.guardian_has_student(id) or app_private.is_admin());
drop policy if exists projects_insert_own on public.projects;
drop policy if exists projects_update_own on public.projects;
drop policy if exists project_tasks_insert_own on public.project_tasks;
create policy projects_student_insert on public.projects for insert to authenticated with check (app_private.current_user_kind()='student' and user_id=app_private.current_user_id());
create policy projects_student_update on public.projects for update to authenticated using (app_private.current_user_kind()='student' and user_id=app_private.current_user_id()) with check (app_private.current_user_kind()='student' and user_id=app_private.current_user_id());
create policy project_tasks_student_insert on public.project_tasks for insert to authenticated with check (app_private.current_user_kind()='student' and exists(select 1 from public.projects p where p.id=project_tasks.project_id and p.user_id=app_private.current_user_id()));
create policy projects_teacher_read on public.projects for select to authenticated using (app_private.teacher_has_student(user_id) or app_private.guardian_has_student(user_id) or app_private.is_admin());
create policy project_tasks_teacher_read on public.project_tasks for select to authenticated using (exists(select 1 from public.projects p where p.id=project_tasks.project_id and (app_private.teacher_has_student(p.user_id) or app_private.is_admin())));
create policy enrollments_teacher_read on public.enrollments for select to authenticated using (app_private.teacher_has_student(user_id) or app_private.guardian_has_student(user_id) or app_private.is_admin());
create policy lesson_progress_teacher_read on public.lesson_progress for select to authenticated using (exists(select 1 from public.enrollments e where e.id=lesson_progress.enrollment_id and (app_private.teacher_has_student(e.user_id) or app_private.guardian_has_student(e.user_id) or app_private.is_admin())));

revoke all on all tables in schema public from anon;
grant select on public.teacher_profiles,public.guardian_profiles,public.groups,public.group_teachers,public.group_memberships,public.class_sessions,public.class_session_reschedules,public.class_materials,public.attendance,public.homework,public.homework_resources,public.homework_submissions,public.submission_attachments,public.homework_reviews,public.homework_review_events,public.skills,public.project_skills,public.student_skills,public.portfolios,public.portfolio_projects,public.portfolio_project_skills,public.portfolio_project_media,public.mentor_availability,public.mentor_bookings,public.guardian_student_links,public.parent_reports,public.file_assets to authenticated;
grant insert on public.homework_submissions,public.submission_attachments,public.portfolios,public.portfolio_projects,public.file_assets to authenticated;
grant update on public.portfolios,public.portfolio_projects to authenticated;
grant insert on public.class_sessions,public.homework to authenticated;
grant insert,update on public.parent_reports to authenticated;
revoke all on function public.reschedule_class(uuid,timestamptz,timestamptz,text),public.confirm_attendance(uuid,uuid,text,text),public.review_homework_submission(uuid,integer,text,text,text),public.book_mentor_slot(uuid) from public,anon;
revoke all on function app_private.current_user_kind(),app_private.is_admin(),app_private.teacher_has_group(uuid),app_private.teacher_has_student(uuid),app_private.guardian_has_student(uuid) from public,anon;
grant execute on function app_private.current_user_kind(),app_private.is_admin(),app_private.teacher_has_group(uuid),app_private.teacher_has_student(uuid),app_private.guardian_has_student(uuid) to authenticated;
grant execute on function public.reschedule_class(uuid,timestamptz,timestamptz,text),public.confirm_attendance(uuid,uuid,text,text),public.review_homework_submission(uuid,integer,text,text,text),public.book_mentor_slot(uuid) to authenticated;

update public.modules set title='Основи роботи з AI' where position=1 and course_id=(select id from public.courses where slug='ai-foundations');
update public.courses set title='Основи роботи з AI' where slug='ai-foundations';
update public.lessons l set title=v.title from (values
  (1,'Знайомство з AI'),(2,'Як працювати з AI'),(3,'Як перевіряти відповіді AI'),(4,'Від проблеми до ідеї'),(5,'Плануємо свій проєкт'),
  (6,'Створюємо першу версію'),(7,'Працюємо з кодом через AI'),(8,'Основи дизайну продукту')) as v(position,title)
where l.position=v.position and l.module_id=(select m.id from public.modules m join public.courses c on c.id=m.course_id where c.slug='ai-foundations' and m.position=1);

insert into public.lessons(id,module_id,position,slug,title,summary,content,estimated_minutes,xp_reward,prerequisite_lesson_id,status)
select * from (values
('22000000-0000-4000-8000-000000000009'::uuid,'21000000-0000-4000-8000-000000000001'::uuid,9,'test-and-improve','Тестуємо та покращуємо','Перевір продукт із користувачем і визнач наступну зміну.','{"explanation":"Тестування показує, де реальна поведінка відрізняється від припущень.","examples":["Спостерігай за діями та не підказуй правильний шлях."],"task":{"prompt":"Проведи короткий тест і запиши один сигнал для покращення.","hint":"Фіксуй те, що побачив."},"conceptName":"Цикл перевірки","nextStep":"Підготуємо презентацію проєкту."}'::jsonb,18,180,'22000000-0000-4000-8000-000000000008'::uuid,'published'),
('22000000-0000-4000-8000-000000000010'::uuid,'21000000-0000-4000-8000-000000000001'::uuid,10,'present-project','Презентуємо свій проєкт','Поясни проблему, рішення, перевірку і наступний крок.','{"explanation":"Сильна презентація показує шлях від проблеми до створеного результату.","examples":["Почни з людини та її ситуації."],"task":{"prompt":"Склади пітч із чотирьох речень.","hint":"Хто → проблема → рішення → доказ."},"conceptName":"Product story","nextStep":"Додай проєкт до портфоліо."}'::jsonb,20,200,'22000000-0000-4000-8000-000000000009'::uuid,'published')
) as lesson(id,module_id,position,slug,title,summary,content,estimated_minutes,xp_reward,prerequisite_lesson_id,status)
where exists(select 1 from public.modules m where m.id='21000000-0000-4000-8000-000000000001')
  and exists(select 1 from public.lessons prerequisite where prerequisite.id='22000000-0000-4000-8000-000000000008')
on conflict do nothing;

update public.project_stages set code='idea',title='Ідея' where position=1;
update public.project_stages set code='plan',title='План' where position=2;
update public.project_stages set code='design',title='Дизайн' where position=4;
update public.project_stages set code='test',title='Тест' where position=5;
insert into public.project_stages(id,code,title,position,default_completion_percent) values ('31000000-0000-4000-8000-000000000006','launch','Запуск',6,100) on conflict do nothing;

commit;
