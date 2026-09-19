begin;

alter table public.users drop constraint if exists users_status_check;
alter table public.users add constraint users_status_check check (status in ('active','disabled','archived','suspended','deleted'));

do $$ declare constraint_name text; begin
  for constraint_name in select conname from pg_constraint where conrelid='public.portfolios'::regclass and contype='c' and pg_get_constraintdef(oid) ilike '%visibility%'
  loop execute format('alter table public.portfolios drop constraint %I',constraint_name); end loop;
end $$;
update public.portfolios set visibility='shareable' where visibility='shared';
alter table public.portfolios add constraint portfolios_visibility_check check (visibility in ('private','shareable','public'));
alter table public.portfolios add constraint portfolios_share_state_check check (
  (visibility='private' and share_token_hash is null) or (visibility in ('shareable','public') and share_token_hash is not null)
);

create table app_private.admin_audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  action text not null check (char_length(action) between 3 and 120),
  target_type text not null check (char_length(target_type) between 2 and 80),
  target_id text not null check (char_length(target_id) between 1 and 200),
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata)='object'),
  correlation_id text not null check (char_length(correlation_id) between 1 and 200),
  created_at timestamptz not null default now()
);

create table app_private.security_events (
  id uuid primary key default gen_random_uuid(),
  event_type text not null check (char_length(event_type) between 3 and 120),
  severity text not null check (severity in ('low','medium','high','critical')),
  actor_user_id uuid references public.users(id) on delete set null,
  target_user_id uuid references public.users(id) on delete set null,
  safe_metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(safe_metadata)='object'),
  correlation_id text not null check (char_length(correlation_id) between 1 and 200),
  created_at timestamptz not null default now()
);

create index admin_audit_events_created_idx on app_private.admin_audit_events(created_at desc);
create index admin_audit_events_target_idx on app_private.admin_audit_events(target_type,target_id,created_at desc);
create index security_events_created_idx on app_private.security_events(created_at desc);
alter table app_private.admin_audit_events enable row level security;
alter table app_private.security_events enable row level security;

create function app_private.assert_active_admin() returns uuid language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=app_private.current_user_id(); begin
  if not exists(select 1 from public.users where id=v_actor and kind='admin' and status='active') then
    raise exception 'admin authorization required' using errcode='42501';
  end if;
  return v_actor;
end $$;

