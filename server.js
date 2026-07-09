const express   = require("express");
const multer    = require("multer");
const XLSX      = require("xlsx");
const cors      = require("cors");
const path      = require("path");
const fs        = require("fs");
const { Pool }  = require("pg");

const app     = express();
const PORT    = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "database.db");

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.get("/health", (req, res) => res.status(200).send("ok"));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

// PostgreSQL (opcional)
let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pgPool.connect().then(c => { console.log("PostgreSQL conectado"); c.release(); }).catch(e => console.error("PG error:", e.message));
} else {
  console.log("DATABASE_URL no definida");
}

const server = app.listen(PORT, "0.0.0.0", () => console.log(`Servidor escuchando en 0.0.0.0:${PORT}`));
server.on("error", err => { console.error("Error servidor:", err); process.exit(1); });
process.on("uncaughtException", err => console.error("Excepción:", err));
process.on("unhandledRejection", err => console.error("Promesa:", err));

let SQL = null, dbReady = false;

function loadDb() {
  if (!SQL) throw new Error("sql.js no inicializado");
  if (fs.existsSync(DB_PATH)) return new SQL.Database(fs.readFileSync(DB_PATH));
  return new SQL.Database();
}
function saveDb(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}
function withDb(fn) {
  const db = loadDb();
  try { const r = fn(db); saveDb(db); return r; } finally { db.close(); }
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
function requireDb(req, res, next) {
  if (!dbReady) return res.status(503).json({ error: "Base de datos iniciando, esperá unos segundos." });
  next();
}

function initSchema() {
  const db = loadDb();
  db.run(`PRAGMA journal_mode=WAL`);
  db.run(`
    CREATE TABLE IF NOT EXISTS articulos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, descripcion TEXT, unidad_medida TEXT, rubro TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_sucursales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, unidad_negocio TEXT, existencias REAL,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_detallado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, unidad_negocio TEXT, existencias REAL, descripcion TEXT, rubro TEXT
    );
    CREATE TABLE IF NOT EXISTS pendiente_completo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tp_ord TEXT, numero_orden INTEGER, nro_corto INTEGER, segundo_nro TEXT,
      descripcion TEXT, unidad_negocio TEXT, cantidad_orden REAL, cantidad_recibida REAL,
      cantidad_pendiente REAL, fecha_orden TEXT, fecha_solic TEXT, fecha_actz TEXT,
      proveedor TEXT, nombre_proveedor TEXT, moneda TEXT, precio_unitario REAL,
      importe_total REAL, estado TEXT, aprobador TEXT, nivel_aprobacion INTEGER,
      cotizacion TEXT, fecha_vencimiento TEXT, rubro TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_arranque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, unidad_negocio TEXT, existencias REAL,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS recepciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tp_ord TEXT, numero_orden INTEGER, nro_corto INTEGER, segundo_nro TEXT,
      observaciones TEXT, cantidad_orden REAL, cantidad_recibida REAL,
      cantidad_pendiente REAL, fecha_orden TEXT, fecha_solic TEXT, fecha_actz TEXT,
      fecha_recepcion TEXT, semana_iso INTEGER, unidad_negocio TEXT,
      nro_drc INTEGER, tp_ctj TEXT, tp_doc TEXT, numero_documento INTEGER,
      costo_unitario REAL, iniciador_transaccion TEXT, est_sig INTEGER, ult_est INTEGER,
      hora_dia INTEGER, hora_recepcion TEXT, rubro TEXT,
      archivo_origen TEXT, importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pmp_x_bom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linea TEXT, codigo_corto_comp INTEGER, descripcion_comp TEXT, rubro_comp TEXT,
      cantidad_articulo REAL, cod_corto INTEGER, v_fr TEXT, planta TEXT, ident TEXT,
      producto TEXT, destino TEXT, dia TEXT, semana_iso INTEGER, bultos REAL,
      rubro_fr_ves TEXT, factor REAL, cantidad_insumo REAL, sku_rubro TEXT, sku_insumo TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pmp_y_comex (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linea TEXT, codigo_corto_comp INTEGER, descripcion_comp TEXT, rubro_comp TEXT,
      cantidad_articulo REAL, cod_corto INTEGER, v_fr TEXT, planta TEXT, ident TEXT,
      producto TEXT, destino TEXT, dia TEXT, semana_iso INTEGER, bultos REAL,
      rubro_fr_ves TEXT, factor REAL, cantidad_insumo REAL, sku_rubro TEXT, sku_insumo TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pgm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linea TEXT, dia TEXT, semana_iso INTEGER, cod_corto INTEGER,
      producto TEXT, destino TEXT, bultos REAL, v_fr TEXT, litros REAL, planta TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pgm_x_bom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linea TEXT, codigo_corto_comp INTEGER, descripcion_comp TEXT, rubro_comp TEXT,
      cantidad_articulo REAL, cod_corto INTEGER, v_fr TEXT, planta TEXT, ident TEXT,
      producto TEXT, destino TEXT, dia TEXT, semana_iso INTEGER, bultos REAL,
      rubro_fr_ves TEXT, factor REAL, cantidad_insumo REAL, sku_rubro TEXT, sku_insumo TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS costo_insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, unidad_negocio TEXT, costo_uni REAL,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pendientes_tetra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tp_ord TEXT, numero_orden INTEGER, nro_corto INTEGER, observaciones TEXT,
      cantidad_recibida REAL, fecha_recepcion TEXT, tp_doc TEXT, numero_documento INTEGER,
      mes_facturacion_tetra TEXT, fecha_facturacion TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_consolidado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, descripcion TEXT, unidad_negocio TEXT,
      existencias REAL, ubicacion TEXT, nro_lote_serie TEXT,
      anio INTEGER, semana_iso INTEGER, archivo_origen TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS consumo_consolidado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, unidad_negocio TEXT, tp_doc TEXT, numero_documento INTEGER,
      nro_art_ppal INTEGER, tp_ord TEXT, numero_orden INTEGER,
      fecha_orden TEXT, hora_dia INTEGER, hora_orden TEXT,
      cantidad_trns REAL, id_usuario TEXT, explicacion_transaccion TEXT,
      archivo_origen TEXT, importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS avance_x_articulo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, descripcion TEXT, rubro TEXT,
      arranque REAL, recepciones REAL, consumo REAL,
      necesidad_inicial REAL, necesidad_actual REAL, avance_pct REAL,
      costo_u REAL, costo_recepciones REAL, costo_necesidad_inicial REAL,
      calculado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS avance_x_rubro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rubro TEXT, arranque REAL, recepciones REAL, consumo REAL,
      necesidad_inicial REAL, necesidad_actual REAL, avance_pct REAL,
      calculado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tabla TEXT, filename TEXT, filas INTEGER, status TEXT,
      fecha TEXT DEFAULT (datetime('now'))
    );
  `);
  saveDb(db);
  db.close();
  console.log("Esquema creado");
}

function rebuildStockDetallado(db) {
  db.run("DELETE FROM stock_detallado");
  db.run(`INSERT INTO stock_detallado (nro_corto, unidad_negocio, existencias, descripcion, rubro)
    SELECT s.nro_corto, s.unidad_negocio, s.existencias, a.descripcion, a.rubro
    FROM stock_sucursales s LEFT JOIN articulos a ON a.nro_corto = s.nro_corto`);
}

function rebuildRecepcionesRubro(db) {
  const artRows = query(db, `SELECT nro_corto, MAX(rubro) as rubro FROM articulos WHERE nro_corto IS NOT NULL GROUP BY nro_corto`);
  const rubroMap = new Map(artRows.map(r => [r.nro_corto, r.rubro]));
  const codigos = query(db, `SELECT DISTINCT nro_corto FROM recepciones WHERE nro_corto IS NOT NULL`);
  const stmt = db.prepare("UPDATE recepciones SET rubro = ? WHERE nro_corto = ?");
  for (const { nro_corto } of codigos) stmt.run([rubroMap.get(nro_corto) ?? null, nro_corto]);
  stmt.free();
}

function getIsoWeek(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const jan4 = new Date(d.getFullYear(), 0, 4);
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
  const diff = d - startOfWeek1;
  return Math.floor(diff / (7 * 86400000)) + 1;
}

function horaDiaToTimeString(v) {
  if (v == null || v === "") return null;
  const n = Math.trunc(Number(v));
  if (isNaN(n) || n < 0) return null;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0,2)}:${s.slice(2,4)}:${s.slice(4,6)}`;
}

function toDateString(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") {
    const EPOCH = Date.UTC(1899, 11, 30);
    return new Date(EPOCH + v * 86400000).toISOString().slice(0, 10);
  }
  return String(v);
}

function mesFacturacionToDate(v) {
  if (v == null) return null;
  const m = String(v).match(/(\d{4})\s*-\s*(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2,"0")}-01`;
}

