import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type { AppRepository } from './repository.js';
import type {
  AchievementDto, AiContextDto, AiConversationDto, AiMessageDto, AuthUser, HomeDto, LearningDto,
  LessonDto, LessonSummaryDto, NewSession, ProfileDto, ProjectDto, ProjectTaskDto, RotationResult,
  TelegramIdentityInput
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
    const result = await this.pool.query(`select u.id,u.status,sp.display_name from public.users u join public.student_profiles sp on sp.user_id=u.id where u.id=$1`, [userId]);
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
      const result = await client.query(`select s.*,u.status,sp.display_name from app_private.auth_sessions s join public.users u on u.id=s.user_id join public.student_profiles sp on sp.user_id=u.id where refresh_token_hash=$1 for update`, [currentTokenHash]);
      const current = result.rows[0];
      if (!current) { await client.query('rollback'); return { status: 'invalid' }; }
      if (current.replaced_by_session_id) {
        await client.query(`update app_private.auth_sessions set revoked_at=coalesce(revoked_at,$2),reuse_detected_at=coalesce(reuse_detected_at,$2) where family_id=$1`, [current.family_id, now]);
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

  async getHome(userId: string): Promise<HomeDto> {
    const [learning, projects, viewer] = await Promise.all([this.getLearning(userId), this.listProjects(userId), this.getViewer(userId)]);
    const currentLesson = learning.modules.flatMap(m => m.lessons).find(l => l.state === 'current' || l.state === 'available') ?? null;
    return { viewer, course: learning.course, currentLesson, projectCount: projects.length, currentProject: projects.find(p => p.status === 'active') ?? null };
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
  private async getViewer(userId:string){return this.withUser(userId,async db=>{const r=await db.query(`select u.id,sp.display_name,sp.current_streak,coalesce(sum(x.delta),0)::int xp,l.position level_number,l.title level_title,l.min_xp,(select title from public.levels where min_xp>coalesce(sum(x.delta),0) order by min_xp limit 1) next_title,(select min_xp from public.levels where min_xp>coalesce(sum(x.delta),0) order by min_xp limit 1) next_min_xp from public.users u join public.student_profiles sp on sp.user_id=u.id left join public.xp_events x on x.user_id=u.id join lateral(select * from public.levels where min_xp<=coalesce((select sum(delta) from public.xp_events where user_id=u.id),0) order by min_xp desc limit 1) l on true where u.id=$1 group by u.id,sp.display_name,sp.current_streak,l.position,l.title,l.min_xp`,[userId]);if(!r.rows[0])throw new AppError('USER_NOT_FOUND',404,'Користувача не знайдено');const x=r.rows[0];return{id:x.id,firstName:x.display_name,level:{number:x.level_number,title:x.level_title,nextTitle:x.next_title,currentMinXp:x.min_xp,nextMinXp:x.next_min_xp},xp:x.xp,streak:x.current_streak};});}
  private async getMentor(userId:string):Promise<ProfileDto['mentor']>{return this.withUser(userId,async db=>{const r=await db.query(`select m.display_name,m.title,m.avatar_path,ma.next_meeting_at from public.mentor_assignments ma join public.mentors m on m.id=ma.mentor_id where ma.student_user_id=$1 and ma.ends_at is null`,[userId]);const x=r.rows[0];return x?{displayName:x.display_name,title:x.title,avatarPath:x.avatar_path,nextMeetingAt:x.next_meeting_at?.toISOString?.()??x.next_meeting_at??null}:null;});}
  private authUser(r:any):AuthUser{return{id:r.id,displayName:r.display_name,status:r.status};}
  private project(p:any,tasks:any[]):ProjectDto{return{id:p.id,title:p.title,summary:p.summary,status:p.status,completionPercent:p.completion_percent,tags:p.tags??[],workspaceUrl:p.workspace_url??this.workspaceUrl??null,stage:{id:p.stage_id,code:p.stage_code,title:p.stage_title,position:p.stage_position,total:Number(p.stage_total)},tasks:tasks.map((t):ProjectTaskDto=>({id:t.id,number:String(t.position).padStart(2,'0'),title:t.title,description:t.description,status:t.status,xpReward:t.xp_reward,weight:t.weight}))};}
  private conversation=(r:any):AiConversationDto=>({id:r.id,title:r.title,courseId:r.course_id,lessonId:r.lesson_id,projectId:r.project_id,createdAt:r.created_at.toISOString?.()??r.created_at,updatedAt:r.updated_at.toISOString?.()??r.updated_at});
  private message=(r:any):AiMessageDto=>({id:r.id,role:r.role,content:r.content,createdAt:r.created_at.toISOString?.()??r.created_at});
}
