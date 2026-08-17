function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function buscar(){
  const msg = document.getElementById("msg");
  const result = document.getElementById("result");
  const patente = document.getElementById("patenteInput").value.trim();
  msg.textContent = "";
  msg.className = "msg";
  result.style.display = "none";

  if(!patente){
    msg.textContent = "Ingresa tu patente.";
    msg.className = "msg error";
    return;
  }

  try{
    const res = await fetch(`/api/public/consulta?patente=${encodeURIComponent(patente)}`);
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo consultar");
    render(data.ot, data.stages, data.fotos || []);
    result.style.display = "block";
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}

function render(ot, stages, fotos){
  document.getElementById("v_modelo").textContent = ot.modelo || ("OT " + ot.numero);
  document.getElementById("v_patente").textContent = ot.patente || "";
  document.getElementById("v_sucursal").textContent = ot.sucursal || "";

  const stepper = document.getElementById("stepper");
  stepper.innerHTML = stages.map((s,i)=>{
    const cls = i < ot.etapa ? "done" : (i === ot.etapa ? "current" : "");
    const bullet = i < ot.etapa ? "✓" : (i+1);
    return `<div class="step ${cls}"><div class="bullet">${bullet}</div><div class="label">${escapeHtml(s)}</div></div>`;
  }).join("");

  const entregaBox = document.getElementById("entregaBox");
  if(ot.fechaEntrega){
    const d = new Date(ot.fechaEntrega);
    if(!isNaN(d.getTime())){
      document.getElementById("v_entrega").textContent =
        d.toLocaleDateString("es-CL",{day:"2-digit",month:"2-digit"}) + " " +
        d.toLocaleTimeString("es-CL",{hour:"2-digit",minute:"2-digit"});
      entregaBox.style.display = "block";
    } else {
      entregaBox.style.display = "none";
    }
  } else {
    entregaBox.style.display = "none";
  }

  const fotosBox = document.getElementById("fotosBox");
  if(fotos && fotos.length){
    document.getElementById("fotosGrid").innerHTML = fotos.map(url => `<img src="${url}">`).join("");
    fotosBox.style.display = "block";
  } else {
    fotosBox.style.display = "none";
  }
}

document.getElementById("buscarBtn").addEventListener("click", buscar);
document.getElementById("patenteInput").addEventListener("keydown", e=>{ if(e.key==="Enter") buscar(); });