// ── Parsers ──

function parseArticulos(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames.find(n => n === "BD ART x RUBRO") || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Nº CORTO"] != null)
    .map(r => [r["Nº CORTO"] ?? null, String(r["2º Nº ARTÍCULO"] ?? "").trim(),
      String(r["DESCRIPCIÓN"] ?? "").trim(), String(r["UNIDAD DE MEDIDA"] ?? "").trim(),
      String(r["RUBRO"] ?? "").trim()]);
}

function parseStock(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames.find(n => n === "Sheet1") || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Nº corto artículo [F4101]"] != null)
    .map(r => [r["Nº corto artículo [F4101]"] ?? null,
      String(r["Unidad negocio [F41021]"] ?? "").trim(),
      r["Existencias físicas [F41021]"] ?? 0]);
}

function parsePendiente(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n.includes("Tabla_Pendiente")) || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Número orden"] != null)
    .map(r => [
      String(r["Tp ord"] ?? "").trim(), r["Número orden"] ?? null,
      r["Nº corto artículo"] ?? null, String(r["2° Nº artículo"] ?? "").trim(),
      String(r["Descripción"] ?? "").trim(), String(r["Unidad negocio"] ?? "").trim(),
      r["Cantidad orden"] ?? null, r["Cantidad recibida"] ?? null, r["Cantidad pendiente"] ?? null,
      toDateString(r["Fecha orden"]), toDateString(r["Fecha solic."]), toDateString(r["Fecha actz."]),
      String(r["Proveedor"] ?? "").trim(), String(r["Nombre proveedor"] ?? "").trim(),
      String(r["Moneda"] ?? "").trim(), r["Precio unitario"] ?? null, r["Importe total"] ?? null,
      String(r["Estado"] ?? "").trim(), String(r["Aprobador"] ?? "").trim(),
      r["Nivel aprobación"] ?? null, String(r["Cotización"] ?? "").trim(),
      toDateString(r["Fecha vencimiento"]), String(r["Rubro"] ?? "").trim(),
    ]);
}

