const STAGE_COLORS = ["#6B7280","#0F8A72","#B08900","#1D6FA5","#EB0A1E","#6B4FA0","#2E8FA6","#1E8A5F"];

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function getSucursalFromUrl(){
  return new URLSearchParams(location.search).get("sucursal") || "";
}

function actualizarReloj(){
  const el = document.getElementById("tvClock");
  if(el) el.textContent = new Date().toLocaleString("es-CL", { weekday:"long", day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
}

async function mostrarPicker(sucursales){
  document.getElementById("tvScreen").style.display = "none";
  document.getElementById("pickerScreen").style.display = "block";
  document.getElementById("pickerButtons").innerHTML = sucursales.map(s =>
    `<button data-suc="${escapeHtml(s)}">${escapeHtml(s)}</button>`
  ).join("");
  document.querySelectorAll("[data-suc]").forEach(b=>{
    b.addEventListener("click", ()=>{
      const params = new URLSearchParams(location.search);
      params.set("sucursal", b.dataset.suc);
      location.search = params.toString();
    });
  });
}

function renderCitas(data){
  const tiposByValue = {};
  (data.tipos || []).forEach(t => tiposByValue[t.value] = t);
  const el = document.getElementById("tvCitasList");
  const citas = data.citas || [];
  if(citas.length === 0){
    el.innerHTML = `<div class="tv-citas-empty">Sin citas hoy</div>`;
    return;
  }
  el.innerHTML = citas.map(c => {
    const tipo = tiposByValue[c.tipo];
    const hora = new Date(c.fechaHora).toLocaleTimeString("es-CL", { hour:"2-digit", minute:"2-digit" });
    const clase = c.estado === "convertida" ? " convertida" : "";
    return `
      <div class="tv-cita${clase}" style="border-left-color:${tipo ? "#"+tipo.color : "var(--border-strong)"}">
        <div class="hora">${hora}</div>
        <div class="cli">${escapeHtml(c.cliente || "Sin nombre")}</div>
        <div class="pat">${escapeHtml(c.patente || "")}</div>
      </div>`;
  }).join("");
}

function render(data){
  document.getElementById("pickerScreen").style.display = "none";
  document.getElementById("tvScreen").style.display = "flex";
  document.getElementById("tvSucursal").textContent = data.sucursal;

  renderCitas(data);

  const tiposByValue = {};
  (data.tipos || []).forEach(t => tiposByValue[t.value] = t);

  const maxEnColumna = Math.max(0, ...data.stages.map((s,idx)=> data.ots.filter(o=>o.etapa===idx).length));
  const board = document.getElementById("tvBoard");
  board.classList.remove("compact","ultra-compact");
  if(maxEnColumna > 12) board.classList.add("ultra-compact");
  else if(maxEnColumna > 6) board.classList.add("compact");

  board.innerHTML = data.stages.map((stage, idx) => {
    const items = data.ots.filter(o => o.etapa === idx);
    return `
      <div class="tv-col">
        <div class="tv-col-head"><span>${escapeHtml(stage)}</span><span>${items.length}</span></div>
        <div class="tv-col-bar" style="background:${STAGE_COLORS[idx]}"></div>
        <div class="tv-cards">
          ${items.length === 0 ? `<div class="tv-empty">Sin OT</div>` : items.map(o => {
            const tipo = tiposByValue[o.tipo];
            return `
              <div class="tv-card" style="border-left-color:${tipo ? "#"+tipo.color : "var(--border-strong)"}">
                <div class="ot">OT ${escapeHtml(o.numero)}</div>
                <div class="cli">${escapeHtml(o.cliente || "Sin cliente")}</div>
                <div class="mod">${escapeHtml(o.modelo || "")} ${o.patente ? "· " + escapeHtml(o.patente) : ""}</div>
              </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");
}

async function cargar(){
  const sucursal = getSucursalFromUrl();
  if(!sucursal){
    try{
      const res = await fetch("/api/public/pantalla");
      const data = await res.json();
      mostrarPicker(data.sucursales || []);
    }catch(e){ /* silencioso */ }
    return;
  }
  try{
    const res = await fetch(`/api/public/pantalla?sucursal=${encodeURIComponent(sucursal)}`);
    const data = await res.json();
    if(!res.ok){
      mostrarPicker(data.sucursales || []);
      return;
    }
    render(data);
  }catch(e){ /* si falla, se mantiene lo último mostrado en pantalla */ }
}

actualizarReloj();
setInterval(actualizarReloj, 30000);
cargar();
setInterval(cargar, 20000);
