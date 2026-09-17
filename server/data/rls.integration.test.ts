import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

const pool=new Pool({connectionString:process.env.TEST_DATABASE_URL,ssl:process.env.TEST_DATABASE_SSL==='false'?false:{rejectUnauthorized:false}});
const studentA='10000000-0000-4000-8000-000000000001';
const studentB='10000000-0000-4000-8000-000000000099';

async function asUser(userId:string,sql:string,values:unknown[]=[]){const c=await pool.connect();try{await c.query('begin');await c.query('set local role authenticated');await c.query(`select set_config('request.jwt.claims',$1,true)`,[JSON.stringify({role:'authenticated',app_user_id:userId})]);const r=await c.query(sql,values);await c.query('rollback');return r;}finally{c.release();}}

describe('RLS ownership',()=>{
  beforeAll(async()=>{await pool.query(`insert into public.users(id) values($1) on conflict do nothing`,[studentB]);await pool.query(`insert into public.student_profiles(user_id,display_name,level_id) values($1,'Other student',(select id from public.levels order by min_xp limit 1)) on conflict do nothing`,[studentB]);});
  afterAll(async()=>{await pool.query(`delete from public.users where id=$1`,[studentB]);await pool.end();});
  it('prevents student B from reading A projects and conversations',async()=>{expect((await asUser(studentB,`select * from public.projects where user_id=$1`,[studentA])).rowCount).toBe(0);expect((await asUser(studentB,`select * from public.ai_conversations where user_id=$1`,[studentA])).rowCount).toBe(0);});
  it('allows student A to read their own rows',async()=>{expect((await asUser(studentA,`select * from public.projects where user_id=$1`,[studentA])).rowCount).toBeGreaterThan(0);});
});
