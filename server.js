const express   = require("express");
const multer    = require("multer");
const XLSX      = require("xlsx");
const cors      = require("cors");
const path      = require("path");
const fs        = require("fs");

const app  = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "database.db");

app.use(cors());
app.use(express.json());
// Healthcheck endpoint — responde inmediatamente, sin depender de la DB
app.get("/health", (req, res) => res.status(200).send("ok"));

app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── Arrancar el servidor PRIMERO para pasar el healthcheck ──
const server = app.listen(PORT, "0.0.0.0", () => console.log(`Servidor escuchando en 0.0.0.0:${PORT}`));
server.on("error", (err) => {
  console.error("Error al iniciar el servidor:", err);
  process.exit(1);
});

process.on("uncaughtException", (err) => {
  console.error("Excepción no capturada:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Promesa rechazada sin manejar:", err);
});

// ── Luego inicializar sql.js de forma async ──
let SQL  = null;
let dbReady = false;

async function initSql() {
  const initSqlJs = require("sql.js");
  SQL = await initSqlJs();
  dbReady = true;
  console.log("sql.js listo");
  initSchema();
  withDb(db => rebuildStockDetallado(db));
  console.log("stock_detallado reconstruido");
}

function loadDb() {
  if (!SQL) throw new Error("Base de datos no inicializada aún");
  if (fs.existsSync(DB_PATH)) {
    return new SQL.Database(fs.readFileSync(DB_PATH));
  }
  return new SQL.Database();
}

function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function withDb(fn) {
  const db = loadDb();
  try {
    const result = fn(db);
    saveDb(db);
    return result;
  } finally {
    db.close();
  }
}

function readDb(fn) {
  const db = loadDb();
  try { return fn(db); } finally { db.close(); }
}

function query(db, sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function initSchema() {
  withDb(db => db.run(`
    CREATE TABLE IF NOT EXISTS articulos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, descripcion TEXT,
      unidad_medida TEXT, rubro TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_sucursales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, descripcion TEXT,
      unidad_negocio TEXT, existencias REAL, ubicacion TEXT,
      nro_lote_serie TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tabla TEXT, filename TEXT, filas INTEGER,
      fecha TEXT DEFAULT (datetime('now')), status TEXT
    );
    CREATE TABLE IF NOT EXISTS stock_detallado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER,
      unidad_negocio TEXT,
      existencias REAL,
      descripcion TEXT,
      rubro TEXT
    );
  `));
  console.log("Esquema creado");
}

// Reconstruye stock_detallado combinando stock_sucursales (LEFT) con articulos,
// usando nro_corto como llave. Se ejecuta tras cada importación.
function rebuildStockDetallado(db) {
  db.run("DELETE FROM stock_detallado");
  db.run(`
    INSERT INTO stock_detallado (nro_corto, unidad_negocio, existencias, descripcion, rubro)
    SELECT
      s.nro_corto,
      s.unidad_negocio,
      s.existencias,
      a.descripcion,
      a.rubro
    FROM stock_sucursales s
    LEFT JOIN articulos a ON a.nro_corto = s.nro_corto
  `);
}

// Middleware: verificar que la DB esté lista para rutas de API
function requireDb(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: "Base de datos iniciando, reintentá en unos segundos." });
  next();
}

// ── Parsers Excel ──
function parseArticulos(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName =
    wb.SheetNames.find(n => n === "BD ART x RUBRO") ||
    wb.SheetNames.find(n => n.toLowerCase().includes("art"));
  if (!sheetName) throw new Error(`Hoja no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }).map(r => ([
    r["Nº corto artículo"] ?? null,
    String(r["2º nº artículo"] ?? "").trim(),
    String(r["Descripcion"] ?? r["Descripción"] ?? "").trim(),
    String(r["UM "] ?? r["UM"] ?? "").trim(),
    r["Rubro"] ?? null,
  ]));
}

function parseStock(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName =
    wb.SheetNames.find(n => n === "Sheet1") ||
    wb.SheetNames.find(n => n.toLowerCase().includes("stock")) ||
    wb.SheetNames[0];
  if (!sheetName) throw new Error(`Hoja no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }).map(r => ([
    r["Nº corto artículo [F4101]"] ?? r["Nº corto artículo"] ?? null,
    String(r["2º nº artículo [F4101]"] ?? r["2º nº artículo"] ?? "").trim(),
    String(r["Descripción [F4101]"] ?? r["Descripción"] ?? "").trim(),
    String(r["Unidad negocio [F41021]"] ?? r["Unidad negocio"] ?? "").trim(),
    r["Existencias físicas [F41021]"] ?? r["Existencias físicas"] ?? 0,
    String(r["Ubicación [F41021]"] ?? r["Ubicación"] ?? "").trim(),
    String(r["Número lote/ serie [F41021]"] ?? r["Número lote/ serie"] ?? "").trim(),
  ]));
}

// ── Health / status ──
app.get("/api/status", (req, res) => res.json({ ready: dbReady }));

