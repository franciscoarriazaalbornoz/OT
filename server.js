const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const XLSX = require("xlsx");

if (!process.env.DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL (cadena de conexión a Postgres).");
  console.error("Ver README.md, sección 'Despliegue gratuito en la nube'.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=disable') ? false : { rejectUnauthorized: false }
});

const STAGES = ["Recepción","Diagnóstico","Presupuesto/Aprobación","Repuestos","Reparación","Control de calidad","Lavado","Entrega"];
const SUCURSALES = ["Summit Colón","Rancagua","Matta","Antofagasta","Calama"];
const ROLES = ["Recepción","Asesor de servicio","Mecánico","Repuestos","Control de calidad","Lavado y entrega","Jefe de taller","Administrador"];
const TIPOS_TRABAJO = [
  { value: "mantencion", label: "Mantención", color: "EB0A1E" },
  { value: "general", label: "Trabajo general", color: "E8B400" },
  { value: "dyp", label: "DyP", color: "6B4FA0" },
  { value: "fir", label: "FIR", color: "181818" },
  { value: "garantia", label: "Garantía / Campaña / Primer servicio", color: "1E8A5F" },
];

function rowToUser(r) {
  return {
    id: r.id, username: r.username, passwordHash: r.password_hash,
    nombre: r.nombre, rol: r.rol, sucursal: r.sucursal || "",
    mustChangePassword: r.must_change_password
  };
}
function rowToOt(r) {
  return {
    id: r.id, numero: r.numero, patente: r.patente || "",
    fechaIngreso: r.fecha_ingreso ? new Date(r.fecha_ingreso).toISOString().slice(0,10) : "",
    fechaEntrega: r.fecha_entrega ? new Date(r.fecha_entrega).toISOString().slice(0,16) : "",
    cliente: r.cliente || "", modelo: r.modelo || "", sucursal: r.sucursal || "",
    etapa: r.etapa, responsable: r.responsable || "", prioridad: r.prioridad || "normal",
    tipo: r.tipo || "general",
    checkLavado: r.check_lavado === true,
    notas: r.notas || "", creadoPor: r.creado_por || "",
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : ""
  };
}
function publicUser(u) {
  return { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol, sucursal: u.sucursal, mustChangePassword: !!u.mustChangePassword };
}
function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

async function logCambioEtapa(otId, etapaAnterior, etapaNueva, actor, origen) {
  await pool.query(
    "INSERT INTO etapa_historial (id, ot_id, etapa_anterior, etapa_nueva, actor, origen, created_at) VALUES ($1,$2,$3,$4,$5,$6, now())",
    [uid("hist"), otId, etapaAnterior, etapaNueva, actor || "", origen]
  );
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nombre TEXT NOT NULL,
      rol TEXT NOT NULL,
      sucursal TEXT DEFAULT '',
      must_change_password BOOLEAN DEFAULT true
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ots (
      id TEXT PRIMARY KEY,
      numero TEXT NOT NULL,
      patente TEXT DEFAULT '',
      fecha_ingreso DATE,
      cliente TEXT DEFAULT '',
      modelo TEXT DEFAULT '',
      sucursal TEXT DEFAULT '',
      etapa INTEGER DEFAULT 0,
      responsable TEXT DEFAULT '',
      prioridad TEXT DEFAULT 'normal',
      notas TEXT DEFAULT '',
      creado_por TEXT DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Migración: agrega la columna de fecha/hora de entrega si la tabla ya existía sin ella
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS fecha_entrega TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS tipo TEXT DEFAULT 'general';`);
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS check_lavado BOOLEAN DEFAULT false;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS etapa_historial (
      id TEXT PRIMARY KEY,
      ot_id TEXT NOT NULL REFERENCES ots(id) ON DELETE CASCADE,
      etapa_anterior INTEGER,
      etapa_nueva INTEGER NOT NULL,
      actor TEXT DEFAULT '',
      origen TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS citas (
      id TEXT PRIMARY KEY,
      patente TEXT DEFAULT '',
      cliente TEXT DEFAULT '',
      telefono TEXT DEFAULT '',
      modelo TEXT DEFAULT '',
      fecha_hora TIMESTAMPTZ NOT NULL,
      sucursal TEXT DEFAULT '',
      tipo TEXT DEFAULT 'general',
      estado TEXT DEFAULT 'pendiente',
      notas TEXT DEFAULT '',
      creado_por TEXT DEFAULT '',
      ot_id TEXT REFERENCES ots(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ot_fotos (
      id TEXT PRIMARY KEY,
      ot_id TEXT NOT NULL REFERENCES ots(id) ON DELETE CASCADE,
      data_url TEXT NOT NULL,
      creado_por TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM users");
  if (rows[0].n === 0) {
    const hash = bcrypt.hashSync("summit2026", 10);
    await pool.query(
      `INSERT INTO users (id, username, password_hash, nombre, rol, sucursal, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      ["u_admin", "admin", hash, "Administrador", "Administrador", ""]
    );
    console.log("Usuario inicial creado -> usuario: admin / clave: summit2026 (cámbiala apenas entres)");
  }
}