create function app_private.write_admin_audit(p_action text,p_target_type text,p_target_id text,p_metadata jsonb,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=app_private.assert_active_admin(); begin
  insert into app_private.admin_audit_events(actor_user_id,action,target_type,target_id,safe_metadata,correlation_id)
  values(v_actor,left(p_action,120),left(p_target_type,80),left(p_target_id,200),coalesce(p_metadata,'{}'::jsonb)-array['password','token','secret','authorization','cookie','initData'],left(p_correlation_id,200));
end $$;

create function public.admin_set_account_status(p_user_id uuid,p_status text,p_reason text,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=app_private.assert_active_admin();v_previous text;begin
  if p_status not in ('active','disabled','archived') then raise exception 'invalid account status';end if;
  if v_actor=p_user_id and p_status<>'active' then raise exception 'admin self lockout denied';end if;
  select status into v_previous from public.users where id=p_user_id for update;
  if v_previous is null then raise exception 'user unavailable' using errcode='P0002';end if;
  update public.users set status=p_status,updated_at=now() where id=p_user_id;
  if p_status<>'active' then update app_private.auth_sessions set revoked_at=coalesce(revoked_at,now()) where user_id=p_user_id;end if;
  perform app_private.write_admin_audit('account.status_changed','user',p_user_id::text,jsonb_build_object('previous',v_previous,'status',p_status,'reason',left(p_reason,1000)),p_correlation_id);
end $$;

create function public.admin_correct_attendance(p_attendance_id uuid,p_status text,p_reason text,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=app_private.assert_active_admin();v_previous text;begin
  if p_status not in ('present','late','absent','excused') then raise exception 'invalid attendance status';end if;
  if char_length(trim(p_reason))<3 then raise exception 'correction reason required';end if;
  select status into v_previous from public.attendance where id=p_attendance_id for update;
  if v_previous is null then raise exception 'attendance unavailable' using errcode='P0002';end if;
  update public.attendance set status=p_status,confirmed_by=v_actor,confirmed_at=now(),updated_at=now() where id=p_attendance_id;
  perform app_private.write_admin_audit('attendance.corrected','attendance',p_attendance_id::text,jsonb_build_object('previous',v_previous,'status',p_status,'reason',left(p_reason,1000)),p_correlation_id);
end $$;

create function public.admin_set_portfolio_visibility(p_portfolio_id uuid,p_visibility text,p_reason text,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_previous text;begin
  perform app_private.assert_active_admin();
  if p_visibility not in ('private','shareable','public') then raise exception 'invalid portfolio visibility';end if;
  select visibility into v_previous from public.portfolios where id=p_portfolio_id for update;
  if v_previous is null then raise exception 'portfolio unavailable' using errcode='P0002';end if;
  update public.portfolios set visibility=p_visibility,share_token_hash=case when p_visibility='private' then null else coalesce(share_token_hash,encode(digest(gen_random_uuid()::text,'sha256'),'hex')) end,updated_at=now() where id=p_portfolio_id;
  perform app_private.write_admin_audit('portfolio.visibility_changed','portfolio',p_portfolio_id::text,jsonb_build_object('previous',v_previous,'visibility',p_visibility,'reason',left(p_reason,1000)),p_correlation_id);
end $$;

create function public.admin_revoke_guardian_link(p_link_id uuid,p_reason text,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform app_private.assert_active_admin();
  update public.guardian_student_links set status='revoked',revoked_at=now(),updated_at=now() where id=p_link_id and status<>'revoked';
  if not found then raise exception 'guardian relationship unavailable' using errcode='P0002';end if;
  perform app_private.write_admin_audit('guardian.relationship_revoked','guardian_link',p_link_id::text,jsonb_build_object('reason',left(p_reason,1000)),p_correlation_id);
end $$;

create function public.admin_resend_parent_report(p_report_id uuid,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_report public.parent_reports%rowtype;v_count integer:=0;begin
  perform app_private.assert_active_admin();select * into v_report from public.parent_reports where id=p_report_id for update;
  if v_report.id is null or v_report.status not in ('approved','sent','failed') then raise exception 'report is not eligible for resend';end if;
  insert into app_private.notification_outbox(recipient_user_id,channel,event_type,payload,idempotency_key)
    select gsl.guardian_id,'telegram','parent_weekly_report',jsonb_build_object('reportId',v_report.id,'studentId',v_report.student_id),'admin-report-resend:'||v_report.id||':'||gsl.guardian_id||':'||extract(epoch from clock_timestamp())::bigint
    from public.guardian_student_links gsl where gsl.student_id=v_report.student_id and gsl.status='active';
  get diagnostics v_count=row_count;if v_count=0 then raise exception 'active guardian relationship required';end if;
  perform app_private.write_admin_audit('report.resend_requested','parent_report',p_report_id::text,jsonb_build_object('recipients',v_count),p_correlation_id);
end $$;

create function public.admin_revoke_session(p_session_id uuid,p_reason text,p_correlation_id text) returns void
language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=app_private.assert_active_admin();v_target uuid;begin
  select user_id into v_target from app_private.auth_sessions where id=p_session_id for update;
  if v_target is null then raise exception 'session unavailable' using errcode='P0002';end if;
  update app_private.auth_sessions set revoked_at=coalesce(revoked_at,now()) where family_id=(select family_id from app_private.auth_sessions where id=p_session_id);
  perform app_private.write_admin_audit('session.revoked','auth_session',p_session_id::text,jsonb_build_object('targetUserId',v_target,'reason',left(p_reason,1000)),p_correlation_id);
  insert into app_private.security_events(event_type,severity,actor_user_id,target_user_id,safe_metadata,correlation_id) values('forced_session_revocation','medium',v_actor,v_target,jsonb_build_object('sessionId',p_session_id),left(p_correlation_id,200));
end $$;

do $$ declare table_name text;begin
  foreach table_name in array array['users','user_identities','student_profiles','teacher_profiles','guardian_profiles','levels','courses','modules','lessons','enrollments','lesson_progress','project_stages','projects','project_tasks','xp_events','achievements','student_achievements','mentors','mentor_assignments','groups','group_teachers','group_memberships','class_sessions','class_session_reschedules','file_assets','class_materials','attendance','homework','homework_resources','homework_submissions','submission_attachments','homework_reviews','homework_review_events','skills','project_skills','student_skills','portfolios','portfolio_projects','portfolio_project_skills','portfolio_project_media','mentor_availability','mentor_bookings','guardian_student_links','parent_reports'] loop
    execute format('drop policy if exists %I on public.%I',table_name||'_admin_read',table_name);
    execute format('create policy %I on public.%I for select to authenticated using (app_private.is_admin())',table_name||'_admin_read',table_name);
    execute format('grant select on public.%I to authenticated',table_name);
  end loop;
end $$;

revoke all on table app_private.admin_audit_events,app_private.security_events from public,anon,authenticated;
revoke all on function app_private.assert_active_admin(),app_private.write_admin_audit(text,text,text,jsonb,text),public.admin_set_account_status(uuid,text,text,text),public.admin_correct_attendance(uuid,text,text,text),public.admin_set_portfolio_visibility(uuid,text,text,text),public.admin_revoke_guardian_link(uuid,text,text),public.admin_resend_parent_report(uuid,text),public.admin_revoke_session(uuid,text,text) from public,anon;
grant execute on function public.admin_set_account_status(uuid,text,text,text),public.admin_correct_attendance(uuid,text,text,text),public.admin_set_portfolio_visibility(uuid,text,text,text),public.admin_revoke_guardian_link(uuid,text,text),public.admin_resend_parent_report(uuid,text),public.admin_revoke_session(uuid,text,text) to authenticated;

commit;
