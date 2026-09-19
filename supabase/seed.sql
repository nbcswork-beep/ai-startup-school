begin;

-- Operational data for the four-student pilot. Authentication identities are
-- deliberately bound outside Git; this file contains no Telegram IDs or passwords.

insert into public.levels(id,code,title,position,min_xp) values
('11000000-0000-4000-8000-000000000001','explorer','Explorer',1,0),
('11000000-0000-4000-8000-000000000002','maker','Maker',2,200),
('11000000-0000-4000-8000-000000000003','builder','Builder',3,400),
('11000000-0000-4000-8000-000000000004','creator','Creator',4,600),
('11000000-0000-4000-8000-000000000005','launcher','Launcher',5,900)
on conflict(id) do update set code=excluded.code,title=excluded.title,position=excluded.position,min_xp=excluded.min_xp;

insert into public.project_stages(id,code,title,position,default_completion_percent) values
('31000000-0000-4000-8000-000000000001','idea','Ідея',1,0),
('31000000-0000-4000-8000-000000000002','plan','План',2,25),
('31000000-0000-4000-8000-000000000003','prototype','Прототип',3,50),
('31000000-0000-4000-8000-000000000004','design','Дизайн',4,75),
('31000000-0000-4000-8000-000000000005','test','Тест',5,90),
('31000000-0000-4000-8000-000000000006','launch','Запуск',6,100)
on conflict(id) do update set code=excluded.code,title=excluded.title,position=excluded.position,default_completion_percent=excluded.default_completion_percent;

insert into public.courses(id,slug,title,description,status) values
('20000000-0000-4000-8000-000000000001','ai-startup-school','AI STARTUP SCHOOL','Від знайомства з AI до запуску власного продукту.','published')
on conflict(id) do update set slug=excluded.slug,title=excluded.title,description=excluded.description,status=excluded.status;
insert into public.modules(id,course_id,position,title,description,status) values
('21000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',1,'Маршрут творця','8 занять: AI, проблема, ідея, MVP, продукт, тестування та запуск.','published')
on conflict(id) do update set course_id=excluded.course_id,position=excluded.position,title=excluded.title,description=excluded.description,status=excluded.status;

insert into public.lessons(id,module_id,position,slug,title,summary,content,estimated_minutes,xp_reward,prerequisite_lesson_id,status) values
('22000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',1,'ai-tools','AI: знайомство з інструментами майбутнього','Досліди можливості AI та навчися перевіряти результат','{"conceptName":"AI-інструменти","nextStep":"Від запиту до майстер-промпту."}',90,80,null,'published'),
('22000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000001',2,'master-prompt','Як правильно працювати з AI: від запиту до майстер-промпту','Побудуй сильний діалог з AI та отримай майстер-промпт','{"conceptName":"Майстер-промпт","nextStep":"Шукаємо реальні проблеми."}',90,100,'22000000-0000-4000-8000-000000000001','published'),
('22000000-0000-4000-8000-000000000003','21000000-0000-4000-8000-000000000001',3,'problem-discovery','Бізнес починається з проблеми','Навчися помічати реальні труднощі людей','{"conceptName":"Problem discovery","nextStep":"Від проблеми до ідеї."}',90,120,'22000000-0000-4000-8000-000000000002','published'),
('22000000-0000-4000-8000-000000000004','21000000-0000-4000-8000-000000000001',4,'startup-idea','Від проблеми до ідеї стартапу','Визнач користувача, рішення та користь продукту','{"conceptName":"Ціннісна пропозиція","nextStep":"MVP та бренд."}',90,140,'22000000-0000-4000-8000-000000000003','published'),
('22000000-0000-4000-8000-000000000005','21000000-0000-4000-8000-000000000001',5,'mvp-brand','Від ідеї до MVP: створюємо бренд і концепцію','Сформуй назву, стиль, функції та майстер-промпт','{"conceptName":"MVP-концепція","nextStep":"Перша робоча версія."}',90,160,'22000000-0000-4000-8000-000000000004','published'),
('22000000-0000-4000-8000-000000000006','21000000-0000-4000-8000-000000000001',6,'build-with-ai','Створюємо власний продукт з AI','Збери першу версію сайту або Telegram-застосунку','{"conceptName":"AI-assisted build","nextStep":"Реальне тестування."}',90,180,'22000000-0000-4000-8000-000000000005','published'),
('22000000-0000-4000-8000-000000000007','21000000-0000-4000-8000-000000000001',7,'product-iteration','Від першої версії до готового продукту','Збери відгуки та визнач пріоритетні покращення','{"conceptName":"Product iteration","nextStep":"SEO та запуск."}',90,180,'22000000-0000-4000-8000-000000000006','published'),
('22000000-0000-4000-8000-000000000008','21000000-0000-4000-8000-000000000001',8,'seo-launch','Як зробити так, щоб твій продукт знайшли: SEO та запуск','Підготуй продукт до запуску та пошуку','{"conceptName":"SEO та запуск","nextStep":"Перші користувачі."}',90,200,'22000000-0000-4000-8000-000000000007','published')
on conflict(id) do update set module_id=excluded.module_id,position=excluded.position,slug=excluded.slug,title=excluded.title,summary=excluded.summary,content=excluded.content,estimated_minutes=excluded.estimated_minutes,xp_reward=excluded.xp_reward,prerequisite_lesson_id=excluded.prerequisite_lesson_id,status=excluded.status;