const app = express();
app.use(express.json({ limit: "6mb" }));
app.set("trust proxy", 1); // necesario en Render/Railway (detrás de proxy) para que la cookie de sesión funcione
app.use(session({
  secret: process.env.SESSION_SECRET || "cambia-este-secreto-en-produccion",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
}));

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "No autenticado" });
  next();
}
async function requireAdmin(req, res, next) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  if (!rows[0] || rows[0].rol !== "Administrador") return res.status(403).json({ error: "Solo administradores" });
  next();
}

// --- Autenticación ---
app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = await pool.query("SELECT * FROM users WHERE username=$1", [(username || "").trim().toLowerCase()]);
  const user = rows[0] ? rowToUser(rows[0]) : null;
  if (!user || !bcrypt.compareSync(password || "", user.passwordHash)) {
    return res.status(401).json({ error: "Usuario o clave incorrectos" });
  }
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});

app.post("/api/logout", (req, res) => { req.session.destroy(() => res.json({ ok: true })); });

app.get("/api/me", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  if (!rows[0]) return res.status(401).json({ error: "No autenticado" });
  res.json({ user: publicUser(rowToUser(rows[0])), stages: STAGES, sucursales: SUCURSALES, roles: ROLES, tipos: TIPOS_TRABAJO });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  const user = rows[0] ? rowToUser(rows[0]) : null;
  if (!user || !bcrypt.compareSync(currentPassword || "", user.passwordHash)) {
    return res.status(400).json({ error: "Clave actual incorrecta" });
  }
  if (!newPassword || newPassword.length < 6) {
    return res.status(400).json({ error: "La nueva clave debe tener al menos 6 caracteres" });
  }
  await pool.query("UPDATE users SET password_hash=$1, must_change_password=false WHERE id=$2",
    [bcrypt.hashSync(newPassword, 10), user.id]);
  res.json({ ok: true });
});

// --- Usuarios (administrador) ---
app.get("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM users ORDER BY nombre");
  res.json({ users: rows.map(r => publicUser(rowToUser(r))) });
});

