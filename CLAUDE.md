# COCICP Gastos — Handoff para Claude Code

## Estado actual del proyecto (01/04/2026)

### Lo que ya está hecho en Cloudflare
- ✅ **D1** `cocicp-gastos` — ID: `82b3f166-7042-48de-b8fb-b0350423c4be`
  - 5 tablas: `gastos`, `proveedores`, `categorias` + índices
  - 20 categorías insertadas
  - 21 proveedores frecuentes insertados
  - **119 registros históricos cargados** (dic 2025 → abr 2026) — total $317.255.091 COP
- ✅ **R2** `cocicp-soportes` — para PDFs/imágenes de facturas
- ⏳ **Worker** `cocicp-gastos` — código listo, pendiente `wrangler deploy`
- ⏳ **ANTHROPIC_API_KEY** — pendiente `wrangler secret put ANTHROPIC_API_KEY`
- ⏳ **Frontend** Pages — `index.html` listo, pendiente deploy

---

## Estructura del proyecto

```
cocicp-gastos/
├── worker.js              # Worker principal — orquesta 3 agentes en Promise.all()
├── agent1-fiscal.js       # Agente 1: extrae montos, fechas, número documento
├── agent2-provider.js     # Agente 2: identifica NIT, razón social, valida D1
├── agent3-classification.js # Agente 3: categoría, concepto, deducibilidad
├── schema.sql             # Schema D1 completo con datos iniciales
├── index.html             # Frontend SPA (dark theme, DM Mono + Fraunces)
├── wrangler.toml          # Config Cloudflare (database_id ya actualizado)
├── package.json           # Scripts npm
└── CLAUDE.md              # Este archivo
```

---

## Arquitectura — 3 agentes en paralelo

```
📄 Documento (imagen/PDF)
        │
        ▼
   POST /api/upload
        │
        ├──► Agente 1 (claude-sonnet-4-5) — Fiscal
        │    Extrae: total, IVA, INC, fecha, número doc
        │
        ├──► Agente 2 (claude-sonnet-4-5) — Proveedor  
        │    Extrae: NIT, razón social → valida contra D1
        │    Tiene catálogo en memoria (21 NITs frecuentes)
        │
        └──► Agente 3 (claude-sonnet-4-5) — Clasificación
             Asigna: categoría, concepto 80 chars, deducibilidad
                     │
                     ▼
              merge() → preview
                     │
              POST /api/confirm → INSERT D1
```

---

## Endpoints del Worker

| Método | Ruta | Descripción |
|--------|------|-------------|
| POST | `/api/upload` | Recibe file (multipart), corre 3 agentes, devuelve preview |
| POST | `/api/confirm` | Guarda el registro confirmado en D1 |
| GET | `/api/gastos` | Lista gastos con filtros `desde`, `hasta`, `categoria` |

---

## wrangler.toml (ya configurado)

```toml
name = "cocicp-gastos"
main = "worker.js"
compatibility_date = "2025-01-01"

[vars]
ENVIRONMENT = "production"

[[d1_databases]]
binding  = "DB"
database_name = "cocicp-gastos"
database_id   = "82b3f166-7042-48de-b8fb-b0350423c4be"

[[r2_buckets]]
binding     = "BUCKET"
bucket_name = "cocicp-soportes"
```

---

## Comandos pendientes para completar el deploy

```bash
# Desde la carpeta cocicp-gastos/

# 1. Instalar wrangler si no está
npm install

# 2. Login (si no está autenticado)
wrangler login

# 3. Subir API Key de Anthropic
wrangler secret put ANTHROPIC_API_KEY
# → Te pide el valor → pegar key → Enter

# 4. Deploy del Worker
wrangler deploy
# → Genera URL: https://cocicp-gastos.CUENTA.workers.dev

# 5. Actualizar WORKER_URL en index.html con la URL real
# Línea: const WORKER_URL = 'https://cocicp-gastos.TU-CUENTA.workers.dev';

# 6. Deploy del frontend en Pages
wrangler pages deploy . --project-name=cocicp-gastos-ui
# → Genera URL: https://cocicp-gastos-ui.pages.dev
```

---

## Schema D1 — tabla gastos (columnas clave)

