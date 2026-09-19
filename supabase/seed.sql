begin;

insert into public.levels(id,code,title,position,min_xp) values
('11000000-0000-4000-8000-000000000001','explorer','Explorer',1,0),
('11000000-0000-4000-8000-000000000002','maker','Maker',2,200),
('11000000-0000-4000-8000-000000000003','builder','Builder',3,400),
('11000000-0000-4000-8000-000000000004','creator','Creator',4,600),
('11000000-0000-4000-8000-000000000005','launcher','Launcher',5,900) on conflict do nothing;

insert into public.project_stages(id,code,title,position,default_completion_percent) values
('31000000-0000-4000-8000-000000000001','problem','Проблема',1,0),
('31000000-0000-4000-8000-000000000002','concept','Концепт',2,25),
('31000000-0000-4000-8000-000000000003','prototype','Прототип',3,50),
('31000000-0000-4000-8000-000000000004','test','Тест',4,75),
('31000000-0000-4000-8000-000000000005','pitch','Пітч',5,90) on conflict do nothing;

insert into public.courses(id,slug,title,description,status) values
('20000000-0000-4000-8000-000000000001','ai-foundations','AI Foundations','Думай разом з AI, став правильні питання й перевіряй результат.','published') on conflict do nothing;
insert into public.modules(id,course_id,position,title,description,status) values
('21000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',1,'AI Foundations','Від першого запиту до перевіреного MVP.','published') on conflict do nothing;

insert into public.lessons(id,module_id,position,slug,title,summary,content,estimated_minutes,xp_reward,prerequisite_lesson_id,status) values
('22000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001',1,'ai-not-magic','AI — не магія','Розберися, що AI вміє насправді.','{"explanation":"AI знаходить закономірності у даних, але не знає все.","examples":["AI може скласти чернетку плану.","Кожен важливий факт треба перевіряти."],"task":{"prompt":"Назви одну задачу для AI й одну для власної перевірки.","hint":"Подумай про навчання або проєкт."},"conceptName":"Модель і прогноз","nextStep":"Навчимося формулювати кращі запити."}',12,80,null,'published'),
('22000000-0000-4000-8000-000000000002','21000000-0000-4000-8000-000000000001',2,'talk-to-ai','Як говорити з AI','Створи запит із контекстом, метою та форматом.','{"explanation":"Сильний запит пояснює контекст, результат і обмеження.","examples":["Скажи, для кого план і що важливо."],"task":{"prompt":"Перепиши запит «Допоможи з навчанням».","hint":"Додай предмет, час і формат."},"conceptName":"Контекстний промпт","nextStep":"Перевіримо переконливу відповідь."}',15,100,'22000000-0000-4000-8000-000000000001','published'),
('22000000-0000-4000-8000-000000000003','21000000-0000-4000-8000-000000000001',3,'ai-can-be-wrong','AI може помилятися','Навчись перевіряти відповіді.','{"explanation":"AI інколи вигадує факти. Впевнений тон не є доказом.","examples":["Перевір автора, дату та джерело.","Відокрем факти від припущень."],"task":{"prompt":"Склади чекліст із трьох кроків для перевірки AI.","hint":"Джерело, дата, порівняння."},"conceptName":"Верифікація","nextStep":"Перетворимо проблему на ідею."}',17,120,'22000000-0000-4000-8000-000000000002','published'),
('22000000-0000-4000-8000-000000000004','21000000-0000-4000-8000-000000000001',4,'problem-to-idea','Проблема → ідея','Знайди проблему, яку варто вирішувати.','{"explanation":"Продукт починається з конкретної проблеми конкретної людини.","examples":["Учні забувають дедлайни — конкретна проблема."],"task":{"prompt":"Опиши проблему одним реченням.","hint":"Не називай рішення."},"conceptName":"Problem statement","nextStep":"Зберемо найменше рішення."}',20,140,'22000000-0000-4000-8000-000000000003','published'),
('22000000-0000-4000-8000-000000000005','21000000-0000-4000-8000-000000000001',5,'first-mvp','Перший MVP','Вибери найменшу версію для перевірки.','{"explanation":"MVP — найменший експеримент, який дає корисну відповідь.","examples":["Клікабельний прототип перевіряє сценарій без коду."],"task":{"prompt":"Залиш одну дію та один результат.","hint":"Прибери зайві функції."},"conceptName":"Minimum Viable Product","nextStep":"Перевіримо прототип."}',22,160,'22000000-0000-4000-8000-000000000004','published'),
('22000000-0000-4000-8000-000000000006','21000000-0000-4000-8000-000000000001',6,'user-test','Тест із користувачем','Покажи прототип і слухай.','{"explanation":"Спостерігай і став відкриті питання.","examples":["Що ти очікував побачити?"],"task":{"prompt":"Напиши три питання для тесту.","hint":"Уникай відповідей так або ні."},"conceptName":"User test","nextStep":"Поліпшимо продукт."}',18,160,'22000000-0000-4000-8000-000000000005','published'),
('22000000-0000-4000-8000-000000000007','21000000-0000-4000-8000-000000000001',7,'iteration','Ітерація продукту','Перетвори фідбек на нову версію.','{"explanation":"Шукай повторювані проблеми.","examples":["Три однакові труднощі важливіші за випадкову пораду."],"task":{"prompt":"Розділи фідбек на три групи.","hint":"Зараз, перевірити, відкласти."},"conceptName":"Ітерація","nextStep":"Підготуємо історію продукту."}',16,180,'22000000-0000-4000-8000-000000000006','published'),
('22000000-0000-4000-8000-000000000008','21000000-0000-4000-8000-000000000001',8,'pitch','Пітч і наступний крок','Поясни проблему, рішення і доказ.','{"explanation":"Пітч показує людину, проблему, рішення і перевірку.","examples":["Почни із ситуації, а не технологій."],"task":{"prompt":"Склади пітч із чотирьох речень.","hint":"Хто → проблема → рішення → доказ."},"conceptName":"Product story","nextStep":"Почни новий цикл."}',20,200,'22000000-0000-4000-8000-000000000007','published') on conflict do nothing;

