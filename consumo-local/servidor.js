// ── Consumo Histórico, versión local ──
// Servidor mínimo que muestra SOLO la pestaña Consumo Histórico, conectado a la
// base que diga el .env de esta carpeta (pensado para un PostgreSQL local).
//
// No duplica nada de la app:
//  - El SQL y las rutas salen de ../consumo-historico.js (el mismo módulo que
//    usa server.js).
//  - La página se arma en cada pedido a partir de ../public/index.html,
//    tomando el bloque de la pestaña (CSS, HTML y JS) y los pocos ayudantes que
//    usa. Cualquier cambio en la pestaña de la app aparece acá solo.
//
// Sin login: escucha únicamente en 127.0.0.1, así que solo se puede abrir desde
// esta misma PC.

const express = require("express");
const path    = require("path");
const fs      = require("fs");
const { Pool } = require("pg");

// ── Configuración (.env de esta carpeta; no pisa lo que ya esté definido) ──
(function cargarEnv(archivo) {
  let texto;
  try { texto = fs.readFileSync(archivo, "utf8"); } catch { return; }
  texto.replace(/^﻿/, "").split(/\r?\n/).forEach(linea => {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) return;
    let valor = m[2];
    const comillas = valor.match(/^(["'])(.*)\1$/);
    if (comillas) valor = comillas[2];
    process.env[m[1]] = valor;
  });
})(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 3001;
// En local lo normal es un PostgreSQL sin SSL: acá el valor por defecto es false
const DB_SSL = /^(true|1|si|sí|on|require)$/i.test(process.env.DB_SSL || "");

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: DB_SSL ? { rejectUnauthorized: false } : false });
  pool.connect()
    .then(c => { console.log("PostgreSQL conectado"); c.release(); })
    .catch(e => console.error("No se pudo conectar a PostgreSQL:", e.message));
} else {
  console.log("Falta DATABASE_URL en consumo-local/.env");
}

const app = express();
app.use(express.json({ limit: "5mb" }));
require("../consumo-historico").registrar(app, () => pool);

// ── La página: se arma a partir del index.html de la app ──
const INDEX = path.join(__dirname, "..", "public", "index.html");

function tramo(texto, desde, hasta, que) {
  const a = texto.indexOf(desde);
  const b = a < 0 ? -1 : texto.indexOf(hasta, a);
  if (a < 0 || b < 0) throw new Error(`No encontré ${que} en public/index.html (¿cambió el marcador "${desde.trim()}"?)`);
  return texto.slice(a, b);
}

// Copia una definición del index.html: function NOMBRE(...) { ... } o
// const NOMBRE = ...; buscando dónde cierra por llaves balanceadas
function definicion(texto, nombre) {
  const re = new RegExp(`(?:function\\s+${nombre}\\s*\\(|const\\s+${nombre}\\s*=)`);
  const m = re.exec(texto);
  if (!m) throw new Error(`No encontré ${nombre} en public/index.html`);
  let i = m.index, nivel = 0, empezo = false;
  // const de una sola expresión (no un objeto { … }): termina en el primer ";"
  // de fin de línea. No se cuentan llaves porque puede tener expresiones
  // regulares con llaves adentro (por ejemplo \p{Diacritic}).
  const resto = texto.slice(m.index + m[0].length);
  if (m[0].startsWith("const") && !/^\s*\{/.test(resto)) {
    const fin = /;\r?\n/.exec(resto);
    if (!fin) throw new Error(`No pude delimitar ${nombre}`);
    return texto.slice(i, m.index + m[0].length + fin.index + 1);
  }
  for (let j = i; j < texto.length; j++) {
    const ch = texto[j];
    if (ch === "{") { nivel++; empezo = true; }
    else if (ch === "}") { nivel--; if (empezo && nivel === 0) {
      const fin = texto[j + 1] === ";" ? j + 2 : j + 1;
      return texto.slice(i, fin);
    } }
    else if (ch === ";" && nivel === 0 && !empezo) return texto.slice(i, j + 1);
    // flecha de una sola expresión sin llaves: termina en el primer ";" del nivel 0
    else if (ch === ";" && nivel === 0 && empezo) return texto.slice(i, j + 1);
  }
  throw new Error(`No pude delimitar ${nombre}`);
}

function armarPagina() {
  const html = fs.readFileSync(INDEX, "utf8");
  const css = tramo(html, "    /* ── Consumo Histórico: tema claro", "    /* ── Tema claro: solo pestaña Recepciones ── */", "el CSS de la pestaña");
  const pane = tramo(html, '<div class="pane" id="tab-consumo-historico">', "<!-- ═══ BOM ═══ -->", "el HTML de la pestaña");
  const js = tramo(html, "  // ── Consumo histórico ──", "  // ── BOM (lista de piezas multiplanta) ──", "el JavaScript de la pestaña");
  const ayudantes = ["MES_NOMBRES", "fmtNum", "nsEsc", "recNormRubro", "renderPagination"]
    .map(n => definicion(html, n)).join("\n\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Consumo Histórico (local)</title>
<style>
    :root {
      --mono: 'JetBrains Mono', 'Fira Code', monospace;
      --radius: 10px;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: #f6f4fb; }
    .pane { display: block; padding: 20px 24px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; margin-bottom: 20px; }
    .btn { border: none; border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
    .btn:disabled { opacity: .5; cursor: default; }
    .btn-outline { background: transparent; border: 1px solid var(--border); color: var(--text); }
    .pagination { display: flex; gap: 8px; align-items: center; margin-top: 14px; }
    .pagination span { color: var(--muted); font-size: 12px; }
    .empty { text-align: center; padding: 40px 20px; color: var(--muted); }
    .empty .big { font-size: 40px; margin-bottom: 8px; }
    .ch-local-aviso { font: 12px system-ui, sans-serif; color: #6b6584; padding: 10px 24px 0; }
${css}
</style>
</head>
<body>
<div class="ch-local-aviso">Consumo Histórico · versión local · base: ${escaparHtml(descripcionBase())}</div>
${pane}
<script>
  const API = "";
${ayudantes}

${js}
  initConsumoHistorico();
</script>
</body>
</html>`;
}

function escaparHtml(t) {
  return String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
// Muestra a qué base se conecta, sin usuario ni contraseña
function descripcionBase() {
  try {
    const u = new URL(process.env.DATABASE_URL);
    return `${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch { return "sin configurar"; }
}

app.get("/", (req, res) => {
  try { res.type("html").send(armarPagina()); }
  catch (e) { res.status(500).type("text").send("No se pudo armar la página: " + e.message); }
});

app.listen(PORT, "127.0.0.1", () => console.log(`Consumo Histórico local en http://localhost:${PORT}`));