app.post("/api/users", requireAuth, requireAdmin, async (req, res) => {
  const { username, nombre, rol, sucursal, password } = req.body || {};
  if (!username || !nombre || !rol || !password) return res.status(400).json({ error: "Faltan campos obligatorios" });
  const uname = username.trim().toLowerCase();
  const existing = await pool.query("SELECT id FROM users WHERE username=$1", [uname]);
  if (existing.rows[0]) return res.status(400).json({ error: "Ese usuario ya existe" });
  const newUser = {
    id: uid("u"), username: uname, passwordHash: bcrypt.hashSync(password, 10),
    nombre, rol, sucursal: sucursal || "", mustChangePassword: true
  };
  await pool.query(
    `INSERT INTO users (id, username, password_hash, nombre, rol, sucursal, must_change_password)
     VALUES ($1,$2,$3,$4,$5,$6,true)`,
    [newUser.id, newUser.username, newUser.passwordHash, newUser.nombre, newUser.rol, newUser.sucursal]
  );
  res.json({ user: publicUser(newUser) });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// --- OT ---
app.get("/api/ots", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ots ORDER BY updated_at DESC");
  res.json({ ots: rows.map(rowToOt) });
});

app.post("/api/ots", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.numero || !String(b.numero).trim()) return res.status(400).json({ error: "Falta el número de OT" });
  const { rows: urows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  const user = urows[0] ? rowToUser(urows[0]) : null;
  const id = uid("ot");
  const etapa = Number.isInteger(b.etapa) ? b.etapa : 0;
  const fecha = b.fechaIngreso || new Date().toISOString().slice(0, 10);
  await pool.query(
    `INSERT INTO ots (id, numero, patente, fecha_ingreso, fecha_entrega, cliente, modelo, sucursal, etapa, responsable, prioridad, tipo, notas, creado_por, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())`,
    [id, String(b.numero).trim(), b.patente || "", fecha, b.fechaEntrega || null, b.cliente || "", b.modelo || "",
     b.sucursal || SUCURSALES[0], etapa, b.responsable || "", b.prioridad === "alta" ? "alta" : "normal",
     TIPOS_TRABAJO.some(t=>t.value===b.tipo) ? b.tipo : "general",
     b.notas || "", user ? user.nombre : ""]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [id]);
  await logCambioEtapa(id, null, etapa, user ? user.nombre : "", "creacion");
  res.json({ ot: rowToOt(rows[0]) });
});

app.put("/api/ots/:id", requireAuth, async (req, res) => {
  const { rows: existingRows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: "OT no encontrada" });
  const existing = rowToOt(existingRows[0]);
  const b = req.body || {};
  const merged = { ...existing, ...b };
  await pool.query(
    `UPDATE ots SET numero=$1, patente=$2, fecha_ingreso=$3, fecha_entrega=$4, cliente=$5, modelo=$6, sucursal=$7,
     etapa=$8, responsable=$9, prioridad=$10, tipo=$11, notas=$12, check_lavado=$13, updated_at=now() WHERE id=$14`,
    [merged.numero, merged.patente, merged.fechaIngreso || null, merged.fechaEntrega || null, merged.cliente, merged.modelo,
     merged.sucursal, merged.etapa, merged.responsable, merged.prioridad,
     TIPOS_TRABAJO.some(t=>t.value===merged.tipo) ? merged.tipo : "general",
     merged.notas, merged.checkLavado === true, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (merged.etapa !== existing.etapa) {
    const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
    await logCambioEtapa(req.params.id, existing.etapa, merged.etapa, urows[0] ? urows[0].nombre : "", "escritorio");
  }
  res.json({ ot: rowToOt(rows[0]) });
});

app.delete("/api/ots/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM ots WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// --- Fotos por OT (máximo 4) ---
async function contarFotos(otId) {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM ot_fotos WHERE ot_id=$1", [otId]);
  return rows[0].n;
}
function rowToFoto(r) {
  return { id: r.id, dataUrl: r.data_url, creadoPor: r.creado_por || "", createdAt: r.created_at };
}

app.get("/api/ots/:id/fotos", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ot_fotos WHERE ot_id=$1 ORDER BY created_at", [req.params.id]);
  res.json({ fotos: rows.map(rowToFoto) });
});

app.post("/api/ots/:id/fotos", requireAuth, async (req, res) => {
  const { dataUrl } = req.body || {};
  if (!dataUrl) return res.status(400).json({ error: "Falta la imagen" });
  if ((await contarFotos(req.params.id)) >= 4) return res.status(400).json({ error: "Ya hay 4 fotos en esta OT (máximo permitido)" });
  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const id = uid("foto");
  await pool.query(
    "INSERT INTO ot_fotos (id, ot_id, data_url, creado_por, created_at) VALUES ($1,$2,$3,$4,now())",
    [id, req.params.id, dataUrl, urows[0] ? urows[0].nombre : ""]
  );
  res.json({ foto: { id, dataUrl } });
});

app.delete("/api/ots/:id/fotos/:fotoId", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM ot_fotos WHERE id=$1 AND ot_id=$2", [req.params.fotoId, req.params.id]);
  res.json({ ok: true });
});

