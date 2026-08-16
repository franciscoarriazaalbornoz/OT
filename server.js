const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const path = require("path");
const { Pool } = require("pg");
const QRCode = require("qrcode");

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
    notas: r.notas || "", creadoPor: r.creado_por || "",
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : ""
  };
}
function publicUser(u) {
  return { id: u.id, username: u.username, nombre: u.nombre, rol: u.rol, sucursal: u.sucursal, mustChangePassword: !!u.mustChangePassword };
}
function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

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
  res.json({ user: publicUser(rowToUser(rows[0])), stages: STAGES, sucursales: SUCURSALES, roles: ROLES });
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
    `INSERT INTO ots (id, numero, patente, fecha_ingreso, fecha_entrega, cliente, modelo, sucursal, etapa, responsable, prioridad, notas, creado_por, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())`,
    [id, String(b.numero).trim(), b.patente || "", fecha, b.fechaEntrega || null, b.cliente || "", b.modelo || "",
     b.sucursal || SUCURSALES[0], etapa, b.responsable || "", b.prioridad === "alta" ? "alta" : "normal",
     b.notas || "", user ? user.nombre : ""]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [id]);
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
     etapa=$8, responsable=$9, prioridad=$10, notas=$11, updated_at=now() WHERE id=$12`,
    [merged.numero, merged.patente, merged.fechaIngreso || null, merged.fechaEntrega || null, merged.cliente, merged.modelo,
     merged.sucursal, merged.etapa, merged.responsable, merged.prioridad, merged.notas, req.params.id]
  );
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
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
  res.json({ ot: rowToOt(rows[0]), stages: STAGES, fotos: fotoRows.map(rowToFoto) });
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

app.put("/api/public/ot/:id/stage", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM ots WHERE id=$1", [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "Esta OT ya no existe o fue eliminada" });
  const { etapa, actorNombre } = req.body || {};
  if (!Number.isInteger(etapa) || etapa < 0 || etapa >= STAGES.length) return res.status(400).json({ error: "Etapa inválida" });
  const existing = rowToOt(rows[0]);
  await pool.query("UPDATE ots SET etapa=$1, responsable=$2, updated_at=now() WHERE id=$3",
    [etapa, actorNombre || existing.responsable, req.params.id]);
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

app.get("/api/qr/consulta", requireAuth, async (req, res) => {
  const url = `${req.protocol}://${req.get("host")}/consulta`;
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 280 });
    res.json({ dataUrl, url });
  } catch (e) {
    res.status(500).json({ error: "No se pudo generar el código QR" });
  }
});

app.get("/consulta", (req, res) => { res.sendFile(path.join(__dirname, "public", "consulta.html")); });

app.get("/t/:id", (req, res) => { res.sendFile(path.join(__dirname, "public", "tecnico.html")); });

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
