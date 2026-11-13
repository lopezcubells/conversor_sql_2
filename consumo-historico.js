// ── Consumo histórico: consultas y endpoints ──
// Módulo compartido: lo usan la app completa (server.js) y el servidor local de
// solo esta pestaña (consumo-local/servidor.js). Así el SQL vive en un solo
// lugar. registrar(app, obtenerPool) agrega las rutas /api/pg/consumo-historico/*.
// obtenerPool es una función porque el pool puede no existir (sin DATABASE_URL).

let pool = () => null;

// Matriz de consumos (versión renovada del tablero de Power BI). Todo sale de
// consumos_im_if_consolidado, enriquecido con:
//  - bd_articulos_x_rubro: descripción y rubro del insumo (por cod_corto) y
//    descripción del producto (por cod_corto_ppal)
//  - bd_maestro_insumos: sub-rubro del insumo (por cod_corto)
//  - bd_productos: familia y mercado del producto (por cod_corto_ppal)
// Las tablas de referencia pueden repetir códigos: se deduplican ANTES de unir
// (DISTINCT ON), si no multiplicarían las filas e inflarían los consumos.
const CH_BASE = `
  WITH art AS (
    SELECT DISTINCT ON (btrim(cod_corto::text))
           btrim(cod_corto::text) AS k,
           NULLIF(btrim(descripcion::text), '') AS descripcion,
           NULLIF(btrim(rubro::text), '')       AS rubro
    FROM bd_articulos_x_rubro
    ORDER BY btrim(cod_corto::text), descripcion
  ),
  mae AS (
    SELECT DISTINCT ON (btrim(cod_corto::text))
           btrim(cod_corto::text) AS k,
           NULLIF(btrim(sub_rubro::text), '') AS sub_rubro
    FROM bd_maestro_insumos
    ORDER BY btrim(cod_corto::text), sub_rubro
  ),
  pro AS (
    SELECT DISTINCT ON (btrim(cod_corto::text))
           btrim(cod_corto::text) AS k,
           NULLIF(btrim(familia::text), '') AS familia,
           NULLIF(btrim(mercado::text), '') AS mercado
    FROM bd_productos
    ORDER BY btrim(cod_corto::text), familia
  ),
  base AS (
    SELECT c.fecha_orden,
           c.consumo,
           NULLIF(btrim(c.cod_corto::text), '')      AS cod,
           NULLIF(btrim(c.cod_corto_ppal::text), '') AS sku,
           NULLIF(btrim(c.unidad_negocio::text), '') AS unidad,
           NULLIF(btrim(c.tipo_doc::text), '')       AS tipo_doc,
           ai.descripcion AS desc_ins,
           ai.rubro       AS rubro,
           m.sub_rubro    AS sub_rubro,
           ap.descripcion AS desc_prod,
           p.familia      AS familia,
           p.mercado      AS mercado
    FROM consumos_im_if_consolidado c
    LEFT JOIN art ai ON ai.k = btrim(c.cod_corto::text)
    LEFT JOIN mae m  ON m.k  = btrim(c.cod_corto::text)
    LEFT JOIN art ap ON ap.k = btrim(c.cod_corto_ppal::text)
    LEFT JOIN pro p  ON p.k  = btrim(c.cod_corto_ppal::text)
  )`;

// Valor que el navegador manda para "(En blanco)" en los filtros de lista
const CH_VACIO = "__vacio__";
// Cómo se agrupan las columnas de la matriz. Entra al SQL como texto de
// to_char, así que sale de esta tabla y nunca de lo que mandó el navegador.
// Semana: ISO 8601 (lunes a domingo; la semana 1 es la que tiene el primer
// jueves del año). IYYY es el año ISO, que en los primeros o últimos días de
// enero/diciembre puede no coincidir con el año calendario.
const CH_GRANOS = { anio: "YYYY", mes: "YYYY-MM", semana: "IYYY-IW", dia: "YYYY-MM-DD" };
// Tope de filas agrupadas: más que esto no se puede dibujar en el navegador
const CH_MAX_FILAS = 400000;

