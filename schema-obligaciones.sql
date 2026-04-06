-- ============================================================
-- COCICP Gastos — Obligaciones recurrentes
-- Ejecutar con: wrangler d1 execute cocicp-gastos --file=schema-obligaciones.sql
-- ============================================================

CREATE TABLE IF NOT EXISTS obligaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  tipo TEXT NOT NULL,             -- 'empresa' | 'personal'
  categoria TEXT,
  proveedor_nit TEXT,
  proveedor_nombre TEXT,
  frecuencia TEXT NOT NULL,       -- 'mensual' | 'quincenal' | 'bimestral' | 'trimestral' | 'semestral' | 'anual'
  dia_limite INTEGER,             -- dia del mes en que vence (1-31)
  valor_estimado REAL,
  medio_pago TEXT,
  activo INTEGER DEFAULT 1,
  notas TEXT,
  creado_en TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_obligaciones_tipo ON obligaciones(tipo);
CREATE INDEX IF NOT EXISTS idx_obligaciones_activo ON obligaciones(activo);

-- ============================================================
-- Datos iniciales — Obligaciones EMPRESA (COCICP)
-- ============================================================
INSERT OR IGNORE INTO obligaciones (nombre, descripcion, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, medio_pago) VALUES
  ('Liceo Frances',           'Pension mensual colegio',              'empresa', 'Educacion hijos',    '901423905-4',    'Liceo Frances',       'mensual',  5,  4500000,  'Transferencia'),
  ('Ballet Pavlova',          'Clases ballet mensual',                'empresa', 'Educacion hijos',    '830009217-2',    'Ballet Pavlova',      'mensual',  5,  350000,   'Transferencia'),
  ('Bus escolar',             'Transporte escolar mensual',           'empresa', 'Educacion hijos',    '901023168-5',    'Bus escolar',         'mensual',  5,  450000,   'Transferencia'),
  ('Seguridad Social',        'Planilla independiente UGPP',          'empresa', 'Seguridad Social',   '9998600669427',  'miplanilla',          'mensual',  10, 1124100,  'PSE'),
  ('Laura Anaya honorarios',  'Honorarios cirugia plastica',         'empresa', 'Honorarios Medicos', '902029628-0',    'Laura Anaya',         'mensual',  15, 14346520, 'Transferencia'),
  ('Accion Fiduciaria apto',  'Cuota apartamento fiduciaria',        'empresa', 'Vivienda',           '800155413-6',    'Accion Fiduciaria',   'mensual',  20, 38000000, 'Debito automatico');

-- ============================================================
-- Datos iniciales — Obligaciones PERSONAL (David Duque)
-- ============================================================
INSERT OR IGNORE INTO obligaciones (nombre, descripcion, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, medio_pago) VALUES
  ('Tarjeta Rappi',              'Pago tarjeta credito Rappi',          'personal', 'Pagos David Duque',    '900451555-3',    'Rappi',               'mensual',  15, NULL,     'PSE'),
  ('Banco Occidente',            'Pago credito/tarjeta Occidente',      'personal', 'Pagos David Duque',    '890300279-0',    'Banco Occidente',     'mensual',  20, NULL,     'PSE'),
  ('SOAT vehiculos',             'SOAT anual vehiculos',                'personal', 'Miscelaneos',          NULL,             NULL,                  'anual',    1,  NULL,     NULL),
  ('Impuesto vehiculos Antioquia','Impuesto automotor Gobernacion Ant', 'personal', 'Impuestos vehiculos',  '890905211-1',    'Gob. Antioquia',      'anual',    NULL, NULL,   'PSE'),
  ('Impuesto vehiculos Valle',   'Impuesto automotor Gobernacion Valle','personal', 'Impuestos vehiculos',  '890399010-1',    'Gob. Valle',          'anual',    NULL, NULL,   'PSE'),
  ('Medicina prepagada',         'Plan medicina prepagada mensual',     'personal', 'Salud',                NULL,             NULL,                  'mensual',  1,  NULL,     'Debito automatico'),
  ('Internet/TV hogar',          'Servicio internet y TV hogar',        'personal', 'Vivienda',             NULL,             NULL,                  'mensual',  10, NULL,     'Debito automatico'),
  ('Celular plan',               'Plan celular mensual',                'personal', 'Personal',             NULL,             NULL,                  'mensual',  15, NULL,     NULL),
  ('Administracion apartamento', 'Cuota administracion conjunto',       'personal', 'Vivienda',             NULL,             NULL,                  'mensual',  1,  NULL,     'Debito automatico'),
  ('Netflix/Spotify/suscripciones','Suscripciones digitales mensuales', 'personal', 'Personal',             NULL,             NULL,                  'mensual',  1,  NULL,     'TC automatico');