function rowToCita(r) {
  return {
    id: r.id, patente: r.patente || "", cliente: r.cliente || "", telefono: r.telefono || "",
    modelo: r.modelo || "", fechaHora: r.fecha_hora ? new Date(r.fecha_hora).toISOString() : "",
    sucursal: r.sucursal || "", tipo: r.tipo || "general", estado: r.estado || "pendiente",
    notas: r.notas || "", creadoPor: r.creado_por || "", otId: r.ot_id || null
  };
}

// --- Sincronización de citas desde un Excel compartido (OneDrive/SharePoint) ---

function normalizarHeader(h) {
  return String(h || "").toLowerCase().trim()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, ""); // quita tildes
}

const HEADER_ALIASES = {
  fecha: ["fecha"],
  hora: ["hora"],
  fechaHora: ["fechahora", "fecha y hora", "fecha/hora"],
  patente: ["patente", "placa"],
  cliente: ["cliente", "nombre", "nombre cliente"],
  telefono: ["telefono", "fono", "celular", "contacto"],
  modelo: ["modelo", "vehiculo", "auto"],
  sucursal: ["sucursal"],
  tipo: ["tipo", "tipo de trabajo", "tipotrabajo"],
  notas: ["notas", "observaciones", "comentarios"]
};

function mapearColumnas(headerRow) {
  const map = {};
  headerRow.forEach((raw, idx) => {
    const norm = normalizarHeader(raw);
    for (const [campo, alias] of Object.entries(HEADER_ALIASES)) {
      if (alias.includes(norm) && map[campo] === undefined) map[campo] = idx;
    }
  });
  return map;
}

function excelDateToJSDate(v) {
  // xlsx con cellDates:true ya entrega Date de JS para celdas de fecha reales.
  if (v instanceof Date) return v;
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function excelHoraToHHMM(v) {
  if (v instanceof Date) {
    return String(v.getHours()).padStart(2,"0") + ":" + String(v.getMinutes()).padStart(2,"0");
  }
  if (typeof v === "number") { // fracción de día
    const totalMin = Math.round(v * 24 * 60);
    return String(Math.floor(totalMin/60)).padStart(2,"0") + ":" + String(totalMin%60).padStart(2,"0");
  }
  if (typeof v === "string" && /^\d{1,2}:\d{2}/.test(v.trim())) return v.trim().slice(0,5);
  return null;
}

function toDirectDownloadUrl(url) {
  // Convierte un link de OneDrive/SharePoint "para compartir" en uno de descarga directa.
  if (/1drv\.ms|onedrive\.live\.com/i.test(url)) {
    if (/[?&]download=1/.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "download=1";
  }
  if (/sharepoint\.com/i.test(url)) {
    if (/[?&]download=1/.test(url)) return url;
    return url + (url.includes("?") ? "&" : "?") + "download=1";
  }
  return url;
}

async function descargarYParsearExcel(url) {
  const directUrl = toDirectDownloadUrl(url);
  const res = await fetch(directUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${res.status}). Verifica que el link sea público ("cualquiera con el link puede ver").`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  if (rows.length < 2) return { citas: [], errores: ["El archivo no tiene filas de datos."] };

  const colMap = mapearColumnas(rows[0]);
  const citas = [];
  const errores = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === "" || c === null || c === undefined)) continue;
    const get = (campo) => colMap[campo] !== undefined ? row[colMap[campo]] : "";

    let fechaHoraISO = null;
    if (colMap.fechaHora !== undefined) {
      const d = excelDateToJSDate(get("fechaHora"));
      if (d) fechaHoraISO = d.toISOString();
    } else if (colMap.fecha !== undefined) {
      const fechaD = excelDateToJSDate(get("fecha"));
      const horaStr = colMap.hora !== undefined ? excelHoraToHHMM(get("hora")) : "09:00";
      if (fechaD && horaStr) {
        const [hh, mm] = horaStr.split(":").map(Number);
        const combinado = new Date(fechaD.getFullYear(), fechaD.getMonth(), fechaD.getDate(), hh, mm, 0);
        fechaHoraISO = combinado.toISOString();
      }
    }

    if (!fechaHoraISO) { errores.push(`Fila ${i+1}: no se pudo interpretar la fecha/hora.`); continue; }

    citas.push({
      fechaHora: fechaHoraISO,
      patente: String(get("patente") || "").trim(),
      cliente: String(get("cliente") || "").trim(),
      telefono: String(get("telefono") || "").trim(),
      modelo: String(get("modelo") || "").trim(),
      sucursal: String(get("sucursal") || "").trim(),
      tipo: TIPOS_TRABAJO.some(t => t.value === normalizarHeader(get("tipo"))) ? normalizarHeader(get("tipo")) : "general",
      notas: String(get("notas") || "").trim()
    });
  }
  return { citas, errores, columnasDetectadas: Object.keys(colMap) };
}

app.get("/api/settings/citas-excel-url", requireAuth, requireAdmin, async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='citas_excel_url'");
  res.json({ url: rows[0] ? rows[0].value : "" });
});

app.put("/api/settings/citas-excel-url", requireAuth, requireAdmin, async (req, res) => {
  const { url } = req.body || {};
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('citas_excel_url', $1)
     ON CONFLICT (key) DO UPDATE SET value=$1`,
    [url || ""]
  );
  res.json({ ok: true });
});