insert into public.achievements(id,code,title,description,artifact_style_key,is_published) values
('50000000-0000-4000-8000-000000000001','first-spark','First Spark','Перша завершена ідея','spark',true),
('50000000-0000-4000-8000-000000000002','builder','Builder','Перші кроки MVP','build',true),
('50000000-0000-4000-8000-000000000003','ai-explorer','AI Explorer','Діалог з AI ментором','explore',true),
('50000000-0000-4000-8000-000000000004','demo-day','Demo Day','Завершений пітч','locked',true) on conflict do nothing;

insert into public.users(id) values('10000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.student_profiles(user_id,display_name,locale,current_streak,longest_streak,level_id) values
('10000000-0000-4000-8000-000000000001','Максим','uk',4,4,'11000000-0000-4000-8000-000000000004') on conflict do nothing;
insert into public.enrollments(id,user_id,course_id,current_lesson_id) values
('23000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003') on conflict do nothing;
insert into public.lesson_progress(enrollment_id,lesson_id,status,progress_percent,started_at,completed_at) values
('23000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000001','completed',100,now()-interval '7 days',now()-interval '6 days'),
('23000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002','completed',100,now()-interval '5 days',now()-interval '4 days'),
('23000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','in_progress',36,now()-interval '1 day',null) on conflict do nothing;
insert into public.xp_events(user_id,delta,event_type,idempotency_key,description) values
('10000000-0000-4000-8000-000000000001',640,'seed','seed:xp','Development starting XP') on conflict do nothing;
insert into public.projects(id,user_id,enrollment_id,title,summary,stage_id,completion_percent,tags) values
('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','23000000-0000-4000-8000-000000000001','Smart Study Planner','AI-помічник для навчання без хаосу.','31000000-0000-4000-8000-000000000003',62,array['AI','WEB','EDUCATION']) on conflict do nothing;
insert into public.project_tasks(id,project_id,stage_id,position,title,description,status,xp_reward,weight,completed_at) values
('32000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000001',1,'Сформулювати проблему','Хто має проблему і що заважає?','completed',80,30,now()-interval '5 days'),
('32000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000002',2,'Описати користувача','Для кого ми створюємо рішення?','completed',100,32,now()-interval '3 days'),
('32000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000003',3,'Зібрати перший прототип','Покажи головний сценарій.','in_progress',160,18,null),
('32000000-0000-4000-8000-000000000004','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000004',4,'Показати 3 людям','Збери чесний зворотний зв’язок.','locked',180,10,null),
('32000000-0000-4000-8000-000000000005','30000000-0000-4000-8000-000000000001','31000000-0000-4000-8000-000000000005',5,'Підготувати пітч','Поясни проблему, рішення та доказ.','locked',200,10,null) on conflict do nothing;
insert into public.mentors(id,display_name,title) values('60000000-0000-4000-8000-000000000001','Анна','Product mentor') on conflict do nothing;
insert into public.mentor_assignments(id,student_user_id,mentor_id) values('61000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.ai_conversations(id,user_id,course_id,lesson_id,project_id,title) values
('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','30000000-0000-4000-8000-000000000001','Smart Study Planner') on conflict do nothing;
insert into public.ai_messages(id,conversation_id,role,content) values
('41000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','assistant','Привіт, Максим! Бачу, ти збираєш Smart Study Planner. З чого почнемо?') on conflict do nothing;
insert into app_private.ai_conversation_state(conversation_id) values('40000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.student_achievements(user_id,achievement_id) values
('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001'),
('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000002'),
('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003') on conflict do nothing;

update public.courses set title='Основи роботи з AI' where id='20000000-0000-4000-8000-000000000001';
update public.modules set title='Основи роботи з AI' where id='21000000-0000-4000-8000-000000000001';
update public.lessons l set title=v.title from (values
(1,'Знайомство з AI'),(2,'Як працювати з AI'),(3,'Як перевіряти відповіді AI'),(4,'Від проблеми до ідеї'),(5,'Плануємо свій проєкт'),
(6,'Створюємо першу версію'),(7,'Працюємо з кодом через AI'),(8,'Основи дизайну продукту')) as v(position,title)
where l.module_id='21000000-0000-4000-8000-000000000001' and l.position=v.position;
insert into public.lessons(id,module_id,position,slug,title,summary,content,estimated_minutes,xp_reward,prerequisite_lesson_id,status) values
('22000000-0000-4000-8000-000000000009','21000000-0000-4000-8000-000000000001',9,'test-and-improve','Тестуємо та покращуємо','Перевір продукт із користувачем і визнач наступну зміну.','{"explanation":"Тестування показує, де реальна поведінка відрізняється від наших припущень.","examples":["Спостерігай за діями та не підказуй правильний шлях."],"task":{"prompt":"Проведи короткий тест і запиши один сигнал для покращення.","hint":"Фіксуй те, що побачив."},"conceptName":"Цикл перевірки","nextStep":"Підготуємо презентацію проєкту."}',18,180,'22000000-0000-4000-8000-000000000008','published'),
('22000000-0000-4000-8000-000000000010','21000000-0000-4000-8000-000000000001',10,'present-project','Презентуємо свій проєкт','Поясни проблему, рішення, перевірку і наступний крок.','{"explanation":"Сильна презентація показує шлях від проблеми до створеного результату.","examples":["Почни з людини та її ситуації."],"task":{"prompt":"Склади пітч із чотирьох речень.","hint":"Хто → проблема → рішення → доказ."},"conceptName":"Product story","nextStep":"Додай проєкт до портфоліо."}',20,200,'22000000-0000-4000-8000-000000000009','published') on conflict do nothing;

update public.project_stages set code='idea',title='Ідея' where position=1;
update public.project_stages set code='plan',title='План' where position=2;
update public.project_stages set code='design',title='Дизайн' where position=4;
update public.project_stages set code='test',title='Тест' where position=5;
insert into public.project_stages(id,code,title,position,default_completion_percent) values ('31000000-0000-4000-8000-000000000006','launch','Запуск',6,100) on conflict do nothing;

insert into public.users(id,kind) values
('12000000-0000-4000-8000-000000000001','teacher'),
('13000000-0000-4000-8000-000000000001','guardian'),
('14000000-0000-4000-8000-000000000001','admin') on conflict(id) do update set kind=excluded.kind;
insert into public.teacher_profiles(user_id,display_name,title,timezone) values
('12000000-0000-4000-8000-000000000001','Анна Коваль','Викладачка та product mentor','Europe/Kyiv') on conflict do nothing;
insert into public.guardian_profiles(user_id,display_name,locale,timezone) values
('13000000-0000-4000-8000-000000000001','Олена','uk','Europe/Kyiv') on conflict do nothing;
update public.mentors set user_id='12000000-0000-4000-8000-000000000001',display_name='Анна Коваль',title='Product mentor',timezone='Europe/Kyiv' where id='60000000-0000-4000-8000-000000000001';

insert into public.groups(id,course_id,name,timezone,starts_on,ends_on,status,schedule_context) values
('70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','Creators · Осінь 2026','Europe/Kyiv',current_date-14,current_date+70,'active','{"weekly":"Вівторок і субота · 17:00","durationMinutes":90}') on conflict do nothing;
insert into public.group_teachers(group_id,teacher_id,role) values
('70000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001','lead_teacher') on conflict do nothing;
insert into public.group_memberships(id,group_id,student_id,status) values
('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','active') on conflict do nothing;

insert into public.class_sessions(id,group_id,course_id,module_id,lesson_id,teacher_id,title,description,scheduled_start,scheduled_end,meeting_url,meeting_provider,status,created_by) values
('71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','12000000-0000-4000-8000-000000000001','Як перевіряти відповіді AI','Живе заняття: джерела, факти та перевірка припущень.',date_trunc('day',now()+interval '1 day')+interval '17 hours',date_trunc('day',now()+interval '1 day')+interval '18 hours 30 minutes','https://meet.google.com/abc-defg-hij','Google Meet','scheduled','12000000-0000-4000-8000-000000000001'),
('71000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000004','12000000-0000-4000-8000-000000000001','Від проблеми до ідеї','Знаходимо проблему, яку варто вирішувати.',date_trunc('day',now()+interval '4 days')+interval '17 hours',date_trunc('day',now()+interval '4 days')+interval '18 hours 30 minutes','https://meet.google.com/abc-defg-hij','Google Meet','rescheduled','12000000-0000-4000-8000-000000000001'),
('71000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001','Як працювати з AI','Контекст, мета та формат сильного запиту.',date_trunc('day',now()-interval '3 days')+interval '17 hours',date_trunc('day',now()-interval '3 days')+interval '18 hours 30 minutes','https://meet.google.com/abc-defg-hij','Google Meet','completed','12000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.class_materials(id,class_session_id,kind,title,external_url,position,created_by) values
('72000000-0000-4000-8000-000000000001','71000000-0000-4000-8000-000000000001','presentation','Презентація заняття','https://example.com/materials/ai-verification',1,'12000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.attendance(id,class_session_id,student_id,status,confirmed_by,confirmed_at,note) values
('72000000-0000-4000-8000-000000000011','71000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','present','12000000-0000-4000-8000-000000000001',now()-interval '3 days','Активно працював у практичній частині.') on conflict do nothing;

insert into public.homework(id,course_id,module_id,lesson_id,class_session_id,group_id,title,instructions,publish_at,due_at,xp_reward,status,created_by) values
('73000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000003','71000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','Перевір відповідь AI','Обери відповідь AI, знайди два джерела та поясни висновок.',now()-interval '5 days',now()-interval '2 days',80,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000004','71000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000001','План твого проєкту','Опиши проблему, користувача, рішення та одну перевірку.',now()-interval '2 days',now()+interval '2 days',120,'published','12000000-0000-4000-8000-000000000001'),
('73000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000001','21000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000006',null,'70000000-0000-4000-8000-000000000001','Підготуй перший прототип','Збери один головний сценарій та додай посилання або скриншот.',now(),now()+interval '6 days',160,'published','12000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.homework_submissions(id,homework_id,student_id,attempt_number,submitted_at,student_comment,content_text,content_url,status) values
('74000000-0000-4000-8000-000000000001','73000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',1,now()-interval '3 days','Перевірив джерела та додав пояснення.','Чекліст перевірки відповіді AI',null,'completed'),
('74000000-0000-4000-8000-000000000002','73000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001',1,now()-interval '1 day','Це перша версія плану.','План Smart Study Planner','https://example.com/smart-study-plan','needs_revision') on conflict do nothing;
insert into public.homework_reviews(id,submission_id,reviewer_id,score,effort,status,feedback,reviewed_at) values
('75000000-0000-4000-8000-000000000001','74000000-0000-4000-8000-000000000001','12000000-0000-4000-8000-000000000001',9,'high_effort','completed','Сильна перевірка джерел. Продовжуй пояснювати, чому джерело надійне.',now()-interval '2 days'),
('75000000-0000-4000-8000-000000000002','74000000-0000-4000-8000-000000000002','12000000-0000-4000-8000-000000000001',6,'high_effort','needs_revision','Зусилля видно. Додай одну конкретну перевірку для головного припущення.',now()) on conflict do nothing;

insert into public.skills(id,code,title) values
('80000000-0000-4000-8000-000000000001','ai','AI'),('80000000-0000-4000-8000-000000000002','prompting','Prompting'),('80000000-0000-4000-8000-000000000003','critical-thinking','Критичне мислення'),('80000000-0000-4000-8000-000000000004','html','HTML'),('80000000-0000-4000-8000-000000000005','css','CSS'),('80000000-0000-4000-8000-000000000006','javascript','JavaScript'),('80000000-0000-4000-8000-000000000007','design','Дизайн'),('80000000-0000-4000-8000-000000000008','ux','UX'),('80000000-0000-4000-8000-000000000009','product-thinking','Продуктове мислення'),('80000000-0000-4000-8000-000000000010','presentation','Презентація') on conflict do nothing;
insert into public.student_skills(student_id,skill_id,level,evidence_count) values
('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001',3,4),('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000003',2,3),('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000009',2,2),('10000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000010',1,1) on conflict do nothing;
update public.projects set problem='Учні губляться між уроками, дедлайнами та власними планами.',target_user='Учні 11–15 років',solution='Один зрозумілий AI-планувальник навчання.',project_type='ai_assistant',technologies=array['HTML','CSS','JavaScript'],demo_url=null where id='30000000-0000-4000-8000-000000000001';
insert into public.portfolios(id,student_id,title) values ('81000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Моє портфоліо') on conflict do nothing;
insert into public.portfolio_projects(id,portfolio_id,project_id,short_description,reflection,learned,technologies,position) values
('82000000-0000-4000-8000-000000000001','81000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','AI-помічник, що допомагає планувати навчання без хаосу.','Я навчився починати з проблеми, а не з функцій.','Перевіряти припущення, будувати прототип і слухати користувача.',array['HTML','CSS','JavaScript'],1) on conflict do nothing;
insert into public.portfolio_project_skills(portfolio_project_id,skill_id) values
('82000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001'),('82000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000008'),('82000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000009') on conflict do nothing;

insert into public.mentor_availability(id,mentor_id,starts_at,ends_at,timezone,status,created_by) values
('91000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001',date_trunc('day',now()+interval '2 days')+interval '18 hours',date_trunc('day',now()+interval '2 days')+interval '18 hours 30 minutes','Europe/Kyiv','open','12000000-0000-4000-8000-000000000001'),
('91000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000001',date_trunc('day',now()+interval '5 days')+interval '16 hours',date_trunc('day',now()+interval '5 days')+interval '16 hours 30 minutes','Europe/Kyiv','open','12000000-0000-4000-8000-000000000001') on conflict do nothing;
insert into public.guardian_student_links(id,guardian_id,student_id,status,invited_by,activated_at) values
('92000000-0000-4000-8000-000000000001','13000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','active','12000000-0000-4000-8000-000000000001',now()) on conflict do nothing;
insert into public.parent_reports(id,student_id,period_start,period_end,payload,teacher_comment,status,created_by) values
('93000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',current_date-7,current_date-1,'{"classesScheduled":2,"classesAttended":2,"attendance":{"present":2,"late":0,"absent":0,"excused":0},"homeworkAssigned":2,"homeworkSubmitted":2,"homeworkReviewed":2,"scores":[9,6],"effort":{"high":2},"project":"Smart Study Planner","projectProgress":62,"xpEarned":120,"level":"Creator","newAchievements":[],"portfolioMilestone":"Smart Study Planner додано до приватного портфоліо"}','Максим уважно працював із джерелами й наполегливо допрацьовує план проєкту.','draft','12000000-0000-4000-8000-000000000001') on conflict do nothing;

commit;
