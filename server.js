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
// Solo estos roles pueden marcar/desmarcar el check de presupuesto (Administrador siempre puede, por diseño general de la app).
const ROLES_PPTO = ["Asesor de servicio", "Jefe de taller", "Repuestos"];
// Solo estos roles pueden ver y gestionar Citas previas (Administrador siempre puede).
const ROLES_CITAS = ["Recepción", "Jefe de taller"];
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
    checkPptoRealizado: r.check_ppto_realizado === true,
    checkPptoAutorizado: r.check_ppto_autorizado === true,
    trabajoIniciadoAt: r.trabajo_iniciado_at ? new Date(r.trabajo_iniciado_at).toISOString() : null,
    notas: r.notas || "", creadoPor: r.creado_por || "",
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : ""
  };
}
function publicUser(u) {
  return { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol, sucursal: u.sucursal, mustChangePassword: !!u.mustChangePassword };
}
function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

// Mantiene el orden visual de la OT: los campos de texto libre se guardan en mayúsculas.
// Nunca se aplica a campos de lista fija (sucursal, tipo, rol, etc.) para no romper su coincidencia.
function up(v) { return v === undefined || v === null ? v : String(v).toUpperCase(); }

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
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS check_ppto_realizado BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS check_ppto_autorizado BOOLEAN DEFAULT false;`);
  await pool.query(`ALTER TABLE ots ADD COLUMN IF NOT EXISTS trabajo_iniciado_at TIMESTAMPTZ;`);
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

// Devuelve { rol, sucursal, isAdmin } del usuario autenticado, o null si no existe.
// La sucursal asignada al usuario es mandante: define qué OT puede ver/tocar (salvo Administrador, que ve todo).
async function currentUserAccess(req) {
  const { rows } = await pool.query("SELECT rol, sucursal FROM users WHERE id=$1", [req.session.userId]);
  if (!rows[0]) return null;
  return { rol: rows[0].rol, sucursal: rows[0].sucursal, isAdmin: rows[0].rol === "Administrador" };
}

// Verifica que el usuario autenticado tenga acceso a la sucursal de una OT puntual.
// Devuelve null si tiene acceso, o un objeto {status, error} listo para responder si no.
async function checkOtAccess(req, otId) {
  const acc = await currentUserAccess(req);
  if (!acc) return { status: 401, error: "No autenticado" };
  const { rows } = await pool.query("SELECT sucursal FROM ots WHERE id=$1", [otId]);
  if (!rows[0]) return { status: 404, error: "OT no encontrada" };
  if (!acc.isAdmin && rows[0].sucursal !== acc.sucursal) {
    return { status: 403, error: "Esta OT pertenece a otra sucursal — no tienes acceso a ella" };
  }
  return null;
}

// Verifica que el usuario tenga el rol habilitado para Citas (Asesor de servicio, Jefe de
// taller o Administrador). Devuelve null si tiene acceso, o {status,error} si no.
async function checkCitasAccess(req) {
  const acc = await currentUserAccess(req);
  if (!acc) return { status: 401, error: "No autenticado" };
  if (!acc.isAdmin && !ROLES_CITAS.includes(acc.rol)) {
    return { status: 403, error: "Solo Recepción, Jefe de taller o Administrador pueden gestionar Citas." };
  }
  return null;
}

// Ver el tablero de Citas es más permisivo que gestionarlas: todos pueden verlo,
// salvo Mecánico y Lavado y entrega (su trabajo pasa por el QR del taller, no por Citas).
const ROLES_CITAS_SIN_VER = ["Mecánico", "Lavado y entrega"];
async function checkCitasVerAccess(req) {
  const acc = await currentUserAccess(req);
  if (!acc) return { status: 401, error: "No autenticado" };
  if (!acc.isAdmin && ROLES_CITAS_SIN_VER.includes(acc.rol)) {
    return { status: 403, error: "Tu rol no tiene acceso a Citas." };
  }
  return null;
}

// Si el usuario no es Administrador, deja solo las citas de SU propia sucursal — así, cuando
// el Excel trae varias sucursales mezcladas, cada secretaria importa únicamente lo suyo.
function filtrarCitasPorSucursal(citas, acc) {
  if (acc.isAdmin) return { citas, omitidasPorSucursal: 0 };
  const propias = citas.filter(c => (c.sucursal || "").trim().toLowerCase() === (acc.sucursal || "").trim().toLowerCase());
  return { citas: propias, omitidasPorSucursal: citas.length - propias.length };
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

app.post("/api/users/importar-excel", requireAuth, requireAdmin, async (req, res) => {
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: "Falta el archivo" });

  let rows;
  try {
    const base64Clean = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
    const buffer = Buffer.from(base64Clean, "base64");
    const wb = XLSX.read(buffer, { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
  } catch (e) {
    return res.status(400).json({ error: "No se pudo leer el archivo. ¿Es un Excel o CSV válido?" });
  }
  if (rows.length < 2) return res.status(400).json({ error: "El archivo no tiene filas de datos." });

  const colMap = mapearColumnas(rows[0], {
    usuario: ["usuario", "username", "nombre usuario"],
    nombre: ["nombre", "nombre completo"],
    rol: ["rol"],
    sucursal: ["sucursal"],
    clave: ["clave", "clave_inicial", "clave inicial", "password"]
  });

  let creados = 0, existentes = 0;
  const errores = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === "" || c === null || c === undefined)) continue;
    const get = (campo) => colMap[campo] !== undefined ? String(row[colMap[campo]] || "").trim() : "";

    const username = get("usuario").toLowerCase();
    const nombre = get("nombre");
    const rol = get("rol");
    const sucursal = get("sucursal");
    const clave = get("clave") || "taller2026";

    if (!username || !nombre) { errores.push(`Fila ${i+1}: falta usuario o nombre.`); continue; }
    if (!ROLES.includes(rol)) { errores.push(`Fila ${i+1} (${username}): rol "${rol}" no reconocido.`); continue; }
    if (sucursal && !SUCURSALES.includes(sucursal)) { errores.push(`Fila ${i+1} (${username}): sucursal "${sucursal}" no reconocida.`); continue; }

    const existing = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
    if (existing.rows[0]) { existentes++; continue; }

    await pool.query(
      `INSERT INTO users (id, username, password_hash, nombre, rol, sucursal, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6,true)`,
      [uid("u"), username, bcrypt.hashSync(clave, 10), nombre, rol, sucursal || ""]
    );
    creados++;
  }

  res.json({ creados, existentes, totalFilas: rows.length - 1, errores });
});

app.delete("/api/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.params.id === req.session.userId) return res.status(400).json({ error: "No puedes eliminar tu propio usuario" });
  await pool.query("DELETE FROM users WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// --- OT ---
app.get("/api/ots", requireAuth, async (req, res) => {
  const acc = await currentUserAccess(req);
  if (!acc) return res.status(401).json({ error: "No autenticado" });
  const { rows } = acc.isAdmin
    ? await pool.query("SELECT * FROM ots ORDER BY updated_at DESC")
    : await pool.query("SELECT * FROM ots WHERE sucursal=$1 ORDER BY updated_at DESC", [acc.sucursal]);
  res.json({ ots: rows.map(rowToOt) });
});

app.post("/api/ots", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.numero || !String(b.numero).trim()) return res.status(400).json({ error: "Falta el número de OT" });
  const acc = await currentUserAccess(req);
  if (!acc) return res.status(401).json({ error: "No autenticado" });
  const { rows: urows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.session.userId]);
  const user = urows[0] ? rowToUser(urows[0]) : null;
  const id = uid("ot");
  const etapa = Number.isInteger(b.etapa) ? b.etapa : 0;
  const fecha = b.fechaIngreso || new Date().toISOString().slice(0, 10);
  // La sucursal del usuario es mandante: si no es Administrador, la OT queda SIEMPRE en su propia sucursal,
  // sin importar qué haya enviado el formulario.
  const sucursalFinal = acc.isAdmin ? (b.sucursal || SUCURSALES[0]) : acc.sucursal;
  await pool.query(
    `INSERT INTO ots (id, numero, patente, fecha_ingreso, fecha_entrega, cliente, modelo, sucursal, etapa, responsable, prioridad, tipo, notas, creado_por, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())`,
    [id, up(String(b.numero).trim()), up(b.patente) || "", fecha, b.fechaEntrega || null, up(b.cliente) || "", up(b.modelo) || "",
     sucursalFinal, etapa, up(b.responsable) || "", b.prioridad === "alta" ? "alta" : "normal",
     TIPOS_TRABAJO.some(t=>t.value===b.tipo) ? b.tipo : "general",
     up(b.notas) || "", user ? user.nombre : ""]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [id]);
  await logCambioEtapa(id, null, etapa, user ? user.nombre : "", "creacion");
  res.json({ ot: rowToOt(rows[0]) });
});

app.put("/api/ots/:id", requireAuth, async (req, res) => {
  const acc = await currentUserAccess(req);
  if (!acc) return res.status(401).json({ error: "No autenticado" });
  const { rows: existingRows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: "OT no encontrada" });
  const existing = rowToOt(existingRows[0]);
  if (!acc.isAdmin && existing.sucursal !== acc.sucursal) {
    return res.status(403).json({ error: "Esta OT pertenece a otra sucursal — no tienes acceso a ella" });
  }
  const b = req.body || {};
  const merged = { ...existing, ...b };
  // Un usuario que no sea Administrador no puede mover la OT a otra sucursal.
  if (!acc.isAdmin) merged.sucursal = acc.sucursal;
  // El check de presupuesto solo lo puede marcar/desmarcar Asesor de servicio, Jefe de taller,
  // Repuestos o Administrador — cualquier otro rol que envíe un cambio ahí queda ignorado,
  // sin afectar el resto de los campos que sí haya editado.
  if (!acc.isAdmin && !ROLES_PPTO.includes(acc.rol)) {
    merged.checkPptoRealizado = existing.checkPptoRealizado;
    merged.checkPptoAutorizado = existing.checkPptoAutorizado;
  }
  await pool.query(
    `UPDATE ots SET numero=$1, patente=$2, fecha_ingreso=$3, fecha_entrega=$4, cliente=$5, modelo=$6, sucursal=$7,
     etapa=$8, responsable=$9, prioridad=$10, tipo=$11, notas=$12, check_lavado=$13,
     check_ppto_realizado=$14, check_ppto_autorizado=$15, updated_at=now() WHERE id=$16`,
    [up(merged.numero), up(merged.patente), merged.fechaIngreso || null, merged.fechaEntrega || null, up(merged.cliente), up(merged.modelo),
     merged.sucursal, merged.etapa, up(merged.responsable), merged.prioridad,
     TIPOS_TRABAJO.some(t=>t.value===merged.tipo) ? merged.tipo : "general",
     up(merged.notas), merged.checkLavado === true,
     merged.checkPptoRealizado === true, merged.checkPptoAutorizado === true, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (merged.etapa !== existing.etapa) {
    const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
    await logCambioEtapa(req.params.id, existing.etapa, merged.etapa, urows[0] ? urows[0].nombre : "", "escritorio");
  }
  res.json({ ot: rowToOt(rows[0]) });
});

app.delete("/api/ots/:id", requireAuth, async (req, res) => {
  const acc = await currentUserAccess(req);
  if (!acc) return res.status(401).json({ error: "No autenticado" });
  const { rows: existingRows } = await pool.query("SELECT sucursal FROM ots WHERE id=$1", [req.params.id]);
  if (existingRows[0] && !acc.isAdmin && existingRows[0].sucursal !== acc.sucursal) {
    return res.status(403).json({ error: "Esta OT pertenece a otra sucursal — no tienes acceso a ella" });
  }
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
  const denied = await checkOtAccess(req, req.params.id);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const { rows } = await pool.query("SELECT * FROM ot_fotos WHERE ot_id=$1 ORDER BY created_at", [req.params.id]);
  res.json({ fotos: rows.map(rowToFoto) });
});

app.post("/api/ots/:id/fotos", requireAuth, async (req, res) => {
  const denied = await checkOtAccess(req, req.params.id);
  if (denied) return res.status(denied.status).json({ error: denied.error });
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
  const denied = await checkOtAccess(req, req.params.id);
  if (denied) return res.status(denied.status).json({ error: denied.error });
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
  fecha: ["fecha", "fecha cita", "fecha de cita", "fechacita"],
  hora: ["hora", "hora cita", "hora de cita"],
  fechaHora: ["fechahora", "fecha y hora", "fecha/hora"],
  patente: ["patente", "placa", "ppu"],
  cliente: ["cliente", "nombre", "nombre cliente", "nombre de cliente"],
  telefono: ["telefono", "fono", "celular", "contacto"],
  modelo: ["modelo", "vehiculo", "auto"],
  marca: ["marca"],
  sucursal: ["sucursal"],
  tipo: ["tipo", "tipo de trabajo", "tipotrabajo", "descripcion", "descripcion trabajo"],
  notas: ["notas", "observaciones", "comentarios"]
};

// Traduce texto libre de la columna "Descripción" (o similar) al tipo de trabajo interno.
// Ej: "TRABAJO GENERAL" -> general, "MANTENCION" -> mantencion, "PRIMER SERVICIO" -> garantia.
function mapearTipoDesdeTexto(texto) {
  const norm = normalizarHeader(texto);
  if (!norm) return "general";
  if (norm.includes("mantenc")) return "mantencion";
  if (norm.includes("primer servicio") || norm.includes("garantia") || norm.includes("campana")) return "garantia";
  if (norm.includes("dyp") || norm.includes("desaboll") || norm.includes("pintura")) return "dyp";
  if (norm === "fir" || norm.includes(" fir") || norm.includes("fir ") || norm.startsWith("fir")) return "fir";
  return "general";
}

// Encuentra a qué sucursal conocida corresponde el nombre de una pestaña del Excel
// (ej: la pestaña "Colón" calza con nuestra sucursal "Summit Colón").
function nombreSucursalDesdeHoja(nombreHoja) {
  const norm = normalizarHeader(nombreHoja);
  return SUCURSALES.find(s => {
    const ns = normalizarHeader(s);
    return ns.includes(norm) || norm.includes(ns);
  }) || null;
}

function mapearColumnas(headerRow, aliases) {
  const aliasMap = aliases || HEADER_ALIASES;
  const map = {};
  headerRow.forEach((raw, idx) => {
    const norm = normalizarHeader(raw);
    for (const [campo, alias] of Object.entries(aliasMap)) {
      if (alias.includes(norm) && map[campo] === undefined) map[campo] = idx;
    }
  });
  return map;
}

// Construye la fecha/hora correcta en UTC a partir de una hora de RELOJ DE CHILE (America/Santiago),
// sin depender de en qué zona horaria esté corriendo el servidor (Render corre en UTC por defecto,
// así que construir la fecha "a la ingenua" con new Date(año,mes,dia,hh,mm) la deja mal — trata la
// hora de Chile como si ya fuera UTC). Respeta automáticamente el horario de verano/invierno chileno.
function crearFechaChile(anio, mes, dia, hh, mm) {
  const pruebaUTC = new Date(Date.UTC(anio, mes, dia, hh, mm, 0));
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Santiago", hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  });
  const partes = fmt.formatToParts(pruebaUTC).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const horaChile = partes.hour === "24" ? 0 : parseInt(partes.hour, 10);
  const comoSiFueraUTC = Date.UTC(parseInt(partes.year,10), parseInt(partes.month,10)-1, parseInt(partes.day,10), horaChile, parseInt(partes.minute,10));
  const offsetMs = comoSiFueraUTC - pruebaUTC.getTime();
  return new Date(pruebaUTC.getTime() - offsetMs);
}

function excelDateToJSDate(v) {
  // xlsx con cellDates:true ya entrega Date de JS para celdas de fecha reales.
  if (v instanceof Date) return v;
  if (typeof v === "string" && v.trim()) {
    const s = v.trim();
    // Formato chileno escrito como texto: DD/MM/YYYY o D/M/YYYY.
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10), anio = parseInt(m[3], 10);
      if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return new Date(anio, mes - 1, dia);
    }
    // Variante con guion, a veces con la hora pegada al final: DD-MM-YYYY o "DD-MM-YYYY HH:MM".
    const m2 = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})/);
    if (m2) {
      const dia = parseInt(m2[1], 10), mes = parseInt(m2[2], 10), anio = parseInt(m2[3], 10);
      if (mes >= 1 && mes <= 12 && dia >= 1 && dia <= 31) return new Date(anio, mes - 1, dia);
    }
    const d = new Date(s);
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

const MESES_ES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

// Corrige fechas nativas de Excel donde día y mes quedaron invertidos (pasa cuando quien
// cargó esos datos tenía el Excel en formato mes/día en vez de día/mes chileno). Solo actúa
// sobre celdas de fecha REAL de Excel (no texto, que ya se interpreta aparte como día/mes).
// Usa como referencia las fechas de esa misma pestaña que NO tienen ninguna ambigüedad posible
// (día > 12, así que no puede confundirse con un mes) y eran las más cercanas en la planilla —
// si el intercambio día/mes acerca más esa fila a su referencia más cercana, se intercambia;
// si no, se deja tal cual. Las filas sin ninguna ancla cercana no se tocan.
function corregirFechasAmbiguas(rows, idxFecha) {
  const anclas = [];
  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][idxFecha];
    if (v instanceof Date && v.getDate() > 12) anclas.push({ pos: i, mes: v.getMonth() + 1 });
  }
  if (anclas.length === 0) return;

  for (let i = 1; i < rows.length; i++) {
    const v = rows[i][idxFecha];
    if (!(v instanceof Date)) continue;
    const dia = v.getDate(), mes = v.getMonth() + 1;
    if (dia > 12 || mes > 12 || dia === mes) continue; // sin ambigüedad, o da igual

    let mejor = null, mejorDist = Infinity;
    for (const a of anclas) {
      const dist = Math.abs(a.pos - i);
      if (dist < mejorDist) { mejorDist = dist; mejor = a; }
    }
    if (!mejor) continue;

    const distCiclica = (a, b) => Math.min(Math.abs(a - b), 12 - Math.abs(a - b));
    const distOriginal = distCiclica(mes, mejor.mes);
    const distIntercambiada = distCiclica(dia, mejor.mes);
    if (distIntercambiada < distOriginal) {
      rows[i][idxFecha] = new Date(v.getFullYear(), dia - 1, mes);
    }
  }
}

function parsearFilasCitas(rows, colMap, sucursalFija) {
  const citas = [];
  const errores = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every(c => c === "" || c === null || c === undefined)) continue;
    const get = (campo) => colMap[campo] !== undefined ? row[colMap[campo]] : "";

    // Fila divisoria de mes (ej: "MAYO" repetido en varias columnas, incluida a veces la de
    // cliente en vez de la de fecha) — se ignora en silencio, no es una cita real.
    const rawFecha = colMap.fecha !== undefined ? get("fecha") : null;
    const rawCliente = colMap.cliente !== undefined ? get("cliente") : null;
    const esDivisoria = (v) => typeof v === "string" && MESES_ES.includes(normalizarHeader(v));
    if (esDivisoria(rawFecha) || esDivisoria(rawCliente)) continue;
    if (typeof rawCliente === "string" && normalizarHeader(rawCliente).includes("sin agendamiento")) continue;

    let fechaHoraISO = null;
    if (colMap.fechaHora !== undefined) {
      const d = excelDateToJSDate(get("fechaHora"));
      if (d) fechaHoraISO = d.toISOString();
    } else if (colMap.fecha !== undefined) {
      const fechaD = excelDateToJSDate(get("fecha"));
      const horaStr = colMap.hora !== undefined ? (excelHoraToHHMM(get("hora")) || "09:00") : "09:00";
      if (fechaD && horaStr) {
        const [hh, mm] = horaStr.split(":").map(Number);
        const combinado = crearFechaChile(fechaD.getFullYear(), fechaD.getMonth(), fechaD.getDate(), hh, mm);
        fechaHoraISO = combinado.toISOString();
      }
    }
    if (!fechaHoraISO) {
      // Filas divisorias tipo "ABRIL" / "MAYO" (rótulos de mes repetidos en varias columnas,
      // sin cliente ni patente real) se ignoran en silencio — no son citas reales.
      const tieneCliente = String(get("cliente") || "").trim() !== "";
      const tienePatente = String(get("patente") || "").trim() !== "";
      if (tieneCliente || tienePatente) errores.push(`Fila ${i+1}: no se pudo interpretar la fecha/hora.`);
      continue;
    }

    // Marca + Modelo combinados (ej: "TOYOTA" + "4RUNNER" -> "TOYOTA 4RUNNER").
    const marca = colMap.marca !== undefined ? String(get("marca") || "").trim() : "";
    const modeloRaw = String(get("modelo") || "").trim();
    const modeloFinal = [marca, modeloRaw].filter(Boolean).join(" ").trim();

    const sucursalFinal = sucursalFija || (colMap.sucursal !== undefined ? String(get("sucursal") || "").trim() : "");
    const tipoTexto = get("tipo");
    const tipoFinal = colMap.tipo !== undefined
      ? (TIPOS_TRABAJO.some(t => t.value === normalizarHeader(tipoTexto)) ? normalizarHeader(tipoTexto) : mapearTipoDesdeTexto(tipoTexto))
      : "general";

    citas.push({
      fechaHora: fechaHoraISO,
      patente: String(get("patente") || "").trim(),
      cliente: String(get("cliente") || "").trim(),
      telefono: String(get("telefono") || "").trim(),
      modelo: modeloFinal,
      sucursal: sucursalFinal,
      tipo: tipoFinal,
      notas: colMap.notas !== undefined ? String(get("notas") || "").trim() : ""
    });
  }
  return { citas, errores };
}

// Lee el Excel de citas soportando dos formatos:
//  1) Una sola hoja con columna "Sucursal" explícita por fila.
//  2) Una pestaña por sucursal, sin columna Sucursal (el nombre de la pestaña ES la sucursal) —
//     formato real usado por Grupo Summit. En este caso, un usuario que no sea Administrador
//     solo procesa la pestaña de SU propia sucursal; el resto de las pestañas se ignoran.
function parsearExcelBuffer(buffer, acc) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const resultado = { citas: [], errores: [], columnasDetectadas: [] };

  for (const nombreHoja of wb.SheetNames) {
    const sheet = wb.Sheets[nombreHoja];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" });
    if (rows.length < 2) continue;
    const colMap = mapearColumnas(rows[0]);
    if (Object.keys(colMap).length === 0) continue; // pestaña sin columnas reconocibles (ej. un resumen), se ignora

    let sucursalFija = null;
    if (colMap.sucursal === undefined) {
      sucursalFija = nombreSucursalDesdeHoja(nombreHoja);
      if (!sucursalFija) continue; // pestaña que no corresponde a ninguna sucursal conocida
      if (acc && !acc.isAdmin && sucursalFija !== acc.sucursal) continue; // no es la sucursal del usuario
    }

    if (colMap.fecha !== undefined) corregirFechasAmbiguas(rows, colMap.fecha);

    const { citas, errores } = parsearFilasCitas(rows, colMap, sucursalFija);
    resultado.citas.push(...citas);
    resultado.errores.push(...errores.map(e => wb.SheetNames.length > 1 ? `[${nombreHoja}] ${e}` : e));
    resultado.columnasDetectadas = Object.keys(colMap);
  }

  if (resultado.citas.length === 0 && resultado.errores.length === 0) {
    const contexto = acc && !acc.isAdmin ? ` para tu sucursal (${acc.sucursal})` : "";
    resultado.errores.push(`No se encontraron citas reconocibles${contexto}. Pestañas del archivo: ${wb.SheetNames.join(", ")}`);
  }

  return resultado;
}

async function descargarYParsearExcel(url, acc) {
  const directUrl = toDirectDownloadUrl(url);
  const res = await fetch(directUrl, { redirect: "follow" });
  if (!res.ok) throw new Error(`No se pudo descargar el archivo (HTTP ${res.status}). Verifica que el link sea público ("cualquiera con el link puede ver").`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return parsearExcelBuffer(buffer, acc);
}

// Aplica una lista de citas ya parseadas: crea las nuevas, actualiza las que ya existían
// (mismo criterio que la sincronización por link: patente + fecha/hora exacta).
async function upsertCitasParseadas(citas, actor) {
  let creadas = 0, actualizadas = 0;
  for (const c of citas) {
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
  return { creadas, actualizadas };
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
  const denied = await checkCitasAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const { rows } = await pool.query("SELECT value FROM app_settings WHERE key='citas_excel_url'");
  const url = rows[0] ? rows[0].value : "";
  if (!url) return res.status(400).json({ error: "No hay un link de Excel configurado. Pídele a un administrador que lo configure." });

  let parsed;
  try {
    parsed = await descargarYParsearExcel(url, acc);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const { citas: citasFiltradas, omitidasPorSucursal } = filtrarCitasPorSucursal(parsed.citas, acc);
  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const actor = urows[0] ? urows[0].nombre : "";
  const { creadas, actualizadas } = await upsertCitasParseadas(citasFiltradas, actor);

  res.json({ creadas, actualizadas, omitidasPorSucursal, totalFilas: parsed.citas.length, errores: parsed.errores, columnasDetectadas: parsed.columnasDetectadas });
});

app.post("/api/citas/importar-excel", requireAuth, async (req, res) => {
  const denied = await checkCitasAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const { fileBase64 } = req.body || {};
  if (!fileBase64) return res.status(400).json({ error: "Falta el archivo" });

  let parsed;
  try {
    const base64Clean = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
    const buffer = Buffer.from(base64Clean, "base64");
    parsed = parsearExcelBuffer(buffer, acc);
  } catch (e) {
    return res.status(400).json({ error: "No se pudo leer el archivo. ¿Es un Excel o CSV válido?" });
  }

  const { citas: citasFiltradas, omitidasPorSucursal } = filtrarCitasPorSucursal(parsed.citas, acc);
  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const actor = urows[0] ? urows[0].nombre : "";
  const { creadas, actualizadas } = await upsertCitasParseadas(citasFiltradas, actor);

  res.json({ creadas, actualizadas, omitidasPorSucursal, totalFilas: parsed.citas.length, errores: parsed.errores, columnasDetectadas: parsed.columnasDetectadas });
});

app.get("/api/citas", requireAuth, async (req, res) => {
  const denied = await checkCitasVerAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const { desde, hasta } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: "Faltan los parámetros desde/hasta" });
  const { rows } = acc.isAdmin
    ? await pool.query("SELECT * FROM citas WHERE fecha_hora >= $1 AND fecha_hora < $2 ORDER BY fecha_hora", [desde, hasta])
    : await pool.query("SELECT * FROM citas WHERE fecha_hora >= $1 AND fecha_hora < $2 AND sucursal=$3 ORDER BY fecha_hora", [desde, hasta, acc.sucursal]);
  res.json({ citas: rows.map(rowToCita) });
});

app.post("/api/citas", requireAuth, async (req, res) => {
  const denied = await checkCitasAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const b = req.body || {};
  if (!b.fechaHora) return res.status(400).json({ error: "Falta la fecha y hora de la cita" });
  const { rows: urows } = await pool.query("SELECT nombre FROM users WHERE id=$1", [req.session.userId]);
  const id = uid("cita");
  const sucursalFinal = acc.isAdmin ? (b.sucursal || SUCURSALES[0]) : acc.sucursal;
  await pool.query(
    `INSERT INTO citas (id, patente, cliente, telefono, modelo, fecha_hora, sucursal, tipo, estado, notas, creado_por, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pendiente',$9,$10, now())`,
    [id, b.patente || "", b.cliente || "", b.telefono || "", b.modelo || "", b.fechaHora,
     sucursalFinal, TIPOS_TRABAJO.some(t=>t.value===b.tipo) ? b.tipo : "general",
     b.notas || "", urows[0] ? urows[0].nombre : ""]
  );
  const { rows } = await pool.query("SELECT * FROM citas WHERE id=$1", [id]);
  res.json({ cita: rowToCita(rows[0]) });
});

