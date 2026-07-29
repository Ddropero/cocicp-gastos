import { describe, it, expect } from 'vitest';
import { generarArchivoDispersion } from '../finandina-dispersion.js';

const cab = {
  fechaPago: new Date('2026-07-10T12:00:00Z'),
  identificacionArchivo: 1,
  tipoOrigen: 'ahorros',
  cuentaOrigen: '1234567890',
};
const benOk = {
  tipoIdentificacion: 'CC', identificacion: '123456789',
  nombre: 'JUAN', apellido: 'PEREZ',
  cuentaDestino: '9876543210', tipoCuentaDestino: 'ahorros',
  banco: 'BANCOLOMBIA SA', valor: 450000, referencia1: 'F-1', referencia2: '20260710',
};

describe('generarArchivoDispersion', () => {
  it('genera archivo válido con líneas de longitud correcta', () => {
    const { content, resumen } = generarArchivoDispersion(cab, [benOk]);
    const lines = content.split('\r\n').filter(Boolean);
    expect(lines[0].length).toBe(185); // cabecera
    expect(lines[1].length).toBe(258); // detalle
    expect(lines[2].length).toBe(185); // cierre
    expect(resumen.totalValor).toBe(450000);
    expect(resumen.totalRegistros).toBe(1);
  });
  it('RECHAZA valor cero', () => {
    expect(() => generarArchivoDispersion(cab, [{ ...benOk, valor: 0 }])).toThrow();
  });
  it('RECHAZA valor negativo (nota crédito)', () => {
    expect(() => generarArchivoDispersion(cab, [{ ...benOk, valor: -450000 }])).toThrow();
  });
  it('RECHAZA valor no entero', () => {
    expect(() => generarArchivoDispersion(cab, [{ ...benOk, valor: 1000.5 }])).toThrow();
  });
  it('RECHAZA lista vacía', () => {
    expect(() => generarArchivoDispersion(cab, [])).toThrow();
  });
  it('suma correctamente múltiples beneficiarios', () => {
    const { resumen } = generarArchivoDispersion(cab, [benOk, { ...benOk, valor: 550000 }]);
    expect(resumen.totalValor).toBe(1000000);
    expect(resumen.totalRegistros).toBe(2);
  });
});
