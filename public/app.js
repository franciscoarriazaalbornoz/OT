let STAGES = [];
let SUCURSALES = [];
let SUCURSALES_OT = [];
let ROLES = [];
let TIPOS = [];
let currentUser = null;
let ots = [];
let editingId = null;

const STAGE_COLORS = ["#6B7280","#8A7A5C","#B08900","#1D6FA5","#EB0A1E","#6B4FA0","#2E8FA6","#1E8A5F"];
function tipoInfo(value){ return TIPOS.find(t=>t.value===value) || null; }

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function daysSince(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr+"T00:00:00");
  return Math.floor((Date.now()-d.getTime())/86400000);
}
function formatEntrega(fechaEntregaStr, etapaIdx){
  if(!fechaEntregaStr) return null;
  const d = new Date(fechaEntregaStr);
  if(isNaN(d.getTime())) return null;
  const texto = "Entrega: " + d.toLocaleDateString("es-CL", { day:"2-digit", month:"2-digit" }) +
    " " + d.toLocaleTimeString("es-CL", { hour:"2-digit", minute:"2-digit" });
  const esUltimaEtapa = etapaIdx === STAGES.length - 1;
  const vencida = !esUltimaEtapa && d.getTime() < Date.now();
  return { texto, vencida };
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
  STAGES = data.stages; SUCURSALES = data.sucursales; SUCURSALES_OT = data.sucursalesOt || data.sucursales; ROLES = data.roles; TIPOS = data.tipos || [];
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
  document.getElementById("reportesBtn").style.display = currentUser.rol === "Administrador" ? "inline-block" : "none";
  document.getElementById("citasConfigExcelBtn").style.display = currentUser.rol === "Administrador" ? "inline-block" : "none";
  document.getElementById("citasBtn").style.display = ["Mecánico","Lavado y entrega"].includes(currentUser.rol) ? "none" : "inline-block";
  // La sucursal del usuario es mandante: el filtro solo tiene sentido si puede ver más de una
  // (Administrador, o Rancagua que también ve Rancagua DyP) — si solo ve la suya, no aporta nada.
  const accesiblesOt = currentUser.rol === "Administrador" ? SUCURSALES_OT : (currentUser.sucursalesAccesibles || [currentUser.sucursal]);
  document.getElementById("filterSucursal").style.display = accesiblesOt.length > 1 ? "inline-block" : "none";
  document.getElementById("citasFilterSucursal").style.display = currentUser.rol === "Administrador" ? "inline-block" : "none";
  document.getElementById("f_etapa").innerHTML = STAGES.map((s,i)=>`<option value="${i}">${s}</option>`).join("");
  populateSelect(document.getElementById("f_sucursal"), accesiblesOt);
  populateSelect(document.getElementById("filterSucursal"), accesiblesOt, "Todas las sucursales");
  const fTipo = document.getElementById("f_tipo");
  fTipo.innerHTML = TIPOS.map(t=>`<option value="${t.value}">${t.label}</option>`).join("");
  const filterTipo = document.getElementById("filterTipo");
  filterTipo.innerHTML = `<option value="">Todo tipo de trabajo</option>` + TIPOS.map(t=>`<option value="${t.value}">${t.label}</option>`).join("");
  renderLegend();
  populateSelect(document.getElementById("nu_rol"), ROLES);
  populateSelect(document.getElementById("nu_sucursal"), SUCURSALES);
  populateSelect(document.getElementById("c_sucursal"), SUCURSALES);
  populateSelect(document.getElementById("citasFilterSucursal"), SUCURSALES, "Todas las sucursales");
  populateSelect(document.getElementById("repSucursal"), SUCURSALES, "Todas las sucursales");
  document.getElementById("c_tipo").innerHTML = TIPOS.map(t=>`<option value="${t.value}">${t.label}</option>`).join("");
  show("appScreen");
  document.getElementById("appScreen").style.display = "block";
  loadOTs();
  setInterval(loadOTs, 12000);
}

function renderLegend(){
  const legend = document.getElementById("legend");
  if(!legend) return;
  legend.innerHTML = TIPOS.map(t => `
    <span class="legend-item"><span class="legend-dot" style="background:#${t.color}"></span>${escapeHtml(t.label)}</span>
  `).join("");
}

function populateSelect(el, items, placeholder){
  el.innerHTML = "";
  if(placeholder){ const o=document.createElement("option"); o.value=""; o.textContent=placeholder; el.appendChild(o); }
  items.forEach(i=>{ const o=document.createElement("option"); o.value=i; o.textContent=i; el.appendChild(o); });
}

