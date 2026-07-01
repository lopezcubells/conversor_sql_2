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

// ── Conexión a PostgreSQL (solo lectura de tablas externas) ──
let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pgPool.connect()
    .then(c => { console.log("PostgreSQL conectado"); c.release(); })
    .catch(e => console.error("PostgreSQL error:", e.message));
} else {
  console.log("DATABASE_URL no definida — PostgreSQL desactivado");
}

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
  withDb(db => rebuildRecepcionesRubro(db));
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

// Subconjunto fijo de rubros relevantes para Avance x Rubro y el Indicador de avance general
const AVANCE_RUBRO_WHITELIST = [
  "ETIQUETA FR", "ETIQUETA CT", "Tapón", "Cápsulas", "TETRA Envases",
  "BOTELLA Vidrio", "Tapa", "Bandeja", "Cajas", "BIB Envase", "Pallets",
];

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
    CREATE TABLE IF NOT EXISTS pendiente_completo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero_orden INTEGER,
      tp_ord TEXT,
      nro_orden_original INTEGER,
      tipo_orden_original TEXT,
      unidad_negocio TEXT,
      nro_corto INTEGER,
      segundo_nro TEXT,
      descripcion TEXT,
      rubro TEXT,
      cantidad_orden REAL,
      cantidad_pendiente REAL,
      ult_est INTEGER,
      est_sig INTEGER,
      iniciador_transaccion TEXT,
      fecha_orden TEXT,
      fecha_solic TEXT,
      nro_drc INTEGER,
      costo_unitario REAL,
      orden_id TEXT,
      significado TEXT,
      es_pendiente TEXT,
      primeros_caracteres TEXT,
      demora_hoy INTEGER,
      proveedor TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_arranque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER, segundo_nro TEXT, descripcion TEXT,
      unidad_negocio TEXT, existencias REAL, ubicacion TEXT,
      nro_lote_serie TEXT,
      archivo_origen TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS recepciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tp_ord TEXT,
      numero_orden INTEGER,
      nro_corto INTEGER,
      segundo_nro TEXT,
      observaciones TEXT,
      cantidad_orden REAL,
      cantidad_recibida REAL,
      cantidad_pendiente REAL,
      fecha_orden TEXT,
      fecha_solic TEXT,
      fecha_actz TEXT,
      fecha_recepcion TEXT,
      semana_iso INTEGER,
      unidad_negocio TEXT,
      nro_drc INTEGER,
      tp_ctj TEXT,
      tp_doc TEXT,
      numero_documento INTEGER,
      costo_unitario REAL,
      iniciador_transaccion TEXT,
      est_sig INTEGER,
      ult_est INTEGER,
      hora_dia INTEGER,
      hora_recepcion TEXT,
      rubro TEXT,
      archivo_origen TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
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
      dia TEXT, semana_iso INTEGER, cod_corto INTEGER, producto TEXT, destino TEXT,
      planta TEXT, bultos REAL, v_fr TEXT, litros REAL, linea TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pgm (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      linea TEXT, dia TEXT, semana_iso INTEGER, cod_corto INTEGER, producto TEXT,
      destino TEXT, bultos REAL, v_fr TEXT, litros REAL, planta TEXT,
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
    CREATE TABLE IF NOT EXISTS avance_x_articulo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER,
      descripcion TEXT,
      rubro TEXT,
      arranque REAL,
      recepciones REAL,
      consumo REAL,
      necesidad_inicial REAL,
      necesidad_actual REAL,
      avance_pct REAL,
      costo_u REAL,
      costo_recepciones REAL,
      costo_necesidad_inicial REAL,
      calculado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS avance_x_rubro (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rubro TEXT,
      arranque REAL,
      recepciones REAL,
      consumo REAL,
      necesidad_inicial REAL,
      necesidad_actual REAL,
      avance_pct REAL,
      calculado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS costo_insumos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER,
      segundo_nro TEXT,
      unidad_negocio TEXT,
      costo_uni REAL,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pendientes_tetra (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tp_ord TEXT,
      numero_orden INTEGER,
      nro_corto INTEGER,
      observaciones TEXT,
      cantidad_recibida REAL,
      fecha_recepcion TEXT,
      tp_doc TEXT,
      numero_documento INTEGER,
      mes_facturacion_tetra TEXT,
      fecha_facturacion TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS stock_consolidado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER,
      segundo_nro TEXT,
      descripcion TEXT,
      unidad_negocio TEXT,
      existencias REAL,
      ubicacion TEXT,
      nro_lote_serie TEXT,
      anio INTEGER,
      semana_iso INTEGER,
      archivo_origen TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS consumo_consolidado (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nro_corto INTEGER,
      unidad_negocio TEXT,
      tp_doc TEXT,
      numero_documento INTEGER,
      nro_art_ppal INTEGER,
      tp_ord TEXT,
      numero_orden INTEGER,
      fecha_orden TEXT,
      hora_dia INTEGER,
      hora_orden TEXT,
      cantidad_trns REAL,
      id_usuario TEXT,
      explicacion_transaccion TEXT,
      archivo_origen TEXT,
      importado_en TEXT DEFAULT (datetime('now'))
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

// Actualiza la columna rubro de Recepciones desde Articulos, usando Nº corto como llave.
// Se ejecuta tras importar Recepciones o Artículos, y al arrancar el servidor.
// Agrupamos por nro_corto (muchos menos valores distintos que filas) para minimizar
// la cantidad de UPDATEs ejecutados, en vez de uno por fila o una subquery correlacionada.
function rebuildRecepcionesRubro(db) {
  const articulosRows = query(db, `
    SELECT nro_corto, MAX(rubro) as rubro
    FROM articulos
    WHERE nro_corto IS NOT NULL
    GROUP BY nro_corto
  `);
  const rubroMap = new Map(articulosRows.map(r => [r.nro_corto, r.rubro]));

  const codigosEnRecepciones = query(db, `SELECT DISTINCT nro_corto FROM recepciones WHERE nro_corto IS NOT NULL`);

  const stmt = db.prepare("UPDATE recepciones SET rubro = ? WHERE nro_corto = ?");
  for (const { nro_corto } of codigosEnRecepciones) {
    const rubro = rubroMap.get(nro_corto) ?? null;
    stmt.run([rubro, nro_corto]);
  }
  stmt.free();
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

// Stock de Arranque usa exactamente la misma estructura de columnas que Stock x Sucursales,
// pero el nombre de archivo varía semana a semana (ej: "BD Stock x Sucursales 2026 SEM 27").
// No filtramos por nombre de hoja distinto: reutilizamos el mismo parser de columnas.
function parseStockArranque(buffer) {
  return parseStock(buffer);
}

function parseRecepciones(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName =
    wb.SheetNames.find(n => n === "Sheet1") || wb.SheetNames[0];
  if (!sheetName) throw new Error(`Hoja no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null }).map(r => {
    const fechaRecepcion = toDateString(r["Fecha recepción"]);
    const horaDia = r["Hora día"] ?? null;
    return [
      String(r["Tp ord"] ?? "").trim(),
      r["Número orden"] ?? null,
      r["Nº corto artículo"] ?? null,
      String(r["2º nº artículo"] ?? "").trim(),
      String(r["Observaciones "] ?? r["Observaciones"] ?? "").trim(),
      parseDecimalComma(r["Cantidad orden"]),
      parseDecimalComma(r["Cantidad recibida"]),
      parseDecimalComma(r["Cantidad pendiente"]),
      toDateString(r["Fecha orden"]),
      toDateString(r["Fecha solic"]),
      toDateString(r["Fecha actz"]),
      fechaRecepcion,
      getIsoWeek(fechaRecepcion),
      String(r["Unidad negocio"] ?? "").trim(),
      r["Nº drc"] ?? null,
      String(r["Tp ctj"] ?? "").trim(),
      String(r["Tp doc"] ?? "").trim(),
      r["Número documento"] ?? null,
      parseDecimalComma(r["Costo unitario"]),
      String(r["Iniciador transacción"] ?? "").trim(),
      r["Est sig"] ?? null,
      r["Últ est"] ?? null,
      horaDia,
      horaDiaToTimeString(horaDia),
    ];
  });
}

// Las 4 tablas de PGM x BOM comparten estructura de columnas en pares
// (PMP x BOM / PGM x BOM por un lado, PMP y COMEX / PGM por otro), pero
// cada una tiene su propio set de campos, así que van con parsers separados.

function parsePmpXBom(buffer, sheetLabel, tableLabel) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === sheetLabel);
  if (!sheetName) throw new Error(`Hoja "${sheetLabel}" no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Cod corto"] != null)
    .map(r => {
      const dia = toDateString(r["Día"]);
      return [
        String(r["Linea"] ?? "").trim(),
        r["Codigo Corto (comp)"] ?? null,
        String(r["Descripción (comp)"] ?? "").trim(),
        String(r["Rubro (Comp)"] ?? "").trim(),
        r["Cantidad de ARTICULO"] ?? null,
        r["Cod corto"] ?? null,
        String(r["V/Fr"] ?? "").trim(),
        String(r["PLANTA"] ?? "").trim(),
        String(r["ID"] ?? "").trim(),
        String(r["Producto"] ?? "").trim(),
        String(r["Destino"] ?? "").trim(),
        dia,
        getIsoWeek(dia),
        r["Bultos"] ?? null,
        String(r["Rubro FR/VES"] ?? "").trim(),
        r["Factor"] ?? null,
        r["Cantidad INSUMO"] ?? null,
        String(r["SKU - Rubro"] ?? "").trim(),
        String(r["SKU - Insumo"] ?? "").trim(),
      ];
    });
}

function parsePmpYComex(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === "PMP y COMEX");
  if (!sheetName) throw new Error(`Hoja "PMP y COMEX" no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Cod corto"] != null)
    .map(r => {
      const dia = toDateString(r["Día"]);
      return [
        dia,
        getIsoWeek(dia),
        r["Cod corto"] ?? null,
        String(r["Producto"] ?? "").trim(),
        String(r["Destino"] ?? "").trim(),
        String(r["PLANTA"] ?? "").trim(),
        r["Bultos"] ?? null,
        String(r["V/Fr"] ?? "").trim(),
        r["Litros"] ?? null,
        String(r["Linea"] ?? "").trim(),
      ];
    });
}

function parsePgm(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === "PGM");
  if (!sheetName) throw new Error(`Hoja "PGM" no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Cod corto"] != null)
    .map(r => {
      const dia = toDateString(r["Día"]);
      return [
        String(r["Linea"] ?? "").trim(),
        dia,
        getIsoWeek(dia),
        r["Cod corto"] ?? null,
        String(r["Producto"] ?? "").trim(),
        String(r["Destino"] ?? "").trim(),
        r["Bultos"] ?? null,
        String(r["V/Fr"] ?? "").trim(),
        r["Litros"] ?? null,
        String(r["PLANTA"] ?? "").trim(),
      ];
    });
}

function parseCostoInsumos(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames.find(n => n === "Sheet1") || wb.SheetNames[0];
  if (!sheetName) throw new Error(`Hoja no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Nº corto artículo"] != null)
    .map(r => ([
      r["Nº corto artículo"] ?? null,
      String(r["2º nº artículo"] ?? "").trim(),
      String(r["Unidad negocio"] ?? "").trim(),
      r["Costo uni"] ?? null,
    ]));
}

// Convierte "MES FACTURACION TETRA" (ej: "2026 - 2", "2025 - 1 (reingresado)",
// "revertido por precio 2024 - 8") al primer día del mes en formato "YYYY-MM-DD".
// Usa una expresión regular para extraer año y mes sin importar texto adicional
// alrededor, ya que la columna trae variantes con sufijos/prefijos de estado.
function mesFacturacionToDate(v) {
  if (v == null) return null;
  const s = String(v);
  const m = s.match(/(\d{4})\s*-\s*(\d{1,2})/);
  if (!m) return null;
  const anio = m[1];
  const mes = m[2].padStart(2, "0");
  return `${anio}-${mes}-01`;
}

function parsePendientesTetra(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName = wb.SheetNames.find(n => n === "OV x Mes Facturacion Tetra");
  if (!sheetName) throw new Error(`Hoja "OV x Mes Facturacion Tetra" no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);

  // SheetJS a veces preserva espacios en blanco alrededor de los encabezados de columna
  // (ej: " Cantidad recibida " en vez de "Cantidad recibida"). Normalizamos las claves
  // de cada fila (trim) antes de buscar por nombre, para no depender de coincidencia exacta.
  function normalizeRow(r) {
    const out = {};
    for (const k in r) out[k.trim()] = r[k];
    return out;
  }

  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .map(normalizeRow)
    .filter(r => r["Número orden"] != null)
    .map(r => {
      const mesFacturacion = r["MES FACTURACION TETRA"] ?? null;
      return [
        String(r["Tp ord"] ?? "").trim(),
        r["Número orden"] ?? null,
        r["Nº corto artículo"] ?? null,
        String(r["Observaciones"] ?? "").trim(),
        r["Cantidad recibida"] ?? null,
        toDateString(r["Fecha recepción"]),
        String(r["Tp doc"] ?? "").trim(),
        r["Número documento"] ?? null,
        mesFacturacion != null ? String(mesFacturacion) : null,
        mesFacturacionToDate(mesFacturacion),
      ];
    });
}

// Convierte fechas de Excel (Date object tras cellDates:true, o string) a "YYYY-MM-DD" / null
function toDateString(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Algunos archivos traen la fecha como número serial de Excel (días desde 1899-12-30)
  // en vez de un objeto Date, típicamente cuando la celda no tiene formato de fecha aplicado.
  if (typeof v === "number") {
    const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
    const ms = EXCEL_EPOCH + v * 86400000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return String(v);
}

// Calcula el número de semana ISO-8601 (lunes a domingo, semana 1 = la que
// contiene el primer jueves del año) a partir de una fecha "YYYY-MM-DD" o Date.
// Equivalente a la función de Excel ISO.NUM.DE.SEMANA / ISOWEEKNUM.
function getIsoWeek(dateInput) {
  if (dateInput == null) return null;
  const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (utc.getUTCDay() + 6) % 7; // lunes=0 ... domingo=6
  utc.setUTCDate(utc.getUTCDate() - dayNum + 3); // jueves de esa semana ISO
  const firstThursday = new Date(Date.UTC(utc.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((utc - firstThursday) / (7 * 86400000));
}

// Parsea un valor numérico que puede venir como number nativo de Excel,
// o como texto con formato regional es-AR ("1.234,56" = mil doscientos
// treinta y cuatro coma cincuenta y seis), donde el punto es separador de
// miles y la coma es el separador decimal. Nunca interpreta la coma como
// separador de miles.
function parseDecimalComma(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v;
  let s = String(v).trim();
  if (s === "") return null;
  // Si tiene coma, se asume formato es-AR: quitar puntos de miles, coma -> punto decimal
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// Convierte el campo "Hora día" (entero tipo HMMSS o HHMMSS, ej: 92158 o 140001)
// al formato de hora "HH:MM:SS" (ej: "09:21:58", "14:00:01").
function horaDiaToTimeString(v) {
  if (v == null || v === "") return null;
  const n = Math.trunc(Number(v));
  if (isNaN(n) || n < 0) return null;
  const s = String(n).padStart(6, "0");
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

function parsePendienteCompleto(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheetName =
    wb.SheetNames.find(n => n === "Pendiente COMPLETO") ||
    wb.SheetNames.find(n => n.toLowerCase().includes("pendiente"));
  if (!sheetName) throw new Error(`Hoja no encontrada. Disponibles: ${wb.SheetNames.join(", ")}`);
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: null })
    .filter(r => r["Número orden"] != null) // descarta filas vacías de cola
    .map(r => ([
      r["Número orden"] ?? null,
      String(r["Tp ord"] ?? "").trim(),
      r["Nº orden original"] ?? null,
      String(r["Tipo orden original"] ?? "").trim(),
      String(r["Unidad negocio"] ?? "").trim(),
      r["Nº corto artículo"] ?? null,
      String(r["2º nº artículo"] ?? "").trim(),
      String(r["Descripción"] ?? "").trim(),
      r["Rubro"] ?? null,
      r["Cantidad orden"] ?? null,
      r["Cantidad pendiente"] ?? null,
      r["Últ est"] ?? null,
      r["Est sig"] ?? null,
      String(r["Iniciador transacción"] ?? "").trim(),
      toDateString(r["Fecha orden"]),
      toDateString(r["Fecha solic"]),
      r["Nº drc"] ?? null,
      r["Costo unitario"] ?? null,
      String(r["ID"] ?? "").trim(),
      String(r["Significado"] ?? "").trim(),
      String(r["¿Es pendiente?"] ?? "").trim(),
      String(r["Primeros caracteres"] ?? "").trim(),
      r["Demora Hoy"] ?? null,
      String(r["Proveedor"] ?? "").trim(),
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
      rebuildRecepcionesRubro(db);
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

app.post("/api/import/pendiente", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parsePendienteCompleto(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM pendiente_completo");
      const stmt = db.prepare(`INSERT INTO pendiente_completo (
        numero_orden, tp_ord, nro_orden_original, tipo_orden_original, unidad_negocio,
        nro_corto, segundo_nro, descripcion, rubro, cantidad_orden, cantidad_pendiente,
        ult_est, est_sig, iniciador_transaccion, fecha_orden, fecha_solic, nro_drc,
        costo_unitario, orden_id, significado, es_pendiente, primeros_caracteres,
        demora_hoy, proveedor
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["pendiente_completo", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/stock-arranque", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseStockArranque(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM stock_arranque");
      const stmt = db.prepare(
        "INSERT INTO stock_arranque (nro_corto,segundo_nro,descripcion,unidad_negocio,existencias,ubicacion,nro_lote_serie,archivo_origen) VALUES (?,?,?,?,?,?,?,?)"
      );
      rows.forEach(r => stmt.run([...r, req.file.originalname]));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["stock_arranque", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/recepciones", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseRecepciones(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM recepciones");
      const stmt = db.prepare(`INSERT INTO recepciones (
        tp_ord, numero_orden, nro_corto, segundo_nro, observaciones,
        cantidad_orden, cantidad_recibida, cantidad_pendiente,
        fecha_orden, fecha_solic, fecha_actz, fecha_recepcion, semana_iso,
        unidad_negocio, nro_drc, tp_ctj, tp_doc, numero_documento,
        costo_unitario, iniciador_transaccion, est_sig, ult_est,
        hora_dia, hora_recepcion, archivo_origen
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run([...r, req.file.originalname]));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["recepciones", req.file.originalname, rows.length, "ok"]);
      rebuildRecepcionesRubro(db);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/pgm-x-bom", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const mode = req.query.mode || "replace";

    const pmpXBom  = parsePmpXBom(req.file.buffer, "PMP x BOM");
    const pmpComex = parsePmpYComex(req.file.buffer);
    const pgm      = parsePgm(req.file.buffer);
    const pgmXBom  = parsePmpXBom(req.file.buffer, "PGM x BOM");

    const totalRows = pmpXBom.length + pmpComex.length + pgm.length + pgmXBom.length;
    if (!totalRows) return res.status(400).json({ error: "No se encontraron datos en ninguna de las 4 tablas esperadas." });

    withDb(db => {
      const insertGroupA = (table, rows) => {
        if (mode === "replace") db.run(`DELETE FROM ${table}`);
        const stmt = db.prepare(`INSERT INTO ${table} (
          linea, codigo_corto_comp, descripcion_comp, rubro_comp, cantidad_articulo,
          cod_corto, v_fr, planta, ident, producto, destino, dia, semana_iso,
          bultos, rubro_fr_ves, factor, cantidad_insumo, sku_rubro, sku_insumo
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        rows.forEach(r => stmt.run(r));
        stmt.free();
      };

      insertGroupA("pmp_x_bom", pmpXBom);
      insertGroupA("pgm_x_bom", pgmXBom);

      if (mode === "replace") db.run("DELETE FROM pmp_y_comex");
      const stmtComex = db.prepare(`INSERT INTO pmp_y_comex (
        dia, semana_iso, cod_corto, producto, destino, planta, bultos, v_fr, litros, linea
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      pmpComex.forEach(r => stmtComex.run(r));
      stmtComex.free();

      if (mode === "replace") db.run("DELETE FROM pgm");
      const stmtPgm = db.prepare(`INSERT INTO pgm (
        linea, dia, semana_iso, cod_corto, producto, destino, bultos, v_fr, litros, planta
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      pgm.forEach(r => stmtPgm.run(r));
      stmtPgm.free();

      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["pgm_x_bom (4 tablas)", req.file.originalname, totalRows, "ok"]);
    });

    res.json({
      success: true,
      mode,
      detalle: {
        pmp_x_bom: pmpXBom.length,
        pmp_y_comex: pmpComex.length,
        pgm: pgm.length,
        pgm_x_bom: pgmXBom.length,
      },
      rows: totalRows,
    });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/costo-insumos", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parseCostoInsumos(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM costo_insumos");
      const stmt = db.prepare(
        "INSERT INTO costo_insumos (nro_corto, segundo_nro, unidad_negocio, costo_uni) VALUES (?,?,?,?)"
      );
      rows.forEach(r => stmt.run(r));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["costo_insumos", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.post("/api/import/pendientes-tetra", requireDb, upload.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se recibió archivo." });
    const rows = parsePendientesTetra(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: "El archivo no contiene datos." });
    const mode = req.query.mode || "replace";
    withDb(db => {
      if (mode === "replace") db.run("DELETE FROM pendientes_tetra");
      const stmt = db.prepare(`INSERT INTO pendientes_tetra (
        tp_ord, numero_orden, nro_corto, observaciones, cantidad_recibida,
        fecha_recepcion, tp_doc, numero_documento, mes_facturacion_tetra, fecha_facturacion
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`);
      rows.forEach(r => stmt.run(r));
      stmt.free();
      db.run("INSERT INTO import_log (tabla,filename,filas,status) VALUES (?,?,?,?)",
        ["pendientes_tetra", req.file.originalname, rows.length, "ok"]);
    });
    res.json({ success: true, rows: rows.length, mode });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});


// ══════════════════════════════════════════════════════
// ── Pestaña "Base de datos": lectura desde PostgreSQL ──
// ══════════════════════════════════════════════════════

// Valores distintos de tp_doc y id_usuario para los filtros desplegables
app.get("/api/db/consumos/filtros", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const [tpDoc, usuario] = await Promise.all([
      pgPool.query("SELECT DISTINCT tp_doc FROM consumos_im_if_2026_1s WHERE tp_doc IS NOT NULL ORDER BY tp_doc"),
      pgPool.query("SELECT DISTINCT id_usuario FROM consumos_im_if_2026_1s WHERE id_usuario IS NOT NULL ORDER BY id_usuario"),
    ]);
    res.json({
      tp_doc:     tpDoc.rows.map(r => r.tp_doc),
      id_usuario: usuario.rows.map(r => r.id_usuario),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lectura paginada con filtros opcionales
app.get("/api/db/consumos", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 500);
    const offset = parseInt(req.query.offset) || 0;
    const { nro_corto, tp_doc, fecha_desde, fecha_hasta, usuario, explicacion } = req.query;

    const whereClauses = [];
    const params = [];
    let p = 1;

    if (nro_corto)    { whereClauses.push(`nro_corto_articulo = $${p++}`);          params.push(parseInt(nro_corto)); }
    if (tp_doc)       { whereClauses.push(`tp_doc = $${p++}`);                      params.push(tp_doc); }
    if (fecha_desde)  { whereClauses.push(`fecha_orden >= $${p++}`);                params.push(fecha_desde); }
    if (fecha_hasta)  { whereClauses.push(`fecha_orden <= $${p++}`);                params.push(fecha_hasta); }
    if (usuario)      { whereClauses.push(`id_usuario = $${p++}`);                  params.push(usuario); }
    if (explicacion)  { whereClauses.push(`explicacion_transaccion ILIKE $${p++}`); params.push(`%${explicacion}%`); }

    const where = whereClauses.length ? "WHERE " + whereClauses.join(" AND ") : "";

    const [rows, count] = await Promise.all([
      pgPool.query(
        `SELECT * FROM consumos_im_if_2026_1s ${where} ORDER BY fecha_orden DESC, hora_dia DESC LIMIT $${p} OFFSET $${p+1}`,
        [...params, limit, offset]
      ),
      pgPool.query(`SELECT COUNT(*) as c FROM consumos_im_if_2026_1s ${where}`, params),
    ]);

    res.json({ rows: rows.rows, total: parseInt(count.rows[0].c), limit, offset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borra todos los datos de todas las tablas, dejando la app como recién desplegada.
// No borra el esquema (las tablas siguen existiendo, vacías).
app.post("/api/reset-all", requireDb, (req, res) => {
  try {
    const ALL_DATA_TABLES = [
      "articulos", "stock_sucursales", "pendiente_completo", "stock_detallado",
      "stock_arranque", "recepciones", "pmp_x_bom", "pmp_y_comex", "pgm", "pgm_x_bom",
      "costo_insumos", "pendientes_tetra", "avance_x_articulo", "avance_x_rubro",
      "stock_consolidado", "consumo_consolidado",
      "import_log",
    ];
    withDb(db => {
      ALL_DATA_TABLES.forEach(t => db.run(`DELETE FROM ${t}`));
    });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});

app.get("/api/export/:tabla", requireDb, (req, res) => {
  try {
    const validTables = [
      "articulos", "stock_sucursales", "stock_detallado", "pendiente_completo",
      "stock_arranque", "recepciones", "pmp_x_bom", "pmp_y_comex", "pgm", "pgm_x_bom",
      "avance_x_articulo", "avance_x_rubro", "costo_insumos", "pendientes_tetra",
      "stock_consolidado", "consumo_consolidado",
    ];
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
