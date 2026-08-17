function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

async function buscar(){
  const msg = document.getElementById("msg");
  const resultadosEl = document.getElementById("resultados");
  const q = document.getElementById("qInput").value.trim();
  msg.textContent = "";
  msg.className = "msg";
  resultadosEl.innerHTML = "";

  if(!q){
    msg.textContent = "Escribe una patente o número de OT.";
    msg.className = "msg error";
    return;
  }

  try{
    const res = await fetch(`/api/public/buscar?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo buscar");

    if(data.resultados.length === 0){
      msg.textContent = "No se encontró ninguna OT con ese dato.";
      msg.className = "msg error";
      return;
    }

    if(data.resultados.length === 1){
      // resultado único: entra directo a la pantalla de la OT
      location.href = `/t/${data.resultados[0].id}`;
      return;
    }

    resultadosEl.innerHTML = data.resultados.map(r => `
      <div class="resultado" data-id="${r.id}">
        <div class="top">
          <span class="ot">OT ${escapeHtml(r.numero)}</span>
          <span class="etapa">${escapeHtml(data.stages[r.etapa])}</span>
        </div>
        <div class="cliente">${escapeHtml(r.cliente || "Sin cliente")}</div>
        <div class="modelo">${escapeHtml(r.modelo || "")} ${r.patente ? "· "+escapeHtml(r.patente) : ""}</div>
      </div>
    `).join("");
    resultadosEl.querySelectorAll("[data-id]").forEach(el=>{
      el.addEventListener("click", ()=>{ location.href = `/t/${el.dataset.id}`; });
    });
  }catch(e){
    msg.textContent = e.message;
    msg.className = "msg error";
  }
}

document.getElementById("buscarBtn").addEventListener("click", buscar);
document.getElementById("qInput").addEventListener("keydown", e=>{ if(e.key==="Enter") buscar(); });
