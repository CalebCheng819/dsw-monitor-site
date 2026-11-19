'use strict';
const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {Running:'运行中',Stopped:'已停止',Failed:'失败',Queuing:'排队中',Starting:'启动中',Stopping:'停止中',Unknown:'状态未知'};
const fmt = x => typeof x === 'number' && Number.isFinite(x) ? `${x.toFixed(1)}%` : '未知';
const time = v => v ? new Date(typeof v === 'number' ? v * 1000 : v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '—';
const publicData = document.body.dataset.source || '';
const fallbackData = document.body.dataset.fallback || '';
if(publicData){document.querySelector('.private-tag').textContent='公开只读监控';document.querySelector('.interval').textContent='约每 60–90 秒更新 · 指标每 5 分钟采样';}
let state = null, filter = 'all', visible = [], inFlight = null, currentDetail = null, loadError = '';
const ssh = r => r.ports.find(p => String(p.service).toUpperCase() === 'SSH' && p.active && p.port);
const portOrder = r => Number(ssh(r)?.port ?? 999999);
const m = (r,k) => r.metrics[k] || {};
const metricKnown = (r,k) => m(r,k).fresh && m(r,k).latest !== null && m(r,k).latest !== undefined;
function notify(text) { $('toast').textContent=text; $('toast').classList.add('open');clearTimeout(notify.timer);notify.timer=setTimeout(()=>$('toast').classList.remove('open'),2500); }
function stat(label,value,unit,note,accent=false) { return `<div class="stat${accent?' stat-accent':''}"><div class="stat-top">${label}<span class="stat-icon">▦</span></div><div class="stat-value">${value}<small>${unit}</small></div><div class="stat-note">${note}</div></div>`; }
function metric(row,kind) {
 if(row.status!=='Running')return '<span class="muted">—</span>';
 const val=m(row,kind),known=metricKnown(row,kind),n=known?val.latest:0;
 return `<div class="metric ${kind==='GpuCoreUsage'?'gpu':''}"><div class="metric-top ${known&&n<20?'metric-low':''}">${known?fmt(n):'未知 / 过期'}</div><svg class="metric-bar" width="100" height="4" aria-hidden="true"><rect width="100" height="4" fill="#edf2f6"/><rect width="${Math.min(100,Math.max(0,n))}" height="4" fill="${kind==='GpuCoreUsage'?'#529abc':'#7eada3'}"/></svg><div class="submetric">1h 均值 ${fmt(val.avg)}</div></div>`;
}
function render() {
 const s=state?.snapshot;
 $('refresh').disabled=!!state?.collecting||!!inFlight;
 $('refresh').textContent=inFlight?'↻ 正在读取…':state?.collecting?'↻ 采集中…':publicData?'↻ 刷新页面数据':'↻ 立即采集';
 const stale = !s || Date.now()-Date.parse(s.collected_at)>180000;
 $('sync').classList.toggle('warn',stale||!!state?.error||!!loadError);
 $('sync').textContent=loadError?'连接已断开':state?.error?'采集异常':!s?'首次采集中':stale?'数据已过期':state.collecting?'正在更新':'数据已同步';
 $('updated').textContent=s?`最近采集：${time(s.collected_at)}`:'等待首次实时数据…';
 const warnings=[];
 if(loadError)warnings.push(loadError);
 if(state?.error)warnings.push(state.error);
 if(state?.publish_error)warnings.push(state.publish_error);
 if(stale&&s)warnings.push('最近数据已超过 3 分钟，请勿据此判断当前是否空闲。');
 if(s?.errors?.length)warnings.push(`${s.errors.length} 项查询未成功，对应数据已标记未知。`);
 $('notice').hidden=!warnings.length;$('notice').textContent=warnings.join(' ');
 if(!s)return;
 const rows=s.instances,running=rows.filter(r=>r.status==='Running'),idle=running.filter(r=>r.idle&&!stale&&!state.error);
 $('summary').innerHTML=stat('全部 DSW',rows.length,'台',`${rows.length-running.length} 台未运行或状态未知`)+stat('运行中',running.length,'台',`${running.reduce((a,r)=>a+r.cpu,0)} 核 CPU 已分配`,true)+stat('已分配 GPU',running.reduce((a,r)=>a+r.gpu,0),'张','统计所有运行中节点')+stat('比较空闲',idle.length,'台',`${idle.reduce((a,r)=>a+r.gpu,0)} 张 GPU · CPU / GPU 均低于 20%`,true);
 const q=$('search').value.trim().toLowerCase();
 visible=rows.filter(r=>filter==='all'||filter==='idle'&&r.idle&&!stale&&!state.error||filter==='other'&&r.status!=='Running'||filter==='Running'&&r.status==='Running').filter(r=>!q||[r.name,r.id,...r.ports.flatMap(p=>[p.port,p.host])].some(v=>String(v??'').toLowerCase().includes(q)));
 const order=$('sort').value;
 visible.sort((a,b)=>order==='name'?a.name.localeCompare(b.name):order==='gpu'||order==='cpu'?((metricKnown(a,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage')?m(a,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage').latest:Infinity)-(metricKnown(b,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage')?m(b,order==='gpu'?'GpuCoreUsage':'CpuCoreUsage').latest:Infinity))||portOrder(a)-portOrder(b):portOrder(a)-portOrder(b));
 $('count').textContent=`${visible.length} / ${rows.length}`;
 $('nodes').innerHTML=visible.map(r=>{
  const p=ssh(r),known=metricKnown(r,'CpuCoreUsage')&&metricKnown(r,'GpuCoreUsage');
  const badge=stale||state.error?'数据过期':r.status!=='Running'?'—':r.idle?'比较空闲':!known||!m(r,'CpuCoreUsage').complete_hour||!m(r,'GpuCoreUsage').complete_hour?'数据不足':'有资源使用';
  const tone=badge==='比较空闲'?'idle':badge==='有资源使用'?'busy':'unknown';
  return `<tr><td><button class="node-name" data-detail="${esc(r.id)}">${esc(r.name||'未命名节点')}</button><div class="instance-id">${esc(r.id)}</div></td><td>${p?`<button class="port" data-copy="${esc(r.id)}" title="复制 SSH 连接命令">${esc(p.port)}</button>`:'<span class="muted">无就绪映射</span>'}</td><td><span class="status"><i class="dot ${r.status==='Running'?'green':r.status==='Failed'?'red':r.status==='Queuing'?'amber':''}"></i>${esc(labels[r.status]||r.status)}</span></td><td><div class="resource">${r.gpu} GPU · ${r.cpu} CPU</div><div class="instance-id">${esc(r.memory)}</div></td><td>${metric(r,'CpuCoreUsage')}</td><td>${metric(r,'GpuCoreUsage')}</td><td><span class="badge ${tone}">${badge}</span></td><td><button class="row-action" data-detail="${esc(r.id)}">详情</button></td></tr>`;
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
function fillDetail(id){const r=state.snapshot.instances.find(r=>r.id===id);if(!r){$('detail').close();return;}const p=ssh(r);$('detail-name').textContent=r.name;$('detail-body').innerHTML=`<div class="detail-meta">${esc(r.id)}<br>状态：${esc(labels[r.status]||r.status)} · ${r.cpu} CPU / ${r.gpu} GPU / ${esc(r.memory)}<br>SSH：${p?esc(p.host)+':'+esc(p.port)+' · Ready':'无当前就绪映射'}<br>端口映射由平台返回，未执行连通性测试。</div><div class="charts">${chart(r,'CpuCoreUsage','CPU 利用率')}${chart(r,'GpuCoreUsage','GPU 利用率')}${chart(r,'MemoryUsage','内存使用率')}${chart(r,'GpuMemoryUsage','显存使用率')}</div>`;}
async function fetchStatus(url,backup=false){
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(),12000);
 try{
  const response=await fetch(url,{cache:'no-store',signal:controller.signal,headers:backup?{Accept:'application/vnd.github.raw+json'}:{}});
  if(!response.ok)throw new Error('Data request failed');
  const data=await response.json();
  if(!data||!('snapshot' in data)||data.snapshot&&(!Array.isArray(data.snapshot.instances)||!Number.isFinite(Date.parse(data.snapshot.collected_at))))throw new Error('Invalid status data');
  return data;
 }finally{clearTimeout(timer);}
}
function poll(){
 if(inFlight)return inFlight;
 inFlight=(async()=>{
  try{
   const stamp=Date.now();let data;
   try{data=await fetchStatus(publicData?`${publicData}?t=${stamp}`:'/api/status');}
   catch(error){if(!fallbackData)throw error;data=await fetchStatus(`${fallbackData}&t=${stamp}`,true);}
   state=data;loadError='';return true;
  }catch{
   loadError=publicData?'无法连接 GitHub 监控数据入口，请检查网络后重试。已有数据会保留，超过 3 分钟将标记过期。':'无法连接本机采集器，请检查采集服务。';
   if(!state)$('nodes').innerHTML='<tr><td colspan="8" class="empty">监控数据暂时无法读取，请点击刷新重试。</td></tr>';
   return false;
  }finally{inFlight=null;render();}
 })();
 render();return inFlight;
}
$('refresh').addEventListener('click',async()=>{if(publicData){const ok=await poll();notify(ok?'已读取最新页面数据':'刷新失败，请检查网络后重试');return;}try{const response=await fetch('/api/refresh',{method:'POST',headers:{'X-DSW-Refresh':'1'}});if(!response.ok)throw new Error();const d=await response.json();notify(d.accepted?'已开始重新采集':'正在采集或请求间隔过短，请稍候');await poll();}catch{notify('暂时无法发起采集');}});
$('search').addEventListener('input',render);$('sort').addEventListener('change',render);
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('selected',t===b));render();}));
$('nodes').addEventListener('click',async e=>{const detail=e.target.closest('[data-detail]'),copy=e.target.closest('[data-copy]');if(detail){currentDetail=detail.dataset.detail;fillDetail(currentDetail);$('detail').showModal();}if(copy){const r=state.snapshot.instances.find(r=>r.id===copy.dataset.copy),p=ssh(r);if(p){try{await navigator.clipboard.writeText(`ssh -p ${p.port} root@${p.host}`);notify('已复制 SSH 命令');}catch{notify('浏览器未允许复制，请从详情查看地址');}}}});
$('close').addEventListener('click',()=>$('detail').close());$('detail').addEventListener('click',e=>{if(e.target===$('detail'))$('detail').close();});
$('export').addEventListener('click',()=>{if(!state?.snapshot)return notify('请等待首次采集');const cell=v=>'"'+String(v??'').replace(/^[=+@\-\t\r]/,"'$&").replaceAll('"','""')+'"';const rows=[['实例ID','名称','状态','SSH地址','SSH端口','CPU核数','GPU数','CPU最新%','CPU均值%','GPU最新%','GPU均值%','采集时间'],...visible.map(r=>[r.id,r.name,r.status,ssh(r)?.host,ssh(r)?.port,r.cpu,r.gpu,m(r,'CpuCoreUsage').latest,m(r,'CpuCoreUsage').avg,m(r,'GpuCoreUsage').latest,m(r,'GpuCoreUsage').avg,state.snapshot.collected_at])];const url=URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download='dsw-nodes.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
poll();setInterval(poll,publicData?60000:5000);setInterval(()=>{if(state)render();},15000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
