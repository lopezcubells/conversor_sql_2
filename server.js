const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.get("/health", (req, res) => res.status(200).send("ok"));
app.use(express.static(path.join(__dirname, "public")));

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

// PostgreSQL endpoints

// ── Avance ──

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

// ── Rotación ──

app.get("/api/pg/rotacion/rubros", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const result = await pgPool.query(
      "SELECT DISTINCT rubro FROM rotacion_2026 WHERE rubro IS NOT NULL ORDER BY rubro"
    );
    res.json({ rubros: result.rows.map(r => r.rubro) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/pg/rotacion/chart", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const rubro = req.query.rubro;
    if (!rubro) return res.status(400).json({ error: "Indicá un rubro." });
    const result = await pgPool.query(
      `SELECT numero_mes, pr, objetivo
       FROM rotacion_2026
       WHERE rubro = $1
       ORDER BY numero_mes ASC`,
      [rubro]
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

