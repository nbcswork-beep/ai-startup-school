let accessToken='';

async function request(path,options={},retry=true){
  const headers=new Headers(options.headers);if(options.body&&!headers.has('content-type'))headers.set('content-type','application/json');if(accessToken)headers.set('authorization',`Bearer ${accessToken}`);
  const response=await fetch(`/api/v1${path}`,{...options,headers,credentials:'include'});
  if(response.status===401&&retry&&!path.startsWith('/auth/')){const refreshed=await fetch('/api/v1/auth/refresh',{method:'POST',credentials:'include'});if(refreshed.ok){accessToken=(await refreshed.json()).accessToken;return request(path,options,false)}}
  const payload=response.status===204?null:await response.json().catch(()=>({}));if(!response.ok){const error=new Error(payload?.error?.message||'Не вдалося виконати захищену операцію');error.status=response.status;throw error}return payload;
}

export const adminApi={
  async authenticate(){const response=await request('/auth/refresh',{method:'POST'},false);accessToken=response.accessToken;return response.user},
  async logout(){await request('/auth/logout',{method:'POST'},false);accessToken=''},
  workspace:()=>request('/admin/bootstrap'),
  search:q=>request(`/admin/search?q=${encodeURIComponent(q)}`),
  explore:(entity,{page=1,pageSize=25,sort='id',direction='asc',q=''})=>request(`/admin/explorer/${entity}?page=${page}&pageSize=${pageSize}&sort=${encodeURIComponent(sort)}&direction=${direction}&q=${encodeURIComponent(q)}`),
  setAccountStatus:(id,input)=>request(`/admin/users/${id}/status`,{method:'PATCH',body:JSON.stringify(input)}),
  correctAttendance:(id,input)=>request(`/admin/attendance/${id}`,{method:'PATCH',body:JSON.stringify(input)}),
  setPortfolioVisibility:(id,input)=>request(`/admin/portfolios/${id}/visibility`,{method:'PATCH',body:JSON.stringify(input)}),
  revokeGuardianLink:(id,reason)=>request(`/admin/guardian-links/${id}/revoke`,{method:'POST',body:JSON.stringify({reason})}),
  resendReport:id=>request(`/admin/reports/${id}/resend`,{method:'POST',body:JSON.stringify({confirm:true})}),
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
