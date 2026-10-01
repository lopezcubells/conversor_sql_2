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
    await pgPool.query("ALTER TABLE app_users ADD COLUMN IF NOT EXISTS es_admin BOOLEAN DEFAULT false");
    const { rows } = await pgPool.query("SELECT COUNT(*)::int AS c FROM app_users");
    if (rows[0].c === 0) {
      const usuario = process.env.ADMIN_USER || "admin";
      const pass    = process.env.ADMIN_PASS || "admin";
      const hash    = await bcrypt.hash(pass, 10);
      await pgPool.query("INSERT INTO app_users (usuario, password_hash, es_admin) VALUES ($1, $2, true)", [usuario, hash]);
      console.log(`Usuario inicial creado: "${usuario}"${process.env.ADMIN_PASS ? "" : " (contraseña por defecto: admin — cambiala)"}`);
    } else {
      // Migración: asegurar que el usuario admin configurado tenga el flag
      await pgPool.query("UPDATE app_users SET es_admin = true WHERE usuario = $1", [process.env.ADMIN_USER || "admin"]);
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
    req.session.user = { id: user.id, usuario: user.usuario, es_admin: !!user.es_admin };
    res.json({ success: true, usuario: user.usuario });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get("/api/me", (req, res) => {
  if (req.session.user) res.json({ usuario: req.session.user.usuario, es_admin: !!req.session.user.es_admin });
  else res.status(401).json({ error: "No autenticado." });
});

// ── Administración de usuarios (solo admin) ──

function requireAdmin(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "No autenticado." });
  if (!req.session.user.es_admin) return res.status(403).json({ error: "Requiere permisos de administrador." });
  next();
}

