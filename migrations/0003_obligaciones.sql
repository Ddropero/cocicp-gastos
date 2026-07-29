-- 0003_obligaciones — SOLO esquema (los datos reales NO se versionan; ver Fase 5.8).
-- UNIQUE(nombre,tipo) evita duplicar al re-sembrar (Fase 5.7).
CREATE TABLE IF NOT EXISTS obligaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('empresa','personal')),
  categoria TEXT,
  proveedor_nit TEXT,
  proveedor_nombre TEXT,
  frecuencia TEXT NOT NULL CHECK (frecuencia IN ('mensual','quincenal','bimestral','trimestral','semestral','anual')),
  dia_limite INTEGER CHECK (dia_limite IS NULL OR (dia_limite BETWEEN 1 AND 31)),
  valor_estimado REAL,
  medio_pago TEXT,
  activo INTEGER DEFAULT 1,
  notas TEXT,
  creado_en TEXT DEFAULT (datetime('now')),
  UNIQUE (nombre, tipo)
);

CREATE INDEX IF NOT EXISTS idx_obligaciones_tipo ON obligaciones(tipo);
CREATE INDEX IF NOT EXISTS idx_obligaciones_activo ON obligaciones(activo);
