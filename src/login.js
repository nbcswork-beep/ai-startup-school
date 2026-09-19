const params=new URLSearchParams(location.search);
const next=params.get('next')==='/admin.html'?'/admin.html':'/teacher.html';
const target=next==='/admin.html'?'admin':'teacher';
const form=document.querySelector('#login-form');
const errorNode=document.querySelector('#login-error');
const title=document.querySelector('#login-title');
const identity=document.querySelector('#identity-label');

if(target==='admin'){
  document.title='AI Startup School — Admin Login';
  title.textContent='Вхід до Admin Control Center';
  identity.textContent='ADMIN CONTROL CENTER';
  document.querySelector('.intro').textContent='Захищене операційне середовище для адміністрування школи та контролю доступу.';
}

async function responsePayload(response){return response.status===204?null:response.json().catch(()=>({}))}
async function existingSession(){
  const refresh=await fetch('/api/v1/auth/refresh',{method:'POST',credentials:'include'});
  if(!refresh.ok)return false;
  const result=await refresh.json();
  const probe=await fetch(target==='admin'?'/api/v1/admin/bootstrap':'/api/v1/teacher/bootstrap',{headers:{authorization:`Bearer ${result.accessToken}`},credentials:'include'});
  return probe.ok;
}

form.addEventListener('submit',async event=>{
  event.preventDefault();errorNode.textContent='';
  const submit=form.querySelector('button');submit.disabled=true;submit.querySelector('span').textContent='Перевіряємо…';
  const data=new FormData(form);
  try{
    const response=await fetch('/api/v1/auth/web',{method:'POST',credentials:'include',headers:{'content-type':'application/json'},body:JSON.stringify({email:data.get('email'),password:data.get('password'),target})});
    const payload=await responsePayload(response);
    if(!response.ok)throw new Error(payload?.error?.message||'Не вдалося увійти');
    location.replace(next);
  }catch(error){errorNode.textContent=error.message;submit.disabled=false;submit.querySelector('span').textContent='Увійти'}
});

existingSession().then(active=>{if(active)location.replace(next)}).catch(()=>{});
