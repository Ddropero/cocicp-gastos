-- 0005_hardening — endurecimiento (idempotencia de pagos, auditoría, deducibilidad, entidad).
-- ESTA es la única migración nueva que la base EXISTENTE necesita.
-- Ejecutar contra la base actual:
--   wrangler d1 execute cocicp-gastos --file=migrations/0005_hardening.sql
-- (Fase 5.4) Backfill no destructivo: los registros existentes quedan entidad='cocicp'.

-- Dispersiones: idempotencia + auditoría (Fase 3.10/3.12)
ALTER TABLE dispersiones ADD COLUMN op_id TEXT;
ALTER TABLE dispersiones ADD COLUMN archivo_hash TEXT;
ALTER TABLE dispersiones ADD COLUMN creado_por TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_dispersiones_op ON dispersiones(op_id) WHERE op_id IS NOT NULL;

-- Gastos: deducibilidad persistida (Fase 4.2) + separación auditoría/entidad (Fase 5.1)
-- entidad multi-empresa: 'cocicp' | 'restituyo' | 'personal' (default cocicp para backfill)
ALTER TABLE gastos ADD COLUMN deducible_cocicp INTEGER DEFAULT 1;
ALTER TABLE gastos ADD COLUMN entidad TEXT DEFAULT 'cocicp';
ALTER TABLE gastos ADD COLUMN created_by_user_id INTEGER;      -- FK lógica a users(id)
ALTER TABLE gastos ADD COLUMN updated_by_user_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_gastos_entidad ON gastos(entidad);
CREATE INDEX IF NOT EXISTS idx_gastos_pagado ON gastos(pagado_via);

-- NOTA CHECK: SQLite no permite ALTER ... ADD CONSTRAINT. Los invariantes de estado,
-- importes, frecuencia, días y roles se validan en la capa de aplicación
-- (lib/finance-utils.js) y, para tablas nuevas, con CHECK en 0002/0003.
