// Unsaved form input is a draft, not a second copy of the group roster.
export function attendanceDraft(root=document){
  return [...root.querySelectorAll('.attendance-row')].filter(row=>row.dataset.statusDirty||row.dataset.noteDirty).map(row=>({
    studentId:row.dataset.student,status:row.querySelector('input:checked')?.value,
    note:row.querySelector('.note-input')?.value,statusDirty:Boolean(row.dataset.statusDirty),noteDirty:Boolean(row.dataset.noteDirty),
    focused:row.contains(document.activeElement)?document.activeElement.type:null,start:row.querySelector('.note-input')?.selectionStart,end:row.querySelector('.note-input')?.selectionEnd
  }));
}
export function restoreAttendanceDraft(draft,root=document){
  let retained=0;
  for(const item of draft){
    const row=[...root.querySelectorAll('.attendance-row')].find(row=>row.dataset.student===item.studentId&&row.dataset.currentMember!=='false');
    if(!row)continue;
    if(item.statusDirty){row.querySelectorAll('input[type=radio]').forEach(input=>input.checked=input.value===item.status);row.dataset.statusDirty='true';}
    if(item.noteDirty){row.querySelector('.note-input').value=item.note;row.dataset.noteDirty='true';}
    const focus=item.focused==='text'?row.querySelector('.note-input'):item.focused==='radio'?row.querySelector('input:checked'):null;
    if(focus&&!focus.disabled){focus.focus();if(item.focused==='text')focus.setSelectionRange(item.start,item.end);}
    retained++;
  }
  updateAttendanceSummary(root);return retained>0;
}
export function updateAttendanceSummary(root=document){
  const rows=[...root.querySelectorAll('.attendance-row')].filter(row=>row.dataset.currentMember!=='false');
  const values=[rows.length,rows.filter(row=>row.querySelector('input[value=present]')?.checked).length,rows.filter(row=>row.querySelector('input[value=late]')?.checked).length];
  root.querySelectorAll('.attendance-summary>span>b').forEach((item,index)=>item.textContent=values[index]);
}
