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

async function load(){
  try{
    const res = await fetch(`/api/public/ot/${otId}`);
    if(!res.ok) throw new Error("not found");
    const data = await res.json();
    ot = data.ot; stages = data.stages; fotos = data.fotos || [];

    const rosterRes = await fetch("/api/public/roster");
    const rosterData = await rosterRes.json();
    const sel = document.getElementById("actorSelect");
    rosterData.roster.forEach(u=>{
      const o = document.createElement("option");
      o.value = u.nombre; o.textContent = `${u.nombre} (${u.rol})`;
      sel.appendChild(o);
    });
    const savedActor = sessionStorage.getItem("ot-actor-nombre");
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

  document.getElementById("backBtn").disabled = ot.etapa === 0;
  document.getElementById("advanceBtn").disabled = ot.etapa === stages.length - 1;
  document.getElementById("advanceBtn").textContent = ot.etapa === stages.length - 1
    ? "Ya está en la última etapa"
    : `Avanzar a: ${stages[ot.etapa+1]} →`;

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
document.getElementById("lavadoCheckInput").addEventListener("change", toggleCheckLavado);

document.getElementById("advanceBtn").addEventListener("click", ()=>{
  if(ot.etapa < stages.length-1) updateStage(ot.etapa+1);
});
document.getElementById("backBtn").addEventListener("click", ()=>{
  if(ot.etapa > 0) updateStage(ot.etapa-1);
});
document.getElementById("addFotoBtn").addEventListener("click", ()=>document.getElementById("fotoInput").click());
document.getElementById("fotoInput").addEventListener("change", (e)=>{
  const file = e.target.files[0];
  if(file) addFoto(file);
  e.target.value = "";
});

load();
