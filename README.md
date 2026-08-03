# Reporte de Indicadores — Insumos

Aplicación web interna para el seguimiento del abastecimiento de insumos de
FECOVITA. Presenta indicadores de cobertura, rotación, recepciones, inmovilizados
y nivel de servicio a partir de vistas y funciones de PostgreSQL.

## Pestañas

| Pestaña | Para qué sirve |
|---|---|
| **Dashboard** | Pantalla de inicio y administración de usuarios. |
| **Avance** | Avance de abastecimiento por rubro y por artículo, contra el PMP. |
| **Rotación** | Rotación en días por rubro, con objetivo, y stock vs. consumo mensual. |
| **Cobertura y faltantes** | Tablero diario de cobertura por insumo, con quiebres y programado. |
| **Inmovilizados** | Evolución del costo inmovilizado y ranking de artículos obsoletos. |
| **Recepciones** | Detalle de recepciones del año, con totales y gráficos por mes y por proveedor. |
| **Nivel de servicio** | Indicador de NS por planta, faltantes por causa y reporte exportable a PDF. |
| **Necesidad Final** | Necesidad de compra por insumo, con criticidad ABC en semáforo. |

Cada pestaña tiene su propio bloque de parámetros; lo que se ingresa queda
guardado en el navegador para la próxima visita.

## Acceso

La app está protegida por usuario y contraseña, con sesiones de 8 horas.

Los usuarios se administran desde el **Dashboard**, visible solo para usuarios con
rol de administrador: permite crear usuarios, cambiar contraseñas y eliminar. Las
contraseñas se guardan hasheadas con bcrypt en la tabla `app_users`.

El primer usuario se crea solo al arrancar, cuando la tabla está vacía, tomando
`ADMIN_USER` y `ADMIN_PASS`. Si no están definidas, crea `admin` / `admin`.

## Requisitos

- Node.js >= 18
- PostgreSQL con las vistas y funciones que consume la app (ver más abajo)

## Correr localmente

```bash
npm install
DATABASE_URL="postgres://..." npm start
# Abrir http://localhost:3000
```

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `DATABASE_URL` | — | Conexión a PostgreSQL. Sin ella la app levanta, pero los endpoints de datos responden 503. |
| `SESSION_SECRET` | aleatorio | Firma las cookies de sesión. **Conviene fijarla**: si no, cada redeploy cierra todas las sesiones. |
| `ADMIN_USER` | `admin` | Usuario inicial. Solo se usa si `app_users` está vacía. |
| `ADMIN_PASS` | `admin` | Contraseña inicial. Solo se usa si `app_users` está vacía. |
| `PORT` | `3000` | Puerto del servidor. |

## Objetos de PostgreSQL que consume

La app no calcula lógica de negocio: consulta y presenta.

**Funciones**: `avance_x_rubro`, `avance_x_articulo`, `cobertura_semanal`,
`indicador_cobertura`, `necesidad_final`

**Vistas**: `view_recepciones_2026`, `view_avance_inmovilizados`, `rotacion_2026`,
`view_stock_x_rubro`

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
