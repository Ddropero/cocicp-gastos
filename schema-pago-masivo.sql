-- ============================================================
-- Pago masivo Finandina — extensión schema
-- ============================================================

-- Columnas bancarias en proveedores (info del beneficiario)
ALTER TABLE proveedores ADD COLUMN banco_finandina TEXT;
ALTER TABLE proveedores ADD COLUMN tipo_cuenta TEXT;
ALTER TABLE proveedores ADD COLUMN numero_cuenta TEXT;
ALTER TABLE proveedores ADD COLUMN tipo_documento_titular TEXT;
ALTER TABLE proveedores ADD COLUMN numero_documento_titular TEXT;
ALTER TABLE proveedores ADD COLUMN nombre_titular TEXT;
ALTER TABLE proveedores ADD COLUMN apellido_titular TEXT;
ALTER TABLE proveedores ADD COLUMN razon_social_titular TEXT;
ALTER TABLE proveedores ADD COLUMN email_notificacion TEXT;

-- Columna en gastos para marcar pagos via Finandina
ALTER TABLE gastos ADD COLUMN pagado_via TEXT;
ALTER TABLE gastos ADD COLUMN fecha_pago_masivo TEXT;
ALTER TABLE gastos ADD COLUMN archivo_dispersion TEXT;

-- Tabla para llevar el consecutivo de archivos generados
CREATE TABLE IF NOT EXISTS dispersiones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  identificacion  INTEGER NOT NULL,
  fecha_pago      TEXT NOT NULL,
  cuenta_origen   TEXT,
  tipo_origen     TEXT,
  total_registros INTEGER,
  total_valor     REAL,
  archivo_nombre  TEXT,
  gastos_ids      TEXT,
  creado_en       TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispersiones_fecha ON dispersiones(fecha_pago);
