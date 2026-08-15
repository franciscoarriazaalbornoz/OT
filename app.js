let STAGES = [];
let SUCURSALES = [];
let ROLES = [];
let currentUser = null;
let ots = [];
let editingId = null;

const STAGE_COLORS = ["#6B7280","#8A7A5C","#B08900","#1D6FA5","#EB0A1E","#6B4FA0","#2E8FA6","#1E8A5F"];

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function daysSince(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr+"T00:00:00");
  return Math.floor((Date.now()-d.getTime())/86400000);
}
async function api(path, opts={}){
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || "Error de conexión con el servidor");
  return data;
}

function show(id){ document.getElementById(id).style.display = "flex"; }
function hide(id){ document.getElementById(id).style.display = "none"; }

async function tryResumeSession(){
  try{
    const data = await api("/api/me");
    onLogin(data);
  }catch(e){
    hide("appScreen"); hide("changePwScreen"); show("loginScreen");
  }
}

async function doLogin(){
  const errorEl = document.getElementById("loginError");
  errorEl.style.display = "none";
  const username = document.getElementById("loginUser").value.trim();
  const password = document.getElementById("loginPass").value;
  try{
    await api("/api/login", { method:"POST", body:{ username, password } });
    const data = await api("/api/me");
    onLogin(data);
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

function onLogin(data){
  currentUser = data.user;
  STAGES = data.stages; SUCURSALES = data.sucursales; ROLES = data.roles;
  hide("loginScreen");
  if(currentUser.mustChangePassword){
    show("changePwScreen");
    return;
  }
  hide("changePwScreen");
  enterApp();
}

async function savePassword(){
  const errorEl = document.getElementById("pwError");
  errorEl.style.display = "none";
  try{
    await api("/api/change-password", { method:"POST", body:{
      currentPassword: document.getElementById("pwCurrent").value,
      newPassword: document.getElementById("pwNew").value
    }});
    hide("changePwScreen");
    enterApp();
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

function enterApp(){
  document.getElementById("userInfo").textContent = `${currentUser.nombre} · ${currentUser.rol}${currentUser.sucursal ? " · "+currentUser.sucursal : ""}`;
  document.getElementById("usersBtn").style.display = currentUser.rol === "Administrador" ? "inline-block" : "none";
  document.getElementById("f_etapa").innerHTML = STAGES.map((s,i)=>`<option value="${i}">${s}</option>`).join("");
  populateSelect(document.getElementById("f_sucursal"), SUCURSALES);
  populateSelect(document.getElementById("filterSucursal"), SUCURSALES, "Todas las sucursales");
  populateSelect(document.getElementById("nu_rol"), ROLES);
  populateSelect(document.getElementById("nu_sucursal"), SUCURSALES);
  show("appScreen");
  document.getElementById("appScreen").style.display = "block";
  loadOTs();
  setInterval(loadOTs, 12000);
}

function populateSelect(el, items, placeholder){
  el.innerHTML = "";
  if(placeholder){ const o=document.createElement("option"); o.value=""; o.textContent=placeholder; el.appendChild(o); }
  items.forEach(i=>{ const o=document.createElement("option"); o.value=i; o.textContent=i; el.appendChild(o); });
}

async function loadOTs(){
  try{
    const data = await api("/api/ots");
    ots = data.ots;
    render();
  }catch(e){
    // si falla una actualización puntual, se conserva lo que ya está en pantalla
    console.error(e);
  }
}

function filteredOTs(){
  const suc = document.getElementById("filterSucursal").value;
  const pri = document.getElementById("filterPrioridad").value;
  return ots.filter(o => (!suc || o.sucursal===suc) && (!pri || o.prioridad===pri));
}

function render(){
  const board = document.getElementById("board");
  board.innerHTML = "";
  const data = filteredOTs();
  document.getElementById("totalCount").textContent = data.length + " OT en tablero";

  STAGES.forEach((stage, idx)=>{
    const col = document.createElement("div");
    col.className = "col";
    const items = data.filter(o=>o.etapa===idx);
    col.innerHTML = `
      <div class="col-head"><span class="col-title">${stage}</span><span class="col-badge">${items.length}</span></div>
      <div class="col-bar" style="background:${STAGE_COLORS[idx]}"></div>
    `;
    if(items.length===0){
      const empty = document.createElement("div");
      empty.className = "empty-col";
      empty.textContent = "Sin OT en esta etapa";
      col.appendChild(empty);
    }
    items.sort((a,b)=> (a.prioridad==="alta"?0:1) - (b.prioridad==="alta"?0:1));
    items.forEach(o=>{
      const days = daysSince(o.fechaIngreso);
      const card = document.createElement("div");
      card.className = "card" + (o.prioridad==="alta" ? " alta" : "");
      card.innerHTML = `
        <div class="card-top">
          <span class="card-ot">OT ${escapeHtml(o.numero||"—")}</span>
          <span class="card-days${days!==null && days>=5 ? " warn" : ""}">${days!==null ? days+"d" : ""}</span>
        </div>
        <div class="card-cliente">${escapeHtml(o.cliente||"Sin cliente")}</div>
        <div class="card-modelo">${escapeHtml(o.modelo||"")} ${o.patente? "· "+escapeHtml(o.patente):""}</div>
        <div class="card-foot">
          <span class="card-suc">${escapeHtml(o.sucursal||"—")}</span>
          <span class="card-move">
            ${idx>0 ? `<button class="mini" data-back="${o.id}" title="Etapa anterior">‹</button>`:""}
            ${idx<STAGES.length-1 ? `<button class="mini" data-fwd="${o.id}" title="Siguiente etapa">›</button>`:""}
          </span>
        </div>`;
      card.addEventListener("click",(e)=>{ if(!e.target.closest(".mini")) openEdit(o.id); });
      col.appendChild(card);
    });
    board.appendChild(col);
  });

  board.querySelectorAll("[data-fwd]").forEach(b=>b.addEventListener("click",(e)=>{ e.stopPropagation(); moveStage(b.dataset.fwd, 1); }));
  board.querySelectorAll("[data-back]").forEach(b=>b.addEventListener("click",(e)=>{ e.stopPropagation(); moveStage(b.dataset.back, -1); }));
}

async function moveStage(id, delta){
  const o = ots.find(x=>x.id===id);
  if(!o) return;
  const nuevaEtapa = Math.min(STAGES.length-1, Math.max(0, o.etapa+delta));
  try{
    const data = await api("/api/ots/"+id, { method:"PUT", body:{ etapa: nuevaEtapa } });
    const idx = ots.findIndex(x=>x.id===id);
    ots[idx] = data.ot;
    render();
  }catch(e){ alert(e.message); }
}

function openNew(){
  editingId = null;
  document.getElementById("modalTitle").textContent = "Nueva OT";
  document.getElementById("deleteBtn").style.display = "none";
  document.getElementById("qrBtn").style.display = "none";
  document.getElementById("formError").style.display = "none";
  ["f_numero","f_patente","f_cliente","f_modelo","f_responsable","f_notas"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("f_fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("f_sucursal").value = currentUser.sucursal || SUCURSALES[0];
  document.getElementById("f_etapa").value = "0";
  document.getElementById("f_prioridad").value = "normal";
  document.getElementById("overlay").classList.add("show");
  document.getElementById("f_numero").focus();
}

function openEdit(id){
  const o = ots.find(x=>x.id===id);
  if(!o) return;
  editingId = id;
  document.getElementById("modalTitle").textContent = "Editar OT";
  document.getElementById("deleteBtn").style.display = "block";
  document.getElementById("qrBtn").style.display = "inline-block";
  document.getElementById("formError").style.display = "none";
  document.getElementById("f_numero").value = o.numero||"";
  document.getElementById("f_patente").value = o.patente||"";
  document.getElementById("f_fecha").value = o.fechaIngreso||"";
  document.getElementById("f_cliente").value = o.cliente||"";
  document.getElementById("f_modelo").value = o.modelo||"";
  document.getElementById("f_sucursal").value = o.sucursal||SUCURSALES[0];
  document.getElementById("f_etapa").value = String(o.etapa||0);
  document.getElementById("f_responsable").value = o.responsable||"";
  document.getElementById("f_prioridad").value = o.prioridad||"normal";
  document.getElementById("f_notas").value = o.notas||"";
  document.getElementById("overlay").classList.add("show");
}

function closeModal(){ document.getElementById("overlay").classList.remove("show"); }

async function saveForm(){
  const errorEl = document.getElementById("formError");
  errorEl.style.display = "none";
  const numero = document.getElementById("f_numero").value.trim();
  if(!numero){ errorEl.textContent = "Ingresa el número de OT."; errorEl.style.display = "block"; return; }

  const payload = {
    numero,
    patente: document.getElementById("f_patente").value.trim(),
    fechaIngreso: document.getElementById("f_fecha").value,
    cliente: document.getElementById("f_cliente").value.trim(),
    modelo: document.getElementById("f_modelo").value.trim(),
    sucursal: document.getElementById("f_sucursal").value,
    etapa: parseInt(document.getElementById("f_etapa").value,10),
    responsable: document.getElementById("f_responsable").value.trim(),
    prioridad: document.getElementById("f_prioridad").value,
    notas: document.getElementById("f_notas").value.trim()
  };

  try{
    if(editingId){
      const data = await api("/api/ots/"+editingId, { method:"PUT", body: payload });
      const idx = ots.findIndex(o=>o.id===editingId);
      ots[idx] = data.ot;
    }else{
      const data = await api("/api/ots", { method:"POST", body: payload });
      ots.push(data.ot);
    }
    closeModal();
    render();
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

async function deleteOT(){
  if(!editingId) return;
  if(!confirm("¿Eliminar esta OT del tablero?")) return;
  try{
    await api("/api/ots/"+editingId, { method:"DELETE" });
    ots = ots.filter(o=>o.id!==editingId);
    closeModal();
    render();
  }catch(e){ alert(e.message); }
}

// --- Usuarios (administrador) ---
async function openUsers(){
  document.getElementById("userFormError").style.display = "none";
  try{
    const data = await api("/api/users");
    const list = document.getElementById("usersList");
    list.innerHTML = data.users.map(u => `
      <div class="user-row">
        <div>
          <div>${escapeHtml(u.nombre)} <span class="u-meta">(${escapeHtml(u.username)})</span></div>
          <div class="u-meta">${escapeHtml(u.rol)}${u.sucursal ? " · "+escapeHtml(u.sucursal) : ""}</div>
        </div>
        ${u.id !== currentUser.id ? `<button data-del="${u.id}">Eliminar</button>` : ""}
      </div>
    `).join("") || `<p style="font-size:13px;color:var(--text-2)">No hay usuarios.</p>`;
    list.querySelectorAll("[data-del]").forEach(b=>b.addEventListener("click", async ()=>{
      if(!confirm("¿Eliminar este usuario?")) return;
      await api("/api/users/"+b.dataset.del, { method:"DELETE" });
      openUsers();
    }));
  }catch(e){ alert(e.message); }
  document.getElementById("usersOverlay").classList.add("show");
}

async function createUser(){
  const errorEl = document.getElementById("userFormError");
  errorEl.style.display = "none";
  try{
    await api("/api/users", { method:"POST", body:{
      username: document.getElementById("nu_username").value.trim(),
      nombre: document.getElementById("nu_nombre").value.trim(),
      rol: document.getElementById("nu_rol").value,
      sucursal: document.getElementById("nu_sucursal").value,
      password: document.getElementById("nu_password").value
    }});
    ["nu_username","nu_nombre","nu_password"].forEach(id=>document.getElementById(id).value="");
    openUsers();
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

async function openQr(){
  if(!editingId) return;
  try{
    const data = await api(`/api/ots/${editingId}/qr`);
    document.getElementById("qrTitle").textContent = "QR — OT " + data.numero;
    document.getElementById("qrImg").src = data.dataUrl;
    document.getElementById("qrOverlay").classList.add("show");
  }catch(e){ alert(e.message); }
}
function printQr(){
  const img = document.getElementById("qrImg").src;
  const title = document.getElementById("qrTitle").textContent;
  const w = window.open("", "_blank");
  w.document.write(`
    <html><head><title>${title}</title></head>
    <body style="text-align:center;font-family:sans-serif;padding:24px;">
      <h2>${title}</h2>
      <img src="${img}" style="width:260px;height:260px;">
      <p style="font-size:12px;color:#666;">Escanea para actualizar la etapa desde el celular</p>
    </body></html>
  `);
  w.document.close();
  w.focus();
  w.print();
}

document.getElementById("loginBtn").addEventListener("click", doLogin);
document.getElementById("loginPass").addEventListener("keydown", e=>{ if(e.key==="Enter") doLogin(); });
document.getElementById("pwSaveBtn").addEventListener("click", savePassword);
document.getElementById("newBtn").addEventListener("click", openNew);
document.getElementById("cancelBtn").addEventListener("click", closeModal);
document.getElementById("saveBtn").addEventListener("click", saveForm);
document.getElementById("deleteBtn").addEventListener("click", deleteOT);
document.getElementById("overlay").addEventListener("click",(e)=>{ if(e.target.id==="overlay") closeModal(); });
document.getElementById("refreshBtn").addEventListener("click", loadOTs);
document.getElementById("filterSucursal").addEventListener("change", render);
document.getElementById("filterPrioridad").addEventListener("change", render);
document.getElementById("logoutBtn").addEventListener("click", async ()=>{ await api("/api/logout", {method:"POST"}); location.reload(); });
document.getElementById("usersBtn").addEventListener("click", openUsers);
document.getElementById("usersCloseBtn").addEventListener("click", ()=>document.getElementById("usersOverlay").classList.remove("show"));
document.getElementById("createUserBtn").addEventListener("click", createUser);
document.getElementById("qrBtn").addEventListener("click", openQr);
document.getElementById("qrCloseBtn").addEventListener("click", ()=>document.getElementById("qrOverlay").classList.remove("show"));
document.getElementById("qrPrintBtn").addEventListener("click", printQr);

tryResumeSession();