function resizeImageFile(file, maxWidth=1000, quality=0.72){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width, h = img.height;
        if(w > maxWidth){ h = Math.round(h * maxWidth/w); w = maxWidth; }
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = () => reject(new Error("No se pudo leer la imagen"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

async function loadFotos(){
  if(!editingId) return;
  try{
    const data = await api(`/api/ots/${editingId}/fotos`);
    renderFotos(data.fotos);
  }catch(e){ console.error(e); }
}

function renderFotos(fotos){
  const grid = document.getElementById("fotosGrid");
  grid.innerHTML = fotos.map(f => `
    <div class="foto-thumb">
      <img src="${f.dataUrl}">
      <button class="del" data-foto="${f.id}" title="Eliminar">✕</button>
    </div>
  `).join("");
  grid.querySelectorAll("[data-foto]").forEach(b=>b.addEventListener("click", ()=>deleteFoto(b.dataset.foto)));
  document.getElementById("addFotoBtn").style.display = fotos.length >= 4 ? "none" : "inline-block";
}

async function addFoto(file){
  if(!editingId) return;
  try{
    const dataUrl = await resizeImageFile(file);
    await api(`/api/ots/${editingId}/fotos`, { method:"POST", body:{ dataUrl } });
    loadFotos();
  }catch(e){ alert(e.message); }
}

async function deleteFoto(fotoId){
  if(!editingId) return;
  try{
    await api(`/api/ots/${editingId}/fotos/${fotoId}`, { method:"DELETE" });
    loadFotos();
  }catch(e){ alert(e.message); }
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
  const tipo = document.getElementById("filterTipo").value;
  return ots.filter(o => (!suc || o.sucursal===suc) && (!pri || o.prioridad===pri) && (!tipo || o.tipo===tipo));
}

function render(){
  const board = document.getElementById("board");
  board.innerHTML = "";
  const data = filteredOTs();
  document.getElementById("totalCount").textContent = data.length + " OT en tablero";

  const maxEnColumna = Math.max(0, ...STAGES.map((s,idx)=> data.filter(o=>o.etapa===idx).length));
  board.classList.remove("compact","ultra-compact");
  if(maxEnColumna > 12) board.classList.add("ultra-compact");
  else if(maxEnColumna > 6) board.classList.add("compact");

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
      const entregaInfo = formatEntrega(o.fechaEntrega, idx);
      const tipo = tipoInfo(o.tipo);
      const card = document.createElement("div");
      card.className = "card";
      card.style.borderLeftColor = tipo ? "#"+tipo.color : "var(--border-strong)";
      card.innerHTML = `
        <div class="card-top">
          <span class="card-ot">OT ${escapeHtml(o.numero||"—")}</span>
          <span class="card-days${days!==null && days>=5 ? " warn" : ""}">${days!==null ? days+"d" : ""}</span>
        </div>
        <div class="card-cliente">${escapeHtml(o.cliente||"Sin cliente")}</div>
        <div class="card-modelo">${escapeHtml(o.modelo||"")} ${o.patente? "· "+escapeHtml(o.patente):""}</div>
        ${entregaInfo ? `<div class="card-entrega${entregaInfo.vencida?" warn":""}">${entregaInfo.texto}</div>` : ""}
        <div class="card-chips">
          ${tipo ? `<span class="chip-tipo" style="background:#${tipo.color}">${escapeHtml(tipo.label)}</span>` : ""}
          ${o.prioridad==="alta" ? `<span class="chip-alta">Alta</span>` : ""}
          ${o.checkLavado ? `<span class="card-lavado-ok">✓ Lavado OK</span>` : ""}
          ${o.checkPptoAutorizado ? `<span class="card-ppto-ok autorizado">Ppto: OK</span>` : (o.checkPptoRealizado ? `<span class="card-ppto-ok pendiente">Ppto: OK</span>` : "")}
          ${o.tieneFotos ? `<span class="card-fotos-chip" title="Tiene fotos adjuntas">📎</span>` : ""}
        </div>
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
  document.getElementById("f_check_lavado").checked = false;
  document.getElementById("f_check_ppto_realizado").checked = false;
  document.getElementById("f_check_ppto_autorizado").checked = false;
  const puedePpto = currentUser.rol === "Administrador" || ["Asesor de servicio","Jefe de taller","Repuestos"].includes(currentUser.rol);
  document.getElementById("f_check_ppto_realizado").disabled = !puedePpto;
  document.getElementById("f_check_ppto_autorizado").disabled = !puedePpto;
  document.getElementById("tecnicoTrabajoBox").style.display = "none";
  document.getElementById("f_fecha").value = new Date().toISOString().slice(0,10);
  document.getElementById("f_fecha_entrega").value = "";
  document.getElementById("f_sucursal").value = currentUser.sucursal || SUCURSALES[0];
  document.getElementById("f_sucursal").disabled = currentUser.rol !== "Administrador" && (currentUser.sucursalesAccesibles||[]).length <= 1;
  document.getElementById("f_etapa").value = "0";
  document.getElementById("f_prioridad").value = "normal";
  document.getElementById("f_tipo").value = "general";
  document.getElementById("fotosSection").style.display = "none";
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
  document.getElementById("f_fecha_entrega").value = o.fechaEntrega||"";
  document.getElementById("f_cliente").value = o.cliente||"";
  document.getElementById("f_modelo").value = o.modelo||"";
  document.getElementById("f_sucursal").value = o.sucursal||SUCURSALES[0];
  document.getElementById("f_sucursal").disabled = currentUser.rol !== "Administrador" && (currentUser.sucursalesAccesibles||[]).length <= 1;
  document.getElementById("f_etapa").value = String(o.etapa||0);
  document.getElementById("f_responsable").value = o.responsable||"";
  document.getElementById("f_prioridad").value = o.prioridad||"normal";
  document.getElementById("f_tipo").value = o.tipo||"";
  document.getElementById("f_notas").value = o.notas||"";
  document.getElementById("f_check_lavado").checked = !!o.checkLavado;
  document.getElementById("f_check_ppto_realizado").checked = !!o.checkPptoRealizado;
  document.getElementById("f_check_ppto_autorizado").checked = !!o.checkPptoAutorizado;
  {
    const puedePpto = currentUser.rol === "Administrador" || ["Asesor de servicio","Jefe de taller","Repuestos"].includes(currentUser.rol);
    document.getElementById("f_check_ppto_realizado").disabled = !puedePpto;
    document.getElementById("f_check_ppto_autorizado").disabled = !puedePpto;
  }
  if(o.tecnicoTrabajo){
    document.getElementById("tecnicoTrabajoBox").style.display = "block";
    document.getElementById("tecnicoTrabajoNombre").textContent = o.tecnicoTrabajo;
  } else {
    document.getElementById("tecnicoTrabajoBox").style.display = "none";
  }
  document.getElementById("fotosSection").style.display = "block";
  document.getElementById("fotosGrid").innerHTML = "";
  loadFotos();
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
    fechaEntrega: document.getElementById("f_fecha_entrega").value,
    cliente: document.getElementById("f_cliente").value.trim(),
    modelo: document.getElementById("f_modelo").value.trim(),
    sucursal: document.getElementById("f_sucursal").value,
    etapa: parseInt(document.getElementById("f_etapa").value,10),
    responsable: document.getElementById("f_responsable").value.trim(),
    prioridad: document.getElementById("f_prioridad").value,
    tipo: document.getElementById("f_tipo").value,
    notas: document.getElementById("f_notas").value.trim(),
    checkLavado: document.getElementById("f_check_lavado").checked,
    checkPptoRealizado: document.getElementById("f_check_ppto_realizado").checked,
    checkPptoAutorizado: document.getElementById("f_check_ppto_autorizado").checked
  };

  try{
    if(editingId){
      const data = await api("/api/ots/"+editingId, { method:"PUT", body: payload });
      const idx = ots.findIndex(o=>o.id===editingId);
      ots[idx] = data.ot;
    }else{
      const data = await api("/api/ots", { method:"POST", body: payload });
      ots.push(data.ot);
      if(pendingCitaId){
        try{ await api(`/api/citas/${pendingCitaId}`, { method:"PUT", body:{ estado:"convertida", otId: data.ot.id } }); }
        catch(e){ console.error(e); }
        pendingCitaId = null;
      }
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

function leerArchivoComoBase64(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

async function importarUsuariosExcel(file){
  const msg = document.getElementById("importUsersMsg");
  msg.style.display = "block";
  msg.className = "sync-msg";
  msg.textContent = "Importando...";
  try{
    const fileBase64 = await leerArchivoComoBase64(file);
    const data = await api("/api/users/importar-excel", { method:"POST", body:{ fileBase64 } });
    msg.className = "sync-msg ok";
    let texto = `Listo — ${data.creados} usuario(s) nuevo(s), ${data.existentes} ya existían, de ${data.totalFilas} filas leídas.`;
    if(data.errores && data.errores.length) texto += ` (${data.errores.length} fila(s) con problemas: ${data.errores.slice(0,3).join(" ")})`;
    msg.textContent = texto;
    openUsers();
  }catch(e){
    msg.className = "sync-msg error";
    msg.textContent = e.message;
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
async function openClienteQr(){
  try{
    const data = await api("/api/qr/consulta");
    document.getElementById("qrTitle").textContent = "QR para consulta de clientes";
    document.getElementById("qrImg").src = data.dataUrl;
    document.getElementById("qrOverlay").classList.add("show");
  }catch(e){ alert(e.message); }
}
async function openTallerQr(){
  try{
    const data = await api("/api/qr/taller");
    document.getElementById("qrTitle").textContent = "QR único de taller (técnicos y lavado)";
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

// --- Citas previas ---
let citasView = "dia";
let citasFecha = new Date();
let citasCache = [];
let editingCitaId = null;
let pendingCitaId = null;

function dayRange(d){
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0);
  const end = new Date(start); end.setDate(end.getDate()+1);
  return [start, end];
}
function weekRange(d){
  const day = d.getDay();
  const diffToMonday = (day===0 ? -6 : 1-day);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate()+diffToMonday, 0,0,0);
  const end = new Date(monday); end.setDate(end.getDate()+7);
  return [monday, end];
}
function estadoLabel(e){ return e==="convertida" ? "Convertida" : (e==="no_show" ? "No llegó" : "Pendiente"); }
const MINUTOS_ATRASO = 30;

function puedeGestionarCitas(){
  return currentUser.rol === "Administrador" || ["Recepción","Jefe de taller","Asesor de servicio","Control de calidad"].includes(currentUser.rol);
}

function openCitas(){
  document.getElementById("appScreen").style.display = "none";
  document.getElementById("citasScreen").style.display = "block";
  document.getElementById("citasUserInfo").textContent = document.getElementById("userInfo").textContent;
  const gestiona = puedeGestionarCitas();
  document.getElementById("citasNewBtn").style.display = gestiona ? "inline-block" : "none";
  document.getElementById("citasSyncBtn").style.display = gestiona ? "inline-block" : "none";
  document.getElementById("citasImportarArchivoBtn").style.display = gestiona ? "inline-block" : "none";
  document.getElementById("citasBorrarTodasBtn").style.display = currentUser.rol === "Administrador" ? "inline-block" : "none";
  loadCitas();
}
function closeCitas(){
  document.getElementById("citasScreen").style.display = "none";
  document.getElementById("appScreen").style.display = "block";
}

async function loadCitas(){
  const [desde, hasta] = citasView==="dia" ? dayRange(citasFecha) : weekRange(citasFecha);
  try{
    const data = await api(`/api/citas?desde=${encodeURIComponent(desde.toISOString())}&hasta=${encodeURIComponent(hasta.toISOString())}`);
    citasCache = data.citas;
  }catch(e){ console.error(e); }
  renderCitas();
}

function citasFiltradas(){
  const suc = document.getElementById("citasFilterSucursal").value;
  return citasCache.filter(c => !suc || c.sucursal===suc);
}

function updateCitasFechaLabel(){
  const label = document.getElementById("citasFechaLabel");
  if(citasView==="dia"){
    label.textContent = citasFecha.toLocaleDateString("es-CL", { weekday:"long", day:"2-digit", month:"2-digit", year:"numeric" });
  } else {
    const [monday, end] = weekRange(citasFecha);
    const sunday = new Date(end); sunday.setDate(sunday.getDate()-1);
    label.textContent = monday.toLocaleDateString("es-CL",{day:"2-digit",month:"2-digit"}) + " – " + sunday.toLocaleDateString("es-CL",{day:"2-digit",month:"2-digit",year:"numeric"});
  }
}

function renderCitas(){
  updateCitasFechaLabel();
  if(citasView==="dia") renderCitasDia(); else renderCitasSemana();
}

function renderCitasDia(){
  document.getElementById("citasDiaView").style.display = "block";
  document.getElementById("citasSemanaView").style.display = "none";
  const list = citasFiltradas().sort((a,b)=> new Date(a.fechaHora)-new Date(b.fechaHora));
  const el = document.getElementById("citasDiaView");
  if(list.length===0){ el.innerHTML = `<div class="citas-empty">No hay citas agendadas para este día.</div>`; return; }
  const ahora = new Date();
  el.innerHTML = list.map(c=>{
    const tipo = tipoInfo(c.tipo);
    const hora = new Date(c.fechaHora).toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"});
    // Una cita atrasada (pasó la hora y sigue "pendiente") es más urgente que "cliente espera" —
    // si se dan ambas a la vez, manda el aviso de atrasada.
    const atrasada = c.estado === "pendiente" && (ahora - new Date(c.fechaHora)) > MINUTOS_ATRASO * 60000;
    const claseEstado = atrasada ? " atrasada" : (c.estado === "convertida" ? " convertida" : (c.clienteEspera ? " espera" : ""));
    return `
      <div class="cita-card${claseEstado}" data-id="${c.id}" style="border-left-color:${tipo?"#"+tipo.color:"var(--border-strong)"}">
        <div class="cita-hora">${hora}</div>
        <div class="cita-info">
          <div class="cita-cliente">${escapeHtml(c.cliente||"Sin nombre")} ${c.patente?"· "+escapeHtml(c.patente):""}</div>
          <div class="cita-detalle">${escapeHtml(c.modelo||"")} ${c.sucursal?"· "+escapeHtml(c.sucursal):""} ${tipo?"· "+escapeHtml(tipo.label):""}</div>
          ${c.pruebaRuta ? `<span class="cita-chip-ruta">Prueba de ruta</span>` : ""}
          ${atrasada ? `<span class="cita-chip-atrasada">⚠ No ha ingresado</span>` : ""}
        </div>
        <span class="cita-estado ${c.estado}">${estadoLabel(c.estado)}</span>
      </div>`;
  }).join("");
  el.querySelectorAll("[data-id]").forEach(card=>card.addEventListener("click", ()=>openEditCita(card.dataset.id)));
}

function renderCitasSemana(){
  document.getElementById("citasDiaView").style.display = "none";
  document.getElementById("citasSemanaView").style.display = "flex";
  const [monday] = weekRange(citasFecha);
  const dias = [];
  for(let i=0;i<7;i++){ const d = new Date(monday); d.setDate(d.getDate()+i); dias.push(d); }
  const list = citasFiltradas();
  const hoy = new Date(); hoy.setHours(0,0,0,0);
  const ahora = new Date();
  const el = document.getElementById("citasSemanaView");
  el.innerHTML = dias.map(d=>{
    const esHoy = d.getTime()===hoy.getTime();
    const citasDia = list.filter(c => new Date(c.fechaHora).toDateString()===d.toDateString())
      .sort((a,b)=> new Date(a.fechaHora)-new Date(b.fechaHora));
    return `
      <div class="citas-semana-col">
        <div class="dia-head${esHoy?" hoy":""}">${d.toLocaleDateString("es-CL",{weekday:"short",day:"2-digit"})}</div>
        ${citasDia.length===0 ? `<div class="citas-empty" style="padding:10px 0;font-size:11px;">Sin citas</div>` : citasDia.map(c=>{
          const tipo = tipoInfo(c.tipo);
          const hora = new Date(c.fechaHora).toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"});
          const atrasada = c.estado === "pendiente" && (ahora - new Date(c.fechaHora)) > MINUTOS_ATRASO * 60000;
          const claseEstado = atrasada ? " atrasada" : (c.estado === "convertida" ? " convertida" : (c.clienteEspera ? " espera" : ""));
          return `<div class="cita-mini${claseEstado}" data-id="${c.id}" style="border-left-color:${tipo?"#"+tipo.color:"var(--border-strong)"}"><span class="h">${hora}</span> ${escapeHtml(c.patente||c.cliente||"—")}</div>`;
        }).join("")}
      </div>`;
  }).join("");
  el.querySelectorAll("[data-id]").forEach(card=>card.addEventListener("click", ()=>openEditCita(card.dataset.id)));
}

function citasPrev(){ citasFecha.setDate(citasFecha.getDate() - (citasView==="dia"?1:7)); loadCitas(); }
function citasNext(){ citasFecha.setDate(citasFecha.getDate() + (citasView==="dia"?1:7)); loadCitas(); }
function citasHoy(){ citasFecha = new Date(); loadCitas(); }

function setCitasView(v){
  citasView = v;
  document.getElementById("citasViewDiaBtn").classList.toggle("active", v==="dia");
  document.getElementById("citasViewSemanaBtn").classList.toggle("active", v==="semana");
  loadCitas();
}

function openNewCita(){
  editingCitaId = null;
  document.getElementById("citaModalTitle").textContent = "Nueva cita";
  document.getElementById("citaConvertirBtn").style.display = "none";
  document.getElementById("c_estadoField").style.display = "none";
  document.getElementById("citaFormError").style.display = "none";
  document.getElementById("c_fecha").value = citasFecha.toISOString().slice(0,10);
  document.getElementById("c_hora").value = "09:00";
  ["c_patente","c_cliente","c_telefono","c_modelo","c_notas"].forEach(id=>document.getElementById(id).value="");
  document.getElementById("c_sucursal").value = currentUser.sucursal || SUCURSALES[0];
  document.getElementById("c_sucursal").disabled = currentUser.rol !== "Administrador";
  document.getElementById("c_tipo").value = "general";
  document.getElementById("c_cliente_espera").checked = false;
  document.getElementById("c_prueba_ruta").checked = false;
  document.getElementById("citaOverlay").classList.add("show");
}

function openEditCita(id){
  const c = citasCache.find(x=>x.id===id);
  if(!c) return;
  editingCitaId = id;
  document.getElementById("citaModalTitle").textContent = "Editar cita";
  document.getElementById("citaFormError").style.display = "none";
  document.getElementById("c_estadoField").style.display = "block";
  const d = new Date(c.fechaHora);
  document.getElementById("c_fecha").value = d.toISOString().slice(0,10);
  document.getElementById("c_hora").value = d.toTimeString().slice(0,5);
  document.getElementById("c_patente").value = c.patente||"";
  document.getElementById("c_cliente").value = c.cliente||"";
  document.getElementById("c_telefono").value = c.telefono||"";
  document.getElementById("c_modelo").value = c.modelo||"";
  document.getElementById("c_sucursal").value = c.sucursal||SUCURSALES[0];
  document.getElementById("c_sucursal").disabled = currentUser.rol !== "Administrador";
  document.getElementById("c_tipo").value = c.tipo||"general";
  document.getElementById("c_estado").value = c.estado||"pendiente";
  document.getElementById("c_notas").value = c.notas||"";
  document.getElementById("c_cliente_espera").checked = !!c.clienteEspera;
  document.getElementById("c_prueba_ruta").checked = !!c.pruebaRuta;
  document.getElementById("citaConvertirBtn").style.display = c.estado==="convertida" ? "none" : "inline-block";

  const gestiona = puedeGestionarCitas();
  document.getElementById("citaModalTitle").textContent = gestiona ? "Editar cita" : "Detalle de la cita (solo lectura)";
  ["c_fecha","c_hora","c_patente","c_cliente","c_telefono","c_modelo","c_sucursal","c_tipo","c_estado","c_notas","c_cliente_espera","c_prueba_ruta"].forEach(id=>{
    document.getElementById(id).disabled = !gestiona || document.getElementById(id).disabled;
  });
  document.getElementById("citaSaveBtn").style.display = gestiona ? "inline-block" : "none";
  if(!gestiona) document.getElementById("citaConvertirBtn").style.display = "none";

  document.getElementById("citaOverlay").classList.add("show");
}

function closeCitaModal(){ document.getElementById("citaOverlay").classList.remove("show"); }

async function saveCita(){
  const errorEl = document.getElementById("citaFormError");
  errorEl.style.display = "none";
  const fecha = document.getElementById("c_fecha").value;
  const hora = document.getElementById("c_hora").value;
  if(!fecha || !hora){ errorEl.textContent = "Ingresa fecha y hora de la cita."; errorEl.style.display = "block"; return; }
  const payload = {
    fechaHora: new Date(`${fecha}T${hora}:00`).toISOString(),
    patente: document.getElementById("c_patente").value.trim(),
    cliente: document.getElementById("c_cliente").value.trim(),
    telefono: document.getElementById("c_telefono").value.trim(),
    modelo: document.getElementById("c_modelo").value.trim(),
    sucursal: document.getElementById("c_sucursal").value,
    tipo: document.getElementById("c_tipo").value,
    notas: document.getElementById("c_notas").value.trim(),
    clienteEspera: document.getElementById("c_cliente_espera").checked,
    pruebaRuta: document.getElementById("c_prueba_ruta").checked
  };
  if(editingCitaId) payload.estado = document.getElementById("c_estado").value;
  try{
    if(editingCitaId){
      await api(`/api/citas/${editingCitaId}`, { method:"PUT", body: payload });
    }else{
      await api("/api/citas", { method:"POST", body: payload });
    }
    closeCitaModal();
    loadCitas();
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

// Nota: las citas no se pueden eliminar (se conservan como historial) — sin función de borrado aquí.

function convertirCitaEnOT(){
  const c = citasCache.find(x=>x.id===editingCitaId);
  if(!c) return;
  pendingCitaId = c.id;
  closeCitaModal();
  closeCitas();
  openNew();
  document.getElementById("f_patente").value = (c.patente||"").replace(/-/g, "").toUpperCase();
  document.getElementById("f_cliente").value = c.cliente||"";
  document.getElementById("f_modelo").value = c.modelo||"";
  document.getElementById("f_sucursal").value = c.sucursal||SUCURSALES[0];
  document.getElementById("f_tipo").value = c.tipo||"general";
  let notaFinal = "Agendado el " + new Date(c.fechaHora).toLocaleString("es-CL") + (c.notas ? " — " + c.notas : "");
  if(c.pruebaRuta) notaFinal += " — REQUIERE PRUEBA DE RUTA";
  document.getElementById("f_notas").value = notaFinal;
}

// --- Reportes (solo Administrador) ---
let repDetalleCache = [];

function openReportes(){
  document.getElementById("appScreen").style.display = "none";
  document.getElementById("reportesScreen").style.display = "block";
  const hoy = new Date();
  const hace30 = new Date(); hace30.setDate(hace30.getDate()-30);
  document.getElementById("repHasta").value = hoy.toISOString().slice(0,10);
  document.getElementById("repDesde").value = hace30.toISOString().slice(0,10);
  cargarReporte();
}
function closeReportes(){
  document.getElementById("reportesScreen").style.display = "none";
  document.getElementById("appScreen").style.display = "block";
}

function horasATexto(h){
  if(h===null || h===undefined) return "—";
  if(h < 1) return Math.round(h*60) + " min";
  if(h < 48) return h.toFixed(1) + " h";
  return (h/24).toFixed(1) + " días";
}

async function cargarReporte(){
  const desde = document.getElementById("repDesde").value;
  const hasta = document.getElementById("repHasta").value;
  const sucursal = document.getElementById("repSucursal").value;
  if(!desde || !hasta) return;
  try{
    const params = new URLSearchParams({ desde, hasta });
    if(sucursal) params.set("sucursal", sucursal);
    const data = await api(`/api/reportes/tiempos?${params.toString()}`);
    repDetalleCache = data.detalle;
    renderReporteSummary(data);
    renderReporteEtapas(data);
    renderReporteOts(data);
  }catch(e){ alert(e.message); }
}

function renderReporteSummary(data){
  const el = document.getElementById("repSummary");
  el.innerHTML = `
    <div class="rep-stat"><div class="n">${data.totalOts}</div><div class="l">OT en el período</div></div>
    <div class="rep-stat"><div class="n" style="${data.totalSaltos>0?'color:var(--accent);':''}">${data.totalSaltos}</div><div class="l">Etapas saltadas detectadas</div></div>
  `;
}

function renderReporteEtapas(data){
  const el = document.getElementById("repTablaEtapas");
  el.innerHTML = `
    <tr><th>Etapa</th><th>Promedio de tiempo</th><th>OT registradas</th></tr>
    ${data.promedioPorEtapa.map(p => `
      <tr><td>${escapeHtml(p.etapa)}</td><td>${horasATexto(p.promedioHoras)}</td><td>${p.cantidad}</td></tr>
    `).join("")}
  `;
}

function renderReporteOts(data){
  const el = document.getElementById("repTablaOts");
  if(data.detalle.length===0){
    el.innerHTML = `<tr><th>Sin datos</th></tr><tr><td>No hay OT en este período.</td></tr>`;
    return;
  }
  el.innerHTML = `
    <tr><th>OT</th><th>Cliente</th><th>Sucursal</th><th>Etapa actual</th><th>Tiempo total</th><th>Saltos</th></tr>
    ${data.detalle.map(d => `
      <tr class="clickable" data-id="${d.id}">
        <td>${escapeHtml(d.numero)}${d.patente?" · "+escapeHtml(d.patente):""}</td>
        <td>${escapeHtml(d.cliente||"—")}</td>
        <td>${escapeHtml(d.sucursal||"—")}</td>
        <td>${escapeHtml(STAGES[d.etapa]||"—")}</td>
        <td>${horasATexto(d.tiempoTotalHoras)}</td>
        <td>${d.saltos>0 ? `<span class="rep-salto-badge">${d.saltos} salto${d.saltos>1?"s":""}</span>` : "—"}</td>
      </tr>
    `).join("")}
  `;
  el.querySelectorAll("[data-id]").forEach(row=>row.addEventListener("click", ()=>openHistorial(row.dataset.id)));
}

function openHistorial(otId){
  const d = repDetalleCache.find(x=>x.id===otId);
  if(!d) return;
  document.getElementById("historialTitle").textContent = "Historial — OT " + d.numero;
  document.getElementById("historialList").innerHTML = d.cambios.map(c => {
    const fecha = new Date(c.fecha).toLocaleString("es-CL");
    const de = c.etapaAnterior===null ? "—" : STAGES[c.etapaAnterior];
    const a = STAGES[c.etapaNueva];
    const salto = c.etapaAnterior!==null && Math.abs(c.etapaNueva-c.etapaAnterior)>1;
    return `
      <div class="hist-row">
        <div>
          <div>${c.etapaAnterior===null ? "Creada en" : "De <b>"+escapeHtml(de)+"</b> a"} <b>${escapeHtml(a)}</b>${salto?' <span class="rep-salto-badge">salto</span>':""}</div>
          <div class="meta">${escapeHtml(c.actor||"—")} · ${escapeHtml(c.origen||"—")} · ${fecha}</div>
        </div>
      </div>`;
  }).join("");
  document.getElementById("historialOverlay").classList.add("show");
}

async function abrirConfigExcel(){
  document.getElementById("excelConfigError").style.display = "none";
  try{
    const data = await api("/api/settings/citas-excel-url");
    document.getElementById("excelUrlInput").value = data.url || "";
  }catch(e){ document.getElementById("excelUrlInput").value = ""; }
  document.getElementById("excelConfigOverlay").classList.add("show");
}
function cerrarConfigExcel(){ document.getElementById("excelConfigOverlay").classList.remove("show"); }

async function guardarConfigExcel(){
  const errorEl = document.getElementById("excelConfigError");
  errorEl.style.display = "none";
  try{
    await api("/api/settings/citas-excel-url", { method:"PUT", body:{ url: document.getElementById("excelUrlInput").value.trim() } });
    cerrarConfigExcel();
  }catch(e){
    errorEl.textContent = e.message;
    errorEl.style.display = "block";
  }
}

async function sincronizarExcel(){
  const msg = document.getElementById("citasSyncMsg");
  msg.style.display = "block";
  msg.className = "sync-msg";
  msg.textContent = "Sincronizando...";
  try{
    const data = await api("/api/citas/sincronizar", { method:"POST" });
    msg.className = "sync-msg ok";
    let texto = `Listo — ${data.creadas} cita(s) nueva(s), ${data.actualizadas} actualizada(s) de ${data.totalFilas} filas leídas.`;
    if(data.omitidasPorSucursal) texto += ` ${data.omitidasPorSucursal} fila(s) de otras sucursales se ignoraron.`;
    if(data.errores && data.errores.length) texto += ` (${data.errores.length} fila(s) con problemas — revisa el formato)`;
    msg.textContent = texto;
    loadCitas();
  }catch(e){
    msg.className = "sync-msg error";
    msg.textContent = e.message;
  }
}

async function importarCitasArchivo(file){
  const msg = document.getElementById("citasSyncMsg");
  msg.style.display = "block";
  msg.className = "sync-msg";
  msg.textContent = "Importando...";
  try{
    const fileBase64 = await leerArchivoComoBase64(file);
    const data = await api("/api/citas/importar-excel", { method:"POST", body:{ fileBase64 } });
    msg.className = "sync-msg ok";
    let texto = `Listo — ${data.creadas} cita(s) nueva(s), ${data.actualizadas} actualizada(s) de ${data.totalFilas} filas leídas.`;
    if(data.omitidasPorSucursal) texto += ` ${data.omitidasPorSucursal} fila(s) de otras sucursales se ignoraron.`;
    if(data.errores && data.errores.length) texto += ` (${data.errores.length} fila(s) con problemas — revisa el formato)`;
    msg.textContent = texto;
    loadCitas();
  }catch(e){
    msg.className = "sync-msg error";
    msg.textContent = e.message;
  }
}

async function borrarTodasLasCitas(){
  const suc = document.getElementById("citasFilterSucursal").value;
  const alcance = suc ? `de ${suc}` : "de TODAS las sucursales";
  const confirmacion = prompt(`Esto va a borrar TODAS las citas ${alcance} — no se puede deshacer.\n\nEscribe BORRAR para confirmar:`);
  if (confirmacion !== "BORRAR") return;
  const msg = document.getElementById("citasSyncMsg");
  msg.style.display = "block";
  msg.className = "sync-msg";
  msg.textContent = "Borrando...";
  try{
    const qs = suc ? `?sucursal=${encodeURIComponent(suc)}` : "";
    const data = await api(`/api/citas${qs}`, { method:"DELETE" });
    msg.className = "sync-msg ok";
    msg.textContent = `Listo — ${data.eliminadas} cita(s) eliminada(s).`;
    loadCitas();
  }catch(e){
    msg.className = "sync-msg error";
    msg.textContent = e.message;
  }
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
document.getElementById("filterTipo").addEventListener("change", render);
document.getElementById("logoutBtn").addEventListener("click", async ()=>{ await api("/api/logout", {method:"POST"}); location.reload(); });
document.getElementById("usersBtn").addEventListener("click", openUsers);
document.getElementById("usersCloseBtn").addEventListener("click", ()=>document.getElementById("usersOverlay").classList.remove("show"));
document.getElementById("createUserBtn").addEventListener("click", createUser);
document.getElementById("importUsersBtn").addEventListener("click", ()=>document.getElementById("importUsersInput").click());
document.getElementById("importUsersInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) importarUsuariosExcel(file);
  e.target.value = "";
});
document.getElementById("qrBtn").addEventListener("click", openQr);
document.getElementById("qrCloseBtn").addEventListener("click", ()=>document.getElementById("qrOverlay").classList.remove("show"));
document.getElementById("qrPrintBtn").addEventListener("click", printQr);
document.getElementById("clienteQrBtn").addEventListener("click", openClienteQr);
document.getElementById("tallerQrBtn").addEventListener("click", openTallerQr);
document.getElementById("addFotoBtn").addEventListener("click", ()=>document.getElementById("fotoInput").click());
document.getElementById("fotoInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) addFoto(file);
  e.target.value = "";
});

document.getElementById("citasBtn").addEventListener("click", openCitas);
document.getElementById("citasVolverBtn").addEventListener("click", closeCitas);
document.getElementById("citasNewBtn").addEventListener("click", openNewCita);
document.getElementById("citasPrevBtn").addEventListener("click", citasPrev);
document.getElementById("citasNextBtn").addEventListener("click", citasNext);
document.getElementById("citasHoyBtn").addEventListener("click", citasHoy);
document.getElementById("citasViewDiaBtn").addEventListener("click", ()=>setCitasView("dia"));
document.getElementById("citasViewSemanaBtn").addEventListener("click", ()=>setCitasView("semana"));
document.getElementById("citasFilterSucursal").addEventListener("change", renderCitas);
document.getElementById("citaCancelBtn").addEventListener("click", closeCitaModal);
document.getElementById("citaSaveBtn").addEventListener("click", saveCita);
// El listener de eliminar cita se quitó — ya no existe esa función.
document.getElementById("citaConvertirBtn").addEventListener("click", convertirCitaEnOT);
document.getElementById("citaOverlay").addEventListener("click",(e)=>{ if(e.target.id==="citaOverlay") closeCitaModal(); });

document.getElementById("reportesBtn").addEventListener("click", openReportes);
document.getElementById("reportesVolverBtn").addEventListener("click", closeReportes);
document.getElementById("reportesUnidadesBtn").addEventListener("click", ()=>{
  window.location.href = "/api/reportes/unidades-excel";
});
document.getElementById("repBuscarBtn").addEventListener("click", cargarReporte);
document.getElementById("historialCloseBtn").addEventListener("click", ()=>document.getElementById("historialOverlay").classList.remove("show"));
document.getElementById("historialOverlay").addEventListener("click",(e)=>{ if(e.target.id==="historialOverlay") document.getElementById("historialOverlay").classList.remove("show"); });

document.getElementById("citasSyncBtn").addEventListener("click", sincronizarExcel);
document.getElementById("citasImportarArchivoBtn").addEventListener("click", ()=>document.getElementById("citasImportarArchivoInput").click());
document.getElementById("citasBorrarTodasBtn").addEventListener("click", borrarTodasLasCitas);
document.getElementById("citasImportarArchivoInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) importarCitasArchivo(file);
  e.target.value = "";
});
document.getElementById("citasConfigExcelBtn").addEventListener("click", abrirConfigExcel);
document.getElementById("excelConfigCancelBtn").addEventListener("click", cerrarConfigExcel);
document.getElementById("excelConfigSaveBtn").addEventListener("click", guardarConfigExcel);
document.getElementById("excelConfigOverlay").addEventListener("click",(e)=>{ if(e.target.id==="excelConfigOverlay") cerrarConfigExcel(); });

// Mantiene el orden visual de la OT: convierte a mayúsculas mientras se escribe,
// conservando la posición del cursor (el servidor igual lo normaliza al guardar).
document.querySelectorAll(".input-upper").forEach(el=>{
  el.addEventListener("input", ()=>{
    const pos = el.selectionStart;
    el.value = el.value.toUpperCase();
    if(pos !== null && el.setSelectionRange) el.setSelectionRange(pos, pos);
  });
});

tryResumeSession();
