const otId = location.pathname.split("/t/")[1];
let ot = null;
let stages = [];
let fotos = [];
let intervaloCuentaRegresiva = null;

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
  // Esta pantalla ahora es solo para técnicos (el lavado tiene su propio QR independiente).
  let roster = [];
  try{
    const params = new URLSearchParams({ sucursal: ot.sucursal || "", rol: "Mecánico" });
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
    // Si el trabajo ya está iniciado, se muestra a quien lo inició (así, al volver a buscar la
    // misma patente/OT para finalizar, aparece solo su nombre) — esto manda por sobre el último
    // nombre usado en este celular.
    if(ot.trabajoIniciadoAt && ot.tecnicoTrabajo) sel.value = ot.tecnicoTrabajo;
    else if(savedActor) sel.value = savedActor;
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

  // Esta pantalla ya no depende de en qué etapa esté la OT — solo importa si el trabajo está
  // iniciado o no, para saber cuál de los 2 botones mostrar.
  const yaIniciado = !!ot.trabajoIniciadoAt;
  document.getElementById("inicioTrabajoBtn").style.display = yaIniciado ? "none" : "block";
  document.getElementById("terminoTrabajoBtn").style.display = yaIniciado ? "block" : "none";
  const hint = document.getElementById("inicioTrabajoHint");
  if(yaIniciado){
    const hora = new Date(ot.trabajoIniciadoAt).toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"});
    hint.textContent = "Iniciado a las " + hora;
    hint.style.display = "block";
    actualizarBloqueoTermino();
  } else {
    hint.style.display = "none";
  }
}

// Mínimo 15 minutos entre "Inicio" y "Término de trabajo" — mientras no pasen, el botón queda
// bloqueado con una cuenta regresiva visible. El servidor valida lo mismo por su cuenta, así que
// esto es solo para que el técnico vea por qué no puede terminar todavía.
const MINUTOS_MINIMOS_TRABAJO = 15;
function actualizarBloqueoTermino(){
  if(intervaloCuentaRegresiva){ clearInterval(intervaloCuentaRegresiva); intervaloCuentaRegresiva = null; }
  const btn = document.getElementById("terminoTrabajoBtn");
  const countdown = document.getElementById("terminoTrabajoCountdown");

  const tick = () => {
    if(!ot.trabajoIniciadoAt){
      btn.disabled = false;
      countdown.style.display = "none";
      if(intervaloCuentaRegresiva){ clearInterval(intervaloCuentaRegresiva); intervaloCuentaRegresiva = null; }
      return;
    }
    const segundosFaltantes = Math.ceil(MINUTOS_MINIMOS_TRABAJO*60 - (Date.now() - new Date(ot.trabajoIniciadoAt).getTime())/1000);
    if(segundosFaltantes <= 0){
      btn.disabled = false;
      countdown.style.display = "none";
      if(intervaloCuentaRegresiva){ clearInterval(intervaloCuentaRegresiva); intervaloCuentaRegresiva = null; }
      return;
    }
    btn.disabled = true;
    const mm = Math.floor(segundosFaltantes/60), ss = segundosFaltantes%60;
    countdown.textContent = `Disponible en ${mm}:${String(ss).padStart(2,"0")}`;
    countdown.style.display = "block";
  };
  tick();
  intervaloCuentaRegresiva = setInterval(tick, 1000);
}

// Nota: el check de presupuesto es solo de consulta en esta pantalla — no editable desde el QR.
// Nota: el check de lavado ya no vive acá — tiene su propio QR independiente (/lavado).

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
document.getElementById("terminoTrabajoBtn").addEventListener("click", async ()=>{
  const msg = document.getElementById("msg");
  const actor = document.getElementById("actorSelect").value;
  if(!actor){
    msg.textContent = "Selecciona tu nombre antes de continuar.";
    msg.className = "msg error";
    return;
  }
  try{
    const res = await fetch(`/api/public/ot/${otId}/termino-trabajo`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorNombre: actor })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo guardar");
    ot = data.ot;
    render();
    msg.textContent = "Término de trabajo registrado ✓";
    msg.className = "msg ok";
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
});
document.getElementById("addFotoBtn").addEventListener("click", ()=>document.getElementById("fotoInput").click());
document.getElementById("fotoInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) addFoto(file);
  e.target.value = "";
});

load();
