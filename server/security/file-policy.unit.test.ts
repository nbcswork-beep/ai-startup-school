import { describe,expect,it } from 'vitest';
import { createFileUploadPlan } from './file-policy.js';

describe('private educational file policy',()=>{
  it('generates an owned server path and ignores user filenames for storage paths',()=>{const plan=createFileUploadPlan('10000000-0000-4000-8000-000000000001',{name:'../../робота.png',mimeType:'image/png',size:8,scope:'homework'},new Uint8Array([137,80,78,71,13,10,26,10]));expect(plan.objectPath).toMatch(/^homework\/10000000-0000-4000-8000-000000000001\/[0-9a-f-]+\.png$/);expect(plan.objectPath).not.toContain('..');expect(plan.bucket).toBe('education-private');});
  it('rejects unsupported metadata, oversized files, and spoofed content types',()=>{expect(()=>createFileUploadPlan('u',{name:'x.svg',mimeType:'image/svg+xml',size:10,scope:'portfolio'},new Uint8Array([60,115,118,103]))).toThrow();expect(()=>createFileUploadPlan('u',{name:'x.png',mimeType:'image/png',size:20*1024*1024,scope:'portfolio'},new Uint8Array([137,80,78,71,13,10,26,10]))).toThrow();expect(()=>createFileUploadPlan('u',{name:'x.png',mimeType:'image/png',size:10,scope:'portfolio'},new Uint8Array([60,115,118,103]))).toThrow(/Вміст файлу/);});
});
