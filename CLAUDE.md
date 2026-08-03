# Reporte de Indicadores — Insumos

App web interna de FECOVITA para seguimiento de abastecimiento de insumos.
Node + Express sirviendo un frontend de una sola página, con **PostgreSQL en
Railway** como única fuente de datos.

## Arquitectura

Tres archivos hacen toda la app:

| Archivo | Qué es |
|---|---|
| `server.js` (~500 líneas) | Express: sesión/login, ABM de usuarios y endpoints `/api/pg/*`. **Todo el SQL vive acá**, embebido como strings. |
| `public/index.html` (~4.000 líneas) | La app entera: HTML, CSS y JS **inline** en un solo archivo. Sin build, sin framework, sin módulos. |
| `public/login.html` | Pantalla de login, standalone. |

Librerías del frontend por CDN (Chart.js + datalabels, jsPDF + autotable, xlsx).
No hay bundler ni `npm run build`: se edita el HTML y listo.

### El punto clave del frontend

`public/index.html` es un archivo enorme con 8 pestañas conviviendo. Lo que hace
que eso sea manejable es una convención estricta: **cada pestaña prefija todos
sus identificadores** (ids de HTML, funciones y variables de JS).

| Pestaña | Prefijo | Init |
|---|---|---|
| Avance | `av*` | `initAvance()` |
| Rotación | `rot*` | `initRotacion()` |
| Cobertura y faltantes | `cob*` | `initCobertura()` |
| Inmovilizados | `inm*` | `initInmovilizados()` |
| Recepciones | `rec*` | `initRecepciones()` |
| Nivel de servicio | `ns*` | `initNivelServicio()` |
| Necesidad Final | `nf*` | `initNecesidadFinal()` |

**Respetar el prefijo al agregar código.** Es lo único que evita colisiones de
nombres en un archivo de este tamaño. El router de pestañas está en el listener
de `.tab` y llama al `init` correspondiente.

Helpers compartidos (reutilizarlos, no duplicarlos): `fmtNum`, `renderPagination`,
`toast`, `nsEsc`, `recNormRubro`.

## Base de datos

Todo sale de funciones y vistas de PostgreSQL; la app **no calcula lógica de
negocio**, solo la consulta y la presenta.

- **Funciones**: `avance_x_rubro`, `avance_x_articulo`, `cobertura_semanal`,
  `indicador_cobertura`, `necesidad_final`
- **Vistas**: `view_recepciones_2026`, `view_avance_inmovilizados`, `rotacion_2026`,
  `view_stock_x_rubro`
- **Tablas propias de la app**: `app_users` (login; se crea sola al arrancar),
  `registro_nivel_servicio` (histórico que se inserta al generar el PDF)

Variables de entorno: `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_USER`, `ADMIN_PASS`, `PORT`.
`ADMIN_USER`/`ADMIN_PASS` solo se usan la primera vez, cuando `app_users` está vacía.

## Cómo verificar cambios (importante)

**No hay Node instalado en el entorno de desarrollo**, así que la app no se puede
levantar acá. Pero sí hay Python, y eso alcanza para probar el frontend de verdad:

1. Copiar `public/index.html` a un archivo temporal en la raíz del proyecto,
   inyectando un `<script>` que pise `window.fetch` para simular las respuestas
   del backend (hay que mockear al menos `/api/me`, si no la página redirige al login).
   El marcador para insertarlo es la línea `<script>\n  const API = "";`.
2. `python -m http.server 8765 --bind 127.0.0.1`
3. Abrir con `preview_start` y verificar con `javascript_tool` **midiendo**
   (posiciones, estilos computados, cantidad de filas), que es más confiable que
   mirar capturas.
4. **Borrar el archivo temporal y matar el servidor** antes de commitear.

El panel del navegador solo renderiza en vivo desde dentro del proyecto o URLs de
localhost ya aprobadas; los `file://` de fuera del proyecto quedan como snapshot
estático y no sirven para probar.

## Convenciones y trampas conocidas

- **Rubros**: los listados están hardcodeados en varios lugares y siempre **sin
  tilde** (`ETIQUETA Rotulo`, `FILM Termocontraible`). Al comparar rubros contra
  datos de la base, usar `recNormRubro` (normaliza tildes y mayúsculas): si la
  base los tuviera con tilde, una comparación exacta haría desaparecer filas en
  silencio.
- **Filtros del lado del cliente**: el patrón general es traer los datos una vez
  y filtrar/ordenar/paginar en el navegador, para que los filtros respondan al
  instante. Los parámetros de las funciones SQL sí van al servidor.
- **Parámetros por pestaña**: se guardan en `localStorage` con una clave propia
  (`cobertura-params`, `nivel-servicio-params`, `necesidad-final-params`) y se
  restauran al entrar.
- **`position: sticky` en tablas**: se ancla al ancestro scrolleable más cercano.
  Como `.table-wrap` tiene `overflow-x: auto` (y por spec eso hace que el eje Y
  también sea `auto`), el contenedor necesita `max-height` propio o el encabezado
  no se fija a nada. Además hay que usar `border-collapse: separate`, porque con
  `collapse` los bordes no acompañan a las celdas fijas.
- **Commits desde PowerShell**: los mensajes con `:` rompen los here-strings.
  Usar `git commit -F archivo`.

## Flujo de trabajo

El usuario espera **commit y push a `main` después de cada tarea terminada**.
Mensajes de commit en inglés; la UI, los comentarios del código y la conversación,
en español (rioplatense).
