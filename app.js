'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {Running:'运行中',Stopped:'已停止',Failed:'失败',Queuing:'排队中',Starting:'启动中',Stopping:'停止中',Recovering:'恢复中',Unknown:'状态未知'};
const fmt = x => typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(1)}%` : '未知';
const time = v => v ? new Date(typeof v === 'number' ? v * 1000 : v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '—';
const publicData = document.body.dataset.source || '';
const fallbackData = document.body.dataset.fallback || '';
if(publicData){document.querySelector('.private-tag').textContent='公开只读监控';document.querySelector('.interval').textContent='约每 60–90 秒更新 · 指标每 5 分钟采样';}
let state = null, filter = 'all', visible = [], inFlight = null, currentDetail = null, loadError = '', fromCache = false;
let retryTimer = null, retryDelay = 5000;
const cacheKey = `dsw-monitor-v1:${publicData || 'local'}`;
const ssh = r => r.ports.find(p => String(p.service).toUpperCase() === 'SSH' && p.active && p.port);
const portOrder = r => Number(ssh(r)?.port ?? 999999);
const m = (r,k) => r.metrics[k] || {};
const metricKnown = (r,k) => m(r,k).fresh && m(r,k).latest !== null && m(r,k).latest !== undefined;
// Allocation confirmed by the owner on 2026-11-19; names and active ports remain live API data.
const allocations = [
 {id:'fudan',name:'复旦 · qianrui',gpu:16,nodes:[['dsw-ugznzc40h3d5vnlfx3',909],['dsw-vqavb9oc0or51bkgz5',991],['dsw-sq97gl9f1zru2bm1xh',946]]},
 {id:'ntu',name:'NTU · 胡连宇',gpu:12,nodes:[['dsw-hgq4odu0jfbvg7iu8x',951],['dsw-8ox9zktttck0mubnte',1020],['dsw-qwhdob2zqvzesz1ec5',874]]},
 {id:'xie',name:'独立合作者 · 谢育林',gpu:4,nodes:[['dsw-xpe3b8qiiq8a4zmi2u',1088]]},
 {id:'hu',name:'独立合作者 · 胡刘兵',gpu:4,nodes:[['dsw-39vtkvrqohjlhps7yl',987]]},
 {id:'chen',name:'独立合作者 · 陈卢楷',gpu:12,nodes:[['dsw-jsvn6euz7njy70c36j',926],['dsw-x885rk24n7y8dtscod',945]]},
 {id:'zhang',name:'独立合作者 · 张玉鹏',gpu:4,nodes:[['dsw-1orp9falqappmmgj3z',923]]}
];
const unassigned={id:'unassigned',name:'未分组',gpu:null,nodes:[]};
const groupOf = row => allocations.find(g=>g.nodes.some(([id])=>id===row.id))||unassigned;
function groupUsage(rows,kind,weight,confirmed){
 const total=rows.reduce((a,r)=>a+r[weight],0);
 const known=confirmed?rows.filter(r=>metricKnown(r,kind)&&m(r,kind).complete_hour&&Number.isFinite(m(r,kind).avg)):[];
 const covered=known.reduce((a,r)=>a+r[weight],0);
 return {total,covered,avg:covered?known.reduce((a,r)=>a+m(r,kind).avg*r[weight],0)/covered:null};
}
function renderGroups(rows,confirmed){
 const selected=$('group').value||'all';
 $('group-count').textContent='6 组 · 分配 52 张 GPU';
 $('groups').innerHTML=[...allocations,unassigned].map(g=>{
  const members=rows.filter(r=>groupOf(r).id===g.id),running=members.filter(r=>r.status==='Running');
  const gpu=running.reduce((a,r)=>a+r.gpu,0),cpuUsage=groupUsage(running,'CpuCoreUsage','cpu',confirmed),gpuUsage=groupUsage(running,'GpuCoreUsage','gpu',confirmed);
  const idle=confirmed?running.filter(r=>r.idle):[];
  const unknown=running.filter(r=>!confirmed||!metricKnown(r,'CpuCoreUsage')||!metricKnown(r,'GpuCoreUsage')||!m(r,'CpuCoreUsage').complete_hour||!m(r,'GpuCoreUsage').complete_hour).length;
  const missing=g.nodes.filter(([id])=>!members.some(r=>r.id===id)).length;
  const usage=(value,unit)=>`${fmt(value.avg)} <span class="coverage">${value.covered}/${value.total} ${unit}有效</span>`;
  return `<button class="group-card${selected===g.id?' selected':''}" data-group="${g.id}" aria-pressed="${selected===g.id}"><span class="group-name">${esc(g.name)}</span><span class="group-capacity">${gpu}<small> 张运行 / ${g.gpu===null?'未设定':g.gpu+' 张分配'}</small></span><span class="group-ports">${g.nodes.length?'分配端口 '+g.nodes.map(([,port])=>port).join(' · '):'未列入当前分配的节点'}</span><span class="group-usage">近 1h CPU ${usage(cpuUsage,'核')}<br>近 1h GPU ${usage(gpuUsage,'卡')}</span><span class="group-status">${members.length} 台 · ${running.length} 运行 · ${members.length-running.length} 未运行${missing?' · '+missing+' 未查询到':''}<br>${confirmed?`比较空闲 ${idle.length} 台 / ${idle.reduce((a,r)=>a+r.gpu,0)} 卡 · 判断未知 ${unknown} 台`:'数据未确认，暂停用量与空闲判断'}</span></button>`;
 }).join('');
}
$('group').innerHTML='<option value="all">全部分组</option>'+[...allocations,unassigned].map(g=>`<option value="${g.id}">${esc(g.name)}</option>`).join('');
function notify(text) { $('toast').textContent=text; $('toast').classList.add('open');clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('toast').classList.remove('open'),2500); }
function stat(label,value,unit,note,accent=false) { return `<div class="stat${accent?' stat-accent':''}"><div class="stat-top">${label}<span class="stat-icon">▦</span></div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-note">${note}</div></div>`; }
function metric(row,kind) {
 if(row.status!=='Running')return '<span class="muted">—</span>';
 const val=m(row,kind),known=metricKnown(row,kind),n=known?val.latest:0;
 return `<div class="metric ${kind==='GpuCoreUsage'?'gpu':''}"><div class="metric-top ${known&&n<20?'metric-low':''}">${known?fmt(n):'未知 / 过期'}</div><svg class="metric-bar" width="100" height="4" aria-hidden="true"><rect width="100" height="4" fill="#edf2f6"/><rect width="${Math.min(100,Math.max(0,n))}" height="4" fill="${kind==='GpuCoreUsage'?'#529abc':'#7eada3'}"/></svg><div class="submetric">1h 均值 ${fmt(val.avg)}</div></div>`;
}
function renderQueryErrors(snapshot) {
 const errors=snapshot?.errors||[],rows=new Map((snapshot?.instances||[]).map(r=>[r.id,r]));
 const scopes={inventory:'实例详情',CpuCoreUsage:'CPU 利用率',GpuCoreUsage:'GPU 利用率',MemoryUsage:'内存使用率',GpuMemoryUsage:'显存使用率'};
 $('query-errors').hidden=!errors.length;
 $('query-error-count').textContent=`${errors.length} 项`;
 $('query-error-rows').innerHTML=errors.map(error=>{
  const row=rows.get(error.id),port=row&&ssh(row);
  return `<tr><td><strong>${esc(row?.name||'名称未知')}</strong><div class="instance-id">${esc(error.id)}</div></td><td>${port?esc(port.port):'<span class="muted">无就绪映射</span>'}</td><td><span class="badge unknown">${esc(scopes[error.scope]||error.scope)}</span></td><td>${error.scope==='inventory'?'实例状态、配置和端口未知':'该指标已标记未知'}<div class="query-error-note">本轮未取得数据，等待下轮重试</div></td></tr>`;
 }).join('');
}
function render() {
 const s=state?.snapshot;
 $('refresh').disabled=!!state?.collecting||!!inFlight;
 $('refresh').textContent=inFlight?'↻ 正在读取…':state?.collecting?'↻ 采集中…':publicData?'↻ 刷新页面数据':'↻ 立即采集';
 const stale = !s || Date.now()-Date.parse(s.collected_at)>180000 || fromCache;
 $('sync').classList.toggle('warn',stale||!!state?.error||!!loadError);
 $('sync').textContent=loadError?(stale?'自动重连 · 状态未确认':'自动重连 · 保留最近数据'):fromCache?'显示上次缓存':state?.error?'采集异常':!s?'首次采集中':stale?'数据已过期':state.collecting?'正在更新':'数据已同步';
 $('updated').textContent=s?`最近采集：${time(s.collected_at)}`:'等待首次实时数据…';
 const warnings=[];
 if(loadError)warnings.push(loadError);
 if(state?.error){
  const stage={authentication:'认证读取',inventory:'实例列表查询',collector:'数据采集'}[state.collection_failure?.stage];
  warnings.push(`${stage?stage+'失败：':''}${state.error}`);
 }
 if(state?.publish_error)warnings.push(state.publish_error);
 if(state?.cache_error)warnings.push(state.cache_error);
 if(fromCache)warnings.push('当前显示上次缓存，正在尝试连接；尚未确认当前状态。');
 if(s&&Date.now()-Date.parse(s.collected_at)>180000)warnings.push('最近数据已超过 3 分钟，请勿据此判断当前是否空闲。');
 if(s?.errors?.length)warnings.push(`${s.errors.length} 项查询未成功，详见下方「查询未成功」清单。`);
 $('notice').hidden=!warnings.length;$('notice').textContent=warnings.join(' ');
 renderQueryErrors(s);
 if(!s)return;
 const rows=s.instances,running=rows.filter(r=>r.status==='Running'),idle=running.filter(r=>r.idle&&!stale&&!state.error);
 $('summary').innerHTML=stat('全部 DSW',rows.length,'台',`${rows.length-running.length} 台未运行或状态未知`)+stat('运行中',running.length,'台',`${running.reduce((a,r)=>a+r.cpu,0)} 核 CPU 已分配`,true)+stat('已分配 GPU',running.reduce((a,r)=>a+r.gpu,0),'张','统计所有运行中节点')+stat('比较空闲',idle.length,'台',`${idle.reduce((a,r)=>a+r.gpu,0)} 张 GPU · CPU / GPU 均低于 20%`,true);
 renderGroups(rows,!stale&&!state.error);
 const q=$('search').value.trim().toLowerCase();
 visible=rows.filter(r=>filter==='all'||filter==='idle'&&r.idle&&!stale&&!state.error||filter==='other'&&r.status!=='Running'||filter==='Running'&&r.status==='Running').filter(r=>!$('group').value||$('group').value==='all'||groupOf(r).id===$('group').value).filter(r=>!q||[r.name,r.id,groupOf(r).name,...r.ports.flatMap(p=>[p.port,p.host])].some(v=>String(v??'').toLowerCase().includes(q)));
 const order=$('sort').value;
 visible.sort((a,b)=>order==='name'?a.name.localeCompare(b.name):order==='gpu'||order==='cpu'?((metricKnown(a,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage')?m(a,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage').latest:Infinity)-(metricKnown(b,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage')?m(b,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage').latest:Infinity))||portOrder(a)-portOrder(b):portOrder(a)-portOrder(b));
 $('count').textContent=`${visible.length} / ${rows.length}`;
 $('nodes').innerHTML=visible.map(r=>{
  const p=ssh(r),known=metricKnown(r,'CpuCoreUsage')&&metricKnown(r,'GpuCoreUsage');
  const badge=stale||state.error?'数据过期':r.status!=='Running'?'—':r.idle?'比较空闲':!known||!m(r,'CpuCoreUsage').complete_hour||!m(r,'GpuCoreUsage').complete_hour?'数据不足':'有资源使用';
  const tone=badge==='比较空闲'?'idle':badge==='有资源使用'?'busy':'unknown';
  return `<tr><td><button class="node-name" data-detail="${esc(r.id)}">${esc(r.name||'未命名节点')}</button><div class="node-group">${esc(groupOf(r).name)}</div><div class="instance-id">${esc(r.id)}</div></td><td>${p?`<button class="port" data-copy="${esc(r.id)}" title="复制 SSH 连接命令">${esc(p.port)}</button>`:'<span class="muted">无就绪映射</span>'}</td><td><span class="status"><i class="dot ${r.status==='Running'?'green':r.status==='Failed'?'red':r.status==='Queuing'?'amber':''}"></i>${esc(labels[r.status]||r.status)}</span></td><td><div class="resource">${r.gpu} GPU · ${r.cpu} CPU</div><div class="instance-id">${esc(r.memory)}</div></td><td>${metric(r,'CpuCoreUsage')}</td><td>${metric(r,'GpuCoreUsage')}</td><td><span class="badge ${tone}">${badge}</span></td><td><button class="row-action" data-detail="${esc(r.id)}">详情</button></td></tr>`;
 }).join('')||'<tr><td colspan="8" class="empty">没有符合筛选条件的节点</td></tr>';
 $('window').textContent=`指标窗口：${time(s.window_start)} — ${time(s.window_end)} · 5 分钟采样 · 名称直接读取 PAI 接口`;
 if(currentDetail&&$('detail').open)fillDetail(currentDetail);
}
function chart(row,kind,title) {
 const val=m(row,kind),points=val.points||[],s=state.snapshot;
 let graph='<div class="chart-empty">暂无有效指标</div>';
 if(points.length){
  const start=Date.parse(s.window_start)/1000,end=Date.parse(s.window_end)/1000;
  // Keep gaps in the graph rather than suggesting continuous observations.
  let path='',last=null;
  for(const p of points){const x=((p.time-start)/(end-start)*300).toFixed(2),y=(100-Math.min(100,Math.max(0,p.value))).toFixed(2);path+=`${last===null||p.time-last>330?'M':'L'}${x},${y} `;last=p.time;}
  graph=`<svg viewBox="0 0 300 100" role="img" aria-label="${title}近一小时趋势"><path d="M0 0H300M0 50H300M0 99H300" stroke="#e8eef3" fill="none"/><path d="${path}" stroke="#35a185" stroke-width="2" fill="none"/></svg>`;
 }
 return `<div class="chart"><h3>${title}</h3><div class="chart-value">${metricKnown(row,kind)?fmt(val.latest):'未知 / 过期'}</div>${graph}<p>均值 ${fmt(val.avg)} · 峰值 ${fmt(val.max)} · ${val.samples||0} 个样本</p><p>最新采样：${time(val.latest_time)}</p></div>`;
}
function fillDetail(id){const r=state.snapshot.instances.find(r=>r.id===id);if(!r){$('detail').close();return;}const p=ssh(r);$('detail-name').textContent=r.name;$('detail-body').innerHTML=`<div class="detail-meta">${esc(r.id)}<br>归属：${esc(groupOf(r).name)}<br>状态：${esc(labels[r.status]||r.status)} · ${r.cpu} CPU / ${r.gpu} GPU / ${esc(r.memory)}<br>SSH：${p?esc(p.host)+':'+esc(p.port)+' · Ready':'无当前就绪映射'}<br>端口映射由平台返回，未执行连通性测试。</div><div class="charts">${chart(r,'CpuCoreUsage','CPU 利用率')}${chart(r,'GpuCoreUsage','GPU 利用率')}${chart(r,'MemoryUsage','内存使用率')}${chart(r,'GpuMemoryUsage','显存使用率')}</div>`;}
function validStatus(data){
 const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
 if(!object(data)||!('snapshot' in data))return false;
 const s=data.snapshot;if(s===null)return true;
 if(!object(s)||!Array.isArray(s.instances)||!Number.isFinite(Date.parse(s.collected_at))||Date.parse(s.collected_at)>Date.now()+60000)return false;
 if(s.errors!==undefined&&(!Array.isArray(s.errors)||!s.errors.every(e=>object(e)&&typeof e.id==='string'&&typeof e.scope==='string')))return false;
 const ids=new Set();
 return s.instances.every(r=>{
  if(!object(r)||typeof r.id!=='string'||ids.has(r.id)||typeof r.name!=='string'||typeof r.status!=='string'||!Number.isFinite(r.cpu)||r.cpu<0||!Number.isFinite(r.gpu)||r.gpu<0||!Array.isArray(r.ports)||!object(r.metrics))return false;
  ids.add(r.id);
  return r.ports.every(object)&&Object.values(r.metrics).every(v=>object(v)&&(!v.points||Array.isArray(v.points)&&v.points.every(p=>object(p)&&Number.isFinite(p.time)&&Number.isFinite(p.value))));
 });
}
function restoreCache(){
 try{
  const data=JSON.parse(localStorage.getItem(cacheKey));
  if(validStatus(data)&&data.snapshot&&Date.now()-Date.parse(data.snapshot.collected_at)<86400000){state={...data,collecting:false};fromCache=true;render();}
 }catch{}
}
function saveCache(){try{localStorage.setItem(cacheKey,JSON.stringify(state));}catch{}}
async function fetchStatus(url,backup=false,controllers=[]){
 const controller=new AbortController();controllers.push(controller);
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(url,{cache:'no-store',signal:controller.signal,headers:backup?{Accept:'application/vnd.github.raw+json'}:{}});
  if(!response.ok)throw new Error(`HTTP ${response.status}`);
  let data;try{data=await response.json();}catch{throw new Error('数据格式异常');}
  if(!validStatus(data))throw new Error('数据格式异常');
  return data;
 }catch(error){
  const reason=controller.signal.aborted?'请求超时':/^HTTP \d{3}$/.test(error.message)||error.message==='数据格式异常'?error.message:'连接中断';
  throw new Error(reason);
 }finally{clearTimeout(timer);}
}
function latestStatus(stamp){
 if(!fallbackData)return fetchStatus(publicData?`${publicData}?t=${stamp}`:'/api/status');
 // Start the backup after a short head start, rather than waiting out a stalled primary.
 return new Promise((resolve,reject)=>{
  const controllers=[],failures=[];let best=null,finished=0,startedBackup=false,settled=false;
  const finish=()=>{
   if(settled)return;
   if((best?.snapshot&&stamp-Date.parse(best.snapshot.collected_at)<=180000)||finished===2){
    settled=true;clearTimeout(hedge);controllers.forEach(c=>c.abort());
    if(best)resolve(best);else reject(new Error(failures.join('；')));
   }
  };
  const request=async(backup)=>{
   try{
    const data=await fetchStatus(backup?`${fallbackData}&t=${stamp}`:`${publicData}?t=${stamp}`,backup,controllers);
    if(!best||Date.parse(data.snapshot?.collected_at||0)>Date.parse(best.snapshot?.collected_at||0))best=data;
   }catch(error){failures.push(`${backup?'备用入口':'主入口'}：${error.message}`);}finally{
    finished++;finish();
    if(!settled&&!backup)startBackup();
   }
  };
  const startBackup=()=>{if(!startedBackup&&!settled){startedBackup=true;request(true);}};
  const hedge=setTimeout(startBackup,1500);
  request(false);
 });
}
function retryPoll(){
 retryTimer=setTimeout(()=>{retryTimer=null;poll();},retryDelay);
 retryDelay=Math.min(retryDelay*2,30000);
}
function poll(){
 if(inFlight)return inFlight;
 clearTimeout(retryTimer);retryTimer=null;
 inFlight=(async()=>{
  try{
   let data;
   // Absorb one failed read round before surfacing an interruption to the user.
   for(let attempt=0;attempt<2;attempt++){
    try{data=await latestStatus(Date.now());break;}catch(error){if(attempt===1)throw error;}
   }
   // A CDN response must not replace a snapshot already known to be newer.
   if(state?.snapshot&&Date.parse(state.snapshot.collected_at)>Date.parse(data.snapshot?.collected_at||0))data=state;
   state=data;fromCache=false;loadError='';
   if(publicData&&(!state.snapshot||state.error||Date.now()-Date.parse(state.snapshot.collected_at)>180000))retryPoll();else retryDelay=5000;
   saveCache();return true;
  }catch(error){
   loadError=publicData?`正在自动重连，${retryDelay/1000} 秒后自动重试，无需手动刷新。${error.message}。已有数据会保留，超过 3 分钟将标记过期。`:'无法连接本机采集器，请检查采集服务。';
   if(publicData){
    try{
     const key=cacheKey+':connection-events',saved=JSON.parse(localStorage.getItem(key)||'[]'),history=Array.isArray(saved)?saved:[];
     localStorage.setItem(key,JSON.stringify([...history,{at:new Date().toISOString(),reason:error.message}].slice(-20)));
    }catch{}
    retryPoll();
   }
   if(!state)$('nodes').innerHTML='<tr><td colspan="8" class="empty">监控数据暂时无法读取，正在自动重连，恢复后会自动显示。</td></tr>';
   return false;
  }finally{inFlight=null;render();}
 })();
 render();return inFlight;
}
$('refresh').addEventListener('click',async()=>{if(publicData){const ok=await poll();notify(ok?(state?.snapshot&&Date.now()-Date.parse(state.snapshot.collected_at)<=180000&&!state.error?'已读取最新页面数据':'已读取数据，但采集尚未更新，正在自动等待新数据'):'连接暂时中断，已自动重试，恢复后会自动更新');return;}try{const response=await fetch('/api/refresh',{method:'POST',headers:{'X-DSW-Refresh':'1'}});if(!response.ok)throw new Error();const d=await response.json();notify(d.accepted?'已开始重新采集':'正在采集或请求间隔过短，请稍候');await poll();}catch{notify('暂时无法发起采集');}});
$('group').addEventListener('change',render);
$('groups').addEventListener('click',e=>{const card=e.target.closest('[data-group]');if(card){$('group').value=$('group').value===card.dataset.group?'all':card.dataset.group;render();}});
$('search').addEventListener('input',render);$('sort').addEventListener('change',render);
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('selected',t===b));render();}));
$('nodes').addEventListener('click',async e=>{const detail=e.target.closest('[data-detail]'),copy=e.target.closest('[data-copy]');if(detail){currentDetail=detail.dataset.detail;fillDetail(currentDetail);$('detail').showModal();}if(copy){const r=state.snapshot.instances.find(r=>r.id===copy.dataset.copy),p=ssh(r);if(p){try{await navigator.clipboard.writeText(`ssh -p ${p.port} root@${p.host}`);notify('已复制 SSH 命令');}catch{notify('浏览器未允许复制，请从详情查看地址');}}}});
$('close').addEventListener('click',()=>$('detail').close());$('detail').addEventListener('click',e=>{if(e.target===$('detail'))$('detail').close();});
$('export').addEventListener('click',()=>{if(!state?.snapshot)return notify('请等待首次采集');const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';const rows=[['实例ID','名称','分组','状态','SSH地址','SSH端口','CPU核数','GPU数','CPU最新%','CPU均值%','GPU最新%','GPU均值%','采集时间'],...visible.map(r=>[r.id,r.name,groupOf(r).name,r.status,ssh(r)?.host,ssh(r)?.port,r.cpu,r.gpu,m(r,'CpuCoreUsage').latest,m(r,'CpuCoreUsage').avg,m(r,'GpuCoreUsage').latest,m(r,'GpuCoreUsage').avg,state.snapshot.collected_at])];const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='dsw-nodes.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
restoreCache();poll();setInterval(poll,publicData?60000:5000);setInterval(()=>{if(state)render();},15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});

window.addEventListener('online',()=>poll());
