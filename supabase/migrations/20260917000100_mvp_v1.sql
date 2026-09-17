begin;

create extension if not exists pgcrypto;
create schema if not exists app_private;

create table public.users (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'student' check (kind in ('student', 'mentor', 'admin')),
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz,
  deleted_at timestamptz,
  check ((status = 'deleted') = (deleted_at is not null))
);

create table public.user_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('telegram', 'supabase_auth')),
  provider_subject text not null check (char_length(provider_subject) between 1 and 255),
  created_at timestamptz not null default now(),
  last_authenticated_at timestamptz not null default now(),
  unique (provider, provider_subject),
  unique (user_id, provider)
);

create table public.levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  position integer not null unique check (position > 0),
  min_xp integer not null unique check (min_xp >= 0)
);

create table public.student_profiles (
  user_id uuid primary key references public.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 60),
  locale text not null default 'uk' check (char_length(locale) between 2 and 16),
  timezone text,
  current_streak integer not null default 0 check (current_streak >= 0),
  longest_streak integer not null default 0 check (longest_streak >= current_streak),
  last_activity_on date,
  level_id uuid references public.levels(id) on delete set null,
  onboarding_completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.courses (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.modules (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete restrict,
  position integer not null check (position > 0),
  title text not null,
  description text not null default '',
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, position)
);

create table public.lessons (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete restrict,
  position integer not null check (position > 0),
  slug text not null,
  title text not null,
  summary text not null default '',
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  estimated_minutes integer not null default 10 check (estimated_minutes > 0),
  xp_reward integer not null default 0 check (xp_reward >= 0),
  prerequisite_lesson_id uuid references public.lessons(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (module_id, position),
  unique (module_id, slug),
  check (prerequisite_lesson_id is null or prerequisite_lesson_id <> id)
);

create table public.enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  course_id uuid not null references public.courses(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'completed', 'paused')),
  current_lesson_id uuid references public.lessons(id) on delete set null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  last_activity_at timestamptz not null default now(),
  unique (user_id, course_id),
  check ((status = 'completed') = (completed_at is not null))
);

create table public.lesson_progress (
  id uuid primary key default gen_random_uuid(),
  enrollment_id uuid not null references public.enrollments(id) on delete cascade,
  lesson_id uuid not null references public.lessons(id) on delete restrict,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed')),
  progress_percent smallint not null default 0 check (progress_percent between 0 and 100),
  started_at timestamptz,
  completed_at timestamptz,
  last_activity_at timestamptz not null default now(),
  unique (enrollment_id, lesson_id),
  check (status <> 'completed' or (progress_percent = 100 and completed_at is not null))
);

create table public.project_stages (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  position integer not null unique check (position > 0),
  default_completion_percent smallint not null check (default_completion_percent between 0 and 100),
  is_active boolean not null default true
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  enrollment_id uuid references public.enrollments(id) on delete set null,
  title text not null check (char_length(title) between 1 and 120),
  summary text not null default '' check (char_length(summary) <= 1000),
  stage_id uuid not null references public.project_stages(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'completed', 'archived')),
  completion_percent smallint not null default 0 check (completion_percent between 0 and 100),
  tags text[] not null default '{}',
  workspace_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index projects_one_active_per_enrollment
  on public.projects(user_id, enrollment_id)
  where status = 'active' and enrollment_id is not null;

create table public.project_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  stage_id uuid references public.project_stages(id) on delete set null,
  position integer not null check (position > 0),
  title text not null,
  description text not null default '',
  status text not null default 'locked' check (status in ('locked', 'available', 'in_progress', 'completed')),
  xp_reward integer not null default 0 check (xp_reward >= 0),
  weight smallint not null default 0 check (weight between 0 and 100),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, position),
  check ((status = 'completed') = (completed_at is not null))
);

create table public.xp_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  delta integer not null check (delta <> 0),
  event_type text not null,
  source_type text,
  source_id uuid,
  idempotency_key text not null unique,
  description text not null default '',
  created_at timestamptz not null default now()
);

