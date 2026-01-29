async function api(path, method='GET', body=null){
  const opts = { method, headers: {} };
  if (body) { opts.body = JSON.stringify(body); opts.headers['Content-Type']='application/json'; }
  const r = await fetch(path, opts);
  return r.json();
}

async function refresh(){
  const list = await api('/macs');
  const tbody = document.querySelector('#list tbody');
  tbody.innerHTML = '';
  list.forEach(item => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mac-col">${item.mac}</td><td class="name-col">${item.name||''}</td><td class="actions"><div class="actions">` +
      `<button data-mac="${encodeURIComponent(item.mac)}" class="wake">唤醒</button>` +
      `<button data-mac="${encodeURIComponent(item.mac)}" class="edit">编辑</button>` +
      `<button data-mac="${encodeURIComponent(item.mac)}" class="del">删除</button>` +
    `</div></td>`;
    tbody.appendChild(tr);
  });
  document.querySelectorAll('.wake').forEach(b=>b.onclick=async e=>{ b.disabled=true; try{ await api('/wake/'+decodeURIComponent(e.target.dataset.mac),'POST'); showMsg('已发送唤醒包'); }catch(err){ showMsg('唤醒失败'); } b.disabled=false; });
  document.querySelectorAll('.edit').forEach(b=>b.onclick=async e=>{ const mac = decodeURIComponent(e.target.dataset.mac); const newName = prompt('输入新的名称：'); if(newName===null) return; await api('/macs/'+encodeURIComponent(mac),'PUT',{name:newName}); showMsg('名称已更新'); refresh(); });
  document.querySelectorAll('.del').forEach(b=>b.onclick=async e=>{ if(!confirm('确认删除?')) return; await api('/macs/'+decodeURIComponent(e.target.dataset.mac),'DELETE'); showMsg('已删除'); refresh(); });
}

async function loadNetwork(){
  try{
    const nets = await api('/network');
    if(Array.isArray(nets) && nets.length>0){
      const text = nets.map(n=>`${n.iface}: ${n.cidr}`).join('  |  ');
      const el = document.getElementById('network-info');
      if(el) el.textContent = '网络: ' + text;
    }
  }catch(e){ console.debug('network fetch failed', e); }
}

document.getElementById('add').onclick = async ()=>{
  const mac = document.getElementById('mac').value.trim();
  const name = document.getElementById('name').value.trim();
  if(!mac) { showMsg('请输入 MAC',3000,'error'); return; }
  if(!validateMac(mac)) { showMsg('MAC 格式异常，请使用 AA:BB:CC:DD:EE:FF',4000,'error'); return; }
  const r = await api('/macs','POST',{mac,name});
  if(r.error) showMsg(r.error,4000,'error'); else { document.getElementById('mac').value=''; document.getElementById('name').value=''; showMsg('已保存'); refresh(); }
}

function showMsg(text, timeout=3000, type='success'){
  const el = document.getElementById('msg');
  el.textContent = text;
  el.classList.remove('msg-success','msg-error');
  if(type==='error') el.classList.add('msg-error'); else el.classList.add('msg-success');
  if(timeout>0) setTimeout(()=>{ if(el.textContent===text) { el.textContent=''; el.classList.remove('msg-success','msg-error'); } }, timeout);
}

function validateMac(mac){
  const s = mac.toLowerCase().replace(/[^0-9a-f]/g,'');
  return s.length===12;
}

refresh().catch(e=>console.error(e));
loadNetwork();
