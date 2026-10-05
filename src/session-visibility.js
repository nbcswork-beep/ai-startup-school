export const sessionFilters=[['active','Актуальні'],['completed','Завершені'],['cancelled','Скасовані'],['archived','Архів'],['all','Усі / історія']];
export function visibleSessions(sessions,filter='active'){
  return sessions.filter(s=>filter==='all'||(filter==='active'?['scheduled','rescheduled','in_progress'].includes(s.status):filter==='week'?['scheduled','rescheduled','in_progress'].includes(s.status)&&Date.parse(s.startsAt)<=Date.now()+7*86400000:s.status===filter));
}
export function sessionFilterButtons(selected,attribute){
  return `<div class="filter-row">${sessionFilters.map(([key,label])=>`<button type="button" class="${selected===key?'active':''}" ${attribute}="${key}" aria-pressed="${selected===key}">${label}</button>`).join('')}</div>`;
}