app.post("/api/citas/sincronizar", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='citas_excel_url'");
  const url = rows[0] ? rows[0].value : "";
  if (!url) return res.status(400).json({ error: "No hay un link de Excel configurado. Pídele a un administrador que lo configure." });

  let parsed;
  try {
    parsed = await descargarYParsearExcel(url);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const actor = urows[0] ? urows[0].nombre : "";

  let creadas = 0, actualizadas = 0;
  for (const c of parsed.citas) {
    const { rows: existentes } = await pool.query(
      "SELECT id FROM citas WHERE fecha_hora=$1 AND UPPER(patente)=UPPER($2)",
      [c.fechaHora, c.patente || ""]
    );
    if (existentes[0]) {
      await pool.query(
        `UPDATE citas SET cliente=$1, telefono=$2, modelo=$3, sucursal=$4, tipo=$5, notas=$6 WHERE id=$7`,
        [c.cliente, c.telefono, c.modelo, c.sucursal || SUCURSALES[0], c.tipo, c.notas, existentes[0].id]
      );
      actualizadas++;
    } else {
      await pool.query(
        `INSERT INTO citas (id, patente, cliente, telefono, modelo, fecha_hora, sucursal, tipo, estado, notas, creado_por, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',$9,$10, now())`,
        [uid("cita"), c.patente, c.cliente, c.telefono, c.modelo, c.fechaHora, c.sucursal || SUCURSALES[0], c.tipo, c.notas, actor + " (Excel)"]
      );
      creadas++;
    }
  }

  res.json({ creadas, actualizadas, totalFilas: parsed.citas.length, errores: parsed.errores, columnasDetectadas: parsed.columnasDetectadas });
});

app.get("/api/citas", requireAuth, async (req, res) => {
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: "Faltan los parámetros desde/hasta" });
  const { rows } = await pool.query(
    "SELECT * FROM citas WHERE fecha_hora >= $1 AND fecha_hora < $2 ORDER BY fecha_hora",
    [desde, hasta]
  );
  res.json({ citas: rows.map(rowToCita) });
});

