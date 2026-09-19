import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors/app-error.js';

const accepted={
  'image/png':{extension:'png',signature:(bytes:Uint8Array)=>bytes.slice(0,8).every((value,index)=>value===[137,80,78,71,13,10,26,10][index])},
  'image/jpeg':{extension:'jpg',signature:(bytes:Uint8Array)=>bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff},
  'image/webp':{extension:'webp',signature:(bytes:Uint8Array)=>Buffer.from(bytes.slice(0,4)).toString()==='RIFF'&&Buffer.from(bytes.slice(8,12)).toString()==='WEBP'},
  'application/pdf':{extension:'pdf',signature:(bytes:Uint8Array)=>Buffer.from(bytes.slice(0,5)).toString()==='%PDF-'},
  'text/plain':{extension:'txt',signature:(bytes:Uint8Array)=>!bytes.slice(0,512).some(value=>value===0)}
} as const;
const metadata=z.object({name:z.string().trim().min(1).max(180),mimeType:z.enum(['image/png','image/jpeg','image/webp','application/pdf','text/plain']),size:z.number().int().positive().max(10*1024*1024),scope:z.enum(['homework','project','portfolio','class-material'])}).strict();

export function createFileUploadPlan(userId:string,input:unknown,headerBytes:Uint8Array){const value=metadata.parse(input),policy=accepted[value.mimeType];if(headerBytes.length===0||!policy.signature(headerBytes))throw new AppError('FILE_CONTENT_MISMATCH',400,'Вміст файлу не відповідає дозволеному типу');return{bucket:'education-private',objectPath:`${value.scope}/${userId}/${randomUUID()}.${policy.extension}`,originalName:value.name,mimeType:value.mimeType,size:value.size};}