insert into public.achievements(id,code,title,description,artifact_style_key,is_published) values
('50000000-0000-4000-8000-000000000001','first-spark','First Spark','Перша завершена ідея','spark',true),
('50000000-0000-4000-8000-000000000002','builder','Builder','Перші кроки MVP','build',true),
('50000000-0000-4000-8000-000000000003','ai-explorer','AI Explorer','Дослідження можливостей AI','explore',true),
('50000000-0000-4000-8000-000000000004','demo-day','Demo Day','Завершений запуск','locked',true)
on conflict(id) do update set code=excluded.code,title=excluded.title,description=excluded.description,artifact_style_key=excluded.artifact_style_key,is_published=excluded.is_published;

insert into public.users(id,kind,status) values
('10000000-0000-4000-8000-000000000001','student','active'),
('10000000-0000-4000-8000-000000000002','student','active'),
('10000000-0000-4000-8000-000000000003','student','active'),
('10000000-0000-4000-8000-000000000004','student','active'),
('12000000-0000-4000-8000-000000000001','admin','active'),
('12000000-0000-4000-8000-000000000002','teacher','active')
on conflict(id) do update set kind=excluded.kind,status=excluded.status;

insert into public.student_profiles(user_id,display_name,profile_display_name,locale,timezone,current_streak,longest_streak,level_id) values
('10000000-0000-4000-8000-000000000001','Анохін Ілля','Ілля','uk','Europe/Kyiv',0,0,'11000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000002','Максимчук Іван','Іван','uk','Europe/Kyiv',0,0,'11000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000003','Шамсетдінов Рінат','Рінат','uk','Europe/Kyiv',0,0,'11000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000004','Прохуренко Юлія','🐭💗 Мишка','uk','Europe/Kyiv',0,0,'11000000-0000-4000-8000-000000000001')
on conflict(user_id) do update set display_name=excluded.display_name,profile_display_name=excluded.profile_display_name,locale=excluded.locale,timezone=excluded.timezone,current_streak=excluded.current_streak,longest_streak=excluded.longest_streak,level_id=excluded.level_id;
insert into public.teacher_profiles(user_id,display_name,title,timezone,is_active) values
('12000000-0000-4000-8000-000000000001','Анохін Максим','Викладач · Ментор','Europe/Kyiv',true),
('12000000-0000-4000-8000-000000000002','Кривич Вадим','Викладач','Europe/Kyiv',true)
on conflict(user_id) do update set display_name=excluded.display_name,title=excluded.title,timezone=excluded.timezone,is_active=excluded.is_active;

insert into public.enrollments(id,user_id,course_id,current_lesson_id,status) values
('23000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','active'),
('23000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','active'),
('23000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','active'),
('23000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','active')
on conflict(id) do update set user_id=excluded.user_id,course_id=excluded.course_id,current_lesson_id=excluded.current_lesson_id,status=excluded.status,completed_at=null;

insert into public.groups(id,course_id,name,timezone,starts_on,ends_on,status,schedule_context) values
('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Пілотна група · 2026','Europe/Kyiv',current_date,current_date+56,'active','{"weekly":"Розклад уточнюється","durationMinutes":90}')
on conflict(id) do update set course_id=excluded.course_id,name=excluded.name,timezone=excluded.timezone,starts_on=excluded.starts_on,ends_on=excluded.ends_on,status=excluded.status,schedule_context=excluded.schedule_context;
insert into public.group_teachers(group_id,teacher_id,role) values
('70000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','lead_teacher'),
('70000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000002','teacher') on conflict do nothing;
insert into public.group_memberships(id,group_id,student_id,status) values
('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','active'),
('70000000-0000-4000-8000-000000000012','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002','active'),
('70000000-0000-4000-8000-000000000013','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000003','active'),
('70000000-0000-4000-8000-000000000014','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000004','active')
on conflict(id) do update set group_id=excluded.group_id,student_id=excluded.student_id,status=excluded.status,left_at=null;

