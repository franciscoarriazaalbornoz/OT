const otId = location.pathname.split("/l/")[1];

function escapeHtml(s){
  return String(s || "").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function render(ot, stages){
  document.getElementById("loadingWrap").style.display = "none";
  document.getElementById("wrap").style.display = "block";
  document.getElementById("otNum").textContent = "OT " + (ot.numero || "—");
  document.getElementById("otCliente").textContent = ot.cliente || "Sin cliente";
  document.getElementById("otModelo").textContent = [ot.modelo, ot.patente].filter(Boolean).join(" · ");
  document.getElementById("otEtapa").textContent = "Etapa actual: " + (stages[ot.etapa] || "");

  const toggle = document.getElementById("lavadoToggle");
  const input = document.getElementById("lavadoInput");
  input.checked = !!ot.checkLavado;
  toggle.classList.toggle("on", !!ot.checkLavado);
}

async function cargar(){
  try{
    const res = await fetch(`/api/public/ot/${otId}`);
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo cargar la OT");
    render(data.ot, data.stages);
  }catch(e){
    document.getElementById("loadingWrap").innerHTML = `<p style="text-align:center;color:var(--accent);">${escapeHtml(e.message)}</p>`;
  }
}

document.getElementById("lavadoInput").addEventListener("change", async (e)=>{
  const msg = document.getElementById("msg");
  const toggle = document.getElementById("lavadoToggle");
  const value = e.target.checked;
  msg.textContent = "Guardando...";
  msg.className = "msg";
  try{
    const res = await fetch(`/api/public/ot/${otId}/check-lavado`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value })
    });
    const data = await res.json();
    if(!res.ok) throw new Error(data.error || "No se pudo guardar");
    toggle.classList.toggle("on", value);
    msg.textContent = value ? "Marcado ✓" : "Desmarcado";
    msg.className = "msg ok";
  }catch(err){
    e.target.checked = !value;
    msg.textContent = err.message;
    msg.className = "msg error";
  }
});

cargar();
