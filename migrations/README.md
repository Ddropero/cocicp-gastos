# Migraciones D1 — COCICP

Migraciones forward-only, numeradas. No destructivas.

## Base NUEVA (vacía)
```
wrangler d1 migrations apply cocicp-gastos --local     # pruebas
wrangler d1 migrations apply cocicp-gastos             # remoto (requiere autorización)
```
Aplica 0001→0005 en orden.

## Base EXISTENTE (producción actual)
Las tablas y columnas de 0001–0004 **ya existen** (se crearon con los `schema-*.sql`
originales). `ALTER TABLE ADD COLUMN` fallaría por columna duplicada. Por eso, en la
base existente aplica **solo la migración nueva 0005**:

```
wrangler d1 execute cocicp-gastos --file=migrations/0005_hardening.sql
```

Opcional (para que `wrangler d1 migrations` no intente re-aplicar 0001–0004):
marca 0001–0004 como aplicadas insertando sus nombres en la tabla de control
`d1_migrations` (crear la tabla si no existe; ver docs de Wrangler). No es
obligatorio si solo ejecutas 0005 con `d1 execute`.

## Qué agrega 0005 (única nueva)
- `dispersiones.op_id` (idempotencia de pagos), `archivo_hash`, `creado_por` + índice único parcial.
- `gastos.deducible_cocicp` (deducibilidad persistida), `entidad` ('cocicp'|'personal'),
  `created_by_user_id`, `updated_by_user_id`.
- Backfill no destructivo: los registros previos quedan `entidad='cocicp'`, `deducible_cocicp=1`.

## Datos
- Los seeds versionados contienen **solo** las categorías (no personales).
- Las obligaciones/proveedores reales **no** se versionan (datos personales y montos reales).
- Fixtures ficticios para pruebas: `test/fixtures/seed-fake.sql`.

## CHECK constraints
SQLite no soporta `ALTER TABLE ... ADD CONSTRAINT`. Los invariantes (estados, importes,
frecuencia, días, roles) se validan en `lib/finance-utils.js` y con `CHECK` en las tablas
creadas nuevas (0002 users/sessions, 0003 obligaciones).