app.put("/api/citas/:id", requireAuth, async (req, res) => {
  const denied = await checkCitasAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const { rows: existingRows } = await pool.query("SELECT * FROM citas WHERE id=$1", [req.params.id]);
  if (!existingRows[0]) return res.status(404).json({ error: "Cita no encontrada" });
  const existing = rowToCita(existingRows[0]);
  if (!acc.isAdmin && existing.sucursal !== acc.sucursal) {
    return res.status(403).json({ error: "Esta cita pertenece a otra sucursal — no tienes acceso a ella" });
  }
  const b = req.body || {};
  const merged = { ...existing, ...b };
  if (!acc.isAdmin) merged.sucursal = acc.sucursal;
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
  const denied = await checkCitasAccess(req);
  if (denied) return res.status(denied.status).json({ error: denied.error });
  const acc = await currentUserAccess(req);
  const { rows: existingRows } = await pool.query("SELECT sucursal FROM citas WHERE id=$1", [req.params.id]);
  if (existingRows[0] && !acc.isAdmin && existingRows[0].sucursal !== acc.sucursal) {
    return res.status(403).json({ error: "Esta cita pertenece a otra sucursal — no tienes acceso a ella" });
  }
  await pool.query("DELETE FROM citas WHERE id=$1", [req.params.id]);
  res.json({ ok: true });
});