create table public.achievements (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  description text not null,
  artifact_style_key text not null,
  xp_reward integer not null default 0 check (xp_reward >= 0),
  criteria jsonb not null default '{}'::jsonb check (jsonb_typeof(criteria) = 'object'),
  is_published boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.student_achievements (
  user_id uuid not null references public.users(id) on delete cascade,
  achievement_id uuid not null references public.achievements(id) on delete restrict,
  xp_event_id uuid unique references public.xp_events(id) on delete set null,
  awarded_at timestamptz not null default now(),
  primary key (user_id, achievement_id)
);

create table public.mentors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid unique references public.users(id) on delete set null,
  display_name text not null check (char_length(display_name) between 1 and 60),
  title text not null,
  avatar_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.mentor_assignments (
  id uuid primary key default gen_random_uuid(),
  student_user_id uuid not null references public.users(id) on delete cascade,
  mentor_id uuid not null references public.mentors(id) on delete restrict,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  next_meeting_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);

create unique index mentor_assignments_one_active
  on public.mentor_assignments(student_user_id)
  where ends_at is null;

create table public.ai_conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  course_id uuid references public.courses(id) on delete set null,
  lesson_id uuid references public.lessons(id) on delete set null,
  project_id uuid references public.projects(id) on delete set null,
  title text not null default 'Нова розмова' check (char_length(title) between 1 and 120),
  status text not null default 'active' check (status in ('active', 'archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_message_at timestamptz
);

create table public.ai_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null check (char_length(content) between 1 and 20000),
  client_message_id uuid,
  safety_status text not null default 'allowed' check (safety_status in ('pending', 'allowed', 'blocked', 'review')),
  created_at timestamptz not null default now(),
  unique (conversation_id, client_message_id)
);

create table app_private.auth_sessions (
  id uuid primary key,
  family_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null check (provider in ('telegram', 'development', 'web')),
  refresh_token_hash char(64) not null unique,
  created_at timestamptz not null,
  last_used_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  rotated_at timestamptz,
  replaced_by_session_id uuid references app_private.auth_sessions(id) on delete set null,
  reuse_detected_at timestamptz,
  check (expires_at > created_at)
);

create table app_private.ai_conversation_state (
  conversation_id uuid primary key references public.ai_conversations(id) on delete cascade,
  summary text not null default '',
  prompt_version text not null default 'mentor-v1',
  last_compacted_message_id uuid references public.ai_messages(id) on delete set null,
  provider_metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create index user_identities_user_id_idx on public.user_identities(user_id);
create index modules_course_id_idx on public.modules(course_id);
create index lessons_module_id_idx on public.lessons(module_id);
create index enrollments_user_status_idx on public.enrollments(user_id, status);
create index enrollments_course_id_idx on public.enrollments(course_id);
create index lesson_progress_enrollment_status_idx on public.lesson_progress(enrollment_id, status);
create index lesson_progress_lesson_id_idx on public.lesson_progress(lesson_id);
create index projects_user_status_idx on public.projects(user_id, status);
create index project_tasks_project_position_idx on public.project_tasks(project_id, position);
create index xp_events_user_created_idx on public.xp_events(user_id, created_at desc);
create index student_achievements_user_awarded_idx on public.student_achievements(user_id, awarded_at desc);
create index mentor_assignments_mentor_idx on public.mentor_assignments(mentor_id);
create index ai_conversations_user_updated_idx on public.ai_conversations(user_id, updated_at desc);
create index ai_messages_conversation_created_idx on public.ai_messages(conversation_id, created_at, id);
create index auth_sessions_user_idx on app_private.auth_sessions(user_id, created_at desc);
create index auth_sessions_family_idx on app_private.auth_sessions(family_id);

create function app_private.current_user_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif((select auth.jwt()) ->> 'app_user_id', '')::uuid
$$;

create function app_private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end
$$;

create trigger users_touch before update on public.users for each row execute function app_private.touch_updated_at();
create trigger profiles_touch before update on public.student_profiles for each row execute function app_private.touch_updated_at();
create trigger courses_touch before update on public.courses for each row execute function app_private.touch_updated_at();
create trigger modules_touch before update on public.modules for each row execute function app_private.touch_updated_at();
create trigger lessons_touch before update on public.lessons for each row execute function app_private.touch_updated_at();
create trigger projects_touch before update on public.projects for each row execute function app_private.touch_updated_at();
create trigger project_tasks_touch before update on public.project_tasks for each row execute function app_private.touch_updated_at();
create trigger mentors_touch before update on public.mentors for each row execute function app_private.touch_updated_at();
create trigger conversations_touch before update on public.ai_conversations for each row execute function app_private.touch_updated_at();

create function app_private.record_student_activity(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date;
  v_last date;
  v_streak integer;
begin
  select (now() at time zone coalesce(sp.timezone, 'UTC'))::date, sp.last_activity_on, sp.current_streak
    into v_today, v_last, v_streak
    from public.student_profiles sp where sp.user_id = p_user_id for update;
  if v_last = v_today then return; end if;
  if v_last = v_today - 1 then v_streak := v_streak + 1; else v_streak := 1; end if;
  update public.student_profiles
    set current_streak = v_streak,
        longest_streak = greatest(longest_streak, v_streak),
        last_activity_on = v_today
    where user_id = p_user_id;
end
$$;

alter table public.users enable row level security;
alter table public.user_identities enable row level security;
alter table public.student_profiles enable row level security;
alter table public.levels enable row level security;
alter table public.courses enable row level security;
alter table public.modules enable row level security;
alter table public.lessons enable row level security;
alter table public.enrollments enable row level security;
alter table public.lesson_progress enable row level security;
alter table public.project_stages enable row level security;
alter table public.projects enable row level security;
alter table public.project_tasks enable row level security;
alter table public.xp_events enable row level security;
alter table public.achievements enable row level security;
alter table public.student_achievements enable row level security;
alter table public.mentors enable row level security;
alter table public.mentor_assignments enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_messages enable row level security;
alter table app_private.auth_sessions enable row level security;
alter table app_private.ai_conversation_state enable row level security;

create policy users_read_own on public.users for select to authenticated
  using (id = (select app_private.current_user_id()));
create policy profiles_read_own on public.student_profiles for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy levels_read on public.levels for select to authenticated using (true);
create policy courses_read_published on public.courses for select to authenticated using (status = 'published');
create policy modules_read_published on public.modules for select to authenticated
  using (status = 'published' and exists (select 1 from public.courses c where c.id = modules.course_id and c.status = 'published'));
create policy lessons_read_published on public.lessons for select to authenticated
  using (status = 'published' and exists (
    select 1 from public.modules m join public.courses c on c.id = m.course_id
    where m.id = lessons.module_id and m.status = 'published' and c.status = 'published'
  ));
create policy enrollments_read_own on public.enrollments for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy lesson_progress_read_own on public.lesson_progress for select to authenticated
  using (exists (select 1 from public.enrollments e where e.id = lesson_progress.enrollment_id and e.user_id = (select app_private.current_user_id())));
create policy project_stages_read on public.project_stages for select to authenticated using (is_active);
create policy projects_read_own on public.projects for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy projects_insert_own on public.projects for insert to authenticated
  with check (user_id = (select app_private.current_user_id()));
create policy projects_update_own on public.projects for update to authenticated
  using (user_id = (select app_private.current_user_id()))
  with check (user_id = (select app_private.current_user_id()));
create policy project_tasks_read_own on public.project_tasks for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_tasks.project_id and p.user_id = (select app_private.current_user_id())));
create policy project_tasks_insert_own on public.project_tasks for insert to authenticated
  with check (exists (select 1 from public.projects p where p.id = project_tasks.project_id and p.user_id = (select app_private.current_user_id())));
create policy xp_events_read_own on public.xp_events for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy achievements_read_published on public.achievements for select to authenticated using (is_published);
create policy student_achievements_read_own on public.student_achievements for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy mentor_assignments_read_own on public.mentor_assignments for select to authenticated
  using (student_user_id = (select app_private.current_user_id()));
create policy mentors_read_assigned on public.mentors for select to authenticated
  using (exists (
    select 1 from public.mentor_assignments ma
    where ma.mentor_id = mentors.id and ma.student_user_id = (select app_private.current_user_id())
      and ma.starts_at <= now() and (ma.ends_at is null or ma.ends_at > now())
  ));
create policy conversations_read_own on public.ai_conversations for select to authenticated
  using (user_id = (select app_private.current_user_id()));
create policy conversations_insert_own on public.ai_conversations for insert to authenticated
  with check (user_id = (select app_private.current_user_id()));
create policy conversations_update_own on public.ai_conversations for update to authenticated
  using (user_id = (select app_private.current_user_id()))
  with check (user_id = (select app_private.current_user_id()));
create policy messages_read_own on public.ai_messages for select to authenticated
  using (exists (select 1 from public.ai_conversations c where c.id = ai_messages.conversation_id and c.user_id = (select app_private.current_user_id())));
create policy messages_insert_own on public.ai_messages for insert to authenticated
  with check (exists (select 1 from public.ai_conversations c where c.id = ai_messages.conversation_id and c.user_id = (select app_private.current_user_id())));

revoke all on all tables in schema public from anon, authenticated;
revoke all on schema app_private from public, anon, authenticated;
revoke all on all tables in schema app_private from public, anon, authenticated;
grant usage on schema public to authenticated;
grant usage on schema app_private to authenticated;
grant execute on function app_private.current_user_id() to authenticated;
grant select on public.users, public.student_profiles, public.levels, public.courses, public.modules,
  public.lessons, public.enrollments, public.lesson_progress, public.project_stages, public.projects,
  public.project_tasks, public.xp_events, public.achievements, public.student_achievements,
  public.mentors, public.mentor_assignments, public.ai_conversations, public.ai_messages to authenticated;
grant insert, update on public.projects, public.ai_conversations to authenticated;
grant insert on public.project_tasks, public.ai_messages to authenticated;

create function public.complete_lesson(p_lesson_id uuid, p_idempotency_key text)
returns table (awarded_xp integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app_private.current_user_id();
  v_enrollment_id uuid;
  v_reward integer;
  v_prerequisite uuid;
  v_already_completed boolean;
  v_event_id uuid;
  v_next_lesson uuid;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  if char_length(p_idempotency_key) < 8 or char_length(p_idempotency_key) > 200 then raise exception 'invalid idempotency key'; end if;
  select e.id, l.xp_reward, l.prerequisite_lesson_id,
         exists(select 1 from public.lesson_progress lp where lp.enrollment_id = e.id and lp.lesson_id = l.id and lp.status = 'completed')
    into v_enrollment_id, v_reward, v_prerequisite, v_already_completed
    from public.enrollments e
    join public.courses c on c.id = e.course_id
    join public.modules m on m.course_id = c.id
    join public.lessons l on l.module_id = m.id
    where e.user_id = v_user_id and e.status = 'active' and l.id = p_lesson_id and l.status = 'published'
    for update of e;
  if v_enrollment_id is null then raise exception 'lesson unavailable' using errcode = '42501'; end if;
  if v_prerequisite is not null and not exists (
    select 1 from public.lesson_progress where enrollment_id = v_enrollment_id and lesson_id = v_prerequisite and status = 'completed'
  ) then raise exception 'lesson locked' using errcode = '42501'; end if;
  if v_already_completed then return query select 0; return; end if;

  insert into public.lesson_progress(enrollment_id, lesson_id, status, progress_percent, started_at, completed_at, last_activity_at)
    values (v_enrollment_id, p_lesson_id, 'completed', 100, now(), now(), now())
    on conflict (enrollment_id, lesson_id) do update
      set status = 'completed', progress_percent = 100, completed_at = now(), last_activity_at = now();
  insert into public.xp_events(user_id, delta, event_type, source_type, source_id, idempotency_key, description)
    values (v_user_id, v_reward, 'lesson_completed', 'lesson', p_lesson_id, 'lesson:' || p_lesson_id || ':' || p_idempotency_key, 'Lesson completion')
    on conflict (idempotency_key) do nothing returning id into v_event_id;
  if v_event_id is null then return query select 0; return; end if;

  select l2.id into v_next_lesson
    from public.lessons l1 join public.lessons l2 on l2.module_id = l1.module_id and l2.position = l1.position + 1
    where l1.id = p_lesson_id and l2.status = 'published';
  update public.enrollments set current_lesson_id = coalesce(v_next_lesson, current_lesson_id), last_activity_at = now()
    where id = v_enrollment_id;
  perform app_private.record_student_activity(v_user_id);
  insert into public.student_achievements(user_id, achievement_id)
    select v_user_id, a.id from public.achievements a where a.code = 'first-spark'
    on conflict do nothing;
  return query select v_reward;
end
$$;

create function public.complete_project_task(p_project_id uuid, p_task_id uuid, p_idempotency_key text)
returns table (awarded_xp integer, completion_percent smallint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := app_private.current_user_id();
  v_reward integer;
  v_status text;
  v_event_id uuid;
  v_progress smallint;
  v_next_task uuid;
begin
  if v_user_id is null then raise exception 'authentication required' using errcode = '42501'; end if;
  select pt.xp_reward, pt.status into v_reward, v_status
    from public.project_tasks pt join public.projects p on p.id = pt.project_id
    where pt.id = p_task_id and p.id = p_project_id and p.user_id = v_user_id for update of pt, p;
  if v_status is null then raise exception 'task unavailable' using errcode = '42501'; end if;
  if v_status = 'locked' then raise exception 'task locked' using errcode = '42501'; end if;
  if v_status = 'completed' then
    select coalesce(sum(weight), 0)::smallint into v_progress from public.project_tasks where project_id = p_project_id and status = 'completed';
    return query select 0, v_progress; return;
  end if;
  update public.project_tasks set status = 'completed', completed_at = now() where id = p_task_id;
  insert into public.xp_events(user_id, delta, event_type, source_type, source_id, idempotency_key, description)
    values (v_user_id, v_reward, 'project_task_completed', 'project_task', p_task_id, 'project-task:' || p_task_id || ':' || p_idempotency_key, 'Project task completion')
    on conflict (idempotency_key) do nothing returning id into v_event_id;
  if v_event_id is null then
    select coalesce(sum(weight), 0)::smallint into v_progress from public.project_tasks where project_id = p_project_id and status = 'completed';
    return query select 0, v_progress; return;
  end if;
  select id into v_next_task from public.project_tasks
    where project_id = p_project_id and position > (select position from public.project_tasks where id = p_task_id)
    order by position limit 1;
  if v_next_task is not null then update public.project_tasks set status = 'in_progress' where id = v_next_task and status = 'locked'; end if;
  select coalesce(sum(weight), 0)::smallint into v_progress from public.project_tasks where project_id = p_project_id and status = 'completed';
  update public.projects set completion_percent = v_progress,
    status = case when v_progress >= 100 then 'completed' else status end,
    completed_at = case when v_progress >= 100 then now() else completed_at end
    where id = p_project_id;
  perform app_private.record_student_activity(v_user_id);
  insert into public.student_achievements(user_id, achievement_id)
    select v_user_id, a.id from public.achievements a where a.code = 'builder' and v_progress >= 50
    on conflict do nothing;
  return query select v_reward, v_progress;
end
$$;

revoke all on function public.complete_lesson(uuid, text) from public, anon;
revoke all on function public.complete_project_task(uuid, uuid, text) from public, anon;
grant execute on function public.complete_lesson(uuid, text) to authenticated;
grant execute on function public.complete_project_task(uuid, uuid, text) to authenticated;

commit;
