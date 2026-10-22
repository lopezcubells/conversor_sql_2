# Reporte de Indicadores — Insumos

Aplicación web interna para el seguimiento del abastecimiento de insumos de
FECOVITA. Presenta indicadores de cobertura, rotación, recepciones, inmovilizados
y nivel de servicio a partir de vistas y funciones de PostgreSQL.

## Pestañas

| Pestaña | Para qué sirve |
|---|---|
| **Dashboard** | Pantalla de inicio y administración de usuarios. Solo para administradores. |
| **Avance** | Avance de abastecimiento por rubro y por artículo, contra el PMP. |
| **Rotación** | Rotación en días por rubro, con objetivo, y stock vs. consumo mensual. |
| **Cobertura y faltantes** | Tablero diario de cobertura por insumo, con quiebres y programado. |
| **Inmovilizados** | Evolución del costo inmovilizado y ranking de artículos obsoletos. |
| **Recepciones** | Detalle de recepciones del año, con totales y gráficos por mes y por proveedor. |
| **Nivel de servicio** | Indicador de NS por planta, faltantes por causa y reporte exportable a PDF. |
| **Necesidad Final** | Necesidad de compra por insumo, con criticidad ABC en semáforo. |
| **Consumo Histórico** | Tablero de consumos por insumo y producto, con evolución anual/mensual/diaria. |
| **BOM** | Lista de piezas por producto, comparada entre plantas, y vista inversa por insumo. |
| **Catálogo** | Imágenes de insumos alojadas en Cloudflare R2, con listado y visor. |

Cada pestaña tiene su propio bloque de parámetros; lo que se ingresa queda
guardado en el navegador para la próxima visita.

## Acceso

La app está protegida por usuario y contraseña, con sesiones de 8 horas.

Los usuarios se administran desde el **Dashboard**, visible solo para usuarios con
rol de administrador: permite crear usuarios, cambiar contraseñas, eliminar y
**elegir a qué pestañas accede cada uno**. Las contraseñas se guardan hasheadas
con bcrypt en la tabla `app_users`.

Un usuario con pestañas restringidas no ve su nombre en la barra ni su contenido,
y el servidor tampoco le entrega los datos de esas secciones. Los administradores
ven todas las pestañas; el **Dashboard es exclusivo de ellos**.

El primer usuario se crea solo al arrancar, cuando la tabla está vacía, tomando
`ADMIN_USER` y `ADMIN_PASS`. Si no están definidas, crea `admin` / `admin`.

## Requisitos

- Node.js >= 18
- PostgreSQL con las vistas y funciones que consume la app (ver más abajo)

## Dos accesos: Railway y local

La misma app puede correr en Railway (por internet, con su dominio) y en una PC
(en `http://localhost:3000`) **al mismo tiempo**. Si las dos apuntan a la misma
base, comparten todo: usuarios, permisos y las tablas auxiliares de Recepciones.
La sesión sí es aparte: hay que iniciar sesión en cada acceso.

Si Railway tiene problemas con el servidor de la app, el acceso local sigue
funcionando mientras la base responda. Si el problema es la base, los dos
accesos se caen: para eso hace falta un respaldo de la base, que es otro tema.

### Correr en local (Windows)

1. Instalar **Node.js LTS** desde <https://nodejs.org> (una sola vez).
2. Copiar `.env.example` como `.env`, en la misma carpeta, y completar:
   - `DATABASE_URL`: la URL **pública** de la base. En Railway: servicio
     Postgres → Variables → `DATABASE_PUBLIC_URL` (el host termina en
     `.proxy.rlwy.net`). La interna (`postgres.railway.internal`) solo anda
     dentro de Railway.
   - `SESSION_SECRET`: cualquier texto largo.
   - Las variables `R2_*`, si se quieren ver las imágenes del Catálogo.
3. Doble clic en **`iniciar-local.bat`**. La primera vez instala las
   dependencias; después arranca la app y abre el navegador. Para detenerla,
   cerrar esa ventana.

El `.env` tiene contraseñas: **nunca se sube al repositorio** (está en
`.gitignore`) y no conviene compartirlo.

Desde otra PC de la misma red se puede entrar con `http://IP-DE-ESTA-PC:3000`,
si el firewall de Windows lo permite.

Sin el `.bat` (o en otro sistema operativo):

```bash
npm install
npm start          # lee el .env de la carpeta
```

## Variables de entorno

En Railway se cargan desde el panel. En local, desde el archivo `.env` (ver
`.env.example`): la app lo lee al arrancar, sin pisar las que ya estén definidas
en el entorno.

| Variable | Default | Descripción |
|---|---|---|
| `DATABASE_URL` | — | Conexión a PostgreSQL. Sin ella la app levanta, pero los endpoints de datos responden 503. |
| `SESSION_SECRET` | aleatorio | Firma las cookies de sesión. **Conviene fijarla**: si no, cada redeploy cierra todas las sesiones. |
| `ADMIN_USER` | `admin` | Usuario inicial. Solo se usa si `app_users` está vacía. |
| `ADMIN_PASS` | `admin` | Contraseña inicial. Solo se usa si `app_users` está vacía. |
| `PORT` | `3000` | Puerto del servidor. |
| `DB_SSL` | `true` | SSL hacia la base. `false` solo para un PostgreSQL instalado en la PC, que no lo usa. |
| `R2_ACCOUNT_ID` | — | Cuenta de Cloudflare R2. Sin ella, la pestaña Catálogo avisa que falta configurarla. |
| `R2_ACCESS_KEY_ID` | — | Access Key del token de R2. |
| `R2_SECRET_ACCESS_KEY` | — | Secret Access Key del token de R2. |
| `R2_BUCKET` | `imagenes-insumos` | Bucket de donde salen las imágenes. |

## Objetos de PostgreSQL que consume

La app no calcula lógica de negocio: consulta y presenta.

**Funciones**: `avance_x_rubro`, `avance_x_articulo`, `cobertura_semanal`,
`indicador_cobertura`, `necesidad_final`

**Vistas**: `view_recepciones_2026`, `view_avance_inmovilizados`, `rotacion_2026`,
`view_stock_x_rubro`

**Tablas de datos**: `consumos_im_if_consolidado`, `bd_articulos_x_rubro`,
`bd_maestro_insumos`, `bd_bom_m_multiplanta`

**Tablas propias**: `app_users` (usuarios; se crea sola al arrancar) y
`registro_nivel_servicio` (histórico que se graba al generar el PDF de nivel de
servicio, si se tilda "Cargar en BD").

## Deploy en Railway

El repo trae `railway.toml` configurado (Nixpacks, `npm start`, healthcheck en
`/health`). Alcanza con conectar el repo de GitHub y definir las variables de
entorno de arriba.

## Estructura

```
server.js           Express: login, ABM de usuarios y endpoints /api/pg/*. Todo el SQL.
public/index.html   La app completa: HTML, CSS y JS inline. Sin build ni framework.
public/login.html   Pantalla de login.
```