function parseRecepciones(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === "Sheet1") || wb.SheetNames[0];
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Número orden"] != null)
    .map(r => {
      const fechaRec = toDateString(r["Fecha recepción"]);
      const horaDia = r["Hora día"] ?? null;
      return [
        String(r["Tp ord"] ?? "").trim(), r["Número orden"] ?? null,
        r["Nº corto artículo"] ?? null, String(r["2° Nº artículo"] ?? r["2º Nº artículo"] ?? "").trim(),
        String(r["Observaciones"] ?? "").trim(),
        r["Cantidad orden"] ?? null, r["Cantidad recibida"] ?? null, r["Cantidad pendiente"] ?? null,
        toDateString(r["Fecha orden"]), toDateString(r["Fecha solic."]), toDateString(r["Fecha actz."]),
        fechaRec, getIsoWeek(fechaRec),
        String(r["Unidad negocio"] ?? "").trim(), r["Nº DRC"] ?? null,
        String(r["Tp Ctj"] ?? "").trim(), String(r["Tp doc"] ?? "").trim(),
        r["Número documento"] ?? null, r["Costo unitario"] ?? null,
        String(r["Iniciador transacción"] ?? "").trim(),
        r["Est. Sig."] ?? null, r["Ult. Est."] ?? null,
        horaDia, horaDiaToTimeString(horaDia), null,
      ];
    });
}

function parsePgmXBom(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  function parseSheet(sheetName, mapFn) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
    return XLSX.utils.sheet_to_json(ws, { defval: null }).filter(r => r["Cod corto"] != null || r["Código corto"] != null).map(mapFn);
  }
  const mapPmp = r => {
    const dia = toDateString(r["Día"]); return [
      String(r["Linea"] ?? "").trim(), r["Cód. Corto (comp)"] ?? r["Codigo corto comp"] ?? null,
      String(r["Descripción (comp)"] ?? "").trim(), String(r["Rubro (comp)"] ?? "").trim(),
      r["Cant. artículo"] ?? null, r["Cod corto"] ?? r["Código corto"] ?? null,
      String(r["V/Fr"] ?? "").trim(), String(r["PLANTA"] ?? "").trim(),
      String(r["Ident."] ?? "").trim(), String(r["Producto"] ?? "").trim(),
      String(r["Destino"] ?? "").trim(), dia, getIsoWeek(dia), r["Bultos"] ?? null,
      String(r["Rubro FR/VES"] ?? "").trim(), r["Factor"] ?? null,
      r["CANT. INSUMO"] ?? r["Cant. Insumo"] ?? null,
      String(r["SKU RUBRO"] ?? "").trim(), String(r["SKU INSUMO"] ?? "").trim(),
    ];
  };
  const mapPgm = r => {
    const dia = toDateString(r["Día"]); return [
      String(r["Linea"] ?? "").trim(), dia, getIsoWeek(dia),
      r["Cod corto"] ?? r["Código corto"] ?? null,
      String(r["Producto"] ?? "").trim(), String(r["Destino"] ?? "").trim(),
      r["Bultos"] ?? null, String(r["V/Fr"] ?? "").trim(),
      r["Litros"] ?? null, String(r["PLANTA"] ?? "").trim(),
    ];
  };
  return {
    pmpXBom:  parseSheet("PMP_x_BOM",  mapPmp),
    pmpYComex: parseSheet("PMP_y_COMEX", mapPmp),
    pgm:      parseSheet("PGM",         mapPgm),
    pgmXBom:  parseSheet("PGM_x_BOM",  mapPmp),
  };
}

function parseCostoInsumos(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { defval: null })
    .filter(r => r["Nº corto artículo"] != null)
    .map(r => [r["Nº corto artículo"] ?? null, String(r["2º nº artículo"] ?? "").trim(),
      String(r["Unidad negocio"] ?? "").trim(), r["Costo uni"] ?? null]);
}

function parsePendientesTetra(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === "OV x Mes Facturacion Tetra");
  if (!sheetName) throw new Error(`Hoja "OV x Mes Facturacion Tetra" no encontrada`);
  function normalizeRow(r) { const o = {}; for (const k in r) o[k.trim()] = r[k]; return o; }
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .map(normalizeRow).filter(r => r["Número orden"] != null)
    .map(r => {
      const mes = r["MES FACTURACION TETRA"] ?? null;
      return [String(r["Tp ord"] ?? "").trim(), r["Número orden"] ?? null,
        r["Nº corto artículo"] ?? null, String(r["Observaciones"] ?? "").trim(),
        r["Cantidad recibida"] ?? null, toDateString(r["Fecha recepción"]),
        String(r["Tp doc"] ?? "").trim(), r["Número documento"] ?? null,
        mes != null ? String(mes) : null, mesFacturacionToDate(mes)];
    });
}

// ── Import endpoints ──