-- The current schema requires a teacher_id. Максим is the initial owner; each
-- session remains reassignable through Teacher/Admin functionality.
insert into public.class_sessions(id,group_id,course_id,module_id,lesson_id,teacher_id,title,description,scheduled_start,scheduled_end,meeting_url,meeting_provider,status,created_by)
select
  ('71000000-0000-4000-8000-' || lpad(position::text,12,'0'))::uuid,
  '70000000-0000-4000-8000-000000000001'::uuid,
  '20000000-0000-4000-8000-000000000001'::uuid,
  '21000000-0000-4000-8000-000000000001'::uuid,
  id,
  '12000000-0000-4000-8000-000000000001'::uuid,
  title,
  'Живе заняття пілотної групи.',
  date_trunc('day',now()+((1+(position-1)*7)||' days')::interval)+interval '17 hours',
  date_trunc('day',now()+((1+(position-1)*7)||' days')::interval)+interval '18 hours 30 minutes',
  'https://meet.google.com/fcj-nfcv-umw','Google Meet','scheduled',
  '12000000-0000-4000-8000-000000000001'::uuid
from public.lessons where module_id='21000000-0000-4000-8000-000000000001' and position between 1 and 8
on conflict(id) do update set lesson_id=excluded.lesson_id,teacher_id=excluded.teacher_id,title=excluded.title,scheduled_start=excluded.scheduled_start,scheduled_end=excluded.scheduled_end,meeting_url=excluded.meeting_url,meeting_provider=excluded.meeting_provider,status=excluded.status;

insert into public.homework(id,course_id,module_id,lesson_id,class_session_id,group_id,title,instructions,publish_at,due_at,xp_reward,status,created_by) values
('73000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 1','Протестувати 3 різні AI-моделі на однаковому завданні та коротко порівняти результати.',now(),now()+interval '7 days',80,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002','71000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 2','Обрати реальну задачу, описати її AI своїми словами, через діалог отримати майстер-промпт та використати його.',now(),now()+interval '14 days',100,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 3','Знайти та записати 10 реальних проблем, з якими стикаються люди у повсякденному житті.',now(),now()+interval '21 days',120,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000004','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 4','Допрацювати обрану проблему та рішення: для кого створюється продукт, що він вирішує та чому ним будуть користуватися.',now(),now()+interval '28 days',140,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000005','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000005','71000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 5','Завершити MVP-концепцію та бренд: назва, логотип, стиль, основні функції та фінальний майстер-промпт для створення продукту.',now(),now()+interval '35 days',160,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000006','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000006','71000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 6','Допрацювати першу версію свого сайту або Telegram-застосунку та підготувати її до тестування.',now(),now()+interval '42 days',180,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000007','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000007','71000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000001','Домашнє завдання · заняття 7','Дати свій продукт протестувати мінімум 3 людям, зібрати відгуки та скласти список із 5 покращень.',now(),now()+interval '49 days',180,'published','12000000-0000-4000-8000-000000000001')
on conflict(id) do update set lesson_id=excluded.lesson_id,class_session_id=excluded.class_session_id,title=excluded.title,instructions=excluded.instructions,publish_at=excluded.publish_at,due_at=excluded.due_at,xp_reward=excluded.xp_reward,status=excluded.status;

insert into public.mentors(id,user_id,display_name,title,timezone,is_active) values
('60000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','Анохін Максим','Ментор','Europe/Kyiv',true)
on conflict(id) do update set user_id=excluded.user_id,display_name=excluded.display_name,title=excluded.title,timezone=excluded.timezone,is_active=excluded.is_active;
insert into public.mentor_assignments(id,student_user_id,mentor_id) values
('61000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001'),
('61000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001'),
('61000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000001'),
('61000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','60000000-0000-4000-8000-000000000001')
on conflict(id) do update set student_user_id=excluded.student_user_id,mentor_id=excluded.mentor_id,ends_at=null;

insert into public.portfolios(id,student_id,title,visibility) values
('81000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Моє портфоліо','private'),
('81000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Моє портфоліо','private'),
('81000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','Моє портфоліо','private'),
('81000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000004','Моє портфоліо','private')
on conflict(id) do update set student_id=excluded.student_id,title=excluded.title,visibility=excluded.visibility,share_token_hash=null;

commit;
