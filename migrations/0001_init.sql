-- 0001_init — tablas base (idempotente). Deriva de schema.sql.
CREATE TABLE IF NOT EXISTS proveedores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nit         TEXT NOT NULL UNIQUE,
  nombre      TEXT NOT NULL,
  nombre_corto TEXT,
  categoria_default TEXT,
  es_nota_credito_posible INTEGER DEFAULT 0,
  creado_en   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categorias (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  deducible_cocicp INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS gastos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          INTEGER UNIQUE,
  fecha           TEXT NOT NULL,
  proveedor_nit   TEXT,
  proveedor_nombre TEXT NOT NULL,
  numero_documento TEXT,
  concepto        TEXT NOT NULL,
  categoria       TEXT NOT NULL,
  valor_base      REAL DEFAULT 0,
  iva             REAL DEFAULT 0,
  inc             REAL DEFAULT 0,
  otros_impuestos REAL DEFAULT 0,
  total           REAL NOT NULL,
  es_nota_credito INTEGER DEFAULT 0,
  medio_pago      TEXT,
  referencia_pago TEXT,
  archivo_r2      TEXT,
  usuario         TEXT DEFAULT 'sistema',
  estado          TEXT DEFAULT 'confirmado',
  notas           TEXT,
  creado_en       TEXT DEFAULT (datetime('now')),
  actualizado_en  TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (categoria) REFERENCES categorias(nombre)
);

CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos(categoria);
CREATE INDEX IF NOT EXISTS idx_gastos_proveedor ON gastos(proveedor_nit);
CREATE INDEX IF NOT EXISTS idx_gastos_numero_doc ON gastos(numero_documento);

-- Categorías (no personal; seguro versionar)
INSERT OR IGNORE INTO categorias (nombre, deducible_cocicp) VALUES
  ('Alimentación',1),('Alimentación/Viáticos',1),('Mercado/Aseo',1),('Combustible',1),
  ('Educación hijos',1),('Honorarios Médicos',1),('Prestadores de servicios',1),
  ('Seguridad Social',1),('Impuestos vehículos',1),('Gastos Administrativos',1),
  ('Transporte Aéreo',1),('Alojamiento',1),('Salud',1),('Tecnología',1),('Libros',1),
  ('Personal',0),('Misceláneos',1),('Vivienda',1),('Pagos David Duque',0),('Parqueadero',1);
