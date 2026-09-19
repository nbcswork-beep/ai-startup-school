begin;

alter table public.parent_reports drop constraint if exists parent_reports_status_check;
alter table public.parent_reports add constraint parent_reports_status_check check (status in ('draft','ready_for_review','approved','sent','failed'));
do $$ declare constraint_name text; begin
  for constraint_name in
    select conname from pg_constraint
    where conrelid='public.parent_reports'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%status%draft%approved_by%'
  loop execute format('alter table public.parent_reports drop constraint %I',constraint_name); end loop;
end $$;
alter table public.parent_reports add constraint parent_reports_approval_state_check check (
  (status in ('draft','ready_for_review') and approved_by is null and approved_at is null)
  or (status in ('approved','sent','failed') and approved_by is not null and approved_at is not null)
);

create table public.teacher_private_notes (
  id uuid primary key default gen_random_uuid(),
  student_id uuid not null references public.users(id) on delete cascade,
  teacher_id uuid not null references public.users(id) on delete cascade,
  category text not null default 'general' check (category in ('general','learning','project','mentoring')),
  content text not null check (char_length(content) between 1 and 10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.teacher_session_notes (
  id uuid primary key default gen_random_uuid(),
  class_session_id uuid not null references public.class_sessions(id) on delete cascade,
  teacher_id uuid not null references public.users(id) on delete cascade,
  content text not null default '' check (char_length(content)<=10000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(class_session_id,teacher_id)
);

create index teacher_private_notes_student_idx on public.teacher_private_notes(student_id,updated_at desc);
create index teacher_session_notes_session_idx on public.teacher_session_notes(class_session_id);

create trigger teacher_private_notes_touch_updated_at before update on public.teacher_private_notes for each row execute function app_private.touch_updated_at();
create trigger teacher_session_notes_touch_updated_at before update on public.teacher_session_notes for each row execute function app_private.touch_updated_at();

alter table public.teacher_private_notes enable row level security;
alter table public.teacher_session_notes enable row level security;

alter table public.mentor_availability add constraint mentor_availability_no_overlap
  exclude using gist (mentor_id with =,tstzrange(starts_at,ends_at,'[)') with &&)
  where (status in ('open','blocked','booked'));

create policy teacher_private_notes_teacher_access on public.teacher_private_notes for all to authenticated
  using ((teacher_id=app_private.current_user_id() and app_private.teacher_has_student(student_id)) or app_private.is_admin())
  with check ((teacher_id=app_private.current_user_id() and app_private.teacher_has_student(student_id)) or app_private.is_admin());
create policy teacher_session_notes_teacher_access on public.teacher_session_notes for all to authenticated
  using ((teacher_id=app_private.current_user_id() and exists(select 1 from public.class_sessions cs where cs.id=teacher_session_notes.class_session_id and app_private.teacher_has_group(cs.group_id))) or app_private.is_admin())
  with check ((teacher_id=app_private.current_user_id() and exists(select 1 from public.class_sessions cs where cs.id=teacher_session_notes.class_session_id and app_private.teacher_has_group(cs.group_id))) or app_private.is_admin());

create or replace function public.reschedule_class(p_session_id uuid,p_new_start timestamptz,p_new_end timestamptz,p_reason text default '') returns void
language plpgsql security definer set search_path='' as $$
declare v public.class_sessions%rowtype; begin
  if p_new_end<=p_new_start then raise exception 'invalid class time' using errcode='22007'; end if;
  select * into v from public.class_sessions where id=p_session_id for update;
  if v.id is null or not (app_private.teacher_has_group(v.group_id) or app_private.is_admin()) then raise exception 'class unavailable' using errcode='42501'; end if;
  if v.status in ('completed','cancelled') then raise exception 'class cannot be rescheduled'; end if;
  insert into public.class_session_reschedules(class_session_id,previous_start,previous_end,new_start,new_end,reason,changed_by)
    values(v.id,v.scheduled_start,v.scheduled_end,p_new_start,p_new_end,left(coalesce(p_reason,''),2000),app_private.current_user_id());
  update public.class_sessions set scheduled_start=p_new_start,scheduled_end=p_new_end,status='rescheduled',updated_at=now() where id=v.id;
  insert into app_private.notification_outbox(recipient_user_id,channel,event_type,payload,idempotency_key)
    select gm.student_id,'telegram','class_rescheduled',jsonb_build_object('classSessionId',v.id,'startsAt',p_new_start,'endsAt',p_new_end,'reason',left(coalesce(p_reason,''),2000)),
      'class-rescheduled:'||v.id||':'||gm.student_id||':'||extract(epoch from clock_timestamp())::bigint
    from public.group_memberships gm where gm.group_id=v.group_id and gm.status='active';
end $$;

create function public.update_teacher_class(
  p_session_id uuid,p_title text,p_description text,p_lesson_id uuid,p_meeting_url text,p_meeting_provider text,p_teacher_notes text,p_status text
) returns void language plpgsql security definer set search_path='' as $$
declare v public.class_sessions%rowtype; begin
  select * into v from public.class_sessions where id=p_session_id for update;
  if v.id is null or not (app_private.teacher_has_group(v.group_id) or app_private.is_admin()) then raise exception 'class unavailable' using errcode='42501'; end if;
  if v.status in ('completed','cancelled') and p_status is distinct from v.status then raise exception 'terminal class cannot be changed'; end if;
  if p_status is not null and p_status not in ('scheduled','in_progress','completed','cancelled') then raise exception 'invalid class status'; end if;
  if p_meeting_url is not null and p_meeting_url!~*'^https://' then raise exception 'unsafe meeting url'; end if;
  update public.class_sessions set
    title=coalesce(nullif(trim(p_title),''),title),description=coalesce(p_description,description),lesson_id=coalesce(p_lesson_id,lesson_id),
    meeting_url=coalesce(p_meeting_url,meeting_url),meeting_provider=coalesce(p_meeting_provider,meeting_provider),status=coalesce(p_status,status),updated_at=now()
  where id=v.id;
  if p_teacher_notes is not null then
    insert into public.teacher_session_notes(class_session_id,teacher_id,content) values(v.id,app_private.current_user_id(),left(p_teacher_notes,10000))
    on conflict(class_session_id,teacher_id) do update set content=excluded.content,updated_at=now();
  end if;
  if p_status='cancelled' and v.status<>'cancelled' then
    insert into app_private.notification_outbox(recipient_user_id,channel,event_type,payload,idempotency_key)
      select gm.student_id,'telegram','class_cancelled',jsonb_build_object('classSessionId',v.id,'startsAt',v.scheduled_start),
        'class-cancelled:'||v.id||':'||gm.student_id
      from public.group_memberships gm where gm.group_id=v.group_id and gm.status='active'
      on conflict(idempotency_key) do nothing;
  end if;
end $$;

create function public.publish_homework(p_homework_id uuid,p_publish_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare v public.homework%rowtype; begin
  select * into v from public.homework where id=p_homework_id for update;
  if v.id is null or not (app_private.teacher_has_group(v.group_id) or app_private.is_admin()) then raise exception 'homework unavailable' using errcode='42501'; end if;
  if v.status<>'draft' then raise exception 'only draft homework can be published'; end if;
  if v.due_at is not null and v.due_at<=p_publish_at then raise exception 'deadline must follow publish time'; end if;
  update public.homework set status='published',publish_at=p_publish_at,updated_at=now() where id=v.id;
  insert into app_private.notification_outbox(recipient_user_id,channel,event_type,payload,idempotency_key)
    select gm.student_id,'telegram','homework_published',jsonb_build_object('homeworkId',v.id,'title',v.title,'dueAt',v.due_at),
      'homework-published:'||v.id||':'||gm.student_id
    from public.group_memberships gm where gm.group_id=v.group_id and gm.status='active'
    on conflict(idempotency_key) do nothing;
end $$;

create function public.update_portfolio_project_as_teacher(p_item_id uuid,p_title text,p_description text,p_reflection text,p_learned text) returns void
language plpgsql security definer set search_path='' as $$
declare v_student uuid; begin
  select portfolio.student_id into v_student from public.portfolio_projects item join public.portfolios portfolio on portfolio.id=item.portfolio_id where item.id=p_item_id for update;
  if v_student is null or not (app_private.teacher_has_student(v_student) or app_private.is_admin()) then raise exception 'portfolio item unavailable' using errcode='42501'; end if;
  update public.portfolio_projects set title_override=coalesce(p_title,title_override),short_description=coalesce(p_description,short_description),reflection=coalesce(p_reflection,reflection),learned=coalesce(p_learned,learned),updated_at=now() where id=p_item_id;
end $$;

create function public.manage_mentor_booking(p_booking_id uuid,p_status text,p_meeting_url text,p_starts_at timestamptz,p_ends_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
declare v public.mentor_bookings%rowtype; begin
  select booking.* into v from public.mentor_bookings booking join public.mentors mentor on mentor.id=booking.mentor_id where booking.id=p_booking_id and (mentor.user_id=app_private.current_user_id() or app_private.is_admin()) for update of booking;
  if v.id is null then raise exception 'booking unavailable' using errcode='42501'; end if;
  if p_status not in ('confirmed','completed','cancelled','rescheduled','no_show') then raise exception 'invalid booking status'; end if;
  if p_meeting_url is not null and p_meeting_url!~*'^https://' then raise exception 'unsafe meeting url'; end if;
  if p_status='rescheduled' and (p_starts_at is null or p_ends_at is null or p_ends_at<=p_starts_at) then raise exception 'new booking time required'; end if;
  update public.mentor_bookings set status=p_status,meeting_url=coalesce(p_meeting_url,meeting_url),starts_at=case when p_status='rescheduled' then p_starts_at else starts_at end,ends_at=case when p_status='rescheduled' then p_ends_at else ends_at end,updated_at=now() where id=v.id;
end $$;

create function public.save_parent_report(p_report_id uuid,p_comment text,p_status text) returns void
language plpgsql security definer set search_path='' as $$
declare v_student uuid; begin
  if p_status not in ('draft','ready_for_review') then raise exception 'invalid report status'; end if;
  select student_id into v_student from public.parent_reports where id=p_report_id for update;
  if v_student is null or not (app_private.teacher_has_student(v_student) or app_private.is_admin()) then raise exception 'report unavailable' using errcode='42501'; end if;
  update public.parent_reports set teacher_comment=left(coalesce(p_comment,''),5000),status=p_status,approved_by=null,approved_at=null,updated_at=now() where id=p_report_id;
end $$;

create function public.approve_parent_report(p_report_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v public.parent_reports%rowtype; begin
  select * into v from public.parent_reports where id=p_report_id for update;
  if v.id is null or not (app_private.teacher_has_student(v.student_id) or app_private.is_admin()) then raise exception 'report unavailable' using errcode='42501'; end if;
  if v.status<>'ready_for_review' or char_length(trim(v.teacher_comment))=0 then raise exception 'report is not ready for approval'; end if;
  update public.parent_reports set status='approved',approved_by=app_private.current_user_id(),approved_at=now(),updated_at=now() where id=v.id;
  insert into app_private.notification_outbox(recipient_user_id,channel,event_type,payload,idempotency_key)
    select link.guardian_id,'telegram','parent_report_approved',jsonb_build_object('reportId',v.id,'studentId',v.student_id,'periodStart',v.period_start,'periodEnd',v.period_end),
      'parent-report:'||v.id||':'||link.guardian_id
    from public.guardian_student_links link where link.student_id=v.student_id and link.status='active'
    on conflict(idempotency_key) do nothing;
end $$;

create policy class_materials_teacher_insert on public.class_materials for insert to authenticated with check (
  created_by=app_private.current_user_id() and exists(select 1 from public.class_sessions cs where cs.id=class_materials.class_session_id and app_private.teacher_has_group(cs.group_id))
);
create policy homework_resources_teacher_insert on public.homework_resources for insert to authenticated with check (
  exists(select 1 from public.homework h where h.id=homework_resources.homework_id and app_private.teacher_has_group(h.group_id))
  or app_private.is_admin()
);
create policy mentor_availability_owner_write on public.mentor_availability for all to authenticated
  using (exists(select 1 from public.mentors m where m.id=mentor_availability.mentor_id and m.user_id=app_private.current_user_id()) or app_private.is_admin())
  with check (created_by=app_private.current_user_id() and (exists(select 1 from public.mentors m where m.id=mentor_availability.mentor_id and m.user_id=app_private.current_user_id()) or app_private.is_admin()));

create policy xp_events_teacher_read on public.xp_events for select to authenticated
  using (app_private.teacher_has_student(user_id) or app_private.is_admin());
create policy student_achievements_teacher_read on public.student_achievements for select to authenticated
  using (app_private.teacher_has_student(user_id) or app_private.is_admin());
create policy mentor_assignments_teacher_read on public.mentor_assignments for select to authenticated
  using (app_private.teacher_has_student(student_user_id) or app_private.is_admin());
create policy mentors_owner_read on public.mentors for select to authenticated
  using (user_id=app_private.current_user_id() or app_private.is_admin());
create policy mentor_bookings_teacher_student_read on public.mentor_bookings for select to authenticated
  using (app_private.teacher_has_student(student_id) or app_private.is_admin());

drop policy if exists parent_reports_teacher_update on public.parent_reports;

grant select,insert,update,delete on public.teacher_private_notes,public.teacher_session_notes to authenticated;
grant insert on public.class_materials,public.homework_resources,public.mentor_availability to authenticated;
revoke update on public.parent_reports from authenticated;
revoke all on function public.update_teacher_class(uuid,text,text,uuid,text,text,text,text),public.publish_homework(uuid,timestamptz),public.update_portfolio_project_as_teacher(uuid,text,text,text,text),public.manage_mentor_booking(uuid,text,text,timestamptz,timestamptz),public.save_parent_report(uuid,text,text),public.approve_parent_report(uuid) from public,anon;
grant execute on function public.update_teacher_class(uuid,text,text,uuid,text,text,text,text),public.publish_homework(uuid,timestamptz),public.update_portfolio_project_as_teacher(uuid,text,text,text,text),public.manage_mentor_booking(uuid,text,text,timestamptz,timestamptz),public.save_parent_report(uuid,text,text),public.approve_parent_report(uuid) to authenticated;

commit;