// --- Acceso por QR para técnicos (sin login, pensado para celular) ---
app.get("/api/ots/:id/qr", requireAuth, async (req, res) => {
  const denied = await checkOtAccess(req, req.params.id);
  if (denied) return res.status(denied.status).json({ error: denied.error });
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
  const { sucursal, rol } = req.query;
  // El rol Administrador nunca aparece en esta lista pública, sin importar el filtro —
  // el "quién hizo el cambio" del taller es siempre una persona operativa, no la cuenta de gestión.

  // Sin filtros: comportamiento anterior (compatibilidad con otras pantallas que lo usen así).
  if (!sucursal && !rol) {
    const { rows } = await pool.query("SELECT nombre, rol FROM users WHERE rol<>'Administrador' ORDER BY nombre");
    return res.json({ roster: rows });
  }

  const condiciones = ["rol<>'Administrador'"];
  const params = [];
  if (sucursal) { params.push(sucursal); condiciones.push(`sucursal=$${params.length}`); }
  if (rol) { params.push(rol); condiciones.push(`rol=$${params.length}`); }
  const where = `WHERE ${condiciones.join(" AND ")}`;

  let { rows } = await pool.query(`SELECT nombre, rol FROM users ${where} ORDER BY nombre`, params);

  // Respaldo: si el filtro por rol+sucursal queda vacío (nadie de ese rol cargado en esa sucursal
  // todavía), no dejamos al técnico sin ninguna opción — mostramos toda la sucursal en su lugar
  // (sigue sin incluir al Administrador).
  if (rows.length === 0 && sucursal) {
    const fallback = await pool.query("SELECT nombre, rol FROM users WHERE sucursal=$1 AND rol<>'Administrador' ORDER BY nombre", [sucursal]);
    rows = fallback.rows;
  }

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

app.put("/api/public/ot/:id/inicio-trabajo", async (req, res) => {
  const { rows } = await pool.query("SELECT id FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  await pool.query("UPDATE ots SET trabajo_iniciado_at=now() WHERE id=$1", [req.params.id]);
  const { rows: updated } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  res.json({ ot: rowToOt(updated[0]) });
});

// Nota: el check de presupuesto NO tiene endpoint público de escritura a propósito.
// El técnico (QR sin login) solo puede VERLO — ya viaja incluido en GET /api/public/ot/:id.
// Marcarlo/desmarcarlo está restringido a Asesor de servicio, Jefe de taller, Repuestos y
// Administrador, únicamente desde la app de escritorio (con sesión), vía PUT /api/ots/:id.

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