app.post("/api/import/articulos", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseArticulos(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM articulos");
      const stmt = db.prepare("INSERT INTO articulos (nro_corto, segundo_nro, descripcion, unidad_medida, rubro) VALUES (?,?,?,?,?)");
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["articulos", req.file.originalname, rows.length, "ok"]);
      rebuildStockDetallado(db);
      rebuildRecepcionesRubro(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/stock", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseStock(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM stock_sucursales");
      const stmt = db.prepare("INSERT INTO stock_sucursales (nro_corto, unidad_negocio, existencias) VALUES (?,?,?)");
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["stock_sucursales", req.file.originalname, rows.length, "ok"]);
      rebuildStockDetallado(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/pendiente", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parsePendiente(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM pendiente_completo");
      const stmt = db.prepare(`INSERT INTO pendiente_completo (tp_ord,numero_orden,nro_corto,segundo_nro,descripcion,unidad_negocio,cantidad_orden,cantidad_recibida,cantidad_pendiente,fecha_orden,fecha_solic,fecha_actz,proveedor,nombre_proveedor,moneda,precio_unitario,importe_total,estado,aprobador,nivel_aprobacion,cotizacion,fecha_vencimiento,rubro) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["pendiente_completo", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/stock-arranque", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseStock(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM stock_arranque");
      const stmt = db.prepare("INSERT INTO stock_arranque (nro_corto, unidad_negocio, existencias) VALUES (?,?,?)");
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["stock_arranque", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/recepciones", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseRecepciones(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM recepciones");
      const stmt = db.prepare(`INSERT INTO recepciones (tp_ord,numero_orden,nro_corto,segundo_nro,observaciones,cantidad_orden,cantidad_recibida,cantidad_pendiente,fecha_orden,fecha_solic,fecha_actz,fecha_recepcion,semana_iso,unidad_negocio,nro_drc,tp_ctj,tp_doc,numero_documento,costo_unitario,iniciador_transaccion,est_sig,ult_est,hora_dia,hora_recepcion,rubro) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["recepciones", req.file.originalname, rows.length, "ok"]);
      rebuildRecepcionesRubro(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/pgm-x-bom", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const { pmpXBom, pmpYComex, pgm, pgmXBom } = parsePgmXBom(req.file.buffer);
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") { db.run("DELETE FROM pmp_x_bom"); db.run("DELETE FROM pmp_y_comex"); db.run("DELETE FROM pgm"); db.run("DELETE FROM pgm_x_bom"); }
      const insertPmp = db.prepare(`INSERT INTO pmp_x_bom (linea,codigo_corto_comp,descripcion_comp,rubro_comp,cantidad_articulo,cod_corto,v_fr,planta,ident,producto,destino,dia,semana_iso,bultos,rubro_fr_ves,factor,cantidad_insumo,sku_rubro,sku_insumo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      pmpXBom.forEach(r => insertPmp.run(r)); insertPmp.free();
      const insertComex = db.prepare(`INSERT INTO pmp_y_comex (linea,codigo_corto_comp,descripcion_comp,rubro_comp,cantidad_articulo,cod_corto,v_fr,planta,ident,producto,destino,dia,semana_iso,bultos,rubro_fr_ves,factor,cantidad_insumo,sku_rubro,sku_insumo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      pmpYComex.forEach(r => insertComex.run(r)); insertComex.free();
      const insertPgm = db.prepare(`INSERT INTO pgm (linea,dia,semana_iso,cod_corto,producto,destino,bultos,v_fr,litros,planta) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      pgm.forEach(r => insertPgm.run(r)); insertPgm.free();
      const insertPgmXBom = db.prepare(`INSERT INTO pgm_x_bom (linea,codigo_corto_comp,descripcion_comp,rubro_comp,cantidad_articulo,cod_corto,v_fr,planta,ident,producto,destino,dia,semana_iso,bultos,rubro_fr_ves,factor,cantidad_insumo,sku_rubro,sku_insumo) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      pgmXBom.forEach(r => insertPgmXBom.run(r)); insertPgmXBom.free();
      const totalRows = pmpXBom.length + pmpYComex.length + pgm.length + pgmXBom.length;
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["pgm_x_bom", req.file.originalname, totalRows, "ok"]);
    });
    const totalRows = pmpXBom.length + pmpYComex.length + pgm.length + pgmXBom.length;
    res.json({ success: true, rows: totalRows, detalle: { pmp_x_bom: pmpXBom.length, pmp_y_comex: pmpYComex.length, pgm: pgm.length, pgm_x_bom: pgmXBom.length }, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/costo-insumos", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseCostoInsumos(req.file.buffer);
    withDb(db => {
      db.run("DELETE FROM costo_insumos");
      const stmt = db.prepare("INSERT INTO costo_insumos (nro_corto, segundo_nro, unidad_negocio, costo_uni) VALUES (?,?,?,?)");
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["costo_insumos", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode: "replace" });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/pendientes-tetra", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parsePendientesTetra(req.file.buffer);
    withDb(db => {
      db.run("DELETE FROM pendientes_tetra");
      const stmt = db.prepare(`INSERT INTO pendientes_tetra (tp_ord,numero_orden,nro_corto,observaciones,cantidad_recibida,fecha_recepcion,tp_doc,numero_documento,mes_facturacion_tetra,fecha_facturacion) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r)); stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["pendientes_tetra", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode: "replace" });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

// Lotes consumo_consolidado (parseo en navegador)
app.post("/api/import/consumo-consolidado/batch", requireDb, (req, res) => {
  try {
    const { rows, archivoOrigen, esPrimerLote } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: "Formato inválido." });
    withDb(db => {
      if (esPrimerLote) db.run("DELETE FROM consumo_consolidado WHERE archivo_origen = ?", [archivoOrigen]);
      const stmt = db.prepare(`INSERT INTO consumo_consolidado (nro_corto,unidad_negocio,tp_doc,numero_documento,nro_art_ppal,tp_ord,numero_orden,fecha_orden,hora_dia,hora_orden,cantidad_trns,id_usuario,explicacion_transaccion,archivo_origen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run([...r, archivoOrigen])); stmt.free();
    });
    res.json({ success: true, inserted: rows.length });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
app.post("/api/import/consumo-consolidado/finalizar", requireDb, (req, res) => {
  try {
    const { archivos, totalFilas } = req.body || {};
    withDb(db => db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["consumo_consolidado", `${(archivos||[]).length} archivos`, totalFilas || 0, "ok"]));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.delete("/api/consumo-consolidado", requireDb, (req, res) => {
  try { withDb(db => db.run("DELETE FROM consumo_consolidado")); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Lotes stock_consolidado (parseo en navegador)
app.post("/api/import/stock-consolidado/batch", requireDb, (req, res) => {
  try {
    const { rows, archivoOrigen, esPrimerLote } = req.body || {};
    if (!Array.isArray(rows)) return res.status(400).json({ error: "Formato inválido." });
    withDb(db => {
      if (esPrimerLote) db.run("DELETE FROM stock_consolidado WHERE archivo_origen = ?", [archivoOrigen]);
      const stmt = db.prepare(`INSERT INTO stock_consolidado (nro_corto,segundo_nro,descripcion,unidad_negocio,existencias,ubicacion,nro_lote_serie,anio,semana_iso,archivo_origen) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r)); stmt.free();
    });
    res.json({ success: true, inserted: rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post("/api/import/stock-consolidado/finalizar", requireDb, (req, res) => {
  try {
    const { totalFilas, archivoOrigen } = req.body || {};
    withDb(db => db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)", ["stock_consolidado", archivoOrigen || "csv", totalFilas || 0, "ok"]));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stats
app.get("/api/stats", requireDb, (req, res) => {
  try {
    const data = readDb(db => ({
      articulos:     query(db, "SELECT COUNT(*) as c FROM articulos")[0]?.c ?? 0,
      stock:         query(db, "SELECT COUNT(*) as c FROM stock_sucursales")[0]?.c ?? 0,
      pendiente:     query(db, "SELECT COUNT(*) as c FROM pendiente_completo")[0]?.c ?? 0,
      stockArranque: query(db, "SELECT COUNT(*) as c FROM stock_arranque")[0]?.c ?? 0,
      recepciones:   query(db, "SELECT COUNT(*) as c FROM recepciones")[0]?.c ?? 0,
      pgmTotal:      (query(db,"SELECT COUNT(*) as c FROM pmp_x_bom")[0]?.c??0)+(query(db,"SELECT COUNT(*) as c FROM pmp_y_comex")[0]?.c??0)+(query(db,"SELECT COUNT(*) as c FROM pgm")[0]?.c??0)+(query(db,"SELECT COUNT(*) as c FROM pgm_x_bom")[0]?.c??0),
      costoInsumos:  query(db, "SELECT COUNT(*) as c FROM costo_insumos")[0]?.c ?? 0,
      pendientesTetra: query(db, "SELECT COUNT(*) as c FROM pendientes_tetra")[0]?.c ?? 0,
      logs:          query(db, "SELECT * FROM import_log ORDER BY fecha DESC LIMIT 10"),
    }));
    res.json(data);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Generic read endpoints
const GENERIC_TABLES = {
  "articulos":      { table: "articulos",        searchCols: ["descripcion","segundo_nro"] },
  "stock":          { table: "stock_sucursales", searchCols: ["unidad_negocio"] },
  "pendiente":      { table: "pendiente_completo", searchCols: ["descripcion","segundo_nro"] },
  "stock-arranque": { table: "stock_arranque",   searchCols: ["unidad_negocio"] },
  "recepciones":    { table: "recepciones",      searchCols: ["segundo_nro","observaciones"] },
  "pmp-x-bom":      { table: "pmp_x_bom",       searchCols: ["producto","descripcion_comp"] },
  "pmp-y-comex":    { table: "pmp_y_comex",      searchCols: ["producto"] },
  "pgm":            { table: "pgm",              searchCols: ["producto"] },
  "pgm-x-bom":      { table: "pgm_x_bom",       searchCols: ["producto","descripcion_comp"] },
  "costo-insumos":  { table: "costo_insumos",   searchCols: ["segundo_nro"] },
  "pendientes-tetra": { table: "pendientes_tetra", searchCols: ["observaciones","mes_facturacion_tetra"] },
  "stock-consolidado": { table: "stock_consolidado", searchCols: ["descripcion","segundo_nro"] },
  "consumo-consolidado": { table: "consumo_consolidado", searchCols: ["explicacion_transaccion","id_usuario"] },
};
Object.entries(GENERIC_TABLES).forEach(([route, cfg]) => {
  app.get(`/api/${route}`, requireDb, (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit)||50, 500);
      const offset = parseInt(req.query.offset)||0;
      const q = req.query.q ? `%${req.query.q}%` : null;
      const data = readDb(db => {
        const where = cfg.searchCols.map(c => `${c} LIKE ?`).join(" OR ");
        const rows  = q ? query(db, `SELECT * FROM ${cfg.table} WHERE ${where} LIMIT ? OFFSET ?`, [...cfg.searchCols.map(()=>q), limit, offset])
                        : query(db, `SELECT * FROM ${cfg.table} LIMIT ? OFFSET ?`, [limit, offset]);
        const total = q ? query(db, `SELECT COUNT(*) as c FROM ${cfg.table} WHERE ${where}`, cfg.searchCols.map(()=>q))[0]?.c??0
                        : query(db, `SELECT COUNT(*) as c FROM ${cfg.table}`)[0]?.c??0;
        return { rows, total, limit, offset };
      });
      res.json(data);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
});


// Rubros detallado
app.get("/api/rubros-detallado/kpis", requireDb, (req,res) => {
  try {
    const d = readDb(db => ({
      articulosConStock: query(db,"SELECT COUNT(*) as c FROM stock_detallado WHERE existencias>0")[0]?.c??0,
      unidadesTotales:   query(db,"SELECT SUM(existencias) as s FROM stock_detallado")[0]?.s??0,
      totalRubros:       query(db,"SELECT COUNT(DISTINCT rubro) as c FROM stock_detallado WHERE rubro IS NOT NULL AND rubro!='' AND existencias>0")[0]?.c??0,
      rubroLider:        query(db,"SELECT rubro, SUM(existencias) as s FROM stock_detallado WHERE rubro IS NOT NULL AND rubro!='' GROUP BY rubro ORDER BY s DESC LIMIT 1")[0]?.rubro??null,
    }));
    res.json(d);
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/rubros-detallado/resumen", requireDb, (req,res) => {
  try {
    const rows = readDb(db => query(db, "SELECT rubro, COUNT(*) as articulos, SUM(existencias) as total FROM stock_detallado WHERE rubro IS NOT NULL AND rubro!='' GROUP BY rubro ORDER BY total DESC"));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/rubros-detallado/top-articulos", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro;
    if (!rubro) return res.status(400).json({error:"Indicá un rubro"});
    const rows = readDb(db => query(db, "SELECT descripcion, SUM(existencias) as total FROM stock_detallado WHERE rubro=? GROUP BY descripcion ORDER BY total DESC LIMIT 20",[rubro]));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Pendientes
app.get("/api/pendientes/rubros", requireDb, (req,res) => {
  try {
    const rubros = readDb(db => query(db,"SELECT DISTINCT rubro FROM pendiente_completo WHERE rubro IS NOT NULL AND rubro!='' ORDER BY rubro")).map(r=>r.rubro);
    res.json({ rubros });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/pendientes/cuota-proveedor", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro||null;
    const where = rubro ? "WHERE rubro=?" : "";
    const params = rubro ? [rubro] : [];
    const rows = readDb(db => query(db, `SELECT tp_ord, COUNT(*) as cantidad, SUM(importe_total) as importe FROM pendiente_completo ${where} GROUP BY tp_ord ORDER BY importe DESC`, params));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/pendientes/vencidos", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro||null;
    const where = rubro ? "WHERE fecha_vencimiento < date('now') AND rubro=?" : "WHERE fecha_vencimiento < date('now')";
    const params = rubro ? [rubro] : [];
    const rows = readDb(db => query(db, `SELECT nro_corto, descripcion, cantidad_pendiente, fecha_vencimiento, proveedor FROM pendiente_completo ${where} ORDER BY fecha_vencimiento ASC LIMIT 100`, params));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/pendientes/cadena-aprobacion", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro||null;
    const where = rubro ? "WHERE nivel_aprobacion IS NOT NULL AND rubro=?" : "WHERE nivel_aprobacion IS NOT NULL";
    const params = rubro ? [rubro] : [];
    const rows = readDb(db => query(db, `SELECT nivel_aprobacion, COUNT(*) as cantidad FROM pendiente_completo ${where} GROUP BY nivel_aprobacion ORDER BY nivel_aprobacion`, params));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/pendientes/cotizacion", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro||null;
    const where = rubro ? "WHERE cotizacion IS NOT NULL AND cotizacion!='' AND rubro=?" : "WHERE cotizacion IS NOT NULL AND cotizacion!=''";
    const params = rubro ? [rubro] : [];
    const rows = readDb(db => query(db, `SELECT cotizacion, COUNT(*) as cantidad, SUM(importe_total) as importe FROM pendiente_completo ${where} GROUP BY cotizacion ORDER BY importe DESC LIMIT 20`, params));
    res.json({ rows });
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Recepciones
app.get("/api/recepciones/rubros", requireDb, (req,res) => {
  try {
    const rubros = readDb(db => query(db,"SELECT DISTINCT rubro FROM recepciones WHERE rubro IS NOT NULL AND rubro!='' ORDER BY rubro")).map(r=>r.rubro);
    res.json({ rubros });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/recepciones/total-anio-actual", requireDb, (req,res) => {
  try {
    const anio = String(new Date().getFullYear());
    const rubro = req.query.rubro||null;
    const whereClauses = ["substr(fecha_recepcion,1,4)=?","cantidad_recibida IS NOT NULL"];
    const params = [anio];
    if (rubro) { whereClauses.push("rubro=?"); params.push(rubro); }
    const row = readDb(db => query(db, `SELECT SUM(cantidad_recibida) as total FROM recepciones WHERE ${whereClauses.join(" AND ")}`, params))[0];
    res.json({ anio, total: row?.total??0 });
  } catch(err){ res.status(500).json({error:err.message}); }
});
app.get("/api/recepciones/por-mes", requireDb, (req,res) => {
  try {
    const rubro = req.query.rubro;
    if (!rubro) return res.status(400).json({error:"Indicá un rubro."});
    const data = readDb(db => {
      const rows = query(db, `SELECT substr(fecha_recepcion,1,7) as mes, SUM(cantidad_recibida) as cantidad_recibida FROM recepciones WHERE rubro=? AND fecha_recepcion IS NOT NULL AND cantidad_recibida IS NOT NULL GROUP BY mes ORDER BY mes ASC`, [rubro]);
      if (rubro === "TETRA Envases") {
        const facturado = query(db, `SELECT substr(fecha_facturacion,1,7) as mes, SUM(cantidad_recibida) as cantidad_facturada FROM pendientes_tetra WHERE fecha_facturacion IS NOT NULL AND cantidad_recibida IS NOT NULL GROUP BY mes`);
        const facMap = new Map(facturado.map(r=>[r.mes, r.cantidad_facturada]));
        rows.forEach(r => { r.cantidad_facturada_tetrapak = facMap.get(r.mes)??0; });
      }
      return rows;
    });
    res.json({ rows: data });
  } catch(err){ res.status(500).json({error:err.message}); }
});


// PostgreSQL endpoints
app.get("/api/db/consumos/filtros", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const [tp, usr] = await Promise.all([
      pgPool.query("SELECT DISTINCT tp_doc FROM consumos_im_if_2026_1s WHERE tp_doc IS NOT NULL ORDER BY tp_doc"),
      pgPool.query("SELECT DISTINCT id_usuario FROM consumos_im_if_2026_1s WHERE id_usuario IS NOT NULL ORDER BY id_usuario"),
    ]);
    res.json({ tp_doc: tp.rows.map(r=>r.tp_doc), id_usuario: usr.rows.map(r=>r.id_usuario) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// ── Avance desde funciones PostgreSQL ──

app.post("/api/pg/avance/calcular", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { fe_arranque_stock, hora_arranque_stock, fe_inicio_pmp, fe_final_pmp } = req.body || {};
    if (!fe_arranque_stock || !hora_arranque_stock || !fe_inicio_pmp || !fe_final_pmp)
      return res.status(400).json({ error: "Completá los 4 parámetros antes de calcular." });

    const [rubro, articulo] = await Promise.all([
      pgPool.query(
        `SELECT * FROM avance_x_rubro($1::date, $2::time, $3::date, $4::date)`,
        [fe_arranque_stock, hora_arranque_stock, fe_inicio_pmp, fe_final_pmp]
      ),
      pgPool.query(
        `SELECT * FROM avance_x_articulo($1::date, $2::time, $3::date, $4::date)`,
        [fe_arranque_stock, hora_arranque_stock, fe_inicio_pmp, fe_final_pmp]
      ),
    ]);

    res.json({
      avance_x_rubro:    rubro.rows,
      avance_x_articulo: articulo.rows,
    });
  } catch (e) {
    console.error("PG avance error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Cobertura y Faltantes ──

const COBERTURA_RUBROS = [
  'Bandeja','BIB Bolsa','BIB Envase','BIB Manijas','BOTELLA Vidrio',
  'Cajas','Cápsulas','ETIQUETA CT','ETIQUETA FR','ETIQUETA Medallas y Stickers',
  'ETIQUETA Rotulo','FILM Termocontraible','Pallets','Plancha','Separador',
  'Stretch','Tapa','Tapón','TETRA Envases',
];

app.post("/api/pg/cobertura", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { hora_arranque_stock, fe_inicio_semana, fe_final_semana, rubros_seleccionados } = req.body || {};
    if (!hora_arranque_stock || !fe_inicio_semana || !fe_final_semana)
      return res.status(400).json({ error: "Completá los 3 parámetros antes de aplicar." });

    // Usar rubros seleccionados o todos los de la whitelist
    const rubros = (rubros_seleccionados && rubros_seleccionados.length)
      ? rubros_seleccionados.filter(r => COBERTURA_RUBROS.includes(r))
      : COBERTURA_RUBROS;

    const placeholders = rubros.map((_, i) => `$${i + 4}`).join(",");

    const result = await pgPool.query(
      `SELECT * FROM cobertura_semanal($1::time, $2::date, $3::date)
       WHERE rubro IN (${placeholders})
         AND (arranque + recepciones + programado) > 0
       ORDER BY quiebres DESC`,
      [hora_arranque_stock, fe_inicio_semana, fe_final_semana, ...rubros]
    );

    res.json({ rows: result.rows });
  } catch (e) {
    console.error("PG cobertura error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rotación desde rotacion_2026
app.get("/api/pg/rotacion/rubros", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const result = await pgPool.query(
      "SELECT DISTINCT rubro FROM rotacion_2026 WHERE rubro IS NOT NULL ORDER BY rubro"
    );
    res.json({ rubros: result.rows.map(r => r.rubro) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/pg/rotacion/chart", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const rubro = req.query.rubro;
    if (!rubro) return res.status(400).json({error:"Indicá un rubro."});
    const result = await pgPool.query(
      `SELECT numero_mes, pr
       FROM rotacion_2026
       WHERE rubro = $1
       ORDER BY numero_mes ASC`,
      [rubro]
    );
    res.json({ rows: result.rows });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Rubros stock desde view_stock_x_rubro
app.get("/api/pg/rubros-stock", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const result = await pgPool.query(
      "SELECT DISTINCT rubro FROM view_stock_x_rubro WHERE rubro IS NOT NULL ORDER BY rubro"
    );
    res.json({ rubros: result.rows.map(r => r.rubro) });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/pg/rubros-stock/chart", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const rubros = Array.isArray(req.query.rubros) ? req.query.rubros : req.query.rubros ? [req.query.rubros] : [];
    if (!rubros.length) return res.json({ rows: [] });

    const placeholders = rubros.map((_,i) => `$${i+1}`).join(",");
    const result = await pgPool.query(
      `SELECT rubro, SUM(existencias_fisicas) as existencias_fisicas
       FROM view_stock_x_rubro
       WHERE rubro IN (${placeholders})
       GROUP BY rubro
       ORDER BY existencias_fisicas DESC`,
      rubros
    );
    res.json({ rows: result.rows });
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get("/api/db/consumos", async (req,res) => {
  if (!pgPool) return res.status(503).json({error:"PostgreSQL no disponible."});
  try {
    const limit = Math.min(parseInt(req.query.limit)||50, 500);
    const offset = parseInt(req.query.offset)||0;
    const { nro_corto, tp_doc, fecha_desde, fecha_hasta, usuario, explicacion } = req.query;
    const clauses=[]; const params=[]; let p=1;
    if (nro_corto)    { clauses.push(`nro_corto_articulo=$${p++}`); params.push(parseInt(nro_corto)); }
    if (tp_doc)       { clauses.push(`tp_doc=$${p++}`); params.push(tp_doc); }
    if (fecha_desde)  { clauses.push(`fecha_orden>=$${p++}`); params.push(fecha_desde); }
    if (fecha_hasta)  { clauses.push(`fecha_orden<=$${p++}`); params.push(fecha_hasta); }
    if (usuario)      { clauses.push(`id_usuario=$${p++}`); params.push(usuario); }
    if (explicacion)  { clauses.push(`explicacion_transaccion ILIKE $${p++}`); params.push(`%${explicacion}%`); }
    const where = clauses.length ? "WHERE "+clauses.join(" AND ") : "";
    const [rows, count] = await Promise.all([
      pgPool.query(`SELECT * FROM consumos_im_if_2026_1s ${where} ORDER BY fecha_orden DESC, hora_dia DESC LIMIT $${p} OFFSET $${p+1}`, [...params,limit,offset]),
      pgPool.query(`SELECT COUNT(*) as c FROM consumos_im_if_2026_1s ${where}`, params),
    ]);
    res.json({ rows: rows.rows, total: parseInt(count.rows[0].c), limit, offset });
  } catch(e){ res.status(500).json({error:e.message}); }
});

// Reset
app.post("/api/reset-all", requireDb, (req,res) => {
  try {
    withDb(db => {
      ["articulos","stock_sucursales","pendiente_completo","stock_detallado","stock_arranque","recepciones","pmp_x_bom","pmp_y_comex","pgm","pgm_x_bom","costo_insumos","pendientes_tetra","avance_x_articulo","avance_x_rubro","stock_consolidado","consumo_consolidado","import_log"]
        .forEach(t => db.run(`DELETE FROM ${t}`));
    });
    res.json({ success: true });
  } catch(err){ console.error(err); res.status(500).json({error:err.message}); }
});

// Export CSV
app.get("/api/export/:tabla", requireDb, (req,res) => {
  try {
    const valid = ["articulos","stock_sucursales","pendiente_completo","stock_arranque","recepciones","pmp_x_bom","pmp_y_comex","pgm","pgm_x_bom","costo_insumos","pendientes_tetra","stock_consolidado","consumo_consolidado"];
    const tabla = valid.includes(req.params.tabla) ? req.params.tabla : "stock_sucursales";
    const rows = readDb(db => query(db, `SELECT * FROM ${tabla}`));
    if (!rows.length) return res.status(404).json({error:"Sin datos"});
    const headers = Object.keys(rows[0]).join(",");
    const csv = [headers, ...rows.map(r => Object.values(r).map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(","))].join("\n");
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename=${tabla}.csv`);
    res.send("\uFEFF"+csv);
  } catch(err){ res.status(500).json({error:err.message}); }
});

// Init sql.js
async function initSql() {
  const initSqlJs = require("sql.js");
  SQL = await initSqlJs();
  dbReady = true;
  console.log("sql.js listo");
  initSchema();
  withDb(db => rebuildStockDetallado(db));
  withDb(db => rebuildRecepcionesRubro(db));
  console.log("DB lista");
}
initSql().catch(err => console.error("Error sql.js:", err));
