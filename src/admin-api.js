import {announceAcademicChange} from './academic-sync.js';
let accessToken='';

async function request(path,options={},retry=true){
  const headers=new Headers(options.headers);if(options.body&&!headers.has('content-type'))headers.set('content-type','application/json');if(accessToken)headers.set('authorization',`Bearer ${accessToken}`);
  const response=await fetch(`/api/v1${path}`,{...options,headers,credentials:'include',cache:'no-store'});
  if(response.status===401&&retry&&!path.startsWith('/auth/')){const refreshed=await fetch('/api/v1/auth/refresh',{method:'POST',credentials:'include'});if(refreshed.ok){accessToken=(await refreshed.json()).accessToken;return request(path,options,false)}}
  const payload=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok){const error=new Error(payload?.error?.message||'Не вдалося виконати захищену операцію');error.status=response.status;throw error}if(options.method&&!path.startsWith('/auth/'))announceAcademicChange();return payload;
}

/** A file from a protected endpoint (exports), with the name the server gave it. */
async function download(path,retry=true){
  const headers=new Headers();if(accessToken)headers.set('authorization',`Bearer ${accessToken}`);
  const response=await fetch(`/api/v1${path}`,{headers,credentials:'include',cache:'no-store'});
  if(response.status===401&&retry){const refreshed=await fetch('/api/v1/auth/refresh',{method:'POST',credentials:'include'});if(refreshed.ok){accessToken=(await refreshed.json()).accessToken;return download(path,false)}}
  if(!response.ok){const payload=await response.json().catch(()=>({}));throw new Error(payload?.error?.message||'Не вдалося завантажити файл')}
  const disposition=response.headers.get('content-disposition')??'';
  return{blob:await response.blob(),fileName:/filename="([^"]+)"/.exec(disposition)?.[1]??'download'};
}

export const adminApi={
  async authenticate(){const response=await request('/auth/refresh',{method:'POST'},false);accessToken=response.accessToken;return response.user},
  async logout(){await request('/auth/logout',{method:'POST'},false);accessToken=''},
  groupDirectory:()=>request('/admin/groups/directory'),
  group:id=>request('/admin/groups/'+id),
  createGroup:input=>request('/admin/groups',{method:'POST',body:JSON.stringify(input)}),
  updateGroup:(id,input)=>request('/admin/groups/'+id,{method:'PATCH',body:JSON.stringify(input)}),
  archiveGroup:(id,expectedVersion)=>request('/admin/groups/'+id+'/archive',{method:'POST',body:JSON.stringify({expectedVersion})}),
  setGroupStudent:(groupId,studentId,add,expectedVersion)=>request('/admin/groups/'+groupId+'/students/'+studentId,{method:'PUT',body:JSON.stringify({add,expectedVersion})}),
  saveOneAttendance:(id,studentId,status)=>request('/teacher/sessions/'+id+'/attendance/'+studentId,{method:'PUT',body:JSON.stringify({status})}),
  updateClass:(id,input)=>request('/teacher/sessions/'+id,{method:'PATCH',body:JSON.stringify(input)}),
  createClass:input=>request('/teacher/sessions',{method:'POST',body:JSON.stringify(input)}),
  createHomework:input=>request('/teacher/homework',{method:'POST',body:JSON.stringify(input)}),
  revision:()=>request('/academic-revision'),
  workspace:()=>request('/admin/bootstrap'),
  search:q=>request(`/admin/search?q=${encodeURIComponent(q)}`),
  explore:(entity,{page=1,pageSize=25,sort='id',direction='asc',q=''})=>request(`/admin/explorer/${entity}?page=${page}&pageSize=${pageSize}&sort=${encodeURIComponent(sort)}&direction=${direction}&q=${encodeURIComponent(q)}`),
  setAccountStatus:(id,input)=>request(`/admin/users/${id}/status`,{method:'PATCH',body:JSON.stringify(input)}),
  correctAttendance:(id,input)=>request(`/admin/attendance/${id}`,{method:'PATCH',body:JSON.stringify(input)}),
  setPortfolioVisibility:(id,input)=>request(`/admin/portfolios/${id}/visibility`,{method:'PATCH',body:JSON.stringify(input)}),
  revokeGuardianLink:(id,reason)=>request(`/admin/guardian-links/${id}/revoke`,{method:'POST',body:JSON.stringify({reason})}),
  resendReport:id=>request(`/admin/reports/${id}/resend`,{method:'POST',body:JSON.stringify({confirm:true})}),
  extendSession:(id,expectedExpiresAt)=>request('/admin/sessions/'+id+'/extend',{method:'POST',body:JSON.stringify({expectedExpiresAt})}),
  revokeSession:(id,reason)=>request(`/admin/sessions/${id}/revoke`,{method:'POST',body:JSON.stringify({reason})})
  ,resolveParentRequest:id=>request(`/admin/parent-requests/${id}/resolve`,{method:'POST',body:JSON.stringify({confirm:true})})
  ,createStudent:input=>request('/admin/students',{method:'POST',body:JSON.stringify(input)})
  ,updateStudent:(id,input)=>request(`/admin/students/${id}`,{method:'PATCH',body:JSON.stringify(input)})
  ,setTelegram:(id,input)=>request(`/admin/users/${id}/telegram`,{method:'PUT',body:JSON.stringify(input)})
  ,createGuardian:input=>request('/admin/guardians',{method:'POST',body:JSON.stringify(input)})
  ,updateGuardian:(id,input)=>request(`/admin/guardians/${id}`,{method:'PATCH',body:JSON.stringify(input)})
  ,linkGuardian:(guardianId,studentId)=>request(`/admin/guardians/${guardianId}/students/${studentId}`,{method:'POST'})
  ,unlinkGuardian:(guardianId,studentId)=>request(`/admin/guardians/${guardianId}/students/${studentId}`,{method:'DELETE'})
  ,createStaff:input=>request('/admin/staff',{method:'POST',body:JSON.stringify(input)})
  ,updateStaff:(id,input)=>request(`/admin/staff/${id}`,{method:'PATCH',body:JSON.stringify(input)})
};

