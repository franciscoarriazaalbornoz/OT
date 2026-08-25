const otId = location.pathname.split("/t/")[1];
let ot = null;
let stages = [];
let fotos = [];

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
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

function renderFotos(){
  const grid = document.getElementById("fotosGrid");
  grid.innerHTML = fotos.map(f => `
    <div class="foto-thumb"><img src="${f.dataUrl}"><button class="del" data-foto="${f.id}">✕</button></div>
  `).join("");
  grid.querySelectorAll("[data-foto]").forEach(b=>b.addEventListener("click", ()=>deleteFoto(b.dataset.foto)));
  document.getElementById("addFotoBtn").style.display = fotos.length >= 4 ? "none" : "block";
}

async function addFoto(file){
  const msg = document.getElementById("msg");
  const actor = document.getElementById("actorSelect").value;
  try{
    const dataUrl = await resizeImageFile(file);
    const res = await fetch(`/api/public/ot/${otId}/fotos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl, actorNombre: actor })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo subir la foto");
    fotos.push(data.foto);
    renderFotos();
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}

async function deleteFoto(fotoId){
  try{
    await fetch(`/api/public/ot/${otId}/fotos/${fotoId}`, { method: "DELETE" });
    fotos = fotos.filter(f=>f.id!==fotoId);
    renderFotos();
  }catch(e){ /* silencioso */ }
}

async function loadRoster(){
  const sel = document.getElementById("actorSelect");
  const seleccionActual = sel.value;
  // La sucursal ya está definida por la OT. El rol esperado depende de la etapa:
  // en "Lavado" se muestra solo a los lavadores; en cualquier otra etapa, solo a los técnicos.
  const rolFiltro = stages[ot.etapa] === "Lavado" ? "Lavado y entrega" : "Mecánico";
  let roster = [];
  try{
    const params = new URLSearchParams({ sucursal: ot.sucursal || "", rol: rolFiltro });
    const rosterRes = await fetch(`/api/public/roster?${params.toString()}`);
    const rosterData = await rosterRes.json();
    roster = rosterData.roster || [];
  }catch(e){ /* silencioso: se deja el select como estaba */ }

  sel.innerHTML = `<option value="">Selecciona tu nombre</option>`;
  roster.forEach(u=>{
    const o = document.createElement("option");
    o.value = u.nombre; o.textContent = `${u.nombre} (${u.rol})`;
    sel.appendChild(o);
  });
  if(seleccionActual) sel.value = seleccionActual;
}

async function load(){
  try{
    const res = await fetch(`/api/public/ot/${otId}`);
    if(!res.ok) throw new Error("not found");
    const data = await res.json();
    ot = data.ot; stages = data.stages; fotos = data.fotos || [];

    const savedActor = sessionStorage.getItem("ot-actor-nombre");
    await loadRoster();
    const sel = document.getElementById("actorSelect");
    if(savedActor) sel.value = savedActor;
    sel.addEventListener("change", ()=> sessionStorage.setItem("ot-actor-nombre", sel.value));

    render();
    renderFotos();
    document.getElementById("loading").style.display = "none";
    document.getElementById("content").style.display = "block";
  }catch(e){
    document.getElementById("loading").style.display = "none";
    document.getElementById("notFound").style.display = "block";
  }
}

function render(){
  document.getElementById("v_ot").textContent = "OT " + ot.numero;
  document.getElementById("v_cliente").textContent = ot.cliente || "Sin cliente";
  document.getElementById("v_modelo").textContent = [ot.modelo, ot.patente].filter(Boolean).join(" · ");
  document.getElementById("v_etapa").textContent = stages[ot.etapa];

  const lavadoBox = document.getElementById("lavadoCheckBox");
  const esEtapaLavado = stages[ot.etapa] === "Lavado";
  lavadoBox.style.display = esEtapaLavado ? "block" : "none";
  if(esEtapaLavado){
    document.getElementById("lavadoCheckInput").checked = !!ot.checkLavado;
  }

  const pptoBox = document.getElementById("pptoCheckBox");
  const esEtapaPpto = stages[ot.etapa] === "Presupuesto/Aprobación";
  pptoBox.style.display = esEtapaPpto ? "block" : "none";
  if(esEtapaPpto){
    const realizadoOn = !!ot.checkPptoRealizado;
    const autorizadoOn = !!ot.checkPptoAutorizado;
    document.getElementById("pptoRealizadoDot").className = "ppto-status-dot" + (realizadoOn ? " on" : "");
    document.getElementById("pptoRealizadoLabel").parentElement.className = "ppto-status-row" + (realizadoOn ? " on" : "");
    document.getElementById("pptoAutorizadoDot").className = "ppto-status-dot" + (autorizadoOn ? " on" : "");
    document.getElementById("pptoAutorizadoLabel").parentElement.className = "ppto-status-row" + (autorizadoOn ? " on" : "");
  }

  document.getElementById("backBtn").disabled = ot.etapa === 0;
  document.getElementById("advanceBtn").disabled = ot.etapa === stages.length - 1;
  document.getElementById("advanceBtn").textContent = ot.etapa === stages.length - 1
    ? "Ya está en la última etapa"
    : `Avanzar a: ${stages[ot.etapa+1]} →`;

  // Flujo simplificado para el mecánico: en vez de las flechas genéricas, dos botones claros
  // juntos mientras la OT está en Reparación.
  const nombreEtapa = stages[ot.etapa];
  const esReparacion = nombreEtapa === "Reparación";
  const trabajoBox = document.getElementById("trabajoBox");
  const genericActions = document.getElementById("genericActions");
  trabajoBox.style.display = esReparacion ? "flex" : "none";
  genericActions.style.display = esReparacion ? "none" : "flex";
  if(esReparacion){
    const hint = document.getElementById("inicioTrabajoHint");
    if(ot.trabajoIniciadoAt){
      const hora = new Date(ot.trabajoIniciadoAt).toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"});
      hint.textContent = "Iniciado a las " + hora;
      hint.style.display = "block";
    } else {
      hint.style.display = "none";
    }
  }

  const pills = document.getElementById("stagePills");
  pills.innerHTML = stages.map((s,i)=>`
    <button class="stage-pill${i===ot.etapa? " active":""}" data-stage="${i}">${escapeHtml(s)}</button>
  `).join("");
  pills.querySelectorAll("[data-stage]").forEach(b=>{
    b.addEventListener("click", ()=> updateStage(parseInt(b.dataset.stage,10)));
  });
}

async function updateStage(etapa){
  const msg = document.getElementById("msg");
  const actor = document.getElementById("actorSelect").value;
  if(!actor){
    msg.textContent = "Selecciona tu nombre antes de continuar.";
    msg.className = "msg error";
    return;
  }
  msg.textContent = "Guardando...";
  msg.className = "msg";
  try{
    const res = await fetch(`/api/public/ot/${otId}/stage`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ etapa, actorNombre: actor })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo guardar");
    ot = data.ot; stages = data.stages;
    render();
    await loadRoster();
    msg.textContent = "Actualizado ✓";
    msg.className = "msg ok";
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}

async function toggleCheckLavado(){
  const msg = document.getElementById("msg");
  const checked = document.getElementById("lavadoCheckInput").checked;
  try{
    const res = await fetch(`/api/public/ot/${otId}/check-lavado`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: checked })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo guardar");
    ot = data.ot;
    msg.textContent = checked ? "Marcado ✓" : "Desmarcado";
    msg.className = "msg ok";
  }catch(e){
    document.getElementById("lavadoCheckInput").checked = !checked;
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}
// Nota: el check de presupuesto es solo de consulta en esta pantalla — no editable desde el QR.

document.getElementById("lavadoCheckInput").addEventListener("change", toggleCheckLavado);

document.getElementById("advanceBtn").addEventListener("click", ()=>{
  if(ot.etapa < stages.length-1) updateStage(ot.etapa+1);
});
document.getElementById("backBtn").addEventListener("click", ()=>{
  if(ot.etapa > 0) updateStage(ot.etapa-1);
});
document.getElementById("inicioTrabajoBtn").addEventListener("click", async ()=>{
  const msg = document.getElementById("msg");
  const actor = document.getElementById("actorSelect").value;
  if(!actor){
    msg.textContent = "Selecciona tu nombre antes de continuar.";
    msg.className = "msg error";
    return;
  }
  try{
    const res = await fetch(`/api/public/ot/${otId}/inicio-trabajo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorNombre: actor })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo guardar");
    ot = data.ot;
    render();
    msg.textContent = "Inicio de trabajo registrado ✓";
    msg.className = "msg ok";
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
});
document.getElementById("terminoTrabajoBtn").addEventListener("click", ()=>{
  const idx = stages.indexOf("Control de calidad");
  if(idx >= 0) updateStage(idx);
});
document.getElementById("addFotoBtn").addEventListener("click", ()=>document.getElementById("fotoInput").click());
document.getElementById("fotoInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) addFoto(file);
  e.target.value = "";
});

load();
