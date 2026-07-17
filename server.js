const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const crypto   = require("crypto");
const session  = require("express-session");
const bcrypt   = require("bcryptjs");
const { Pool } = require("pg");

const app  = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1); // Railway corre detrás de un proxy HTTPS

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.get("/health", (req, res) => res.status(200).send("ok"));

let pgPool = null;
if (process.env.DATABASE_URL) {
  pgPool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pgPool.connect().then(c => { console.log("PostgreSQL conectado"); c.release(); }).catch(e => console.error("PG error:", e.message));
} else {
  console.log("DATABASE_URL no definida");
}

// ── Autenticación ──

app.use(session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: "auto",
    maxAge: 8 * 60 * 60 * 1000, // 8 horas
  },
}));

// Crear tabla de usuarios y sembrar el admin inicial (si la tabla está vacía)
async function initAuth() {
  if (!pgPool) return;
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        creado_en TIMESTAMPTZ DEFAULT now()
      )`);
    const { rows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM app_users");
    if (rows[0].c === 0) {
      const usuario = process.env.ADMIN_USER || "admin";
      const pass    = process.env.ADMIN_PASS || "admin";
      const hash    = await bcrypt.hash(pass, 10);
      await pgPool.query("INSERT INTO app_users (usuario, password_hash) VALUES ($1, $2)", [usuario, hash]);
      console.log(`Usuario inicial creado: "${usuario}"${process.env.ADMIN_PASS ? "" : " (contraseña por defecto: admin — cambiala)"}`);
    }
  } catch (e) { console.error("Error init auth:", e.message); }
}
initAuth();

app.post("/api/login", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { usuario, password } = req.body || {};
    if (!usuario || !password) return res.status(400).json({ error: "Ingresá usuario y contraseña." });
    const { rows } = await pgPool.query("SELECT * FROM app_users WHERE usuario = $1", [usuario]);
    const user = rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    req.session.user = { id: user.id, usuario: user.usuario };
    res.json({ success: true, usuario: user.usuario });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
  if (req.session.user) res.json({ usuario: req.session.user.usuario });
  else res.status(401).json({ error: "No autenticado." });
});

// Todo lo que sigue (páginas y APIs) requiere sesión iniciada
const AUTH_EXENTOS = new Set(["/login.html", "/api/login", "/api/me", "/health"]);
app.use((req, res, next) => {
  if (req.session.user || AUTH_EXENTOS.has(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "No autenticado." });
  return res.redirect("/login.html");
});

app.use(express.static(path.join(__dirname, "public")));

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
      `SELECT numero_mes, pr, objetivo, consumo, stock_promedio
       FROM rotacion_2026
       WHERE rubro = $1
       ORDER BY numero_mes ASC`,
      [rubro]
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recepciones ──

app.get("/api/pg/recepciones", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const result = await pgPool.query(
      `SELECT fecha_recepcion, hora_recepcion, cod_corto, descripcion,
              rubro, unidad_negocio, observaciones, cantidad_recibida
       FROM view_recepciones_2026
       ORDER BY fecha_recepcion DESC, hora_recepcion DESC`
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inmovilizados ──

app.get("/api/pg/inmovilizados/rubros", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const result = await pgPool.query(
      "SELECT DISTINCT rubro FROM view_avance_inmovilizados WHERE rubro IS NOT NULL ORDER BY rubro"
    );
    res.json({ rubros: result.rows.map(r => r.rubro) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/pg/inmovilizados/evolucion", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const rubros = Array.isArray(req.query.rubros) ? req.query.rubros
                 : req.query.rubros ? [req.query.rubros] : [];
    const where  = rubros.length ? "WHERE rubro = ANY($1::text[])" : "";
    const params = rubros.length ? [rubros] : [];
    const result = await pgPool.query(
      `SELECT fecha,
              SUM(costo_obsoleto)            AS costo_obsoleto,
              SUM(costo_activo_sin_rotacion) AS costo_activo_sin_rotacion,
              SUM(costo_activo)              AS costo_activo
       FROM view_avance_inmovilizados
       ${where}
       GROUP BY fecha
       ORDER BY fecha ASC`,
      params
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/pg/inmovilizados/detalle", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const rubros = Array.isArray(req.query.rubros) ? req.query.rubros
                 : req.query.rubros ? [req.query.rubros] : [];
    const and    = rubros.length ? "AND rubro = ANY($1::text[])" : "";
    const params = rubros.length ? [rubros] : [];
    const result = await pgPool.query(
      `SELECT cod_corto, descripcion, rubro, obsoleto, costo_obsoleto
       FROM view_avance_inmovilizados
       WHERE fecha = (SELECT MAX(fecha) FROM view_avance_inmovilizados)
       ${and}
       ORDER BY obsoleto DESC`,
      params
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

