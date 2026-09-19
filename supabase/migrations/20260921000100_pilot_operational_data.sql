begin;

alter table public.student_profiles
  add column if not exists profile_display_name text;

update public.student_profiles
set profile_display_name = display_name
where profile_display_name is null;

alter table public.student_profiles
  alter column profile_display_name set not null;

alter table public.student_profiles
  drop constraint if exists student_profiles_profile_display_name_check;

alter table public.student_profiles
  add constraint student_profiles_profile_display_name_check
  check (char_length(profile_display_name) between 1 and 60);

comment on column public.student_profiles.profile_display_name is
  'Student-facing profile name; display_name remains the private operational name for authorized staff.';

commit;