app.get("/api/users", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pgPool.query(
      "SELECT id, usuario, es_admin, creado_en FROM app_users ORDER BY usuario"
    );
    res.json({ users: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/users", requireAdmin, async (req, res) => {
  try {
    const { usuario, password, es_admin } = req.body || {};
    if (!usuario || !usuario.trim()) return res.status(400).json({ error: "Ingresá un nombre de usuario." });
    if (!password || password.length < 4) return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
    const hash = await bcrypt.hash(password, 10);
    await pgPool.query(
      "INSERT INTO app_users (usuario, password_hash, es_admin) VALUES ($1, $2, $3)",
      [usuario.trim(), hash, !!es_admin]
    );
    res.json({ success: true });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Ese usuario ya existe." });
    res.status(500).json({ error: e.message });
  }
});

app.put("/api/users/:id/password", requireAdmin, async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || password.length < 4) return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres." });
    const hash = await bcrypt.hash(password, 10);
    const r = await pgPool.query("UPDATE app_users SET password_hash = $1 WHERE id = $2", [hash, req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/users/:id", requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.user.id)
      return res.status(400).json({ error: "No podés eliminar tu propio usuario." });
    const r = await pgPool.query("DELETE FROM app_users WHERE id = $1", [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: "Usuario no encontrado." });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Todo lo que sigue (páginas y APIs) requiere sesión iniciada
const AUTH_EXENTOS = new Set(["/login.html", "/api/login", "/api/me", "/health", "/favicon.png"]);
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
    const {
      fe_arranque_stock, hora_arranque_stock, fe_inicio_pmp, fe_final_pmp,
      fe_inicio_semana_mes_sgte, fe_final_semana_mes_sgte, porcentaje_arranque,
    } = req.body || {};

    if (!fe_arranque_stock || !hora_arranque_stock || !fe_inicio_pmp || !fe_final_pmp
        || !fe_inicio_semana_mes_sgte || !fe_final_semana_mes_sgte)
      return res.status(400).json({ error: "Completá todos los parámetros antes de calcular." });

    // Llega como fracción 0-1 (el usuario carga el porcentaje 0-100 en la pantalla).
    // 0 es un valor válido, así que se compara contra null/vacío, no por falsy.
    const porc = Number(porcentaje_arranque);
    if (porcentaje_arranque === undefined || porcentaje_arranque === null || porcentaje_arranque === ""
        || !Number.isFinite(porc) || porc < 0 || porc > 1)
      return res.status(400).json({ error: "El % de arranque debe estar entre 0 y 100." });

    // Las dos funciones comparten la misma firma de 7 parámetros.
    const argsAvance = [
      fe_arranque_stock, hora_arranque_stock, fe_inicio_pmp, fe_final_pmp,
      fe_inicio_semana_mes_sgte, fe_final_semana_mes_sgte, porc,
    ];
    const firma = `$1::date, $2::time, $3::date, $4::date, $5::date, $6::date, $7::numeric`;

    const [rubro, articulo] = await Promise.all([
      pgPool.query(`SELECT * FROM avance_x_rubro(${firma})`,    argsAvance),
      pgPool.query(`SELECT * FROM avance_x_articulo(${firma})`, argsAvance),
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
              rubro, unidad_negocio, observaciones, proveedor, cantidad_recibida
       FROM view_recepciones_2026
       ORDER BY fecha_recepcion DESC, hora_recepcion DESC`
    );
    res.json({ rows: result.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Nivel de servicio ──

app.post("/api/pg/nivel-servicio", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const {
      cob_fe_inicio, cob_hora, cob_fe_final, rubros,
      actual_inicio, actual_final,
    } = req.body || {};

    if (!cob_fe_inicio || !cob_hora || !cob_fe_final)
      return res.status(400).json({ error: "Faltan parámetros de cálculo de cobertura." });
    if (!Array.isArray(rubros) || !rubros.length)
      return res.status(400).json({ error: "Seleccioná al menos un rubro." });

    // Resumen de cobertura de la semana en curso → devuelve CM y TORO juntos (GROUP BY planta)
    const sql = `
      WITH detalle AS (
        SELECT *
        FROM indicador_cobertura($1::date, $2::date, $3::time)
        WHERE rubro = ANY($4::text[])
          AND dia >= $5::date
          AND dia <= $6::date
      ),
      lineas AS (
        SELECT d.planta, d.cod_corto_ppal, d.dia,
               MAX(d.bultos)                      AS bultos,
               BOOL_OR(d.evaluacion = 'no cubre') AS tiene_faltante
        FROM detalle d
        GROUP BY d.planta, d.cod_corto_ppal, d.dia
      )
      SELECT l.planta,
             SUM(l.bultos)                                                  AS total_programado,
             COALESCE(SUM(l.bultos) FILTER (WHERE NOT l.tiene_faltante), 0) AS cubre,
             COALESCE(SUM(l.bultos) FILTER (WHERE l.tiene_faltante), 0)     AS no_cubre,
             ROUND(
               100 * COALESCE(SUM(l.bultos) FILTER (WHERE NOT l.tiene_faltante), 0)
                   / NULLIF(SUM(l.bultos), 0)
             , 2) || '%'                                                    AS cobertura
      FROM lineas l
      GROUP BY l.planta
      ORDER BY l.planta`;

    // Reporte de faltantes (SEMANA EN CURSO): a nivel insumo (componente) + producto.
    // Trae todas las filas, sin deduplicar por combinación.
    const sqlReporte = `
      SELECT rubro,
             cod_corto_comp, descripcion_comp,
             cod_corto_ppal, descripcion_ppal,
             planta,
             saldo,
             faltante_puntual,
             bultos_afectados
      FROM indicador_cobertura($1::date, $2::date, $3::time)
      WHERE evaluacion = 'no cubre'
        AND rubro = ANY($4::text[])
        AND dia >= $5::date
        AND dia <= $6::date
      ORDER BY rubro, cod_corto_comp, descripcion_comp, cod_corto_ppal, descripcion_ppal, planta`;

    // Tablero de faltantes por día/producto/rubro: estado 1 (falta), -1 (sobra), 0 (no falta / no aplica)
    const sqlTablero = `
      WITH datos AS (
        SELECT *
        FROM indicador_cobertura($1::date, $2::date, $3::time)
      ),
      estado_calc AS (
        SELECT
          d.dia,
          d.descripcion_ppal,
          d.rubro,
          CASE
            WHEN d.saldo > 0 THEN 1
            WHEN d.saldo < 0 THEN -1
            ELSE 0
          END AS estado
        FROM datos d
        WHERE d.rubro IS NOT NULL
          AND d.rubro = ANY($4::text[])
          AND d.dia >= $5::date
          AND d.dia <= $6::date
      )
      SELECT
        e.dia              AS fecha,
        e.descripcion_ppal AS producto,
        e.rubro,
        CASE
          WHEN bool_or(e.estado = -1) THEN -1
          WHEN bool_or(e.estado = 1)  THEN 1
          ELSE 0
        END AS estado
      FROM estado_calc e
      GROUP BY e.dia, e.descripcion_ppal, e.rubro
      ORDER BY e.dia, e.descripcion_ppal, e.rubro`;

    // Urgencias: faltantes día por día, mismo criterio que el resto de los bloques.
    // La función se llama SIEMPRE con el rango completo de cobertura ($1/$2): arranca
    // el cálculo desde el inicio de la semana y acumula. El rango de SEMANA EN CURSO
    // ($5/$6) se aplica como filtro sobre el resultado, no como arranque del cálculo;
    // si se lo pasara a la función, empezar a mitad de semana perdería el saldo
    // acumulado de los días previos e inventaría faltantes.
    const sqlUrgencias = `
      SELECT dia,
             rubro,
             cod_corto_comp, descripcion_comp,
             descripcion_ppal,
             planta,
             faltante_puntual
      FROM indicador_cobertura($1::date, $2::date, $3::time)
      WHERE evaluacion = 'no cubre'
        AND rubro = ANY($4::text[])
        AND dia >= $5::date
        AND dia <= $6::date
      ORDER BY dia, rubro, cod_corto_comp, descripcion_comp, descripcion_ppal, planta`;

    const args = [cob_fe_inicio, cob_fe_final, cob_hora, rubros, actual_inicio, actual_final];

    const [actualR, reporte, tablero, urgencias] = await Promise.all([
      pgPool.query(sql,          args),
      pgPool.query(sqlReporte,   args),
      pgPool.query(sqlTablero,   args),
      pgPool.query(sqlUrgencias, args),
    ]);

    res.json({
      actual:    { resumen: actualR.rows },
      reporte:   reporte.rows,
      tablero:   tablero.rows,
      urgencias: urgencias.rows,
    });
  } catch (e) {
    console.error("PG nivel-servicio error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Registro histórico: se inserta cada vez que el usuario genera el PDF del reporte
app.post("/api/pg/nivel-servicio/registro", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { fe_inicial, fe_final, filas } = req.body || {};
    if (!fe_inicial || !fe_final) return res.status(400).json({ error: "Faltan fe_inicial/fe_final." });
    if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: "No hay filas para registrar." });

    const cols = [
      "fe_reporte", "fe_inicial", "fe_final", "rubro", "insumo", "producto_afectado",
      "planta", "cantidad_faltante", "bultos_afectados", "faltante_real",
      "causa_estandar", "sector_proveedor_responsable",
    ];
    const values = [];
    const placeholders = filas.map((f, i) => {
      const base = i * cols.length;
      values.push(
        new Date(), fe_inicial, fe_final,
        f.rubro ?? null, f.insumo ?? null, f.producto_afectado ?? null, f.planta ?? null,
        f.cantidad_faltante ?? null, f.bultos_afectados ?? null,
        f.faltante_real ?? null, f.causa_estandar ?? null, f.sector_proveedor_responsable ?? null,
      );
      return `(${cols.map((_, j) => `$${base + j + 1}`).join(",")})`;
    });

    await pgPool.query(
      `INSERT INTO registro_nivel_servicio (${cols.join(",")}) VALUES ${placeholders.join(",")}`,
      values
    );
    res.json({ success: true, inserted: filas.length });
  } catch (e) {
    console.error("PG registro nivel-servicio error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Necesidad final ──

app.post("/api/pg/necesidad-final", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { fecha_arranque_semanal, hora_arranque_semanal, fecha_horizonte_consumo } = req.body || {};
    if (!fecha_arranque_semanal || !hora_arranque_semanal || !fecha_horizonte_consumo)
      return res.status(400).json({ error: "Completá los 3 parámetros antes de calcular." });

    const result = await pgPool.query(
      `SELECT cod_corto, descripcion, rubro,
              arranque_semanal, recepcion_semanal, pendiente_completo,
              consumo_total, necesidad_final,
              criticidad_valor, criticidad_categoria
       FROM necesidad_final($1::date, $2::time, $3::date)
       ORDER BY criticidad_valor DESC`,
      [fecha_arranque_semanal, hora_arranque_semanal, fecha_horizonte_consumo]
    );
    res.json({ rows: result.rows });
  } catch (e) {
    console.error("PG necesidad-final error:", e.message);
    res.status(500).json({ error: e.message });
  }
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

// ── Consumo histórico ──

// Comparación tolerante para los filtros de valor exacto. El valor elegido sale
// del mismo SELECT DISTINCT que llena el desplegable, así que deberían coincidir
// tal cual — salvo que la columna sea character(n), donde el relleno con espacios
// se pierde al castear a text y la igualdad falla sin que se note. Se recortan
// espacios y se ignoran mayúsculas de los dos lados para que no dependa del tipo.
const chIgual = (col, param) =>
  `upper(btrim(${col}::text)) = ANY(SELECT upper(btrim(x)) FROM unnest(${param}::text[]) AS x)`;

// Las tablas de referencia pueden tener más de una fila por código; se deduplican
// con DISTINCT ON antes de unir. Sin eso, un LEFT JOIN multiplicaría cada consumo
// por la cantidad de filas repetidas e inflaría todos los totales.
const CH_BASE = `
  WITH art AS (
    SELECT DISTINCT ON (cod_corto) cod_corto, descripcion, rubro
    FROM bd_articulos_x_rubro
    WHERE cod_corto IS NOT NULL
    ORDER BY cod_corto
  ),
  ins AS (
    SELECT DISTINCT ON (cod_corto) cod_corto, sub_rubro
    FROM bd_maestro_insumos
    WHERE cod_corto IS NOT NULL
    ORDER BY cod_corto
  ),
  base AS (
    SELECT c.cod_corto,
           a.descripcion                   AS descripcion,
           a.rubro                         AS rubro,
           i.sub_rubro                     AS sub_rubro,
           c.cod_corto_ppal,
           p.descripcion                   AS descripcion_ppal,
           c.unidad_negocio,
           c.tipo_doc,
           c.numero_documento,
           c.tipo_orden,
           c.numero_orden,
           c.fecha_orden::date             AS fecha_orden,
           COALESCE(c.consumo, 0)::numeric AS consumo
    FROM consumos_im_if_consolidado c
    LEFT JOIN art a ON a.cod_corto = c.cod_corto
    LEFT JOIN art p ON p.cod_corto = c.cod_corto_ppal
    LEFT JOIN ins i ON i.cod_corto = c.cod_corto
    WHERE ($1::text   IS NULL OR c.cod_corto      ILIKE $1)
      AND ($2::text   IS NULL OR a.descripcion    ILIKE $2)
      AND ($3::text[] IS NULL OR ${chIgual("a.rubro",          "$3")})
      AND ($4::text[] IS NULL OR ${chIgual("i.sub_rubro",      "$4")})
      AND ($5::text[] IS NULL OR ${chIgual("c.unidad_negocio", "$5")})
      AND ($6::text[] IS NULL OR ${chIgual("c.tipo_doc",       "$6")})
      AND ($7::date   IS NULL OR c.fecha_orden::date >= $7::date)
      AND ($8::date   IS NULL OR c.fecha_orden::date <= $8::date)
      AND ($9::text   IS NULL OR c.cod_corto_ppal ILIKE $9)
      AND ($10::int[] IS NULL OR EXTRACT(YEAR FROM c.fecha_orden)::int = ANY($10::int[]))
      AND ($11::text  IS NULL OR p.descripcion    ILIKE $11)
  )`;

// El desplegado del gráfico principal entra como identificador dentro del SQL,
// así que sale de esta tabla y nunca del texto que mandó el navegador.
const CH_GRANOS = {
  anual:   { trunc: "year",  formato: "YYYY" },
  mensual: { trunc: "month", formato: "YYYY-MM" },
  diario:  { trunc: "day",   formato: "YYYY-MM-DD" },
};

const CH_PAGE_SIZE = 50;

// Valores disponibles para los selectores de filtro
app.get("/api/pg/consumo-historico/filtros", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const [un, td, ru, sr, an] = await Promise.all([
      pgPool.query("SELECT DISTINCT btrim(unidad_negocio::text) AS v FROM consumos_im_if_consolidado WHERE unidad_negocio IS NOT NULL ORDER BY 1"),
      pgPool.query("SELECT DISTINCT btrim(tipo_doc::text)       AS v FROM consumos_im_if_consolidado WHERE tipo_doc       IS NOT NULL ORDER BY 1"),
      pgPool.query("SELECT DISTINCT btrim(rubro::text)          AS v FROM bd_articulos_x_rubro       WHERE rubro          IS NOT NULL ORDER BY 1"),
      pgPool.query("SELECT DISTINCT btrim(sub_rubro::text)      AS v FROM bd_maestro_insumos         WHERE sub_rubro      IS NOT NULL ORDER BY 1"),
      pgPool.query("SELECT DISTINCT EXTRACT(YEAR FROM fecha_orden)::int AS v FROM consumos_im_if_consolidado WHERE fecha_orden IS NOT NULL ORDER BY 1"),
    ]);
    const vals = r => r.rows.map(x => x.v);
    res.json({
      unidades_negocio: vals(un),
      tipos_doc:        vals(td),
      rubros:           vals(ru),
      sub_rubros:       vals(sr),
      anios:            vals(an),
    });
  } catch (e) {
    console.error("PG consumo-historico/filtros error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Arma los argumentos comunes a todas las consultas del tablero.
// Un filtro vacío viaja como NULL, que en el WHERE significa "no filtrar".
function chArgs(body) {
  const txt  = v => (v && String(v).trim() ? `%${String(v).trim()}%` : null);
  const arr  = v => (Array.isArray(v) && v.length ? v : null);
  const fech = v => (v && String(v).trim() ? String(v).trim() : null);
  // Los años llegan como botones; se quedan solo los enteros válidos
  const anios = v => {
    if (!Array.isArray(v)) return null;
    const limpios = v.map(x => parseInt(x, 10)).filter(Number.isInteger);
    return limpios.length ? limpios : null;
  };
  return [
    txt(body.q_cod), txt(body.q_desc),
    arr(body.rubros), arr(body.sub_rubros),
    arr(body.unidades_negocio), arr(body.tipos_doc),
    fech(body.desde), fech(body.hasta),
    txt(body.q_prod),
    anios(body.anios),
    txt(body.q_desc_prod),
  ];
}

app.post("/api/pg/consumo-historico", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const body   = req.body || {};
    const grano  = CH_GRANOS[body.grano] || CH_GRANOS.mensual;
    const args   = chArgs(body);
    const offset = Math.max(0, parseInt(body.offset) || 0);

    const sqlResumen = `${CH_BASE}
      SELECT COALESCE(SUM(consumo), 0)          AS consumo_total,
             COUNT(*)::int                      AS movimientos,
             COUNT(DISTINCT cod_corto)::int     AS insumos,
             COUNT(DISTINCT cod_corto_ppal)::int AS productos,
             MIN(fecha_orden)                   AS desde,
             MAX(fecha_orden)                   AS hasta
      FROM base`;

    const sqlSerie = `${CH_BASE}
      SELECT to_char(date_trunc('${grano.trunc}', fecha_orden), '${grano.formato}') AS periodo,
             date_trunc('${grano.trunc}', fecha_orden) AS orden,
             SUM(consumo) AS consumo
      FROM base
      WHERE fecha_orden IS NOT NULL
      GROUP BY 1, 2
      ORDER BY 2`;

    // Los cuatro cortes salen de un solo recorrido de la tabla en vez de cuatro.
    const sqlDims = `${CH_BASE}
      SELECT CASE WHEN GROUPING(rubro)          = 0 THEN 'rubro'
                  WHEN GROUPING(sub_rubro)      = 0 THEN 'sub_rubro'
                  WHEN GROUPING(unidad_negocio) = 0 THEN 'unidad_negocio'
                  ELSE 'tipo_doc' END AS dim,
             CASE WHEN GROUPING(rubro)          = 0 THEN COALESCE(rubro,          '(sin dato)')
                  WHEN GROUPING(sub_rubro)      = 0 THEN COALESCE(sub_rubro,      '(sin dato)')
                  WHEN GROUPING(unidad_negocio) = 0 THEN COALESCE(unidad_negocio, '(sin dato)')
                  ELSE COALESCE(tipo_doc, '(sin dato)') END AS clave,
             SUM(consumo) AS consumo
      FROM base
      GROUP BY GROUPING SETS ((rubro), (sub_rubro), (unidad_negocio), (tipo_doc))
      ORDER BY 1, 3 DESC`;

    const sqlTopInsumos = `${CH_BASE}
      SELECT cod_corto,
             MAX(descripcion)                    AS descripcion,
             MAX(rubro)                          AS rubro,
             MAX(sub_rubro)                      AS sub_rubro,
             SUM(consumo)                        AS consumo,
             COUNT(DISTINCT cod_corto_ppal)::int AS productos
      FROM base
      GROUP BY cod_corto
      ORDER BY consumo DESC NULLS LAST
      LIMIT 15`;

    const sqlTopProductos = `${CH_BASE}
      SELECT cod_corto_ppal,
             MAX(descripcion_ppal)          AS descripcion_ppal,
             SUM(consumo)                   AS consumo,
             COUNT(DISTINCT cod_corto)::int AS insumos
      FROM base
      GROUP BY cod_corto_ppal
      ORDER BY consumo DESC NULLS LAST
      LIMIT 15`;

    // Insumo → productos: se acota a los 20 insumos de mayor consumo para que
    // el cruce no crezca con el producto de ambas dimensiones.
    const sqlInsumoProducto = `${CH_BASE},
      top AS (
        SELECT cod_corto, SUM(consumo) AS consumo
        FROM base
        GROUP BY cod_corto
        ORDER BY consumo DESC NULLS LAST
        LIMIT 20
      )
      SELECT b.cod_corto,
             MAX(b.descripcion)      AS descripcion,
             MAX(b.rubro)            AS rubro,
             b.cod_corto_ppal,
             MAX(b.descripcion_ppal) AS descripcion_ppal,
             SUM(b.consumo)          AS consumo,
             MAX(t.consumo)          AS consumo_insumo
      FROM base b
      JOIN top t ON t.cod_corto = b.cod_corto
      GROUP BY b.cod_corto, b.cod_corto_ppal
      ORDER BY MAX(t.consumo) DESC NULLS LAST, b.cod_corto, SUM(b.consumo) DESC`;

    const sqlDetalle = `${CH_BASE}
      SELECT fecha_orden, cod_corto, descripcion, rubro, sub_rubro,
             cod_corto_ppal, descripcion_ppal,
             unidad_negocio, tipo_doc, numero_documento,
             tipo_orden, numero_orden, consumo,
             (COUNT(*) OVER ())::int AS total
      FROM base
      ORDER BY fecha_orden DESC NULLS LAST, cod_corto
      LIMIT ${CH_PAGE_SIZE} OFFSET $12`;

    const [resumen, serie, dims, topIns, topProd, insProd, detalle] = await Promise.all([
      pgPool.query(sqlResumen,        args),
      pgPool.query(sqlSerie,          args),
      pgPool.query(sqlDims,           args),
      pgPool.query(sqlTopInsumos,     args),
      pgPool.query(sqlTopProductos,   args),
      pgPool.query(sqlInsumoProducto, args),
      pgPool.query(sqlDetalle,        [...args, offset]),
    ]);

    const porDim = d => dims.rows.filter(r => r.dim === d).map(r => ({ clave: r.clave, consumo: r.consumo }));

    res.json({
      resumen:         resumen.rows[0] || {},
      serie:           serie.rows,
      por_rubro:       porDim("rubro"),
      por_sub_rubro:   porDim("sub_rubro"),
      por_unidad:      porDim("unidad_negocio"),
      por_tipo_doc:    porDim("tipo_doc"),
      top_insumos:     topIns.rows,
      top_productos:   topProd.rows,
      insumo_producto: insProd.rows,
      detalle:         detalle.rows,
      total:           detalle.rows.length ? detalle.rows[0].total : 0,
      offset,
    });
  } catch (e) {
    console.error("PG consumo-historico error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Paginado del detalle: repite solo la consulta de la tabla, sin recalcular el tablero
app.post("/api/pg/consumo-historico/detalle", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const body   = req.body || {};
    const args   = chArgs(body);
    const offset = Math.max(0, parseInt(body.offset) || 0);
    const result = await pgPool.query(`${CH_BASE}
      SELECT fecha_orden, cod_corto, descripcion, rubro, sub_rubro,
             cod_corto_ppal, descripcion_ppal,
             unidad_negocio, tipo_doc, numero_documento,
             tipo_orden, numero_orden, consumo,
             (COUNT(*) OVER ())::int AS total
      FROM base
      ORDER BY fecha_orden DESC NULLS LAST, cod_corto
      LIMIT ${CH_PAGE_SIZE} OFFSET $12`, [...args, offset]);

    res.json({
      detalle: result.rows,
      total:   result.rows.length ? result.rows[0].total : 0,
      offset,
    });
  } catch (e) {
    console.error("PG consumo-historico/detalle error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── BOM (lista de piezas multiplanta) ──

// bd_bom_m_multiplanta tiene una fila por (planta, producto, componente).
// Las columnas con sufijo _ppal son del padre y las _comp del componente.
const BOM_TABLA = "bd_bom_m_multiplanta";

// Mismo criterio tolerante que en consumo histórico: el valor viene del propio
// listado, pero un espacio de más en el dato haría fallar la igualdad sin avisar.
const bomIgual = (col, param) => `upper(btrim(${col}::text)) = upper(btrim(${param}::text))`;
const bomEnLista = (col, param) =>
  `upper(btrim(${col}::text)) = ANY(SELECT upper(btrim(x)) FROM unnest(${param}::text[]) AS x)`;

// Valores de los filtros de corte
app.get("/api/pg/bom/filtros", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const col = c => pgPool.query(
      `SELECT DISTINCT btrim(${c}::text) AS v FROM ${BOM_TABLA} WHERE ${c} IS NOT NULL AND btrim(${c}::text) <> '' ORDER BY 1`
    );
    const [pl, me, su] = await Promise.all([col("planta"), col("mercado"), col("sucursal")]);
    const vals = r => r.rows.map(x => x.v);
    res.json({ plantas: vals(pl), mercados: vals(me), sucursales: vals(su) });
  } catch (e) {
    console.error("PG bom/filtros error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Autocompletado. modo=ppal busca productos (padre); modo=comp busca insumos.
app.get("/api/pg/bom/buscar", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const q    = String(req.query.q || "").trim();
    const modo = req.query.modo === "comp" ? "comp" : "ppal";
    if (q.length < 2) return res.json({ opciones: [] });

    const patron = `%${q}%`;
    // El otro extremo de la relación es lo que se cuenta: para un producto,
    // cuántos componentes lleva; para un insumo, en cuántos productos entra.
    const sql = modo === "ppal"
      ? `SELECT btrim(cod_corto_ppal::text)        AS cod,
                MAX(btrim(cod_largo_ppal::text))   AS cod_largo,
                MAX(btrim(descripcion_ppal::text)) AS descripcion,
                MAX(btrim(unidad_ppal::text))      AS unidad,
                NULL::text                         AS rubro,
                COUNT(DISTINCT btrim(cod_corto_comp::text))::int AS relacionados,
                COUNT(DISTINCT btrim(planta::text))::int         AS plantas
         FROM ${BOM_TABLA}
         WHERE cod_corto_ppal IS NOT NULL
           AND (cod_corto_ppal ILIKE $1 OR cod_largo_ppal ILIKE $1 OR descripcion_ppal ILIKE $1)
         GROUP BY 1
         ORDER BY 1
         LIMIT 40`
      : `SELECT btrim(cod_corto_comp::text)        AS cod,
                MAX(btrim(cod_largo_comp::text))   AS cod_largo,
                MAX(btrim(descripcion_comp::text)) AS descripcion,
                MAX(btrim(unidad_comp::text))      AS unidad,
                MAX(btrim(rubro_comp::text))       AS rubro,
                COUNT(DISTINCT btrim(cod_corto_ppal::text))::int AS relacionados,
                COUNT(DISTINCT btrim(planta::text))::int         AS plantas
         FROM ${BOM_TABLA}
         WHERE cod_corto_comp IS NOT NULL
           AND (cod_corto_comp ILIKE $1 OR cod_largo_comp ILIKE $1 OR descripcion_comp ILIKE $1)
         GROUP BY 1
         ORDER BY 1
         LIMIT 40`;

    const r = await pgPool.query(sql, [patron]);
    res.json({ opciones: r.rows, modo });
  } catch (e) {
    console.error("PG bom/buscar error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Despiece de un código. En modo ppal devuelve sus componentes; en modo comp,
// los productos que lo usan. El armado de la vista por planta se hace en el
// navegador: un BOM son decenas de filas, no hace falta paginar.
app.post("/api/pg/bom/despiece", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const { codigo, modo, plantas, mercados, sucursales } = req.body || {};
    if (!codigo || !String(codigo).trim())
      return res.status(400).json({ error: "Elegí un código." });

    const col = (req.body.modo === "comp") ? "cod_corto_comp" : "cod_corto_ppal";
    const arr = v => (Array.isArray(v) && v.length ? v : null);

    const sql = `
      SELECT btrim(planta::text)           AS planta,
             btrim(sucursal::text)         AS sucursal,
             btrim(mercado::text)          AS mercado,
             btrim(cod_corto_ppal::text)   AS cod_corto_ppal,
             btrim(cod_largo_ppal::text)   AS cod_largo_ppal,
             btrim(descripcion_ppal::text) AS descripcion_ppal,
             btrim(unidad_ppal::text)      AS unidad_ppal,
             btrim(cod_corto_comp::text)   AS cod_corto_comp,
             btrim(cod_largo_comp::text)   AS cod_largo_comp,
             btrim(descripcion_comp::text) AS descripcion_comp,
             btrim(rubro_comp::text)       AS rubro_comp,
             btrim(unidad_comp::text)      AS unidad_comp,
             btrim(unidad_comp_ppal::text) AS unidad_comp_ppal,
             cantidad
      FROM ${BOM_TABLA}
      WHERE ${bomIgual(col, "$1")}
        AND ($2::text[] IS NULL OR ${bomEnLista("planta",   "$2")})
        AND ($3::text[] IS NULL OR ${bomEnLista("mercado",  "$3")})
        AND ($4::text[] IS NULL OR ${bomEnLista("sucursal", "$4")})
      ORDER BY rubro_comp NULLS LAST, cod_corto_comp, cod_corto_ppal, planta`;

    const r = await pgPool.query(sql, [
      String(codigo).trim(), arr(plantas), arr(mercados), arr(sucursales),
    ]);
    res.json({ filas: r.rows, modo: (modo === "comp" ? "comp" : "ppal") });
  } catch (e) {
    console.error("PG bom/despiece error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Rubros que se muestran en el catálogo; el resto no se trae de la base.
const CAT_RUBROS = [
  "Adhesivos y Cintas", "Bandeja", "BIB Bolsa", "BIB Envase", "BIB Manijas",
  "BOTELLA Vidrio", "Bozales", "Cajas", "Cápsulas", "Esquineros", "Estuche",
  "ETIQUETA", "ETIQUETA CT", "ETIQUETA Cuello", "ETIQUETA FR",
  "ETIQUETA Medallas y Stickers", "ETIQUETA Rotulo", "FILM Termocontraible",
  "LATAS", "LATAS Film", "LATAS Funda", "LATAS Tapa", "Pallets", "Plancha",
  "Separador", "Stretch", "Tapa", "Tapón", "TETRA Cinta", "TETRA Envases",
  "TETRA Tapa",
];

// Compara ignorando espacios, mayúsculas y tildes. La lista de arriba mezcla
// escrituras ("Cápsulas" con tilde, "ETIQUETA Rotulo" sin ella) y en la base
// pueden estar al revés: con igualdad exacta el rubro desaparecería en
// silencio. translate() alcanza y no necesita la extensión unaccent.
const CAT_SIN_TILDES = (expr) =>
  `upper(translate(btrim(${expr}), 'áéíóúüñÁÉÍÓÚÜÑ', 'aeiouunAEIOUUN'))`;

// Maestro que alimenta el panel de archivos del catálogo. Una fila por
// cod_corto: la tabla puede traer repetidos y duplicarían el listado.
app.get("/api/pg/maestro-insumos", async (req, res) => {
  if (!pgPool) return res.status(503).json({ error: "PostgreSQL no disponible." });
  try {
    const r = await pgPool.query(`
      WITH stock AS (
        SELECT btrim(cod_corto::text)                AS cod_corto,
               SUM(COALESCE(existencias_fisicas, 0)) AS stock
        FROM bd_stock_x_sucursales
        WHERE cod_corto IS NOT NULL
        GROUP BY 1
      )
      SELECT DISTINCT ON (btrim(m.cod_corto::text))
             btrim(m.cod_corto::text)   AS cod_corto,
             btrim(m.cod_largo::text)   AS cod_largo,
             btrim(m.descripcion::text) AS descripcion,
             btrim(m.rubro::text)       AS rubro,
             COALESCE(s.stock, 0)       AS stock
      FROM bd_maestro_insumos m
      LEFT JOIN stock s ON s.cod_corto = btrim(m.cod_corto::text)
      WHERE m.cod_corto IS NOT NULL AND btrim(m.cod_corto::text) <> ''
        AND ${CAT_SIN_TILDES("m.rubro::text")} = ANY(
              SELECT ${CAT_SIN_TILDES("x")} FROM unnest($1::text[]) AS x)
      ORDER BY btrim(m.cod_corto::text)`, [CAT_RUBROS]);
    res.json({ insumos: r.rows, rubros: CAT_RUBROS });
  } catch (e) {
    console.error("PG maestro-insumos error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Catálogo de imágenes (Cloudflare R2) ──

// R2 habla el protocolo S3, así que alcanza con el cliente de S3 apuntado al
// endpoint de la cuenta. Las imágenes NO se sirven con URL pública: las
// proxea este servidor, así quedan detrás del login como el resto de la app.
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

const R2_BUCKET = process.env.R2_BUCKET || "imagenes-insumos";
let r2Client = null;
if (process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY) {
  r2Client = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId:     process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log(`R2 configurado (bucket "${R2_BUCKET}")`);
} else {
  console.log("R2 no configurado: faltan R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY");
}

const CAT_EXT = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif",  ".webp": "image/webp", ".bmp": "image/bmp",
  ".svg": "image/svg+xml", ".avif": "image/avif",
};
const catTipo = key => CAT_EXT[(String(key).match(/\.[^.]+$/) || [""])[0].toLowerCase()] || null;

// Listar el bucket entero cuesta una vuelta por cada 1000 objetos, así que se
// cachea un rato. El botón Actualizar de la pestaña fuerza el refresco.
let catCache = { ts: 0, items: [] };
const CAT_TTL_MS = 10 * 60 * 1000;

app.get("/api/r2/catalogo", async (req, res) => {
  if (!r2Client) return res.status(503).json({
    error: "R2 no configurado. Faltan las variables R2_ACCOUNT_ID, R2_ACCESS_KEY_ID y R2_SECRET_ACCESS_KEY.",
  });
  try {
    const refrescar = req.query.refresh === "1";
    if (!refrescar && catCache.items.length && Date.now() - catCache.ts < CAT_TTL_MS)
      return res.json({ archivos: catCache.items, bucket: R2_BUCKET, cacheado: true });

    const items = [];
    let token = undefined;
    do {
      const out = await r2Client.send(new ListObjectsV2Command({
        Bucket: R2_BUCKET, ContinuationToken: token, MaxKeys: 1000,
      }));
      (out.Contents || []).forEach(o => {
        if (!o.Key || o.Key.endsWith("/")) return;   // las "carpetas" no son archivos
        if (!catTipo(o.Key)) return;                 // solo imágenes
        items.push({ key: o.Key, tamano: o.Size, modificado: o.LastModified });
      });
      token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token && items.length < 20000);

    items.sort((a, b) => a.key.localeCompare(b.key, "es"));
    catCache = { ts: Date.now(), items };
    res.json({ archivos: items, bucket: R2_BUCKET, cacheado: false });
  } catch (e) {
    console.error("R2 catalogo error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Devuelve los bytes de una imagen. La clave viaja como query para no pelear
// con las barras de las "carpetas" del bucket.
app.get("/api/r2/imagen", async (req, res) => {
  if (!r2Client) return res.status(503).json({ error: "R2 no configurado." });
  try {
    const key = String(req.query.key || "");
    if (!key) return res.status(400).json({ error: "Falta la clave del archivo." });
    const tipo = catTipo(key);
    if (!tipo) return res.status(400).json({ error: "El archivo no es una imagen." });

    const out = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    res.setHeader("Content-Type", tipo);
    if (out.ContentLength) res.setHeader("Content-Length", String(out.ContentLength));
    // Privado: la imagen queda en el navegador del usuario, no en proxies
    res.setHeader("Cache-Control", "private, max-age=86400");
    out.Body.pipe(res);
  } catch (e) {
    const code = (e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) ? 404 : 500;
    if (code === 500) console.error("R2 imagen error:", e.message);
    res.status(code).json({ error: code === 404 ? "No se encontró la imagen." : e.message });
  }
});
