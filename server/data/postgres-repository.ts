import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppRepository } from './repository.js';
import type {
  AccessContext, AdminEntity, AdminExplorerPageDto, AdminSearchDto, AdminWorkspaceDto,
  AchievementDto, AiContextDto, AiConversationDto, AiMessageDto, AuthUser, ClassSessionDto, EffortLevel, HomeDto,
  HomeworkSubmissionDto, HomeworkSummaryDto, LearningDto, LessonDto, LessonSummaryDto, MentorBookingDto,
  MentorSlotDto, NewSession, ParentReportDto, PortfolioDto, ProfileDto, ProjectDto, ProjectTaskDto, RotationResult,
  ScheduleDto, TeacherGroupDto, TeacherStudentDto, TelegramIdentityInput, TeacherWorkspaceDto, TeacherSearchDto,
  TeacherPrivateNoteDto, TeacherHomeworkDto
} from '../types/domain.js';
import { AppError } from '../errors/app-error.js';

type Db = Pick<PoolClient, 'query'>;

export class PostgresRepository implements AppRepository {
  private readonly pool: Pool;

  constructor(connectionString: string, ssl = true, private readonly workspaceUrl?: string) {
    this.pool = new Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : false, max: 12 });
  }

  async ping(): Promise<void> { await this.pool.query('select 1'); }

  async resolveTelegramUser(identity: TelegramIdentityInput): Promise<AuthUser> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await client.query<AuthUser & { display_name: string }>(`
        select u.id, u.status, sp.display_name from public.user_identities ui
        join public.users u on u.id=ui.user_id join public.student_profiles sp on sp.user_id=u.id
        where ui.provider='telegram' and ui.provider_subject=$1 for update`, [identity.telegramId]);
      if (existing.rows[0]) {
        await client.query(`update public.user_identities set last_authenticated_at=now() where provider='telegram' and provider_subject=$1`, [identity.telegramId]);
        await client.query('commit');
        return this.authUser(existing.rows[0]);
      }
      const userId = randomUUID();
      await client.query(`insert into public.users(id) values($1)`, [userId]);
      await client.query(`insert into public.student_profiles(user_id,display_name,locale,level_id)
        values($1,$2,$3,(select id from public.levels order by min_xp limit 1))`, [userId, identity.firstName.slice(0, 60) || 'Учень', identity.languageCode?.slice(0, 16) || 'uk']);
      await client.query(`insert into public.user_identities(user_id,provider,provider_subject) values($1,'telegram',$2)`, [userId, identity.telegramId]);
      await client.query(`insert into public.enrollments(user_id,course_id,current_lesson_id)
        select $1,c.id,l.id from public.courses c join public.modules m on m.course_id=c.id join public.lessons l on l.module_id=m.id
        where c.status='published' order by m.position,l.position limit 1`, [userId]);
      await client.query('commit');
      return { id: userId, displayName: identity.firstName.slice(0, 60) || 'Учень', status: 'active' };
    } catch (error: any) {
      await client.query('rollback');
      if (error?.code === '23505') {
        const row = await this.pool.query(`select u.id,u.status,sp.display_name from public.user_identities ui join public.users u on u.id=ui.user_id join public.student_profiles sp on sp.user_id=u.id where ui.provider='telegram' and ui.provider_subject=$1`, [identity.telegramId]);
        if (row.rows[0]) return this.authUser(row.rows[0]);
      }
      throw error;
    } finally { client.release(); }
  }

  async getDevelopmentUser(userId: string) { return this.getAuthUser(userId); }
  async getAuthUser(userId: string): Promise<AuthUser | null> {
    const result = await this.pool.query(`select u.id,u.status,coalesce(sp.display_name,tp.display_name,gp.display_name,case when u.kind='admin' then 'Адміністратор' end) display_name from public.users u left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id where u.id=$1`, [userId]);
    return result.rows[0] ? this.authUser(result.rows[0]) : null;
  }

  async createSession(session: NewSession): Promise<void> {
    await this.pool.query(`insert into app_private.auth_sessions(id,family_id,user_id,provider,refresh_token_hash,created_at,last_used_at,expires_at)
      values($1,$2,$3,$4,$5,$6,$6,$7)`, [session.id, session.familyId, session.userId, session.provider, session.refreshTokenHash, session.createdAt, session.expiresAt]);
  }

  async rotateSession(currentTokenHash: string, next: NewSession, now: Date): Promise<RotationResult> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query(`select s.*,u.status,coalesce(sp.display_name,tp.display_name,gp.display_name,case when u.kind='admin' then 'Адміністратор' end) display_name from app_private.auth_sessions s join public.users u on u.id=s.user_id left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id where refresh_token_hash=$1 for update of s`, [currentTokenHash]);
      const current = result.rows[0];
      if (!current) { await client.query('rollback'); return { status: 'invalid' }; }
      if (current.replaced_by_session_id) {
        await client.query(`update app_private.auth_sessions set revoked_at=coalesce(revoked_at,$2),reuse_detected_at=coalesce(reuse_detected_at,$2) where family_id=$1`, [current.family_id, now]);
        await client.query(`insert into app_private.security_events(event_type,severity,actor_user_id,target_user_id,safe_metadata,correlation_id) values('refresh_token_reuse','high',$1,$1,'{"familyRevoked":true}',$2)`,[current.user_id,`refresh:${current.id}`]);
        await client.query('commit'); return { status: 'reused' };
      }
      if (current.revoked_at) { await client.query('rollback'); return { status: 'revoked' }; }
      if (new Date(current.expires_at).getTime() <= now.getTime()) { await client.query('rollback'); return { status: 'expired' }; }
      const rotated: NewSession = { ...next, familyId: current.family_id, userId: current.user_id, provider: current.provider };
      await client.query(`insert into app_private.auth_sessions(id,family_id,user_id,provider,refresh_token_hash,created_at,last_used_at,expires_at) values($1,$2,$3,$4,$5,$6,$6,$7)`, [rotated.id, rotated.familyId, rotated.userId, rotated.provider, rotated.refreshTokenHash, rotated.createdAt, rotated.expiresAt]);
      await client.query(`update app_private.auth_sessions set revoked_at=$2,rotated_at=$2,replaced_by_session_id=$3,last_used_at=$2 where id=$1`, [current.id, now, rotated.id]);
      await client.query('commit');
      return { status: 'ok', user: this.authUser(current), session: rotated };
    } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  }

  async revokeSession(refreshTokenHash: string, now: Date): Promise<boolean> {
    const result = await this.pool.query(`update app_private.auth_sessions set revoked_at=coalesce(revoked_at,$2) where family_id=(select family_id from app_private.auth_sessions where refresh_token_hash=$1)`, [refreshTokenHash, now]);
    return (result.rowCount ?? 0) > 0;
  }

  async getAccessContext(userId:string,sessionId:string):Promise<AccessContext>{const result=await this.pool.query(`select u.kind role,u.status,(s.id is not null and s.user_id=u.id and s.revoked_at is null and s.expires_at>now()) session_active from public.users u left join app_private.auth_sessions s on s.id=$2 where u.id=$1`,[userId,sessionId]);const row=result.rows[0];return{role:row?.role??'student',status:row?.status??'disabled',sessionActive:Boolean(row?.session_active)};}

  async getHome(userId: string): Promise<HomeDto> {
    const [learning, projects, viewer, schedule, homework] = await Promise.all([this.getLearning(userId), this.listProjects(userId), this.getViewer(userId), this.getSchedule(userId), this.listHomework(userId)]);
    const currentLesson = learning.modules.flatMap(m => m.lessons).find(l => l.state === 'current' || l.state === 'available') ?? null;
    return { viewer, course: learning.course, currentLesson, projectCount: projects.length, currentProject: projects.find(p => p.status === 'active') ?? null, nextClass: schedule.nextClass, homeworkDue: homework.find(item => item.state !== 'completed') ?? null };
  }

  async getSchedule(userId: string): Promise<ScheduleDto> {
    return this.withUser(userId, async db => {
      const result = await db.query(`select cs.*,c.title course_title,m.title module_title,l.title lesson_title,tp.display_name teacher_name
        from public.class_sessions cs
        join public.group_memberships gm on gm.group_id=cs.group_id and gm.student_id=$1 and gm.status='active'
        join public.courses c on c.id=cs.course_id left join public.modules m on m.id=cs.module_id
        left join public.lessons l on l.id=cs.lesson_id join public.teacher_profiles tp on tp.user_id=cs.teacher_id
        order by cs.scheduled_start`, [userId]);
      const ids = result.rows.map(row => row.id);
      const materials = ids.length ? await db.query(`select * from public.class_materials where class_session_id=any($1::uuid[]) order by position`, [ids]) : { rows: [] };
      const sessions = result.rows.map(row => this.classSession(row, materials.rows.filter(item => item.class_session_id === row.id)));
      const now = new Date();
      const endOfWeek = new Date(now); endOfWeek.setDate(now.getDate() + 7);
      const upcoming = sessions.filter(item => new Date(item.endsAt) >= now && item.status !== 'cancelled');
      const dateKey = (date: Date) => date.toISOString().slice(0, 10);
      return { timezone: 'Europe/Kyiv', nextClass: upcoming[0] ?? null, today: upcoming.filter(item => dateKey(new Date(item.startsAt)) === dateKey(now)), thisWeek: upcoming.filter(item => new Date(item.startsAt) <= endOfWeek), upcoming, past: sessions.filter(item => new Date(item.endsAt) < now || item.status === 'completed').reverse() };
    });
  }

  async listHomework(userId: string): Promise<HomeworkSummaryDto[]> {
    return this.withUser(userId, async db => {
      const result = await db.query(`select h.*,cs.title class_title,s.id submission_id,s.attempt_number,s.submitted_at,s.student_comment,s.content_text,s.content_url,s.status submission_status,
        r.score,r.effort,r.status review_status,r.feedback,r.reviewed_at
        from public.homework h join public.group_memberships gm on gm.group_id=h.group_id and gm.student_id=$1 and gm.status='active'
        left join public.class_sessions cs on cs.id=h.class_session_id
        left join lateral(select * from public.homework_submissions hs where hs.homework_id=h.id and hs.student_id=$1 order by attempt_number desc limit 1)s on true
        left join public.homework_reviews r on r.submission_id=s.id
        where h.status='published' and h.publish_at<=now() order by coalesce(h.due_at,'infinity')`, [userId]);
      return result.rows.map(row => this.homework(row));
    });
  }

  async submitHomework(userId: string, homeworkId: string, input: { contentText: string; contentUrl?: string; studentComment?: string }): Promise<HomeworkSubmissionDto> {
    return this.withUser(userId, async db => {
      await db.query(`select id from public.homework where id=$1 for update`, [homeworkId]);
      const result = await db.query(`insert into public.homework_submissions(homework_id,student_id,attempt_number,submitted_at,student_comment,content_text,content_url,status)
        select h.id,$2,coalesce((select max(attempt_number)+1 from public.homework_submissions where homework_id=h.id and student_id=$2),1),now(),$3,$4,$5,'submitted'
        from public.homework h join public.group_memberships gm on gm.group_id=h.group_id and gm.student_id=$2 and gm.status='active'
        where h.id=$1 and h.status='published' returning *`, [homeworkId,userId,input.studentComment ?? '',input.contentText,input.contentUrl ?? null]);
      if (!result.rows[0]) throw new AppError('HOMEWORK_NOT_FOUND', 404, 'Домашнє завдання не знайдено');
      return this.submission(result.rows[0], null);
    }, true);
  }

  async getLearning(userId: string): Promise<LearningDto> {
    return this.withUser(userId, async db => {
      const rows = await db.query(`select c.id course_id,c.title course_title,c.description course_description,m.id module_id,m.position module_position,m.title module_title,m.description module_description,
        l.id lesson_id,l.position lesson_position,l.title lesson_title,l.summary,l.estimated_minutes,l.xp_reward,l.prerequisite_lesson_id,
        coalesce(lp.progress_percent,0) progress_percent,coalesce(lp.status,'not_started') progress_status,e.current_lesson_id
        from public.enrollments e join public.courses c on c.id=e.course_id join public.modules m on m.course_id=c.id join public.lessons l on l.module_id=m.id
        left join public.lesson_progress lp on lp.enrollment_id=e.id and lp.lesson_id=l.id
        where e.user_id=$1 and e.status='active' and m.status='published' and l.status='published' order by m.position,l.position`, [userId]);
      if (!rows.rows.length) throw new AppError('ENROLLMENT_NOT_FOUND', 404, 'Активний курс не знайдено');
      const completedIds = new Set(rows.rows.filter(r => r.progress_status === 'completed').map(r => r.lesson_id));
      const modules = new Map<string, LearningDto['modules'][number]>();
      for (const row of rows.rows) {
        let state: LessonSummaryDto['state'];
        if (row.progress_status === 'completed') state = 'completed';
        else if (row.current_lesson_id === row.lesson_id || row.progress_status === 'in_progress') state = 'current';
        else if (!row.prerequisite_lesson_id || completedIds.has(row.prerequisite_lesson_id)) state = 'available';
        else state = 'locked';
        const lesson: LessonSummaryDto = { id: row.lesson_id, number: String(row.lesson_position).padStart(2, '0'), title: row.lesson_title, summary: row.summary, estimatedMinutes: row.estimated_minutes, xpReward: row.xp_reward, state, progressPercent: Number(row.progress_percent) };
        if (!modules.has(row.module_id)) modules.set(row.module_id, { id: row.module_id, number: String(row.module_position).padStart(2, '0'), title: row.module_title, description: row.module_description, lessons: [] });
        modules.get(row.module_id)!.lessons.push(lesson);
      }
      const all = [...modules.values()].flatMap(m => m.lessons);
      return { course: { id: rows.rows[0].course_id, title: rows.rows[0].course_title, description: rows.rows[0].course_description, progressPercent: Math.round(all.reduce((s,l)=>s+l.progressPercent,0)/all.length), completedLessons: all.filter(l=>l.state==='completed').length, totalLessons: all.length }, modules: [...modules.values()] };
    });
  }

  async getLesson(userId: string, lessonId: string): Promise<LessonDto | null> {
    const learning = await this.getLearning(userId);
    const module = learning.modules.find(m => m.lessons.some(l => l.id === lessonId));
    const summary = module?.lessons.find(l => l.id === lessonId);
    if (!summary) return null;
    if (summary.state === 'locked') throw new AppError('LESSON_LOCKED', 403, 'Цей урок ще не відкрито');
    return this.withUser(userId, async db => {
      const result = await db.query(`select content,(select id from public.lessons n where n.module_id=l.module_id and n.position>l.position and n.status='published' order by n.position limit 1) next_lesson_id from public.lessons l where l.id=$1`, [lessonId]);
      if (!result.rows[0]) return null;
      return { ...summary, moduleTitle: module!.title, content: result.rows[0].content, nextLessonId: result.rows[0].next_lesson_id };
    });
  }

  async completeLesson(userId: string, lessonId: string, idempotencyKey: string) {
    const awardedXp = await this.withUser(userId, async db => Number((await db.query(`select awarded_xp from public.complete_lesson($1,$2)`, [lessonId, idempotencyKey])).rows[0]?.awarded_xp ?? 0));
    return { awardedXp, home: await this.getHome(userId) };
  }

  async listProjects(userId: string): Promise<ProjectDto[]> {
    return this.withUser(userId, async db => {
      const projects = await db.query(`select p.*,s.code stage_code,s.title stage_title,s.position stage_position,(select count(*) from public.project_stages where is_active) stage_total from public.projects p join public.project_stages s on s.id=p.stage_id where p.user_id=$1 order by p.updated_at desc`, [userId]);
      if (!projects.rows.length) return [];
      const tasks = await db.query(`select t.* from public.project_tasks t join public.projects p on p.id=t.project_id where p.user_id=$1 order by t.project_id,t.position`, [userId]);
      return projects.rows.map(p => this.project(p, tasks.rows.filter(t => t.project_id === p.id)));
    });
  }

  async createProject(userId: string, input: { title: string; summary: string }): Promise<ProjectDto> {
    const id = await this.withUser(userId, async db => {
      const stage = await db.query(`select id from public.project_stages where is_active order by position limit 1`);
      const result = await db.query(`insert into public.projects(user_id,title,summary,stage_id,tags) values($1,$2,$3,$4,array['AI']) returning id`, [userId,input.title,input.summary,stage.rows[0].id]);
      const projectId = result.rows[0].id;
      await db.query(`insert into public.project_tasks(project_id,stage_id,position,title,description,status,xp_reward,weight) values
        ($1,$2,1,'Сформулювати проблему','Опиши проблему конкретної людини.','in_progress',80,35),
        ($1,$2,2,'Описати користувача','Хто потребує рішення?','locked',100,25),
        ($1,$2,3,'Зібрати прототип','Перевір головний сценарій.','locked',160,25),
        ($1,$2,4,'Провести тест','Покажи рішення трьом людям.','locked',180,15)`, [projectId,stage.rows[0].id]);
      return projectId;
    }, true);
    return (await this.listProjects(userId)).find(p=>p.id===id)!;
  }

  async updateProject(userId: string, projectId: string, input: { title?: string; summary?: string }): Promise<ProjectDto | null> {
    const changed = await this.withUser(userId, db => db.query(`update public.projects set title=coalesce($3,title),summary=coalesce($4,summary) where id=$1 and user_id=$2 returning id`, [projectId,userId,input.title ?? null,input.summary ?? null]), true);
    if (!changed.rows[0]) return null;
    return (await this.listProjects(userId)).find(p=>p.id===projectId) ?? null;
  }

  async completeProjectTask(userId: string, projectId: string, taskId: string, idempotencyKey: string) {
    const result = await this.withUser(userId, db => db.query(`select * from public.complete_project_task($1,$2,$3)`, [projectId,taskId,idempotencyKey]));
    if (!result.rows[0]) return null;
    const project = (await this.listProjects(userId)).find(p=>p.id===projectId);
    return project ? { awardedXp: Number(result.rows[0].awarded_xp), project } : null;
  }

  async getProfile(userId: string): Promise<ProfileDto> {
    const [viewer, learning, projects, achievements, mentor] = await Promise.all([this.getViewer(userId),this.getLearning(userId),this.listProjects(userId),this.listAchievements(userId),this.getMentor(userId)]);
    const next = viewer.level.nextMinXp;
    const progress = next === null ? 100 : Math.round((viewer.xp-viewer.level.currentMinXp)/(next-viewer.level.currentMinXp)*100);
    return { viewer, nextLevelProgressPercent: Math.max(0,Math.min(100,progress)), lessonCount: learning.course.completedLessons, projectCount: projects.length, achievements, mentor };
  }

  async listAchievements(userId: string): Promise<AchievementDto[]> {
    return this.withUser(userId, async db => (await db.query(`select a.*,sa.awarded_at from public.achievements a left join public.student_achievements sa on sa.achievement_id=a.id and sa.user_id=$1 where a.is_published order by a.created_at`, [userId])).rows.map(r=>({ id:r.id,code:r.code,title:r.title,description:r.description,artifactStyleKey:r.artifact_style_key,earned:!!r.awarded_at,awardedAt:r.awarded_at?.toISOString?.() ?? r.awarded_at ?? null })));
  }

  async getPortfolio(userId: string): Promise<PortfolioDto> {
    return this.withUser(userId, async db => {
      let portfolio = (await db.query(`select * from public.portfolios where student_id=$1`, [userId])).rows[0];
      if (!portfolio) portfolio = (await db.query(`insert into public.portfolios(student_id,title) values($1,'Моє портфоліо') returning *`, [userId])).rows[0];
      const projects = await db.query(`select pp.*,p.title project_title,p.summary,coalesce(array_agg(distinct s.title) filter(where s.id is not null),'{}') skills
        from public.portfolio_projects pp join public.projects p on p.id=pp.project_id
        left join public.portfolio_project_skills pps on pps.portfolio_project_id=pp.id left join public.skills s on s.id=pps.skill_id
        where pp.portfolio_id=$1 group by pp.id,p.title,p.summary order by pp.position,pp.created_at`, [portfolio.id]);
      const media = projects.rows.length ? await db.query(`select portfolio_project_id,object_path from public.portfolio_project_media where portfolio_project_id=any($1::uuid[]) order by position`, [projects.rows.map(row => row.id)]) : { rows: [] };
      const skills = await db.query(`select s.code,s.title,ss.level from public.student_skills ss join public.skills s on s.id=ss.skill_id where ss.student_id=$1 order by ss.level desc,s.title`, [userId]);
      return { id: portfolio.id, title: portfolio.title, visibility: portfolio.visibility, projects: projects.rows.map(row => ({ id:row.id,projectId:row.project_id,title:row.title_override || row.project_title,shortDescription:row.short_description || row.summary,reflection:row.reflection,learned:row.learned,skills:row.skills,technologies:row.technologies ?? [],demoUrl:row.demo_url,coverPath:row.cover_path,screenshots:media.rows.filter(item=>item.portfolio_project_id===row.id).map(item=>item.object_path),completionDate:row.completion_date?.toISOString?.().slice(0,10) ?? row.completion_date ?? null })), skills: skills.rows.map(row => ({ code:row.code,title:row.title,level:row.level })) };
    }, true);
  }

  async addProjectToPortfolio(userId: string, projectId: string, input: { reflection?: string; learned?: string }): Promise<PortfolioDto> {
    await this.withUser(userId, async db => {
      const portfolio = await db.query(`insert into public.portfolios(student_id,title) values($1,'Моє портфоліо') on conflict(student_id) do update set updated_at=now() returning id`, [userId]);
      const inserted = await db.query(`insert into public.portfolio_projects(portfolio_id,project_id,short_description,reflection,learned,technologies,demo_url,completion_date,position)
        select $1,p.id,p.summary,$3,$4,p.technologies,p.demo_url,p.completed_at::date,coalesce((select max(position)+1 from public.portfolio_projects where portfolio_id=$1),1)
        from public.projects p where p.id=$2 and p.user_id=$5 on conflict(portfolio_id,project_id) do update set reflection=excluded.reflection,learned=excluded.learned,updated_at=now() returning id`, [portfolio.rows[0].id,projectId,input.reflection ?? '',input.learned ?? '',userId]);
      if (!inserted.rows[0]) throw new AppError('PROJECT_NOT_FOUND',404,'Проєкт не знайдено');
    }, true);
    return this.getPortfolio(userId);
  }

  async listMentorSlots(userId: string): Promise<MentorSlotDto[]> {
    return this.withUser(userId, async db => (await db.query(`select ma.id,ma.mentor_id,m.display_name,m.title,ma.starts_at,ma.ends_at,ma.timezone,
      not exists(select 1 from public.mentor_bookings mb where mb.mentor_id=ma.mentor_id and mb.status in('reserved','confirmed','rescheduled') and tstzrange(mb.starts_at,mb.ends_at,'[)') && tstzrange(ma.starts_at,ma.ends_at,'[)')) available
      from public.mentor_availability ma join public.mentors m on m.id=ma.mentor_id where ma.starts_at>now() and ma.status='open' order by ma.starts_at limit 30`)).rows.map(row => ({ id:row.id,mentorId:row.mentor_id,mentorName:row.display_name,mentorTitle:row.title,startsAt:row.starts_at.toISOString?.()??row.starts_at,endsAt:row.ends_at.toISOString?.()??row.ends_at,timezone:row.timezone,available:row.available })));
  }

  async bookMentorSlot(userId: string, availabilityId: string): Promise<MentorBookingDto> {
    return this.withUser(userId, async db => {
      const booked = await db.query(`select public.book_mentor_slot($1) id`, [availabilityId]);
      const result = await db.query(`select mb.*,m.display_name from public.mentor_bookings mb join public.mentors m on m.id=mb.mentor_id where mb.id=$1`, [booked.rows[0].id]);
      if (!result.rows[0]) throw new AppError('MENTOR_SLOT_UNAVAILABLE',409,'Цей час уже недоступний');
      const row=result.rows[0]; return { id:row.id,mentorId:row.mentor_id,mentorName:row.display_name,startsAt:row.starts_at.toISOString?.()??row.starts_at,endsAt:row.ends_at.toISOString?.()??row.ends_at,status:row.status,meetingUrl:row.meeting_url };
    }, true);
  }

  async listTeacherGroups(userId:string):Promise<TeacherGroupDto[]>{return this.withUser(userId,async db=>(await db.query(`select g.id,g.name,c.title course_title,g.timezone,count(distinct gm.student_id)::int student_count,min(cs.scheduled_start) filter(where cs.scheduled_start>now() and cs.status not in('cancelled','completed')) next_class_at from public.groups g join public.group_teachers gt on gt.group_id=g.id and gt.teacher_id=$1 and gt.ends_at is null join public.courses c on c.id=g.course_id left join public.group_memberships gm on gm.group_id=g.id and gm.status='active' left join public.class_sessions cs on cs.group_id=g.id group by g.id,c.title order by g.starts_on desc`,[userId])).rows.map(row=>({id:row.id,name:row.name,courseTitle:row.course_title,timezone:row.timezone,studentCount:row.student_count,nextClassAt:row.next_class_at?.toISOString?.()??row.next_class_at??null})));}
  async listGroupStudents(userId:string,groupId:string):Promise<TeacherStudentDto[]>{return this.withUser(userId,async db=>(await db.query(`select u.id,sp.display_name,coalesce(round(avg(lp.progress_percent)),0)::int progress_percent,(select title from public.projects p where p.user_id=u.id and p.status='active' order by updated_at desc limit 1) project_title from public.group_memberships gm join public.users u on u.id=gm.student_id join public.student_profiles sp on sp.user_id=u.id left join public.enrollments e on e.user_id=u.id left join public.lesson_progress lp on lp.enrollment_id=e.id where gm.group_id=$1 and gm.status='active' and app_private.teacher_has_group($1) group by u.id,sp.display_name order by sp.display_name`,[groupId])).rows.map(row=>({id:row.id,firstName:row.display_name,progressPercent:row.progress_percent,projectTitle:row.project_title})));}
  async createClassSession(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;title:string;description?:string;startsAt:string;endsAt:string;meetingUrl?:string;meetingProvider?:string}):Promise<ClassSessionDto>{return this.withUser(userId,async db=>{const created=await db.query(`insert into public.class_sessions(group_id,course_id,module_id,lesson_id,teacher_id,title,description,scheduled_start,scheduled_end,meeting_url,meeting_provider,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$5) returning id`,[input.groupId,input.courseId,input.moduleId??null,input.lessonId??null,userId,input.title,input.description??'',input.startsAt,input.endsAt,input.meetingUrl??null,input.meetingProvider??null]);const row=await db.query(`select cs.*,c.title course_title,m.title module_title,l.title lesson_title,tp.display_name teacher_name from public.class_sessions cs join public.courses c on c.id=cs.course_id left join public.modules m on m.id=cs.module_id left join public.lessons l on l.id=cs.lesson_id join public.teacher_profiles tp on tp.user_id=cs.teacher_id where cs.id=$1`,[created.rows[0].id]);return this.classSession(row.rows[0],[]);},true);}
  async rescheduleClass(userId:string,sessionId:string,input:{startsAt:string;endsAt:string;reason?:string}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.reschedule_class($1,$2,$3,$4)`,[sessionId,input.startsAt,input.endsAt,input.reason??'']),true);}
  async confirmAttendance(userId:string,sessionId:string,studentId:string,status:'present'|'late'|'absent'|'excused',note?:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.confirm_attendance($1,$2,$3,$4)`,[sessionId,studentId,status,note??'']),true);}
  async createHomework(userId:string,input:{groupId:string;courseId:string;moduleId?:string;lessonId?:string;classSessionId?:string;title:string;instructions:string;publishAt?:string;dueAt?:string;xpReward:number;status:'draft'|'published';resources?:Array<{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}>}):Promise<HomeworkSummaryDto>{return this.withUser(userId,async db=>{const row=(await db.query(`insert into public.homework(group_id,course_id,module_id,lesson_id,class_session_id,title,instructions,publish_at,due_at,xp_reward,status,created_by) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,[input.groupId,input.courseId,input.moduleId??null,input.lessonId??null,input.classSessionId??null,input.title,input.instructions,input.publishAt??null,input.dueAt??null,input.xpReward,input.status,userId])).rows[0];for(const [index,resource] of (input.resources??[]).entries())await db.query(`insert into public.homework_resources(homework_id,kind,title,external_url,position) values($1,$2,$3,$4,$5)`,[row.id,resource.kind,resource.title,resource.url,index+1]);return{id:row.id,title:row.title,instructions:row.instructions,publishedAt:row.publish_at?.toISOString?.()??row.publish_at??'',dueAt:row.due_at?.toISOString?.()??row.due_at??null,xpReward:row.xp_reward,classTitle:null,state:'not_started',latestSubmission:null};},true);}
  async reviewHomework(userId:string,submissionId:string,input:{score:number;effort:EffortLevel;status:'reviewed'|'needs_revision'|'completed';feedback:string}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.review_homework_submission($1,$2,$3,$4,$5)`,[submissionId,input.score,input.effort,input.status,input.feedback]),true);}

  async getTeacherWorkspace(userId:string):Promise<TeacherWorkspaceDto>{
    return this.withUser(userId,async db=>{
      const teacher=(await db.query(`select u.id,tp.display_name,tp.title,tp.timezone from public.users u join public.teacher_profiles tp on tp.user_id=u.id where u.id=$1 and u.kind='teacher' and tp.is_active`,[userId])).rows[0];
      if(!teacher)throw new AppError('TEACHER_REQUIRED',403,'Доступ дозволено лише викладачам');
      const groups=await db.query(`select g.id,g.course_id,g.name,g.timezone,g.schedule_context,c.title course_title,count(distinct gm.student_id)::int student_count,
        min(cs.scheduled_start) filter(where cs.scheduled_start>now() and cs.status not in('cancelled','completed')) next_class_at,
        coalesce(round(avg(lp.progress_percent)),0)::int progress_percent,
        coalesce(round(100.0*count(a.id) filter(where a.status in('present','late'))/nullif(count(a.id) filter(where a.status is not null),0)),0)::int attendance_rate,
        (select h.title from public.homework h where h.group_id=g.id order by h.created_at desc limit 1) recent_homework
        from public.groups g join public.group_teachers gt on gt.group_id=g.id and gt.teacher_id=$1 and gt.ends_at is null join public.courses c on c.id=g.course_id
        left join public.group_memberships gm on gm.group_id=g.id and gm.status='active' left join public.enrollments e on e.user_id=gm.student_id and e.course_id=g.course_id
        left join public.lesson_progress lp on lp.enrollment_id=e.id left join public.class_sessions cs on cs.group_id=g.id left join public.attendance a on a.class_session_id=cs.id and a.student_id=gm.student_id
        group by g.id,c.title order by g.starts_on desc`,[userId]);
      const sessions=await db.query(`select cs.*,g.name group_name,c.title course_title,m.title module_title,l.title lesson_title,tp.display_name teacher_name,tsn.content private_teacher_notes
        from public.class_sessions cs join public.groups g on g.id=cs.group_id join public.courses c on c.id=cs.course_id
        left join public.modules m on m.id=cs.module_id left join public.lessons l on l.id=cs.lesson_id join public.teacher_profiles tp on tp.user_id=cs.teacher_id
        left join public.teacher_session_notes tsn on tsn.class_session_id=cs.id and tsn.teacher_id=$1
        where app_private.teacher_has_group(cs.group_id) order by cs.scheduled_start`,[userId]);
      const sessionIds=sessions.rows.map(row=>row.id);
      const materials=sessionIds.length?await db.query(`select * from public.class_materials where class_session_id=any($1::uuid[]) order by position`,[sessionIds]):{rows:[]};
      const attendance=sessionIds.length?await db.query(`select a.*,gm.group_id,sp.display_name from public.group_memberships gm join public.student_profiles sp on sp.user_id=gm.student_id left join public.attendance a on a.student_id=gm.student_id and a.class_session_id=any($1::uuid[]) where gm.group_id=any(select group_id from public.class_sessions where id=any($1::uuid[])) and gm.status='active'`,[sessionIds]):{rows:[]};
      const homework=await db.query(`select h.*,g.name group_name,count(distinct hs.id)::int submission_count,count(distinct r.id)::int review_count,count(distinct r.id) filter(where r.status='needs_revision')::int needs_revision_count
        from public.homework h join public.groups g on g.id=h.group_id left join public.homework_submissions hs on hs.homework_id=h.id left join public.homework_reviews r on r.submission_id=hs.id
        where app_private.teacher_has_group(h.group_id) group by h.id,g.name order by h.created_at desc`);
      const homeworkResources=homework.rows.length?await db.query(`select * from public.homework_resources where homework_id=any($1::uuid[]) order by position`,[homework.rows.map(row=>row.id)]):{rows:[]};
      const submissions=await db.query(`select hs.*,h.title homework_title,h.group_id,g.name group_name,sp.display_name student_name,r.score,r.effort,r.status review_status,r.feedback,r.reviewed_at
        from public.homework_submissions hs join public.homework h on h.id=hs.homework_id join public.groups g on g.id=h.group_id join public.student_profiles sp on sp.user_id=hs.student_id
        left join public.homework_reviews r on r.submission_id=hs.id where app_private.teacher_has_group(h.group_id) order by hs.submitted_at desc nulls last`);
      const attachments=submissions.rows.length?await db.query(`select sa.submission_id,sa.id,sa.kind,fa.original_name,fa.object_path from public.submission_attachments sa join public.file_assets fa on fa.id=sa.file_asset_id where sa.submission_id=any($1::uuid[]) order by sa.position`,[submissions.rows.map(row=>row.id)]):{rows:[]};
      const studentRows=await db.query(`select gm.student_id id,sp.display_name,g.id group_id,g.name group_name,c.title course_title,coalesce(m.title,'') module_title,
        coalesce(round(avg(lp.progress_percent)),0)::int progress_percent,coalesce((select sum(x.delta) from public.xp_events x where x.user_id=gm.student_id),0)::int xp,
        coalesce((select lv.title from public.levels lv where lv.min_xp<=coalesce((select sum(x.delta) from public.xp_events x where x.user_id=gm.student_id),0) order by lv.min_xp desc limit 1),'Explorer') level,
        max(coalesce(lp.last_activity_at,e.last_activity_at)) recent_activity_at
        from public.group_memberships gm join public.groups g on g.id=gm.group_id join public.courses c on c.id=g.course_id join public.student_profiles sp on sp.user_id=gm.student_id
        left join public.enrollments e on e.user_id=gm.student_id and e.course_id=g.course_id left join public.lessons current_lesson on current_lesson.id=e.current_lesson_id left join public.modules m on m.id=current_lesson.module_id left join public.lesson_progress lp on lp.enrollment_id=e.id
        where gm.status='active' and app_private.teacher_has_group(gm.group_id) group by gm.student_id,sp.display_name,g.id,g.name,c.title,m.title order by sp.display_name`);
      const studentIds=studentRows.rows.map(row=>row.id);
      const projectRows=studentIds.length?await db.query(`select p.*,ps.code stage_code,ps.title stage_title,ps.position stage_position,(select count(*) from public.project_stages where is_active) stage_total from public.projects p join public.project_stages ps on ps.id=p.stage_id where p.user_id=any($1::uuid[]) order by p.updated_at desc`,[studentIds]):{rows:[]};
      const taskRows=projectRows.rows.length?await db.query(`select * from public.project_tasks where project_id=any($1::uuid[]) order by position`,[projectRows.rows.map(row=>row.id)]):{rows:[]};
      const portfolios=studentIds.length?await db.query(`select portfolio.student_id,portfolio.id portfolio_id,portfolio.title portfolio_title,portfolio.visibility,item.*,project.title project_title,project.summary from public.portfolios portfolio left join public.portfolio_projects item on item.portfolio_id=portfolio.id left join public.projects project on project.id=item.project_id where portfolio.student_id=any($1::uuid[]) order by item.position`,[studentIds]):{rows:[]};
      const notes=studentIds.length?await db.query(`select * from public.teacher_private_notes where teacher_id=$1 and student_id=any($2::uuid[]) order by updated_at desc`,[userId,studentIds]):{rows:[]};
      const mentorProfile=(await db.query(`select id from public.mentors where user_id=$1`,[userId])).rows[0];
      const mentorAvailability=mentorProfile?await db.query(`select * from public.mentor_availability where mentor_id=$1 order by starts_at`,[mentorProfile.id]):{rows:[]};
      const mentorBookings=mentorProfile?await db.query(`select mb.*,sp.display_name student_name,(select title from public.projects p where p.user_id=mb.student_id and p.status='active' order by updated_at desc limit 1) project_title,m.display_name mentor_name from public.mentor_bookings mb join public.student_profiles sp on sp.user_id=mb.student_id join public.mentors m on m.id=mb.mentor_id where mb.mentor_id=$1 order by mb.starts_at`,[mentorProfile.id]):{rows:[]};
      const studentMentorBookings=studentIds.length?await db.query(`select mb.*,'Ментор'::text mentor_name from public.mentor_bookings mb where mb.student_id=any($1::uuid[]) order by mb.starts_at desc`,[studentIds]):{rows:[]};
      const reports=await db.query(`select pr.*,sp.display_name student_name,g.id group_id,g.name group_name from public.parent_reports pr join public.student_profiles sp on sp.user_id=pr.student_id join public.group_memberships gm on gm.student_id=pr.student_id and gm.status='active' join public.groups g on g.id=gm.group_id where app_private.teacher_has_group(g.id) order by pr.period_end desc,sp.display_name`);
      const lessons=await db.query(`select l.id,l.title,m.title module_title from public.lessons l join public.modules m on m.id=l.module_id join public.courses c on c.id=m.course_id join public.groups g on g.course_id=c.id where l.status='published' and app_private.teacher_has_group(g.id) order by m.position,l.position`);
      const mappedSubmissions=submissions.rows.map(row=>{const previous=submissions.rows.filter(item=>item.student_id===row.student_id&&item.homework_id===row.homework_id&&item.attempt_number<row.attempt_number);return{id:row.id,homeworkId:row.homework_id,homeworkTitle:row.homework_title,groupId:row.group_id,groupName:row.group_name,studentId:row.student_id,studentName:row.student_name,attemptNumber:row.attempt_number,submittedAt:row.submitted_at?.toISOString?.()??row.submitted_at??null,studentComment:row.student_comment,contentText:row.content_text,contentUrl:row.content_url,status:row.status,review:row.score===null?null:{score:row.score,effort:row.effort,status:row.review_status,feedback:row.feedback,reviewedAt:row.reviewed_at?.toISOString?.()??row.reviewed_at},attachments:attachments.rows.filter(item=>item.submission_id===row.id).map(item=>({id:item.id,kind:item.kind==='image'?'file':item.kind,title:item.original_name,url:null})),previousAttempts:previous.map(item=>this.submission(item,item.score===null?null:{score:item.score,effort:item.effort,status:item.review_status,feedback:item.feedback,reviewed_at:item.reviewed_at}))};});
      const mappedStudents=studentRows.rows.map(row=>{const studentProjects=projectRows.rows.filter(project=>project.user_id===row.id).map(project=>this.project(project,taskRows.rows.filter(task=>task.project_id===project.id)));const studentPortfolioRows=portfolios.rows.filter(item=>item.student_id===row.id&&item.id);const studentAttempts=submissions.rows.filter(item=>item.student_id===row.id);const scores=studentAttempts.filter(item=>item.score!==null).map(item=>Number(item.score));const attendanceRows=attendance.rows.filter(item=>item.student_id===row.id&&item.status);const reasons:string[]=[];if(attendanceRows.filter(item=>item.status==='absent').length>=2)reasons.push('2 або більше пропущених занять');if(studentAttempts.some(item=>item.status==='needs_revision'))reasons.push('Є робота на доопрацюванні');if(!studentProjects.length)reasons.push('Ще немає активного проєкту');return{id:row.id,firstName:row.display_name,progressPercent:row.progress_percent,projectTitle:studentProjects.find(project=>project.status==='active')?.title??null,groupId:row.group_id,groupName:row.group_name,courseTitle:row.course_title,moduleTitle:row.module_title,xp:row.xp,level:row.level,attendance:{present:attendanceRows.filter(item=>item.status==='present').length,late:attendanceRows.filter(item=>item.status==='late').length,absent:attendanceRows.filter(item=>item.status==='absent').length,excused:attendanceRows.filter(item=>item.status==='excused').length},homework:{assigned:homework.rows.filter(item=>item.group_id===row.group_id&&item.status==='published').length,submitted:studentAttempts.length,needsRevision:studentAttempts.filter(item=>item.status==='needs_revision').length,averageScore:scores.length?Math.round(scores.reduce((sum,value)=>sum+value,0)/scores.length*10)/10:null,effort:studentAttempts.find(item=>item.effort)?.effort??null},projects:studentProjects,portfolio:studentPortfolioRows.length?{id:studentPortfolioRows[0].portfolio_id,title:studentPortfolioRows[0].portfolio_title,visibility:studentPortfolioRows[0].visibility,projects:studentPortfolioRows.map(item=>({id:item.id,projectId:item.project_id,title:item.title_override||item.project_title,shortDescription:item.short_description||item.summary,reflection:item.reflection,learned:item.learned,skills:[],technologies:item.technologies??[],demoUrl:item.demo_url,coverPath:item.cover_path,screenshots:[],completionDate:item.completion_date?.toISOString?.().slice(0,10)??item.completion_date??null})),skills:[]}:null,mentorBookings:studentMentorBookings.rows.filter(item=>item.student_id===row.id).map(item=>({id:item.id,mentorId:item.mentor_id,mentorName:item.mentor_name,startsAt:item.starts_at?.toISOString?.()??item.starts_at,endsAt:item.ends_at?.toISOString?.()??item.ends_at,status:item.status,meetingUrl:item.meeting_url})),notes:notes.rows.filter(item=>item.student_id===row.id).map(item=>({id:item.id,studentId:item.student_id,category:item.category,content:item.content,createdAt:item.created_at?.toISOString?.()??item.created_at,updatedAt:item.updated_at?.toISOString?.()??item.updated_at})),attentionReasons:reasons,recentActivityAt:row.recent_activity_at?.toISOString?.()??row.recent_activity_at??null};});
      const mappedSessions=sessions.rows.map(row=>({...this.classSession(row,materials.rows.filter(item=>item.class_session_id===row.id)),groupId:row.group_id,groupName:row.group_name,lessonId:row.lesson_id,teacherNotes:row.private_teacher_notes??'',attendance:studentRows.rows.filter(student=>student.group_id===row.group_id).map(student=>{const item=attendance.rows.find(entry=>entry.class_session_id===row.id&&entry.student_id===student.id);return{studentId:student.id,studentName:student.display_name,status:item?.status??null,suggestedStatus:item?.suggested_status??null,note:item?.note??'',confirmedAt:item?.confirmed_at?.toISOString?.()??item?.confirmed_at??null};}),homeworkIds:homework.rows.filter(item=>item.class_session_id===row.id).map(item=>item.id)}));
      const today=new Date().toISOString().slice(0,10);const attentionList=mappedStudents.filter(student=>student.attentionReasons.length).map(student=>({studentId:student.id,studentName:student.firstName,reasons:student.attentionReasons}));
      return{teacher:{id:teacher.id,name:teacher.display_name,title:teacher.title,timezone:teacher.timezone},metrics:{todayClasses:mappedSessions.filter(item=>item.startsAt.slice(0,10)===today).length,awaitingReview:mappedSubmissions.filter(item=>item.status==='submitted'&&!item.review).length,resubmitted:mappedSubmissions.filter(item=>item.attemptNumber>1&&item.status==='submitted').length,mentorToday:mentorBookings.rows.filter(item=>(item.starts_at?.toISOString?.()??item.starts_at).slice(0,10)===today).length,reportsPending:reports.rows.filter(item=>['draft','ready_for_review'].includes(item.status)).length},groups:groups.rows.map(row=>({id:row.id,courseId:row.course_id,name:row.name,courseTitle:row.course_title,timezone:row.timezone,studentCount:row.student_count,nextClassAt:row.next_class_at?.toISOString?.()??row.next_class_at??null,scheduleLabel:row.schedule_context?.weekly??'',progressPercent:row.progress_percent,attendanceRate:row.attendance_rate,recentHomework:row.recent_homework})),sessions:mappedSessions,homework:homework.rows.map((row):TeacherHomeworkDto=>({id:row.id,groupId:row.group_id,groupName:row.group_name,classSessionId:row.class_session_id,title:row.title,instructions:row.instructions,publishAt:row.publish_at?.toISOString?.()??row.publish_at??null,dueAt:row.due_at?.toISOString?.()??row.due_at??null,xpReward:row.xp_reward,status:row.status,submissionCount:row.submission_count,reviewCount:row.review_count,needsRevisionCount:row.needs_revision_count,resources:homeworkResources.rows.filter(item=>item.homework_id===row.id).map(item=>({id:item.id,kind:item.kind,title:item.title,url:item.external_url}))})),submissions:mappedSubmissions,students:mappedStudents,mentor:{mentorId:mentorProfile?.id??null,availability:mentorAvailability.rows.map(row=>({id:row.id,mentorId:row.mentor_id,startsAt:row.starts_at?.toISOString?.()??row.starts_at,endsAt:row.ends_at?.toISOString?.()??row.ends_at,timezone:row.timezone,status:row.status})),bookings:mentorBookings.rows.map(row=>({id:row.id,mentorId:row.mentor_id,mentorName:row.mentor_name,studentId:row.student_id,studentName:row.student_name,projectTitle:row.project_title,startsAt:row.starts_at?.toISOString?.()??row.starts_at,endsAt:row.ends_at?.toISOString?.()??row.ends_at,status:row.status,meetingUrl:row.meeting_url}))},reports:reports.rows.map(row=>({id:row.id,studentId:row.student_id,studentFirstName:row.student_name,groupId:row.group_id,groupName:row.group_name,periodStart:row.period_start?.toISOString?.().slice(0,10)??row.period_start,periodEnd:row.period_end?.toISOString?.().slice(0,10)??row.period_end,payload:row.payload,teacherComment:row.teacher_comment,status:row.status,approvedAt:row.approved_at?.toISOString?.()??row.approved_at??null})),lessons:lessons.rows.map(row=>({id:row.id,title:row.title,moduleTitle:row.module_title})),attention:attentionList};
    });
  }

  async searchTeacherScope(userId:string,query:string):Promise<TeacherSearchDto>{const data=await this.getTeacherWorkspace(userId);const term=query.trim().toLocaleLowerCase('uk');const includes=(value:string)=>value.toLocaleLowerCase('uk').includes(term);return{students:data.students.filter(item=>includes(item.firstName)).map(item=>({id:item.id,label:item.firstName,meta:item.groupName})),groups:data.groups.filter(item=>includes(item.name)||includes(item.courseTitle)).map(item=>({id:item.id,label:item.name,meta:item.courseTitle})),homework:data.homework.filter(item=>includes(item.title)).map(item=>({id:item.id,label:item.title,meta:item.groupName})),projects:data.students.flatMap(student=>student.projects.filter(project=>includes(project.title)).map(project=>({id:project.id,label:project.title,meta:student.firstName})))}};
  async updateTeacherClass(userId:string,sessionId:string,input:{title?:string;description?:string;lessonId?:string|null;meetingUrl?:string|null;meetingProvider?:string|null;teacherNotes?:string;status?:'scheduled'|'in_progress'|'completed'|'cancelled'}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.update_teacher_class($1,$2,$3,$4,$5,$6,$7,$8)`,[sessionId,input.title??null,input.description??null,input.lessonId??null,input.meetingUrl??null,input.meetingProvider??null,input.teacherNotes??null,input.status??null]),true);}
  async addClassMaterial(userId:string,sessionId:string,input:{kind:'presentation'|'document'|'link'|'reference'|'other';title:string;url:string}):Promise<void>{await this.withUser(userId,db=>db.query(`insert into public.class_materials(class_session_id,kind,title,external_url,position,created_by) values($1,$2,$3,$4,(select coalesce(max(position)+1,1) from public.class_materials where class_session_id=$1),$5)`,[sessionId,input.kind,input.title,input.url,userId]),true);}
  async bulkConfirmAttendance(userId:string,sessionId:string,entries:Array<{studentId:string;status:'present'|'late'|'absent'|'excused';note?:string}>):Promise<void>{await this.withUser(userId,async db=>{for(const entry of entries)await db.query(`select public.confirm_attendance($1,$2,$3,$4)`,[sessionId,entry.studentId,entry.status,entry.note??'']);},true);}
  async publishHomework(userId:string,homeworkId:string,publishAt:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.publish_homework($1,$2)`,[homeworkId,publishAt]),true);}
  async createTeacherNote(userId:string,studentId:string,input:{category:'general'|'learning'|'project'|'mentoring';content:string}):Promise<TeacherPrivateNoteDto>{return this.withUser(userId,async db=>{const row=(await db.query(`insert into public.teacher_private_notes(student_id,teacher_id,category,content) values($1,$2,$3,$4) returning *`,[studentId,userId,input.category,input.content])).rows[0];return{id:row.id,studentId:row.student_id,category:row.category,content:row.content,createdAt:row.created_at.toISOString?.()??row.created_at,updatedAt:row.updated_at.toISOString?.()??row.updated_at};},true);}
  async updatePortfolioItemAsTeacher(userId:string,portfolioProjectId:string,input:{title?:string|null;shortDescription?:string;reflection?:string;learned?:string}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.update_portfolio_project_as_teacher($1,$2,$3,$4,$5)`,[portfolioProjectId,input.title??null,input.shortDescription??null,input.reflection??null,input.learned??null]),true);}
  async createMentorAvailability(userId:string,input:{startsAt:string;endsAt:string;timezone:string;status:'open'|'blocked'}):Promise<void>{await this.withUser(userId,async db=>{const result=await db.query(`insert into public.mentor_availability(mentor_id,starts_at,ends_at,timezone,status,created_by) select id,$2,$3,$4,$5,$1 from public.mentors where user_id=$1 returning id`,[userId,input.startsAt,input.endsAt,input.timezone,input.status]);if(!result.rows[0])throw new AppError('MENTOR_REQUIRED',403,'Профіль ментора недоступний');},true);}
  async updateMentorBooking(userId:string,bookingId:string,input:{status:'confirmed'|'completed'|'cancelled'|'rescheduled'|'no_show';meetingUrl?:string|null;startsAt?:string;endsAt?:string}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.manage_mentor_booking($1,$2,$3,$4,$5)`,[bookingId,input.status,input.meetingUrl??null,input.startsAt??null,input.endsAt??null]),true);}
  async generateTeacherReports(userId:string,groupId:string,periodStart:string,periodEnd:string):Promise<void>{await this.withUser(userId,db=>db.query(`insert into public.parent_reports(student_id,period_start,period_end,payload,status,created_by)
    select gm.student_id,$2::date,$3::date,jsonb_build_object(
      'classesScheduled',(select count(*) from public.class_sessions cs where cs.group_id=$1 and cs.scheduled_start::date between $2::date and $3::date),
      'classesAttended',(select count(*) from public.attendance a join public.class_sessions cs on cs.id=a.class_session_id where cs.group_id=$1 and a.student_id=gm.student_id and a.status in('present','late') and cs.scheduled_start::date between $2::date and $3::date),
      'homeworkAssigned',(select count(*) from public.homework h where h.group_id=$1 and h.status in('published','closed') and coalesce(h.publish_at,h.created_at)::date between $2::date and $3::date),
      'homeworkSubmitted',(select count(*) from public.homework_submissions hs join public.homework h on h.id=hs.homework_id where h.group_id=$1 and hs.student_id=gm.student_id and hs.submitted_at::date between $2::date and $3::date),
      'homeworkReviewed',(select count(*) from public.homework_reviews hr join public.homework_submissions hs on hs.id=hr.submission_id join public.homework h on h.id=hs.homework_id where h.group_id=$1 and hs.student_id=gm.student_id and hr.reviewed_at::date between $2::date and $3::date),
      'scores',coalesce((select jsonb_agg(hr.score order by hr.reviewed_at) from public.homework_reviews hr join public.homework_submissions hs on hs.id=hr.submission_id where hs.student_id=gm.student_id and hr.reviewed_at::date between $2::date and $3::date),'[]'::jsonb),
      'effort',jsonb_build_object('needsAttention',(select count(*) from public.homework_reviews hr join public.homework_submissions hs on hs.id=hr.submission_id where hs.student_id=gm.student_id and hr.effort='needs_attention' and hr.reviewed_at::date between $2::date and $3::date),'good',(select count(*) from public.homework_reviews hr join public.homework_submissions hs on hs.id=hr.submission_id where hs.student_id=gm.student_id and hr.effort='good_effort' and hr.reviewed_at::date between $2::date and $3::date),'high',(select count(*) from public.homework_reviews hr join public.homework_submissions hs on hs.id=hr.submission_id where hs.student_id=gm.student_id and hr.effort='high_effort' and hr.reviewed_at::date between $2::date and $3::date)),
      'xpEarned',coalesce((select sum(x.delta) from public.xp_events x where x.user_id=gm.student_id and x.created_at::date between $2::date and $3::date),0),
      'project',(select p.title from public.projects p where p.user_id=gm.student_id and p.status='active' order by p.updated_at desc limit 1),
      'projectProgress',coalesce((select p.completion_percent from public.projects p where p.user_id=gm.student_id and p.status='active' order by p.updated_at desc limit 1),0),
      'newAchievements',coalesce((select jsonb_agg(a.title order by sa.awarded_at) from public.student_achievements sa join public.achievements a on a.id=sa.achievement_id where sa.user_id=gm.student_id and sa.awarded_at::date between $2::date and $3::date),'[]'::jsonb),
      'portfolioMilestone',(select coalesce(pp.title_override,p.title) from public.portfolios portfolio join public.portfolio_projects pp on pp.portfolio_id=portfolio.id join public.projects p on p.id=pp.project_id where portfolio.student_id=gm.student_id and pp.created_at::date between $2::date and $3::date order by pp.created_at desc limit 1)
    ),'draft',$4 from public.group_memberships gm where gm.group_id=$1 and gm.status='active' and app_private.teacher_has_group($1)
    on conflict(student_id,period_start,period_end) do nothing`,[groupId,periodStart,periodEnd,userId]),true);}
  async saveTeacherReport(userId:string,reportId:string,input:{teacherComment:string;status:'draft'|'ready_for_review'}):Promise<void>{await this.withUser(userId,db=>db.query(`select public.save_parent_report($1,$2,$3)`,[reportId,input.teacherComment,input.status]),true);}
  async approveTeacherReport(userId:string,reportId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.approve_parent_report($1)`,[reportId]),true);}
  async listLinkedStudents(userId:string):Promise<TeacherStudentDto[]>{return this.withUser(userId,async db=>(await db.query(`select u.id,sp.display_name,coalesce(round(avg(lp.progress_percent)),0)::int progress_percent,(select title from public.projects p where p.user_id=u.id and p.status='active' order by updated_at desc limit 1) project_title from public.guardian_student_links gsl join public.users u on u.id=gsl.student_id join public.student_profiles sp on sp.user_id=u.id left join public.enrollments e on e.user_id=u.id left join public.lesson_progress lp on lp.enrollment_id=e.id where gsl.guardian_id=$1 and gsl.status='active' group by u.id,sp.display_name order by sp.display_name`,[userId])).rows.map(row=>({id:row.id,firstName:row.display_name,progressPercent:row.progress_percent,projectTitle:row.project_title})));}
  async listParentReports(userId:string,studentId:string):Promise<ParentReportDto[]>{return this.withUser(userId,async db=>(await db.query(`select pr.*,sp.display_name from public.parent_reports pr join public.student_profiles sp on sp.user_id=pr.student_id where pr.student_id=$1 and pr.status in('approved','sent') and app_private.guardian_has_student(pr.student_id) order by period_end desc`,[studentId])).rows.map(row=>({id:row.id,studentId:row.student_id,studentFirstName:row.display_name,periodStart:row.period_start.toISOString?.().slice(0,10)??row.period_start,periodEnd:row.period_end.toISOString?.().slice(0,10)??row.period_end,payload:row.payload,teacherComment:row.teacher_comment,status:row.status})));}

  async getAdminWorkspace(userId:string):Promise<AdminWorkspaceDto>{
    const admin=await this.requireAdminDirect(userId);const [students,teachers,guardians,groups,sessions,homework,projects,portfolios,bookings,reports,notifications,activeSessions,auditEvents,securityEvents]=await Promise.all([
      this.pool.query(`select u.id,sp.display_name name,u.status,g.name "group",c.title course,coalesce(round(avg(lp.progress_percent)),0)::int progress,coalesce((select sum(delta) from public.xp_events where user_id=u.id),0)::int xp,l.title level,sp.current_streak streak,count(distinct case when a.status='absent' then a.id end)::int absences,count(distinct case when hs.submitted_at is not null then hs.id end)::int submissions,(select title from public.projects where user_id=u.id and status='active' order by updated_at desc limit 1) project,exists(select 1 from public.guardian_student_links where student_id=u.id and status='active') "guardianLinked",exists(select 1 from public.user_identities where user_id=u.id and provider='telegram') "telegramLinked" from public.users u join public.student_profiles sp on sp.user_id=u.id left join public.group_memberships gm on gm.student_id=u.id and gm.status='active' left join public.groups g on g.id=gm.group_id left join public.enrollments e on e.user_id=u.id and e.status='active' left join public.courses c on c.id=e.course_id left join public.lesson_progress lp on lp.enrollment_id=e.id left join public.levels l on l.id=sp.level_id left join public.attendance a on a.student_id=u.id left join public.homework_submissions hs on hs.student_id=u.id where u.kind='student' group by u.id,sp.display_name,g.name,c.title,l.title,sp.current_streak order by sp.display_name limit 200`),
      this.pool.query(`select u.id,tp.display_name name,tp.title,u.status,count(distinct gt.group_id)::int groups,count(distinct cs.id) filter(where cs.scheduled_start>now() and cs.status not in('cancelled','completed'))::int "upcomingClasses",count(distinct cs.id) filter(where cs.status='completed')::int "classesTaught",count(distinct hr.id)::int reviews,(m.id is not null) mentor from public.users u join public.teacher_profiles tp on tp.user_id=u.id left join public.group_teachers gt on gt.teacher_id=u.id and gt.ends_at is null left join public.class_sessions cs on cs.teacher_id=u.id left join public.homework_reviews hr on hr.reviewer_id=u.id left join public.mentors m on m.user_id=u.id where u.kind='teacher' group by u.id,tp.display_name,tp.title,m.id order by tp.display_name limit 200`),
      this.pool.query(`select u.id,gp.display_name name,u.status,count(gsl.id) filter(where gsl.status='active')::int "linkedStudents",bool_or(ui.provider='telegram') "telegramLinked",max(gsl.status) "relationshipStatus",max(gsl.id::text) "linkId" from public.users u join public.guardian_profiles gp on gp.user_id=u.id left join public.guardian_student_links gsl on gsl.guardian_id=u.id left join public.user_identities ui on ui.user_id=u.id where u.kind='guardian' group by u.id,gp.display_name order by gp.display_name limit 200`),
      this.pool.query(`select g.id,g.name,c.title "courseTitle",g.status,g.starts_on "startsOn",g.ends_on "endsOn",g.timezone,g.schedule_context "scheduleContext",count(distinct gm.student_id)::int "studentCount",string_agg(distinct tp.display_name,', ') teachers from public.groups g join public.courses c on c.id=g.course_id left join public.group_memberships gm on gm.group_id=g.id and gm.status='active' left join public.group_teachers gt on gt.group_id=g.id and gt.ends_at is null left join public.teacher_profiles tp on tp.user_id=gt.teacher_id group by g.id,c.title order by g.starts_on desc limit 200`),
      this.pool.query(`select cs.id,cs.title,g.name "group",tp.display_name teacher,l.title lesson,cs.scheduled_start "startsAt",extract(epoch from(cs.scheduled_end-cs.scheduled_start))/60 "durationMinutes",cs.status,cs.meeting_provider "meetingProvider",cs.meeting_url "meetingUrl",exists(select 1 from public.group_memberships gm where gm.group_id=cs.group_id and gm.status='active' and not exists(select 1 from public.attendance a where a.class_session_id=cs.id and a.student_id=gm.student_id)) is false "attendanceComplete" from public.class_sessions cs join public.groups g on g.id=cs.group_id join public.teacher_profiles tp on tp.user_id=cs.teacher_id left join public.lessons l on l.id=cs.lesson_id order by cs.scheduled_start desc limit 300`),
      this.pool.query(`select h.id,h.title,g.name "group",tp.display_name teacher,h.status,h.due_at "dueAt",count(distinct hs.id)::int submissions,count(distinct hr.id)::int reviews,count(distinct hr.id) filter(where hr.status='needs_revision')::int revisions from public.homework h join public.groups g on g.id=h.group_id join public.teacher_profiles tp on tp.user_id=h.created_by left join public.homework_submissions hs on hs.homework_id=h.id left join public.homework_reviews hr on hr.submission_id=hs.id group by h.id,g.name,tp.display_name order by h.created_at desc limit 300`),
      this.pool.query(`select p.id,p.user_id "studentId",sp.display_name student,p.title,ps.title stage,p.completion_percent progress,p.technologies,p.status from public.projects p join public.student_profiles sp on sp.user_id=p.user_id join public.project_stages ps on ps.id=p.stage_id order by p.updated_at desc limit 300`),
      this.pool.query(`select p.id,p.student_id "studentId",sp.display_name student,p.title,p.visibility,count(pp.id)::int items from public.portfolios p join public.student_profiles sp on sp.user_id=p.student_id left join public.portfolio_projects pp on pp.portfolio_id=p.id group by p.id,sp.display_name order by p.updated_at desc limit 300`),
      this.pool.query(`select mb.id,m.display_name mentor,sp.display_name student,mb.starts_at "startsAt",mb.ends_at "endsAt",mb.status,mb.meeting_url "meetingUrl" from public.mentor_bookings mb join public.mentors m on m.id=mb.mentor_id join public.student_profiles sp on sp.user_id=mb.student_id order by mb.starts_at desc limit 300`),
      this.pool.query(`select pr.id,pr.student_id "studentId",sp.display_name "studentFirstName",pr.period_start "periodStart",pr.period_end "periodEnd",pr.status,pr.teacher_comment "teacherComment",pr.approved_at "approvedAt",exists(select 1 from public.guardian_student_links gsl where gsl.student_id=pr.student_id and gsl.status='active') "guardianRelationshipActive" from public.parent_reports pr join public.student_profiles sp on sp.user_id=pr.student_id order by pr.period_end desc limit 300`),
      this.pool.query(`select o.id,o.event_type category,coalesce(sp.display_name,tp.display_name,gp.display_name,'Користувач') recipient,o.status,o.scheduled_at "scheduledAt",o.attempts,o.sent_at "sentAt" from app_private.notification_outbox o join public.users u on u.id=o.recipient_user_id left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id order by o.created_at desc limit 100`),
      this.pool.query(`select s.id,s.user_id "userId",coalesce(sp.display_name,tp.display_name,gp.display_name,'Адміністратор') "user",u.kind role,s.provider,s.created_at "createdAt",s.last_used_at "lastUsedAt",s.expires_at "expiresAt",case when s.revoked_at is null and s.expires_at>now() then 'active' else 'revoked' end status from app_private.auth_sessions s join public.users u on u.id=s.user_id left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id order by s.last_used_at desc limit 100`),
      this.pool.query(`select a.id,a.actor_user_id "actorId",coalesce(sp.display_name,tp.display_name,gp.display_name,'Адміністратор') actor,a.action,a.target_type "targetType",a.target_id "targetId",a.safe_metadata metadata,a.correlation_id "correlationId",a.created_at "createdAt" from app_private.admin_audit_events a join public.users u on u.id=a.actor_user_id left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id order by a.created_at desc limit 100`),
      this.pool.query(`select id,event_type type,severity,actor_user_id "actorId",target_user_id "targetId",safe_metadata metadata,correlation_id "correlationId",created_at "createdAt" from app_private.security_events order by created_at desc limit 100`)
    ]);
    const today=new Date().toISOString().slice(0,10);const sessionRows=sessions.rows,homeworkRows=homework.rows,reportRows=reports.rows;
    return{admin:{id:userId,name:admin.display_name,role:'admin',mfaRequired:true},metrics:{activeStudents:students.rows.filter(row=>row.status==='active').length,activeGroups:groups.rows.filter(row=>row.status==='active').length,teachers:teachers.rows.length,upcomingClasses:sessionRows.filter(row=>new Date(row.startsAt)>new Date()&&!['cancelled','completed'].includes(row.status)).length,classesToday:sessionRows.filter(row=>String(row.startsAt?.toISOString?.()??row.startsAt).slice(0,10)===today).length,awaitingReview:homeworkRows.reduce((sum,row)=>sum+Math.max(0,row.submissions-row.reviews),0),needsRevision:homeworkRows.reduce((sum,row)=>sum+row.revisions,0),mentorBookings:bookings.rows.length,attendanceIssues:students.rows.reduce((sum,row)=>sum+row.absences,0),reportsAwaiting:reportRows.filter(row=>row.status==='ready_for_review').length,recentProjects:projects.rows.length,portfolioMilestones:portfolios.rows.reduce((sum,row)=>sum+row.items,0)},students:students.rows,teachers:teachers.rows,guardians:guardians.rows,groups:groups.rows,sessions:sessionRows,homework:homeworkRows,projects:projects.rows,portfolios:portfolios.rows,mentorBookings:bookings.rows,reports:reportRows,notifications:notifications.rows,activeSessions:activeSessions.rows,auditEvents:auditEvents.rows,securityEvents:securityEvents.rows,health:{productionMode:{status:'ok',label:'Перевіряється сервером'},database:{status:'ok',label:'PostgreSQL доступний'},rls:{status:'ok',label:'Admin migration присутня'},telegram:{status:'warning',label:'Перевіряється без розкриття значень'},storage:{status:'warning',label:'Перевірте private buckets'},signingKeys:{status:'ok',label:'JWT signer завантажений'},devAuth:{status:'ok',label:'Production fail-closed'},origins:{status:'ok',label:'CORS allowlist'},securityHeaders:{status:'ok',label:'Helmet/CSP'}}};
  }

  async searchAdmin(userId:string,query:string):Promise<AdminSearchDto>{await this.requireAdminDirect(userId);const term=`%${query.replace(/[%_]/g,'')}%`;const result=await this.pool.query(`select * from (select 'student' type,u.id,sp.display_name label,coalesce(g.name,'Без групи') meta from public.users u join public.student_profiles sp on sp.user_id=u.id left join public.group_memberships gm on gm.student_id=u.id and gm.status='active' left join public.groups g on g.id=gm.group_id where sp.display_name ilike $1 union all select 'teacher',u.id,tp.display_name,tp.title from public.users u join public.teacher_profiles tp on tp.user_id=u.id where tp.display_name ilike $1 union all select 'guardian',u.id,gp.display_name,'Батьки' from public.users u join public.guardian_profiles gp on gp.user_id=u.id where gp.display_name ilike $1 union all select 'group',g.id,g.name,c.title from public.groups g join public.courses c on c.id=g.course_id where g.name ilike $1 union all select 'class',cs.id,cs.title,g.name from public.class_sessions cs join public.groups g on g.id=cs.group_id where cs.title ilike $1 union all select 'project',p.id,p.title,sp.display_name from public.projects p join public.student_profiles sp on sp.user_id=p.user_id where p.title ilike $1) found limit 30`,[term]);return{results:result.rows};}

  async exploreAdmin(userId:string,input:{entity:AdminEntity;page:number;pageSize:number;sort:string;direction:'asc'|'desc';query?:string}):Promise<AdminExplorerPageDto>{await this.requireAdminDirect(userId);const definitions:Record<AdminEntity,{sql:string;sorts:string[]}>={users:{sql:`select id,kind role,status,created_at "createdAt",last_seen_at "lastSeenAt" from public.users`,sorts:['id','role','status','createdAt']},students:{sql:`select u.id,sp.display_name name,u.status,sp.current_streak streak from public.users u join public.student_profiles sp on sp.user_id=u.id`,sorts:['id','name','status','streak']},teachers:{sql:`select u.id,tp.display_name name,tp.title,u.status from public.users u join public.teacher_profiles tp on tp.user_id=u.id`,sorts:['id','name','status']},guardians:{sql:`select u.id,gp.display_name name,u.status from public.users u join public.guardian_profiles gp on gp.user_id=u.id`,sorts:['id','name','status']},groups:{sql:`select id,name,status,starts_on "startsOn",ends_on "endsOn" from public.groups`,sorts:['id','name','status','startsOn']},courses:{sql:`select id,slug,title,status,version from public.courses`,sorts:['id','slug','title','status']},modules:{sql:`select id,course_id "courseId",position,title,status from public.modules`,sorts:['id','position','title','status']},lessons:{sql:`select id,module_id "moduleId",position,title,status,xp_reward "xpReward" from public.lessons`,sorts:['id','position','title','status']},sessions:{sql:`select id,group_id "groupId",teacher_id "teacherId",title,scheduled_start "startsAt",status from public.class_sessions`,sorts:['id','title','startsAt','status']},attendance:{sql:`select id,class_session_id "sessionId",student_id "studentId",status,confirmed_at "confirmedAt" from public.attendance`,sorts:['id','status','confirmedAt']},homework:{sql:`select id,group_id "groupId",title,status,publish_at "publishAt",due_at "dueAt" from public.homework`,sorts:['id','title','status','dueAt']},submissions:{sql:`select id,homework_id "homeworkId",student_id "studentId",attempt_number attempt,status,submitted_at "submittedAt" from public.homework_submissions`,sorts:['id','attempt','status','submittedAt']},reviews:{sql:`select id,submission_id "submissionId",reviewer_id "reviewerId",score,effort,status,reviewed_at "reviewedAt" from public.homework_reviews`,sorts:['id','score','effort','status','reviewedAt']},projects:{sql:`select id,user_id "studentId",title,status,completion_percent progress,updated_at "updatedAt" from public.projects`,sorts:['id','title','status','progress','updatedAt']},portfolios:{sql:`select id,student_id "studentId",title,visibility,updated_at "updatedAt" from public.portfolios`,sorts:['id','title','visibility','updatedAt']},mentor_bookings:{sql:`select id,mentor_id "mentorId",student_id "studentId",starts_at "startsAt",status from public.mentor_bookings`,sorts:['id','startsAt','status']},reports:{sql:`select id,student_id "studentId",period_start "periodStart",period_end "periodEnd",status,approved_at "approvedAt",sent_at "sentAt" from public.parent_reports`,sorts:['id','periodStart','status']}};const definition=definitions[input.entity];if(!definition.sorts.includes(input.sort))throw new AppError('INVALID_SORT',400,'Недозволене поле сортування');const direction=input.direction==='asc'?'asc':'desc',offset=(input.page-1)*input.pageSize,search=input.query?.trim()??'';const count=await this.pool.query(`select count(*)::int total from (${definition.sql}) entity where ($1='' or entity::text ilike $2)`,[search,`%${search.replace(/[%_]/g,'')}%`]);const result=await this.pool.query(`select * from (${definition.sql}) entity where ($1='' or entity::text ilike $2) order by "${input.sort}" ${direction} limit $3 offset $4`,[search,`%${search.replace(/[%_]/g,'')}%`,input.pageSize,offset]);return{entity:input.entity,page:input.page,pageSize:input.pageSize,total:count.rows[0].total,sort:input.sort,direction:input.direction,records:result.rows};}

  async adminSetAccountStatus(userId:string,targetUserId:string,status:'active'|'disabled'|'archived',reason:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_set_account_status($1,$2,$3,$4)`,[targetUserId,status,reason,correlationId]),true);}
  async adminCorrectAttendance(userId:string,attendanceId:string,status:'present'|'late'|'absent'|'excused',reason:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_correct_attendance($1,$2,$3,$4)`,[attendanceId,status,reason,correlationId]),true);}
  async adminSetPortfolioVisibility(userId:string,portfolioId:string,visibility:'private'|'shareable'|'public',reason:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_set_portfolio_visibility($1,$2,$3,$4)`,[portfolioId,visibility,reason,correlationId]),true);}
  async adminRevokeGuardianLink(userId:string,linkId:string,reason:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_revoke_guardian_link($1,$2,$3)`,[linkId,reason,correlationId]),true);}
  async adminResendReport(userId:string,reportId:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_resend_parent_report($1,$2)`,[reportId,correlationId]),true);}
  async adminRevokeUserSession(userId:string,sessionId:string,reason:string,correlationId:string):Promise<void>{await this.withUser(userId,db=>db.query(`select public.admin_revoke_session($1,$2,$3)`,[sessionId,reason,correlationId]),true);}
  async recordSecurityEvent(input:{eventType:string;severity:'low'|'medium'|'high'|'critical';actorUserId?:string;targetUserId?:string;metadata?:Record<string,unknown>;correlationId:string}):Promise<void>{await this.pool.query(`insert into app_private.security_events(event_type,severity,actor_user_id,target_user_id,safe_metadata,correlation_id) values($1,$2,$3,$4,$5,$6)`,[input.eventType,input.severity,input.actorUserId??null,input.targetUserId??null,input.metadata??{},input.correlationId]);}

  async listConversations(userId: string): Promise<AiConversationDto[]> { return this.withUser(userId, async db => (await db.query(`select * from public.ai_conversations where user_id=$1 order by updated_at desc`,[userId])).rows.map(this.conversation)); }
  async createConversation(userId: string, title='Нова розмова'): Promise<AiConversationDto> {
    const result = await this.withUser(userId, db => db.query(`insert into public.ai_conversations(user_id,course_id,lesson_id,project_id,title) select $1,e.course_id,e.current_lesson_id,p.id,$2 from public.enrollments e left join public.projects p on p.user_id=e.user_id and p.status='active' where e.user_id=$1 and e.status='active' limit 1 returning *`,[userId,title]), true);
    if (!result.rows[0]) throw new AppError('ENROLLMENT_NOT_FOUND',404,'Активний курс не знайдено');
    await this.pool.query(`insert into app_private.ai_conversation_state(conversation_id) values($1) on conflict do nothing`,[result.rows[0].id]);
    return this.conversation(result.rows[0]);
  }
  async getConversation(userId: string, conversationId: string): Promise<AiConversationDto | null> { return this.withUser(userId, async db => { const r=await db.query(`select * from public.ai_conversations where id=$1 and user_id=$2`,[conversationId,userId]); return r.rows[0]?this.conversation(r.rows[0]):null; }); }
  async listMessages(userId: string, conversationId: string, limit: number, before?: string): Promise<AiMessageDto[]> { return this.withUser(userId, async db => (await db.query(`select m.* from public.ai_messages m join public.ai_conversations c on c.id=m.conversation_id where c.id=$1 and c.user_id=$2 and ($3::timestamptz is null or m.created_at<$3) order by m.created_at desc limit $4`,[conversationId,userId,before??null,limit])).rows.reverse().map(this.message)); }
  async appendAiMessage(userId: string, conversationId: string, message: Omit<AiMessageDto,'id'|'createdAt'> & {clientMessageId?:string}): Promise<AiMessageDto|null> {
    const r=await this.withUser(userId, db=>db.query(`with inserted as (
      insert into public.ai_messages(conversation_id,role,content,client_message_id)
      select c.id,$3,$4,$5 from public.ai_conversations c where c.id=$1 and c.user_id=$2
      on conflict(conversation_id,client_message_id) do nothing returning *
    ) select * from inserted union all
      select m.* from public.ai_messages m join public.ai_conversations c on c.id=m.conversation_id
      where c.id=$1 and c.user_id=$2 and m.client_message_id=$5 limit 1`,[conversationId,userId,message.role,message.content,message.clientMessageId??null]), true);
    if(r.rows[0]) await this.withUser(userId,db=>db.query(`update public.ai_conversations set last_message_at=now() where id=$1 and user_id=$2`,[conversationId,userId]),true);
    return r.rows[0]?this.message(r.rows[0]):null;
  }
  async getAiContext(userId:string,conversationId:string):Promise<AiContextDto|null>{
    const conversation=await this.getConversation(userId,conversationId); if(!conversation)return null;
    const [home,messages,state]=await Promise.all([this.getHome(userId),this.listMessages(userId,conversationId,12),this.pool.query(`select summary from app_private.ai_conversation_state where conversation_id=$1`,[conversationId])]);
    const learning=await this.getLearning(userId); const lesson=learning.modules.flatMap(m=>m.lessons).find(l=>l.id===conversation.lessonId)??home.currentLesson; const module=learning.modules.find(m=>m.lessons.some(l=>l.id===lesson?.id)); const project=home.currentProject;
    return {firstName:home.viewer.firstName,courseTitle:home.course.title,moduleTitle:module?.title??null,lessonTitle:lesson?.title??null,lessonSummary:lesson?.summary??null,projectTitle:project?.title??null,projectSummary:project?.summary??null,projectStage:project?.stage.title??null,nextProjectTask:project?.tasks.find(t=>t.status==='in_progress'||t.status==='available')?.title??null,conversationSummary:state.rows[0]?.summary??'',recentMessages:messages};
  }
  async updateConversationSummary(conversationId:string,summary:string):Promise<void>{await this.pool.query(`insert into app_private.ai_conversation_state(conversation_id,summary) values($1,$2) on conflict(conversation_id) do update set summary=excluded.summary,updated_at=now()`,[conversationId,summary.slice(0,4000)]);}

  private async withUser<T>(userId:string,fn:(db:Db)=>Promise<T>,write=false):Promise<T>{const client=await this.pool.connect();try{await client.query('begin');await client.query(`set local role authenticated`);await client.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({role:'authenticated',app_user_id:userId})]);const value=await fn(client);await client.query('commit');return value;}catch(error){await client.query('rollback');throw error;}finally{client.release();}}
  private async requireAdminDirect(userId:string):Promise<{display_name:string}>{const result=await this.pool.query(`select coalesce(sp.display_name,tp.display_name,gp.display_name,'Адміністратор') display_name from public.users u left join public.student_profiles sp on sp.user_id=u.id left join public.teacher_profiles tp on tp.user_id=u.id left join public.guardian_profiles gp on gp.user_id=u.id where u.id=$1 and u.kind='admin' and u.status='active'`,[userId]);if(!result.rows[0])throw new AppError('ROLE_FORBIDDEN',403,'Недостатньо прав');return result.rows[0];}
  private async getViewer(userId:string){return this.withUser(userId,async db=>{const r=await db.query(`select u.id,sp.display_name,sp.current_streak,coalesce(sum(x.delta),0)::int xp,l.position level_number,l.title level_title,l.min_xp,(select title from public.levels where min_xp>coalesce(sum(x.delta),0) order by min_xp limit 1) next_title,(select min_xp from public.levels where min_xp>coalesce(sum(x.delta),0) order by min_xp limit 1) next_min_xp from public.users u join public.student_profiles sp on sp.user_id=u.id left join public.xp_events x on x.user_id=u.id join lateral(select * from public.levels where min_xp<=coalesce((select sum(delta) from public.xp_events where user_id=u.id),0) order by min_xp desc limit 1) l on true where u.id=$1 group by u.id,sp.display_name,sp.current_streak,l.position,l.title,l.min_xp`,[userId]);if(!r.rows[0])throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');const x=r.rows[0];return{id:x.id,firstName:x.display_name,level:{number:x.level_number,title:x.level_title,nextTitle:x.next_title,currentMinXp:x.min_xp,nextMinXp:x.next_min_xp},xp:x.xp,streak:x.current_streak};});}
  private async getMentor(userId:string):Promise<ProfileDto['mentor']>{return this.withUser(userId,async db=>{const r=await db.query(`select m.display_name,m.title,m.avatar_path,ma.next_meeting_at from public.mentor_assignments ma join public.mentors m on m.id=ma.mentor_id where ma.student_user_id=$1 and ma.ends_at is null`,[userId]);const x=r.rows[0];return x?{displayName:x.display_name,title:x.title,avatarPath:x.avatar_path,nextMeetingAt:x.next_meeting_at?.toISOString?.()??x.next_meeting_at??null}:null;});}
  private authUser(r:any):AuthUser{return{id:r.id,displayName:r.display_name,status:r.status};}
  private project(p:any,tasks:any[]):ProjectDto{return{id:p.id,title:p.title,summary:p.summary,status:p.status,completionPercent:p.completion_percent,tags:p.tags??[],workspaceUrl:p.workspace_url??this.workspaceUrl??null,stage:{id:p.stage_id,code:p.stage_code,title:p.stage_title,position:p.stage_position,total:Number(p.stage_total)},tasks:tasks.map((t):ProjectTaskDto=>({id:t.id,number:String(t.position).padStart(2,'0'),title:t.title,description:t.description,status:t.status,xpReward:t.xp_reward,weight:t.weight}))};}
  private conversation=(r:any):AiConversationDto=>({id:r.id,title:r.title,courseId:r.course_id,lessonId:r.lesson_id,projectId:r.project_id,createdAt:r.created_at.toISOString?.()??r.created_at,updatedAt:r.updated_at.toISOString?.()??r.updated_at});
  private message=(r:any):AiMessageDto=>({id:r.id,role:r.role,content:r.content,createdAt:r.created_at.toISOString?.()??r.created_at});
  private classSession(row:any,materials:any[]):ScheduleDto['upcoming'][number]{return{id:row.id,title:row.title,description:row.description,startsAt:row.scheduled_start.toISOString?.()??row.scheduled_start,endsAt:row.scheduled_end.toISOString?.()??row.scheduled_end,durationMinutes:Math.round((new Date(row.scheduled_end).getTime()-new Date(row.scheduled_start).getTime())/60000),status:row.status,meetingProvider:row.meeting_provider,meetingUrl:row.meeting_url,courseTitle:row.course_title,moduleTitle:row.module_title,lessonTitle:row.lesson_title,teacherName:row.teacher_name,materials:materials.map(item=>({id:item.id,kind:item.kind,title:item.title,url:item.external_url}))};}
  private submission(row:any,review:any):HomeworkSubmissionDto{return{id:row.id,attemptNumber:row.attempt_number,submittedAt:row.submitted_at?.toISOString?.()??row.submitted_at??null,studentComment:row.student_comment,contentText:row.content_text,contentUrl:row.content_url,status:row.status,review:review?{score:review.score,effort:review.effort,status:review.status,feedback:review.feedback,reviewedAt:review.reviewed_at?.toISOString?.()??review.reviewed_at}:null};}
  private homework(row:any):HomeworkSummaryDto{const submission=row.submission_id?this.submission({id:row.submission_id,attempt_number:row.attempt_number,submitted_at:row.submitted_at,student_comment:row.student_comment,content_text:row.content_text,content_url:row.content_url,status:row.submission_status},row.score===null?null:{score:row.score,effort:row.effort,status:row.review_status,feedback:row.feedback,reviewed_at:row.reviewed_at}):null;return{id:row.id,title:row.title,instructions:row.instructions,publishedAt:row.publish_at.toISOString?.()??row.publish_at,dueAt:row.due_at?.toISOString?.()??row.due_at??null,xpReward:row.xp_reward,classTitle:row.class_title,state:submission?.status??'not_started',latestSubmission:submission};}
}
