-- ============================================================
-- COCICP Gastos - D1 Schema
-- ============================================================

-- Proveedores conocidos (catálogo enriquecido)
CREATE TABLE IF NOT EXISTS proveedores (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nit         TEXT NOT NULL UNIQUE,
  nombre      TEXT NOT NULL,
  nombre_corto TEXT,                        -- "Liceo Francés", "D1", "Laura Anaya"
  categoria_default TEXT,                   -- categoría más frecuente
  es_nota_credito_posible INTEGER DEFAULT 0,
  creado_en   TEXT DEFAULT (datetime('now'))
);

-- Categorías válidas
CREATE TABLE IF NOT EXISTS categorias (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  deducible_cocicp INTEGER DEFAULT 1        -- 1 = deducible, 0 = no
);

-- Gastos (tabla principal)
CREATE TABLE IF NOT EXISTS gastos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          INTEGER UNIQUE,           -- número secuencial (reg #)
  fecha           TEXT NOT NULL,            -- YYYY-MM-DD
  proveedor_nit   TEXT,
  proveedor_nombre TEXT NOT NULL,
  numero_documento TEXT,                    -- factura/NC/comprobante
  concepto        TEXT NOT NULL,
  categoria       TEXT NOT NULL,
  valor_base      REAL DEFAULT 0,
  iva             REAL DEFAULT 0,
  inc             REAL DEFAULT 0,
  otros_impuestos REAL DEFAULT 0,
  total           REAL NOT NULL,            -- negativo si es NC
  es_nota_credito INTEGER DEFAULT 0,
  medio_pago      TEXT,
  referencia_pago TEXT,                     -- CUS, verificación, transacción
  archivo_r2      TEXT,                     -- key en R2 del soporte
  usuario         TEXT DEFAULT 'david',     -- david | andrea
  estado          TEXT DEFAULT 'confirmado',-- confirmado | pendiente | revisión
  notas           TEXT,
  creado_en       TEXT DEFAULT (datetime('now')),
  actualizado_en  TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (categoria) REFERENCES categorias(nombre)
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos(categoria);
CREATE INDEX IF NOT EXISTS idx_gastos_proveedor ON gastos(proveedor_nit);
CREATE INDEX IF NOT EXISTS idx_gastos_numero_doc ON gastos(numero_documento);

-- ============================================================
-- Datos iniciales — categorías
-- ============================================================
INSERT OR IGNORE INTO categorias (nombre, descripcion, deducible_cocicp) VALUES
  ('Alimentación',               'Restaurantes, cafeterías, domicilios',        1),
  ('Alimentación/Viáticos',      'Alimentación en viajes quirúrgicos',           1),
  ('Mercado/Aseo',               'Supermercados, artículos de aseo',             1),
  ('Combustible',                'Gasolina y combustibles',                      1),
  ('Educación hijos',            'Liceo Francés, ballet, transporte escolar',    0),
  ('Honorarios Médicos',         'Pagos a prestadores y cirujanos',              1),
  ('Prestadores de servicios',   'Transferencias a colaboradores clínica',       1),
  ('Seguridad Social',           'Planilla independiente UGPP',                  1),
  ('Impuestos vehículos',        'Impuesto automotores Gobernación',             0),
  ('Gastos Administrativos',     'Cámara de Comercio, certificados, etc.',       1),
  ('Transporte Aéreo',           'Tiquetes aéreos',                              1),
  ('Alojamiento',                'Hoteles en viajes quirúrgicos',                1),
  ('Salud',                      'Copagos, consultas médicas',                   1),
  ('Tecnología',                 'Equipos, software, accesorios',                1),
  ('Libros',                     'Libros académicos y profesionales',             1),
  ('Personal',                   'Artículos personales varios',                  0),
  ('Misceláneos',                'Sin categoría clara',                          0),
  ('Vivienda',                   'Cuotas apartamento, administración',            0),
  ('Pagos David Duque',          'Pagos tarjetas crédito personales',             0),
  ('Parqueadero',                'Parqueaderos',                                  1);

-- ============================================================
-- Datos iniciales — proveedores frecuentes
-- ============================================================
INSERT OR IGNORE INTO proveedores (nit, nombre, nombre_corto, categoria_default, es_nota_credito_posible) VALUES
  ('901423905-4', 'Liceo Francés Bilingüe Internacional de Bogotá SAS', 'Liceo Francés',   'Educación hijos',    1),
  ('900276962-1', 'D1 S.A.S.',                                           'D1',               'Mercado/Aseo',       0),
  ('890900608-9', 'Almacenes Éxito S.A.',                                'Carulla/Éxito',    'Mercado/Aseo',       0),
  ('900720191-9', 'JENAGRO 65 SAS',                                      'JENAGRO',          'Alimentación',       0),
  ('900078103-0', 'Combustibles H&R Ltda.',                              'DH Galerías',      'Combustible',        0),
  ('900568774-5', 'K-Saval Energy SAS BIC',                              'K-Saval Ibagué',   'Combustible',        0),
  ('811009788-8', 'Distracom S.A.',                                      'Distracom Alpes',  'Combustible',        0),
  ('902029628-0', 'Dra. Laura Anaya Cirugía Plástica SAS',               'Laura Anaya',      'Honorarios Médicos', 0),
  ('830019189-8', 'LATAM Airlines Group SA',                             'LATAM',            'Transporte Aéreo',   0),
  ('860007322-9', 'Cámara de Comercio de Bogotá',                        'CCB',              'Gastos Administrativos', 0),
  ('830009217-2', 'Compañía Ballet Anna Pavlova',                        'Ballet Pavlova',   'Educación hijos',    0),
  ('901023168-5', 'Autobuses Group SAS',                                 'Bus escolar',      'Educación hijos',    0),
  ('800155413-6', 'Accion Sociedad Fiduciaria S.A.',                     'Acción Fiduciaria','Vivienda',           0),
  ('890905211-1', 'Gobernación de Antioquia',                            'Gob. Antioquia',   'Impuestos vehículos',0),
  ('890399010-1', 'Gobernación del Valle del Cauca',                     'Gob. Valle',       'Impuestos vehículos',0),
  ('9998600669427','UGPP / miplanilla.com',                              'miplanilla',       'Seguridad Social',   0),
  ('860530559-9', 'Parqueaderos Tequendama SAS',                         'Tequendama',       'Parqueadero',        0),
  ('901555354-2', 'Montaqua SAS',                                        'Ardea Restaurante','Alimentación',       0),
  ('860076919-1', 'Crepes y Waffles S.A.',                               'Crepes y Waffles', 'Alimentación',       0),
  ('900451555-3', 'RappiCuenta',                                         'Rappi',            'Pagos David Duque',  0),
  ('890300279-0', 'Banco de Occidente',                                  'Banco Occidente',  'Pagos David Duque',  0);
