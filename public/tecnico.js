const otId = location.pathname.split("/t/")[1];
let ot = null;
let stages = [];

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function load(){
  try{
    const res = await fetch(`/api/public/ot/${otId}`);
    if(!res.ok) throw new Error("not found");
    const data = await res.json();
    ot = data.ot; stages = data.stages;

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

document.getElementById("advanceBtn").addEventListener("click", ()=>{
  if(ot.etapa < stages.length-1) updateStage(ot.etapa+1);
});
document.getElementById("backBtn").addEventListener("click", ()=>{
  if(ot.etapa > 0) updateStage(ot.etapa-1);
});

load();