// Las consultas de esta pestaña ordenan y agrupan cientos de miles de filas.
// Con la memoria por defecto de PostgreSQL (work_mem = 4 MB) esos ordenamientos
// se pasaban a disco (medido con EXPLAIN ANALYZE). SET LOCAL sube el límite
// solo dentro de esta transacción: no cambia la configuración de la base ni
// afecta otras consultas.
async function chConsulta(consulta, params) {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL work_mem = '32MB'");
    const r = typeof consulta === "string" ? await client.query(consulta, params) : await client.query(consulta);
    await client.query("COMMIT");
    return r;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Arma las condiciones a partir de los filtros, siempre con parámetros. Cada
// condición lleva su clave, así los filtros en cascada pueden armar la lista
// de opciones de un filtro con todas las demás condiciones menos la suya.
const CH_LISTAS = ["unidad", "tipo_doc", "mercado", "familia", "rubro", "sub_rubro"];

function chPartes(f) {
  f = f || {};
  const partes = [], params = [];
  const p = v => { params.push(v); return "$" + params.length; };
  const fecha = /^\d{4}-\d{2}-\d{2}$/;
  if (fecha.test(f.desde || "")) partes.push({ clave: "desde", sql: `fecha_orden >= ${p(f.desde)}::date` });
  if (fecha.test(f.hasta || "")) partes.push({ clave: "hasta", sql: `fecha_orden < ${p(f.hasta)}::date + 1` });
  const enteros = a => Array.isArray(a) ? a.map(Number).filter(Number.isInteger) : [];
  const anios = enteros(f.anios), meses = enteros(f.meses);
  if (anios.length) partes.push({ clave: "anios", sql: `EXTRACT(YEAR FROM fecha_orden)::int = ANY(${p(anios)}::int[])` });
  if (meses.length) partes.push({ clave: "meses", sql: `EXTRACT(MONTH FROM fecha_orden)::int = ANY(${p(meses)}::int[])` });

  // Listas: si no vienen, no se filtra. Si vienen vacías, no pasa nada.
  // El nombre de la columna sale de CH_LISTAS, nunca de lo que mandó el navegador.
  for (const col of CH_LISTAS) {
    const v = f.listas && f.listas[col];
    if (!Array.isArray(v)) continue;
    const reales = v.filter(x => typeof x === "string" && x !== CH_VACIO);
    const conds = [];
    if (reales.length) conds.push(`${col} = ANY(${p(reales)}::text[])`);
    if (v.includes(CH_VACIO)) conds.push(`${col} IS NULL`);
    partes.push({ clave: col, sql: conds.length ? `(${conds.join(" OR ")})` : "FALSE" });
  }

  // Textos: "contiene", sin distinguir mayúsculas. Los comodines que escriba
  // el usuario se toman literales.
  const textos = { desc_prod: "desc_prod", sku: "sku", cod: "cod", desc_ins: "desc_ins", desc_ins2: "desc_ins" };
  for (const [clave, col] of Object.entries(textos)) {
    const v = f.textos && typeof f.textos[clave] === "string" ? f.textos[clave].trim() : "";
    if (!v) continue;
    partes.push({ clave, sql: `${col} ILIKE ${p("%" + v.replace(/[\\%_]/g, m => "\\" + m) + "%")}` });
  }
  return { partes, params };
}

function chWhere(f) {
  const { partes, params } = chPartes(f);
  return { where: partes.length ? "AND " + partes.map(x => x.sql).join(" AND ") : "", params };
}


function registrar(app, obtenerPool) {
  pool = obtenerPool;
  // Valores disponibles para los filtros. En cascada: la lista de cada filtro
  // se arma con todos los demás filtros aplicados menos el propio (así elegir un
  // rubro achica los sub-rubros, pero el rubro sigue mostrando sus opciones).
  // Todo en una sola pasada sobre la base, con un FILTER por lista. Los años y
  // el rango de fechas son siempre los de toda la tabla.
  app.post("/api/pg/consumo-historico/filtros", async (req, res) => {
    if (!pool()) return res.status(503).json({ error: "PostgreSQL no disponible." });
    try {
      const { partes, params } = chPartes((req.body || {}).filtros);
      const sinEl = clave => {
        const resto = partes.filter(x => x.clave !== clave).map(x => x.sql);
        return resto.length ? resto.join(" AND ") : "TRUE";
      };
      const r = await chConsulta(`${CH_BASE}
        SELECT array_agg(DISTINCT EXTRACT(YEAR FROM fecha_orden)::int) AS anios,
               MIN(fecha_orden)::date AS desde,
               MAX(fecha_orden)::date AS hasta,
               ${CH_LISTAS.map(c => `array_agg(DISTINCT ${c}) FILTER (WHERE ${sinEl(c)}) AS ${c}`).join(",\n             ")}
        FROM base
        WHERE fecha_orden IS NOT NULL`, params);
      const f = r.rows[0] || {};
      const lista = a => (a || []).map(v => v === null ? CH_VACIO : v);
      const listas = {};
      CH_LISTAS.forEach(c => { listas[c] = lista(f[c]); });
      res.json({
        anios: (f.anios || []).filter(v => v !== null).sort((a, b) => a - b),
        desde: f.desde, hasta: f.hasta, listas, vacio: CH_VACIO,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // La matriz: consumo sumado por rubro, insumo, producto y período. El navegador
  // arma el árbol (rubro > insumo > producto) y los subtotales, así abrir y cerrar
  // filas no vuelve a consultar. Las filas van como arrays para achicar la respuesta.
  app.post("/api/pg/consumo-historico/datos", async (req, res) => {
    if (!pool()) return res.status(503).json({ error: "PostgreSQL no disponible." });
    try {
      const body  = req.body || {};
      const fmt   = CH_GRANOS[body.grano] || CH_GRANOS.anio;
      const { where, params } = chWhere(body.filtros);
      const r = await chConsulta({
        text: `${CH_BASE}
          SELECT rubro, cod, desc_ins, sku, desc_prod,
                 to_char(fecha_orden, '${fmt}') AS periodo,
                 SUM(consumo)::float8 AS consumo
          FROM base
          WHERE fecha_orden IS NOT NULL ${where}
          GROUP BY 1, 2, 3, 4, 5, 6
          LIMIT ${CH_MAX_FILAS + 1}`,
        values: params,
        rowMode: "array",
      });
      if (r.rows.length > CH_MAX_FILAS)
        return res.status(413).json({ error: "Son demasiados datos para mostrar juntos. Acotá las fechas o los filtros, o usá columnas por Año o Mes." });
      res.json({ filas: r.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { registrar };
