# Importador Excel → SQL

Aplicación web para importar archivos Excel a una base de datos SQLite, con interfaz para visualizar y buscar los datos.

## Funcionalidades

- Importar **BD_ARTICULOS_x_RUBRO** → tabla `articulos` (lee hoja `BD ART x RUBRO`)
- Importar **BD_Stock_x_Sucursales** → tabla `stock_sucursales` (lee hoja `Sheet1`)
- Modo **Reemplazar** o **Agregar** registros
- Búsqueda y paginación en ambas tablas
- Exportar a CSV
- Log de importaciones

## Estructura de tablas

### `articulos`
| Columna | Tipo |
|---------|------|
| id | INTEGER PK |
| nro_corto | INTEGER |
| segundo_nro | TEXT |
| descripcion | TEXT |
| unidad_medida | TEXT |
| rubro | TEXT |
| importado_en | DATETIME |

### `stock_sucursales`
| Columna | Tipo |
|---------|------|
| id | INTEGER PK |
| nro_corto | INTEGER |
| segundo_nro | TEXT |
| descripcion | TEXT |
| unidad_negocio | TEXT |
| existencias | REAL |
| ubicacion | TEXT |
| nro_lote_serie | TEXT |
| importado_en | DATETIME |

## Correr localmente

```bash
npm install
npm start
# Abrir http://localhost:3000
```

## Deploy en Railway

1. Crear repositorio en GitHub con estos archivos
2. En [railway.app](https://railway.app): New Project → Deploy from GitHub repo
3. Railway detecta Node.js automáticamente
4. En el panel de Railway, ir a **Settings → Volumes** y montar `/data` para persistencia de la DB
5. Opcionalmente, agregar variable de entorno: `DB_PATH=/data/database.db`

## Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `3000` | Puerto del servidor |
| `DB_PATH` | `./database.db` | Ruta de la base de datos SQLite |