app.post("/api/citas", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.fechaHora) return res.status(400).json({ error: "Falta la fecha y hora de la cita" });
  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const id = uid("cita");
  await pool.query(
    `INSERT INTO citas (id, patente, cliente, telefono, modelo, fecha_hora, sucursal, tipo, estado, notas, creado_por, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',$9,$10, now())`,
    [id, b.patente || "", b.cliente || "", b.telefono || "", b.modelo || "", b.fechaHora,
     b.sucursal || SUCURSALES[0], TIPOS_TRABAJO.some(t=>t.value===b.tipo) ? b.tipo : "general",
     b.notas || "", urows[0] ? urows[0].nombre : ""]
  );
  const { rows } = await pool.query("SELECT * FROM citas WHERE id=$1", [id]);
  res.json({ cita: rowToCita(rows[0]) });
});

app.put("/api/citas/:id", requireAuth, async (req, res) => {
  const { rows: existingRows } = await pool.query("SELECT * FROM citas WHERE id=$1", [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: "Cita no encontrada" });
  const existing = rowToCita(existingRows[0]);
  const b = req.body || {};
  const merged = { ...existing, ...b };
  await pool.query(
    `UPDATE citas SET patente=$1, cliente=$2, telefono=$3, modelo=$4, fecha_hora=$5, sucursal=$6, tipo=$7, estado=$8, notas=$9, ot_id=$10 WHERE id=$11`,
    [merged.patente, merged.cliente, merged.telefono, merged.modelo, merged.fechaHora, merged.sucursal,
     TIPOS_TRABAJO.some(t=>t.value===merged.tipo) ? merged.tipo : "general",
     ["pendiente","convertida","no_show"].includes(merged.estado) ? merged.estado : "pendiente",
     merged.notas, merged.otId || null, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM citas WHERE id=$1", [req.params.id]);
  res.json({ cita: rowToCita(rows[0]) });
});

app.delete("/api/citas/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM citas WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// --- Acceso por QR para técnicos (sin login, pensado para celular) ---
app.get("/api/ots/:id/qr", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "OT no encontrada" });
  const ot = rowToOt(rows[0]);
  const url = `${req.protocol}://${req.get("host")}/t/${ot.id}`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 260 });
    res.json({ dataUrl, url, numero: ot.numero });
  } catch (e) {
    res.status(500).json({ error: "No se pudo generar el código QR" });
  }
});

app.get("/api/public/ot/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  const { rows: fotoRows } = await pool.query("SELECT * FROM ot_fotos WHERE ot_id=$1 ORDER BY created_at", [req.params.id]);
  res.json({ ot: rowToOt(rows[0]), stages: STAGES, tipos: TIPOS_TRABAJO, fotos: fotoRows.map(rowToFoto) });
});

app.post("/api/public/ot/:id/fotos", async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  const { dataUrl, actorNombre } = req.body || {};
  if (!dataUrl) return res.status(400).json({ error: "Falta la imagen" });
  if ((await contarFotos(req.params.id)) >= 4) return res.status(400).json({ error: "Ya hay 4 fotos en esta OT (máximo permitido)" });
  const id = uid("foto");
  await pool.query(
    "INSERT INTO ot_fotos (id, ot_id, data_url, creado_por, created_at) VALUES ($1,$2,$3,$4,now())",
    [id, req.params.id, dataUrl, actorNombre || ""]
  );
  res.json({ foto: { id, dataUrl } });
});

app.delete("/api/public/ot/:id/fotos/:fotoId", async (req, res) => {
  await pool.query("DELETE FROM ot_fotos WHERE id=$1 AND ot_id=$2", [req.params.fotoId, req.params.id]);
  res.json({ ok: true });
});

app.get("/api/public/roster", async (req, res) => {
  const { rows } = await pool.query("SELECT nombre, rol FROM users ORDER BY nombre");
  res.json({ roster: rows });
});

app.put("/api/public/ot/:id/check-lavado", async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  const { value } = req.body || {};
  await pool.query("UPDATE ots SET check_lavado=$1, updated_at=now() WHERE id=$2", [value === true, req.params.id]);
  const { rows: updated } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  res.json({ ot: rowToOt(updated[0]) });
});

