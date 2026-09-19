import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:process.env.TEST_DATABASE_SSL==='false'?false:{rejectUnauthorized:false}});
const studentA='10000000-0000-4000-8000-000000000001';
const studentB='10000000-0000-4000-8000-000000000099';
const teacher='12000000-0000-4000-8000-000000000002';
const guardian='13000000-0000-4000-8000-000000000001';
const admin='14000000-0000-4000-8000-000000000001';
const group='70000000-0000-4000-8000-000000000001';
const privateNote='94000000-0000-4000-8000-000000000001';

async function asUser(userId:string,sql:string,values:unknown[]=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({role:'authenticated',app_user_id:userId})]);const r=await c.query(sql,values);await c.query('rollback');return r;}finally{c.release();}}

describe('RLS ownership',()=>{
  beforeAll(async()=>{await pool.query(`insert into public.users(id) values($1) on conflict do nothing`,[studentB]);await pool.query(`insert into public.student_profiles(user_id,display_name,level_id) values($1,'Other student',(select id from public.levels order by min_xp limit 1)) on conflict do nothing`,[studentB]);await pool.query(`insert into public.teacher_private_notes(id,student_id,teacher_id,category,content) values($1,$2,$3,'learning','RLS private note') on conflict do nothing`,[privateNote,studentA,teacher]);});
  afterAll(async()=>{await pool.query(`delete from public.teacher_private_notes where id=$1`,[privateNote]);await pool.query(`delete from public.users where id=$1`,[studentB]);await pool.end();});
  it('prevents student B from reading A projects and conversations',async()=>{expect((await asUser(studentB,`select * from public.projects where user_id=$1`,[studentA])).rowCount).toBe(0);expect((await asUser(studentB,`select * from public.ai_conversations where user_id=$1`,[studentA])).rowCount).toBe(0);});
  it('allows student A to read their own rows',async()=>{expect((await asUser(studentA,`select * from public.projects where user_id=$1`,[studentA])).rowCount).toBeGreaterThan(0);});
  it('prevents students from reading another student homework or grading',async()=>{
    expect((await asUser(studentB,`select * from public.homework_submissions where student_id=$1`,[studentA])).rowCount).toBe(0);
    await expect(asUser(studentB,`insert into public.homework_reviews(submission_id,reviewer_id,score,effort,status) values('74000000-0000-4000-8000-000000000002',$1,10,'high_effort','completed')`,[studentB])).rejects.toBeTruthy();
  });
  it('allows assigned teacher group access but rejects an unrelated group',async()=>{
    expect((await asUser(teacher,`select * from public.groups where id=$1`,[group])).rowCount).toBe(1);
    expect((await asUser(teacher,`select * from public.groups where id='70000000-0000-4000-8000-000000000099'`)).rowCount).toBe(0);
  });
  it('prevents a teacher from writing student-owned project records',async()=>{
    await expect(asUser(teacher,`insert into public.projects(user_id,title,stage_id) values($1,'Teacher project','31000000-0000-4000-8000-000000000001')`,[teacher])).rejects.toBeTruthy();
  });
  it('limits guardian reports and keeps portfolios non-public',async()=>{
    expect((await asUser(guardian,`select * from public.parent_reports where student_id=$1 and status in('approved','sent')`,[studentA])).rowCount).toBe(0);
    expect((await asUser(studentB,`select * from public.portfolios where student_id=$1`,[studentA])).rowCount).toBe(0);
  });
  it('removes guardian access immediately when the relationship is revoked',async()=>{
    const client=await pool.connect();
    try{
      await client.query('begin');
      await client.query(`update public.parent_reports set status='approved',approved_by=$1,approved_at=now() where student_id=$2`,[teacher,studentA]);
      await client.query(`update public.guardian_student_links set status='revoked',revoked_at=now() where guardian_id=$1 and student_id=$2`,[guardian,studentA]);
      await client.query('set local role authenticated');
      await client.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({role:'authenticated',app_user_id:guardian})]);
      expect((await client.query(`select * from public.parent_reports where student_id=$1`,[studentA])).rowCount).toBe(0);
      await client.query('rollback');
    }finally{client.release();}
  });
  it('prevents attaching a student-owned file to another student submission',async()=>{
    await expect(asUser(studentB,`with asset as (
      insert into public.file_assets(owner_user_id,bucket,object_path,original_name,mime_type,size_bytes,status)
      values($1,'homework-private','tests/foreign.txt','foreign.txt','text/plain',10,'ready') returning id
    ) insert into public.submission_attachments(submission_id,file_asset_id,kind)
      select '74000000-0000-4000-8000-000000000002',id,'file' from asset`,[studentB])).rejects.toBeTruthy();
  });
  it('keeps teacher private notes hidden from students and guardians',async()=>{
    expect((await asUser(teacher,`select * from public.teacher_private_notes where id=$1`,[privateNote])).rowCount).toBe(1);
    expect((await asUser(studentA,`select * from public.teacher_private_notes where id=$1`,[privateNote])).rowCount).toBe(0);
    expect((await asUser(guardian,`select * from public.teacher_private_notes where id=$1`,[privateNote])).rowCount).toBe(0);
  });
  it('allows assigned educational files but rejects unrelated student files',async()=>{
    const owned=(await pool.query(`select id from public.file_assets where owner_user_id=$1 limit 1`,[studentA])).rows[0];
    if(owned)expect((await asUser(teacher,`select * from public.file_assets where id=$1`,[owned.id])).rowCount).toBe(1);
    const foreign=await pool.query(`insert into public.file_assets(owner_user_id,bucket,object_path,original_name,mime_type,size_bytes,status) values($1,'homework-private','tests/unrelated.txt','unrelated.txt','text/plain',10,'ready') returning id`,[studentB]);
    try{expect((await asUser(teacher,`select * from public.file_assets where id=$1`,[foreign.rows[0].id])).rowCount).toBe(0);}finally{await pool.query(`delete from public.file_assets where id=$1`,[foreign.rows[0].id]);}
  });
  it('allows active admin domain reads while keeping private session hashes inaccessible',async()=>{
    expect((await asUser(admin,`select id from public.users where id in($1,$2)`,[studentA,teacher])).rowCount).toBe(2);
    await expect(asUser(admin,`select refresh_token_hash from app_private.auth_sessions limit 1`)).rejects.toBeTruthy();
  });
  it('rejects privileged functions and arbitrary guardian links for non-admin roles',async()=>{
    await expect(asUser(studentA,`select public.admin_set_account_status($1,'disabled','attempt','rls-test')`,[teacher])).rejects.toBeTruthy();
    await expect(asUser(guardian,`insert into public.guardian_student_links(guardian_id,student_id,status,invited_by) values($1,$2,'active',$1)`,[guardian,studentB])).rejects.toBeTruthy();
  });
  it('keeps another student portfolio private',async()=>{
    expect((await asUser(studentB,`select * from public.portfolios where student_id=$1`,[studentA])).rowCount).toBe(0);
  });
});