```sql
gastos (
  id              INTEGER PK,
  numero          INTEGER UNIQUE,     -- secuencial (1..119...)
  fecha           TEXT,               -- YYYY-MM-DD
  proveedor_nit   TEXT,
  proveedor_nombre TEXT,
  numero_documento TEXT,              -- factura/NC/comprobante
  concepto        TEXT,               -- descripción ≤80 chars
  categoria       TEXT,               -- ver lista abajo
  valor_base      REAL,
  iva             REAL,
  inc             REAL,
  otros_impuestos REAL,
  total           REAL,               -- negativo si NC
  es_nota_credito INTEGER,            -- 0/1
  medio_pago      TEXT,
  referencia_pago TEXT,               -- CUS, verificación, etc.
  archivo_r2      TEXT,               -- key en R2
  usuario         TEXT,               -- 'david' | 'andrea'
  estado          TEXT                -- 'confirmado' | 'revision'
)
```

---

## Categorías válidas (20)

```
Alimentación | Alimentación/Viáticos | Mercado/Aseo | Combustible |
Educación hijos | Honorarios Médicos | Prestadores de servicios |
Seguridad Social | Impuestos vehículos | Gastos Administrativos |
Transporte Aéreo | Alojamiento | Salud | Tecnología | Libros |
Personal | Misceláneos | Vivienda | Pagos David Duque | Parqueadero
```

---

## Proveedores frecuentes (21 en catálogo)

| NIT | Nombre corto | Categoría default |
|-----|-------------|-------------------|
| 901423905-4 | Liceo Francés | Educación hijos |
| 900276962-1 | D1 | Mercado/Aseo |
| 890900608-9 | Carulla/Éxito | Mercado/Aseo |
| 900720191-9 | JENAGRO | Alimentación |
| 900078103-0 | DH Galerías | Combustible |
| 900568774-5 | K-Saval Ibagué | Combustible |
| 811009788-8 | Distracom Alpes | Combustible |
| 902029628-0 | Laura Anaya | Honorarios Médicos |
| 830019189-8 | LATAM | Transporte Aéreo |
| 860007322-9 | CCB | Gastos Administrativos |
| 830009217-2 | Ballet Pavlova | Educación hijos |
| 901023168-5 | Bus escolar | Educación hijos |
| 800155413-6 | Acción Fiduciaria | Vivienda |
| 890905211-1 | Gob. Antioquia | Impuestos vehículos |
| 890399010-1 | Gob. Valle | Impuestos vehículos |
| 9998600669427 | miplanilla | Seguridad Social |
| 860530559-9 | Tequendama | Parqueadero |
| 901555354-2 | Ardea Restaurante | Alimentación |
| 860076919-1 | Crepes y Waffles | Alimentación |
| 900451555-3 | Rappi | Pagos David Duque |
| 890300279-0 | Banco Occidente | Pagos David Duque |

---

## Contexto COCICP

- **NIT**: 901277565-7
- **Nombre**: Corporación Colombiana para el Desarrollo en Investigación en Cirugía Plástica
- **Tipo**: ESAL (Entidad Sin Ánimo de Lucro)
- **Usuarios**: david (Dr. David Duque), andrea (Andrea Cepeda)
- **Clínicas**: HUN, Clínica Colombia, Clínica Reina Sofía, Clínica Santa María del Lago

---

## Próximos pasos sugeridos

1. **Deploy Worker** — `wrangler secret put` + `wrangler deploy`
2. **Actualizar WORKER_URL** en `index.html`
3. **Deploy Pages** — `wrangler pages deploy`
4. **Probar flujo completo** — subir una factura real y verificar los 3 agentes
5. **Opcional: Vista mobile** — el frontend ya es responsive pero se puede mejorar
6. **Opcional: Export Excel** — el CSV está implementado, Excel requiere SheetJS

---

## Verificación de D1 (query de prueba)

```bash
wrangler d1 execute cocicp-gastos \
  --command="SELECT COUNT(*) as total, SUM(total) as gran_total FROM gastos"
# → {total: 119, gran_total: 317255091}
```

---

## Notas técnicas

- El Worker usa ES Modules (`export default { fetch() }`)
- Los 3 agentes corren con `Promise.all()` — tiempo total ~1.5s (no suma)
- El Agente 2 tiene catálogo en memoria para los 21 NITs frecuentes (no espera D1)
- Las notas crédito se detectan por `tipo_documento === 'nota_credito'` → total negativo
- El frontend tiene demo data offline (funciona sin Worker conectado)
- `INSERT OR IGNORE` en todos los INSERTs — seguro re-ejecutar sin duplicar