// AI assistant administration. Keys go to the server once and never come back.
const json=(method,body)=>({method,body:JSON.stringify(body??{})});
Object.assign(adminApi,{
  aiProviders:()=>request('/admin/ai/providers'),
  aiCreateProvider:input=>request('/admin/ai/providers',json('POST',input)),
  aiUpdateProvider:(id,input)=>request(`/admin/ai/providers/${id}`,json('PATCH',input)),
  aiDeleteProvider:id=>request(`/admin/ai/providers/${id}`,{method:'DELETE'}),
  aiTestProvider:id=>request(`/admin/ai/providers/${id}/test`,json('POST')),
  aiDiscover:id=>request(`/admin/ai/providers/${id}/models`),
  aiSyncBalance:id=>request(`/admin/ai/providers/${id}/balance`,json('POST')),
  aiAddKey:(id,input)=>request(`/admin/ai/providers/${id}/keys`,json('POST',input)),
  aiUpdateKey:(id,keyId,input)=>request(`/admin/ai/providers/${id}/keys/${keyId}`,json('PATCH',input)),
  aiDeleteKey:(id,keyId)=>request(`/admin/ai/providers/${id}/keys/${keyId}`,{method:'DELETE'}),
  aiCreateModel:input=>request('/admin/ai/models',json('POST',input)),
  aiUpdateModel:(id,input)=>request(`/admin/ai/models/${id}`,json('PATCH',input)),
  aiDeleteModel:id=>request(`/admin/ai/models/${id}`,{method:'DELETE'}),
  aiFeedback: ()=>request('/admin/ai/feedback'),
  aiProbeModel: id=>request(`/admin/ai/models/${id}/probe`,json('POST',{})),
  aiTestModel:(id,prompt)=>request(`/admin/ai/models/${id}/test`,json('POST',prompt?{prompt}:{})),
  aiSettings:input=>request('/admin/ai/settings',json('PUT',input)),
  aiSetAccess:(scope,id,input)=>request(`/admin/ai/access/${scope}/${id}`,json('PUT',input)),
  aiDeleteAccess:(scope,id)=>request(`/admin/ai/access/${scope}/${id}`,{method:'DELETE'}),
  aiTokens:()=>request('/admin/ai/tokens'),
  aiAdjust:(studentId,input)=>request(`/admin/ai/tokens/students/${studentId}`,json('POST',input)),
  aiFlags:(studentId,input)=>request(`/admin/ai/tokens/students/${studentId}/flags`,json('POST',input)),
  aiGroupGrant:(groupId,input)=>request(`/admin/ai/tokens/groups/${groupId}`,json('POST',input)),
  aiLedger:(studentId,limit=100)=>request(`/admin/ai/tokens/ledger?limit=${limit}${studentId?`&studentId=${studentId}`:''}`),
  aiResources:()=>request('/admin/ai/resources'),
  aiCreatePackage:input=>request('/admin/ai/resources/packages',json('POST',input)),
  aiUpdatePackage:(id,input)=>request(`/admin/ai/resources/packages/${id}`,json('PATCH',input)),
  aiDeletePackage:id=>request(`/admin/ai/resources/packages/${id}`,{method:'DELETE'}),
  aiAgent:()=>request('/admin/ai/agent'),
  aiCreateSkill:input=>request('/admin/ai/skills',json('POST',input)),
  aiUpdateSkill:(id,input)=>request(`/admin/ai/skills/${id}`,json('PATCH',input)),
  aiDeleteSkill:id=>request(`/admin/ai/skills/${id}`,{method:'DELETE'}),
  aiImportSkills:files=>request('/admin/ai/skills/import',json('POST',{files})),
  aiExportSkills:id=>download(`/admin/ai/skills/export${id?`?id=${encodeURIComponent(id)}`:''}`),
  aiInstallPlugin:id=>request(`/admin/ai/plugins/${id}/install`,json('POST')),
  aiImportPlugin:manifest=>request('/admin/ai/plugins/import',json('POST',{manifest})),
  aiUpdatePlugin:(id,input)=>request(`/admin/ai/plugins/${id}`,json('PATCH',input)),
  aiDeletePlugin:id=>request(`/admin/ai/plugins/${id}`,{method:'DELETE'}),
  aiAnalytics:filter=>request(`/admin/ai/analytics?${new URLSearchParams(Object.entries(filter).filter(([,value])=>value))}`)
});
