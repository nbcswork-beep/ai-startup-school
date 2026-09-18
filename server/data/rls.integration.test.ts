import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:process.env.TEST_DATABASE_SSL==='false'?false:{rejectUnauthorized:false}});
const studentA='10000000-0000-4000-8000-000000000001';
const studentB='10000000-0000-4000-8000-000000000099';
const teacher='12000000-0000-4000-8000-000000000001';
const guardian='13000000-0000-4000-8000-000000000001';
const group='70000000-0000-4000-8000-000000000001';

async function asUser(userId:string,sql:string,values:unknown[]=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({role:'authenticated',app_user_id:userId})]);const r=await c.query(sql,values);await c.query('rollback');return r;}finally{c.release();}}

describe('RLS ownership',()=>{
  beforeAll(async()=>{await pool.query(`insert into public.users(id) values($1) on conflict do nothing`,[studentB]);await pool.query(`insert into public.student_profiles(user_id,display_name,level_id) values($1,'Other student',(select id from public.levels order by min_xp limit 1)) on conflict do nothing`,[studentB]);});
  afterAll(async()=>{await pool.query(`delete from public.users where id=$1`,[studentB]);await pool.end();});
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
});
