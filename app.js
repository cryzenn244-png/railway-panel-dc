const $ = s => document.querySelector(s);
let selectedBot = null, toastTimer;
async function api(url, options={}) {
  const headers = { ...(options.body && !(options.body instanceof FormData) ? {'Content-Type':'application/json'} : {}), ...(options.headers||{}) };
  const response = await fetch(url, {...options, headers});
  const data = await response.json().catch(()=>({error:'Unexpected server response.'}));
  if (response.status === 401 && url !== '/api/login') showLogin();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function toast(message, bad=false) {
  const el=$('#toast'); el.textContent=message; el.className='toast'+(bad?' bad':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.className='toast hidden',3500);
}
function showLogin(){ $('#loginView').classList.remove('hidden'); $('#appView').classList.add('hidden'); $('#modal').classList.add('hidden'); }
function showApp(){ $('#loginView').classList.add('hidden'); $('#appView').classList.remove('hidden'); }
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
async function checkSession(){
 try { const me=await api('/api/me'); if(me.authenticated){showApp();$('#uploadLimit').textContent=me.maxUploadMB+' MB';$('#uploadLimit2').textContent=me.maxUploadMB+' MB';await refreshBots();}else showLogin(); } catch {showLogin();}
}
$('#loginForm').addEventListener('submit',async e=>{e.preventDefault();$('#loginError').textContent='';const form=new FormData(e.target);try{await api('/api/login',{method:'POST',body:JSON.stringify({username:form.get('username'),password:form.get('password')})});e.target.reset();showApp();await refreshBots();}catch(err){$('#loginError').textContent=err.message;}});
$('#logoutBtn').addEventListener('click',async()=>{try{await api('/api/logout',{method:'POST'});}catch{}showLogin();});
function switchPage(page){
 $('#overviewPage').classList.toggle('hidden',page!=='overview');$('#botsPage').classList.toggle('hidden',page!=='bots');$('#detailPage').classList.toggle('hidden',page!=='detail');
 document.querySelectorAll('.nav').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 $('#pageTitle').innerHTML=(page==='overview'?'Overview':page==='bots'?'Bot instances':escapeHtml(selectedBot?.name||'Bot'))+'<span class="accent">.</span>';
 $('#pageDesc').textContent=page==='overview'?'Your bots, files and runtime at a glance.':page==='bots'?'Create and manage your bot workspaces.':'Files, runtime and process output.';
}
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>{switchPage(b.dataset.page);if(b.dataset.page==='bots')refreshBots();}));
$('#viewAll').addEventListener('click',()=>{switchPage('bots');refreshBots();});
$('#heroCreate').addEventListener('click',openModal);$('#createBtn').addEventListener('click',openModal);
function openModal(){$('#modal').classList.remove('hidden');$('#createError').textContent='';}
$('#closeModal').addEventListener('click',()=>$('#modal').classList.add('hidden'));
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))$('#modal').classList.add('hidden');});
$('#createForm').addEventListener('submit',async e=>{e.preventDefault();try{const name=new FormData(e.target).get('name');const result=await api('/api/bots',{method:'POST',body:JSON.stringify({name})});$('#modal').classList.add('hidden');e.target.reset();toast('Workspace created.');await refreshBots();openBot(result.bot.id);}catch(err){$('#createError').textContent=err.message;}});
function botCard(bot){return `<article class="bot-card glass"><div class="bot-card-top"><div class="bot-icon">◇</div><div><h3>${escapeHtml(bot.name)}</h3><p>${bot.files} project file${bot.files===1?'':'s'}</p></div></div><div class="status-line"><span>Runtime status</span><b class="status-text ${bot.running?'':'stopped'}">${bot.running?'● Running':'● Stopped'}</b></div><button class="card-open" data-open="${escapeHtml(bot.id)}">Manage workspace ↗</button></article>`;}
async function refreshBots(){
 try{const data=await api('/api/bots');$('#botCount').textContent=data.bots.length;$('#runningCount').textContent=data.bots.filter(b=>b.running).length;
 const html=data.bots.length?data.bots.map(botCard).join(''):'<div class="empty">No bot workspaces yet. Create one to get started.</div>';
 $('#allBots').innerHTML=html;$('#recentBots').innerHTML=html;
 document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openBot(b.dataset.open)));
 if(selectedBot){const updated=data.bots.find(b=>b.id===selectedBot.id);if(updated){selectedBot=updated;$('#detailStatus').innerHTML=`<i></i> ${updated.running?'Running':'Stopped'}`;}}
 }catch(e){toast(e.message,true);}
}
async function openBot(id){
 try{const data=await api('/api/bots');const bot=data.bots.find(b=>b.id===id);if(!bot)throw new Error('Bot not found.');selectedBot=bot;switchPage('detail');$('#detailName').textContent=bot.name;$('#entryFile').value='index.js';await refreshFiles();await refreshLogs();}catch(e){toast(e.message,true);}
}
$('#backBtn').addEventListener('click',()=>{switchPage('bots');refreshBots();});
$('#refreshFiles').addEventListener('click',refreshFiles);
async function refreshFiles(){
 if(!selectedBot)return;try{const data=await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/files`);
 $('#fileList').innerHTML=data.files.length?data.files.map(f=>`<div class="file-row"><span class="file-symbol">▤</span><div class="file-info"><b>${escapeHtml(f.name)}</b><small>${(f.size/1024).toFixed(1)} KB</small></div><div class="file-actions"><button class="ghost" data-download="${escapeHtml(f.name)}">Download</button><button class="danger" data-delete="${escapeHtml(f.name)}">Delete</button></div></div>`).join(''):'<div class="empty">No files yet. Upload a ZIP or individual project files.</div>';
 document.querySelectorAll('[data-download]').forEach(b=>b.addEventListener('click',()=>downloadFile(b.dataset.download)));
 document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>deleteFile(b.dataset.delete)));
 }catch(e){toast(e.message,true);}
}
async function downloadFile(name){
 try{const r=await fetch(`/api/bots/${encodeURIComponent(selectedBot.id)}/file?name=${encodeURIComponent(name)}`);if(!r.ok){const d=await r.json().catch(()=>({}));throw new Error(d.error||'Download failed.');}const blob=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name.split('/').pop();a.click();URL.revokeObjectURL(a.href);}catch(e){toast(e.message,true);}
}
async function deleteFile(name){if(!confirm(`Delete ${name}?`))return;try{await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/file`,{method:'DELETE',body:JSON.stringify({name})});toast('File deleted.');await refreshFiles();}catch(e){toast(e.message,true);}}
$('#uploadBtn').addEventListener('click',async()=>{
 const input=$('#fileInput');if(!selectedBot||!input.files.length){toast('Choose files to upload first.',true);return;}
 const body=new FormData();for(const file of input.files)body.append('files',file);
 $('#uploadBtn').disabled=true;$('#uploadBtn').textContent='Uploading…';
 try{const result=await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/upload`,{method:'POST',body});toast(`Uploaded ${result.results.length} item(s).`);input.value='';await refreshFiles();await refreshBots();}
 catch(e){toast(e.message,true);}finally{$('#uploadBtn').disabled=false;$('#uploadBtn').textContent='Upload files';}
});
$('#startBtn').addEventListener('click',async()=>{try{await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/start`,{method:'POST',body:JSON.stringify({entry:$('#entryFile').value.trim()})});toast('Start requested.');await refreshBots();await refreshLogs();}catch(e){toast(e.message,true);}});
$('#stopBtn').addEventListener('click',async()=>{try{await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/stop`,{method:'POST'});toast('Stop requested.');await refreshBots();await refreshLogs();}catch(e){toast(e.message,true);}});
$('#refreshLogs').addEventListener('click',refreshLogs);
async function refreshLogs(){
 if(!selectedBot)return;try{const data=await api(`/api/bots/${encodeURIComponent(selectedBot.id)}/logs`);const out=$('#consoleOutput');out.innerHTML=data.logs.length?data.logs.map(l=>`<div class="console-line"><span class="console-time">${escapeHtml(new Date(l.time).toLocaleTimeString())}</span> ${escapeHtml(l.text)}</div>`).join(''):'<span class="console-muted">No output yet. Start your bot to see logs.</span>';out.scrollTop=out.scrollHeight;}catch(e){toast(e.message,true);}
}
checkSession();