app.put("/api/public/ot/:id/stage", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  const { etapa, actorNombre } = req.body || {};
  if (!Number.isInteger(etapa) || etapa < 0 || etapa >= STAGES.length) return res.status(400).json({ error: "Etapa inválida" });
  const existing = rowToOt(rows[0]);
  await pool.query("UPDATE ots SET etapa=$1, responsable=$2, updated_at=now() WHERE id=$3",
    [etapa, actorNombre || existing.responsable, req.params.id]);
  if (etapa !== existing.etapa) {
    await logCambioEtapa(req.params.id, existing.etapa, etapa, actorNombre || "", "tecnico");
  }
  const { rows: updatedRows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  res.json({ ot: rowToOt(updatedRows[0]), stages: STAGES });
});

app.get("/api/public/consulta", async (req, res) => {
  const patente = (req.query.patente || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!patente) return res.status(400).json({ error: "Ingresa tu patente" });
  const { rows } = await pool.query(
    "SELECT * FROM ots WHERE UPPER(REPLACE(patente,' ','')) = $1 ORDER BY updated_at DESC LIMIT 1",
    [patente]
  );
  if (!rows[0]) return res.status(404).json({ error: "No encontramos una orden de trabajo activa con esa patente" });
  const ot = rowToOt(rows[0]);
  const { rows: fotoRows } = await pool.query("SELECT data_url FROM ot_fotos WHERE ot_id=$1 ORDER BY created_at", [ot.id]);
  res.json({
    ot: {
      numero: ot.numero, modelo: ot.modelo, patente: ot.patente,
      sucursal: ot.sucursal, etapa: ot.etapa, fechaEntrega: ot.fechaEntrega, updatedAt: ot.updatedAt
    },
    fotos: fotoRows.map(r => r.data_url),
    stages: STAGES
  });
});

app.get("/api/public/buscar", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ resultados: [] });
  const { rows } = await pool.query(
    `SELECT id, numero, patente, cliente, modelo, etapa FROM ots
     WHERE UPPER(patente) LIKE UPPER($1) OR UPPER(numero) LIKE UPPER($1)
     ORDER BY updated_at DESC LIMIT 8`,
    [`%${q}%`]
  );
  res.json({ resultados: rows, stages: STAGES, tipos: TIPOS_TRABAJO });
});

app.get("/taller", (req, res) => { res.sendFile(path.join(__dirname, "public", "buscar.html")); });

app.get("/api/qr/taller", requireAuth, async (req, res) => {
  const url = `${req.protocol}://${req.get("host")}/taller`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 280 });
    res.json({ dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: "No se pudo generar el código QR" });
  }
});

app.get("/api/qr/consulta", requireAuth, async (req, res) => {
  const url = `${req.protocol}://${req.get("host")}/consulta`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 280 });
    res.json({ dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: "No se pudo generar el código QR" });
  }
});

app.get("/pantalla", (req, res) => { res.sendFile(path.join(__dirname, "public", "pantalla.html")); });

app.get("/api/public/pantalla", async (req, res) => {
  const sucursal = req.query.sucursal || "";
  if (!sucursal || !SUCURSALES.includes(sucursal)) {
    return res.status(400).json({ error: "Falta indicar una sucursal válida en el link", sucursales: SUCURSALES });
  }
  const { rows } = await pool.query("SELECT * FROM ots WHERE sucursal=$1 ORDER BY updated_at DESC", [sucursal]);
  const ots = rows.map(rowToOt).map(o => ({
    numero: o.numero, patente: o.patente, cliente: o.cliente, modelo: o.modelo,
    etapa: o.etapa, prioridad: o.prioridad, tipo: o.tipo, fechaEntrega: o.fechaEntrega
  }));
  res.json({ sucursal, ots, stages: STAGES, tipos: TIPOS_TRABAJO });
});

