-- Fixtures FICTICIOS para pruebas locales (Fase 5.9). NO usar en producción.
-- Datos inventados: nombres, NITs y cuentas no reales.
INSERT OR IGNORE INTO proveedores (nit, nombre, nombre_corto, categoria_default, banco_finandina, tipo_cuenta, numero_cuenta, tipo_documento_titular, numero_documento_titular, nombre_titular, apellido_titular, razon_social_titular)
VALUES
  ('900000001-1','PROVEEDOR DEMO SAS','Demo SAS','Tecnología','BANCOLOMBIA SA','ahorros','00000000001','NIT','900000001','','','PROVEEDOR DEMO SAS'),
  ('10000000','JUAN PRUEBA PEREZ','Juan Prueba','Combustible','BANCO DAVIVIENDA','ahorros','00000000002','CC','10000000','JUAN','PEREZ',NULL);

INSERT OR IGNORE INTO obligaciones (nombre, tipo, categoria, frecuencia, dia_limite, valor_estimado)
VALUES
  ('Obligacion Demo Mensual','empresa','Gastos Administrativos','mensual',5,100000),
  ('Obligacion Demo Semestral','personal','Salud','semestral',1,50000);

INSERT OR IGNORE INTO gastos (numero, fecha, proveedor_nit, proveedor_nombre, numero_documento, concepto, categoria, total, estado)
VALUES
  (900001,'2026-07-01','900000001-1','PROVEEDOR DEMO SAS','FE-DEMO-1','Compra demo','Tecnología',100000,'confirmado'),
  (900002,'2026-07-02','10000000','JUAN PRUEBA PEREZ','FE-DEMO-2','Combustible demo','Combustible',50000,'confirmado');