// ── Rutas de importación ──
app.post("/api/import/articulos", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseArticulos(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM articulos");
      const stmt = db.prepare("INSERT INTO articulos (nro_corto,segundo_nro,descripcion,unidad_medida,rubro) VALUES (?,?,?,?,?)");
      rows.forEach(r => stmt.run(r));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["articulos", req.file.originalname, rows.length, "ok"]);
      rebuildStockDetallado(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/stock", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseStock(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM stock_sucursales");
      const stmt = db.prepare("INSERT INTO stock_sucursales (nro_corto,segundo_nro,descripcion,unidad_negocio,existencias,ubicacion,nro_lote_serie) VALUES (?,?,?,?,?,?,?)");
      rows.forEach(r => stmt.run(r));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["stock_sucursales", req.file.originalname, rows.length, "ok"]);
      rebuildStockDetallado(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get("/api/stats", requireDb, (req, res) => {
  try {
    const data = readDb(db => ({
      articulos: query(db, "SELECT COUNT(*) as c FROM articulos")[0]?.c ?? 0,
      stock:     query(db, "SELECT COUNT(*) as c FROM stock_sucursales")[0]?.c ?? 0,
      logs:      query(db, "SELECT * FROM import_log ORDER BY fecha DESC LIMIT 10"),
    }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/articulos", requireDb, (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const q      = req.query.q ? `%${req.query.q}%` : null;
    const data   = readDb(db => {
      const rows  = q
        ? query(db, "SELECT * FROM articulos WHERE descripcion LIKE ? OR segundo_nro LIKE ? LIMIT ? OFFSET ?", [q,q,limit,offset])
        : query(db, "SELECT * FROM articulos LIMIT ? OFFSET ?", [limit,offset]);
      const total = q
        ? query(db, "SELECT COUNT(*) as c FROM articulos WHERE descripcion LIKE ? OR segundo_nro LIKE ?", [q,q])[0]?.c ?? 0
        : query(db, "SELECT COUNT(*) as c FROM articulos")[0]?.c ?? 0;
      return { rows, total, limit, offset };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stock", requireDb, (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const q      = req.query.q ? `%${req.query.q}%` : null;
    const data   = readDb(db => {
      const rows  = q
        ? query(db, "SELECT * FROM stock_sucursales WHERE descripcion LIKE ? OR segundo_nro LIKE ? LIMIT ? OFFSET ?", [q,q,limit,offset])
        : query(db, "SELECT * FROM stock_sucursales LIMIT ? OFFSET ?", [limit,offset]);
      const total = q
        ? query(db, "SELECT COUNT(*) as c FROM stock_sucursales WHERE descripcion LIKE ? OR segundo_nro LIKE ?", [q,q])[0]?.c ?? 0
        : query(db, "SELECT COUNT(*) as c FROM stock_sucursales")[0]?.c ?? 0;
      return { rows, total, limit, offset };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Stock Detallado: rubros disponibles, datos filtrados, export ──

app.get("/api/stock-detallado/rubros", requireDb, (req, res) => {
  try {
    const rubros = readDb(db => query(db,
      `SELECT DISTINCT rubro FROM stock_detallado
       WHERE rubro IS NOT NULL AND rubro != '' AND existencias > 0
       ORDER BY rubro`
    )).map(r => r.rubro);
    res.json({ rubros });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/stock-detallado", requireDb, (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 100, 1000);
    const offset = parseInt(req.query.offset) || 0;
    const rubro  = req.query.rubro || null;

    const data = readDb(db => {
      const whereClauses = ["existencias > 0"];
      const params = [];
      if (rubro) { whereClauses.push("rubro = ?"); params.push(rubro); }
      const where = "WHERE " + whereClauses.join(" AND ");

      const rows = query(db,
        `SELECT nro_corto, unidad_negocio, existencias, descripcion, rubro
         FROM stock_detallado ${where}
         ORDER BY existencias DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );
      const total = query(db,
        `SELECT COUNT(*) as c FROM stock_detallado ${where}`, params
      )[0]?.c ?? 0;

      return { rows, total, limit, offset };
    });
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Datos agregados para el gráfico (por artículo, ya filtrados por rubro si aplica)
app.get("/api/stock-detallado/chart", requireDb, (req, res) => {
  try {
    const rubro = req.query.rubro || null;
    const limit = Math.min(parseInt(req.query.limit) || 30, 200);

    const data = readDb(db => {
      const whereClauses = ["existencias > 0"];
      const params = [];
      if (rubro) { whereClauses.push("rubro = ?"); params.push(rubro); }
      const where = "WHERE " + whereClauses.join(" AND ");

      return query(db,
        `SELECT nro_corto, descripcion, rubro, SUM(existencias) as existencias
         FROM stock_detallado ${where}
         GROUP BY nro_corto, descripcion, rubro
         ORDER BY existencias DESC
         LIMIT ?`,
        [...params, limit]
      );
    });
    res.json({ rows: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/api/export/:tabla", requireDb, (req, res) => {
  try {
    const validTables = ["articulos", "stock_sucursales", "stock_detallado"];
    const tabla = validTables.includes(req.params.tabla) ? req.params.tabla : "stock_sucursales";
    const rows  = readDb(db => query(db, `SELECT * FROM ${tabla}`));
    if (!rows.length) return res.status(404).json({ error: "Sin datos" });
    const headers = Object.keys(rows[0]).join(",");
    const csv     = [headers, ...rows.map(r =>
      Object.values(r).map(v => `"${String(v ?? "").replace(/"/g,'""')}"`).join(",")
    )].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=${tabla}.csv`);
    res.send("\uFEFF" + csv);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Iniciar sql.js en background (no bloquea el arranque del servidor)
initSql().catch(err => console.error("Error iniciando sql.js:", err));
