let changes;
try { changes = new BroadcastChannel('aiss-academic-changes'); } catch {}
export function announceAcademicChange(){changes?.postMessage({changed:true});window.dispatchEvent(new Event('aiss-academic-change'));}

// Read an authorized revision, then refresh only when shared academic state changed.
// No lesson/homework status is stored in localStorage, and hidden pages stop polling.
export function startAcademicSync({revision,refresh,canApply=()=>true,onError=()=>{}}){
  let previous='',busy=false;
  const check=async()=>{
    if(busy||document.hidden||!canApply())return;
    busy=true;
    try{const value=(await revision()).revision;if(value!==previous&&canApply()){const applied=await refresh();if(applied!==false)previous=value;}}
    catch(error){onError(error);}finally{busy=false;}
  };
  setInterval(check,5000);
  window.addEventListener('focus',check);
  document.addEventListener('visibilitychange',check);
  window.addEventListener('aiss-academic-change',check);
  changes?.addEventListener('message',check);
  check();
}