app.get("/consulta", (req, res) => { res.sendFile(path.join(__dirname, "public", "consulta.html")); });

app.get("/t/:id", (req, res) => { res.sendFile(path.join(__dirname, "public", "tecnico.html")); });

// --- Reportes (solo Administrador) ---
app.get("/api/reportes/tiempos", requireAuth, requireAdmin, async (req, res) => {
  const desde = req.query.desde || "2000-01-01";
  const hastaRaw = req.query.hasta;
  const hasta = hastaRaw ? new Date(new Date(hastaRaw).getTime() + 86400000).toISOString() : new Date(9999,0,1).toISOString();
  const sucursal = req.query.sucursal || "";

  const { rows: otRows } = await pool.query(
    `SELECT * FROM ots WHERE fecha_ingreso >= $1 AND fecha_ingreso < $2 ${sucursal ? "AND sucursal=$3" : ""}`,
    sucursal ? [desde, hasta, sucursal] : [desde, hasta]
  );
  const otIds = otRows.map(r => r.id);
  let histRows = [];
  if (otIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT * FROM etapa_historial WHERE ot_id = ANY($1) ORDER BY ot_id, created_at`,
      [otIds]
    );
    histRows = rows;
  }

  const historialPorOt = {};
  histRows.forEach(h => {
    if (!historialPorOt[h.ot_id]) historialPorOt[h.ot_id] = [];
    historialPorOt[h.ot_id].push(h);
  });

  const sumaPorEtapa = STAGES.map(() => 0);
  const cuentaPorEtapa = STAGES.map(() => 0);
  const detalle = [];

  otRows.forEach(otRow => {
    const ot = rowToOt(otRow);
    const hist = historialPorOt[ot.id] || [];
    let saltos = 0;
    for (let i = 0; i < hist.length; i++) {
      const h = hist[i];
      const desdeEtapa = h.etapa_anterior;
      const hastaEtapa = h.etapa_nueva;
      if (desdeEtapa !== null && Math.abs(hastaEtapa - desdeEtapa) > 1) saltos++;
      const inicio = new Date(h.created_at);
      const finProx = hist[i+1] ? new Date(hist[i+1].created_at) : new Date();
      const horas = (finProx - inicio) / 3600000;
      if (hastaEtapa >= 0 && hastaEtapa < STAGES.length && horas >= 0) {
        sumaPorEtapa[hastaEtapa] += horas;
        cuentaPorEtapa[hastaEtapa] += 1;
      }
    }
    const primeraEntrada = hist[0] ? new Date(hist[0].created_at) : null;
    const ultimaEntrada = hist[hist.length-1] ? new Date(hist[hist.length-1].created_at) : null;
    const tiempoTotalHoras = primeraEntrada ? ((ot.etapa === STAGES.length-1 && ultimaEntrada ? ultimaEntrada : new Date()) - primeraEntrada) / 3600000 : null;
    detalle.push({
      id: ot.id, numero: ot.numero, patente: ot.patente, cliente: ot.cliente, sucursal: ot.sucursal,
      tipo: ot.tipo, etapa: ot.etapa, tiempoTotalHoras, saltos,
      cambios: hist.map(h => ({ etapaAnterior: h.etapa_anterior, etapaNueva: h.etapa_nueva, actor: h.actor, origen: h.origen, fecha: h.created_at }))
    });
  });

  const promedioPorEtapa = STAGES.map((s, i) => ({
    etapa: s,
    promedioHoras: cuentaPorEtapa[i] > 0 ? sumaPorEtapa[i] / cuentaPorEtapa[i] : null,
    cantidad: cuentaPorEtapa[i]
  }));

  res.json({ stages: STAGES, promedioPorEtapa, detalle, totalOts: otRows.length, totalSaltos: detalle.reduce((a,d)=>a+d.saltos,0) });
});

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Seguimiento de OT corriendo en el puerto ${PORT}`));
  })
  .catch(err => {
    console.error("No se pudo inicializar la base de datos:", err.message);
    process.exit(1);
  });
