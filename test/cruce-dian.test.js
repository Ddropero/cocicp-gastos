import { describe, it, expect } from 'vitest';
import { matchDianFila } from '../lib/finance-utils.js';

// Simula el scope por entidad: cada "reporte" cruza SOLO contra los gastos de esa entidad.
const gastos = {
  cocicp: [
    { id: 1, numero_documento: 'FE-100', proveedor_nit: '900123456-7', fecha: '2026-07-05', total: 450000 },
    { id: 2, numero_documento: null, proveedor_nit: '811009788', fecha: '2026-07-06', total: 120000 },
  ],
  personal: [
    { id: 9, numero_documento: 'FE-100', proveedor_nit: '900123456-7', fecha: '2026-07-05', total: 450000 }, // mismo doc, otra entidad
    { id: 10, numero_documento: 'FVC-77', proveedor_nit: '5084683', fecha: '2026-07-07', total: 80000 },
  ],
};

describe('matchDianFila — cruce por entidad', () => {
  it('empareja por número de documento + NIT dentro de la entidad', () => {
    const m = matchDianFila({ numero_documento: 'FE-100', nit_emisor: '900123456', fecha: '2026-07-05', total: 450000 }, gastos.cocicp);
    expect(m?.id).toBe(1);
  });

  it('empareja por NIT+fecha+total cuando no hay número de documento', () => {
    const m = matchDianFila({ numero_documento: '', nit_emisor: '811009788', fecha: '2026-07-06', total: 120000 }, gastos.cocicp);
    expect(m?.id).toBe(2);
  });

  it('NO cruza contra gastos de otra entidad (el mismo doc en personal no aparece al cruzar cocicp)', () => {
    // Reporte de COCICP: solo ve gastos.cocicp → encuentra id 1, nunca el id 9 de personal
    const m = matchDianFila({ numero_documento: 'FE-100', nit_emisor: '900123456', fecha: '2026-07-05', total: 450000 }, gastos.cocicp);
    expect(m?.id).toBe(1);
    // Reporte personal con la factura FVC-77 → cruza contra personal
    const mp = matchDianFila({ numero_documento: 'FVC-77', nit_emisor: '5084683', fecha: '2026-07-07', total: 80000 }, gastos.personal);
    expect(mp?.id).toBe(10);
    // FVC-77 NO existe en cocicp → nuevo
    const mn = matchDianFila({ numero_documento: 'FVC-77', nit_emisor: '5084683', fecha: '2026-07-07', total: 80000 }, gastos.cocicp);
    expect(mn).toBeNull();
  });

  it('fila DIAN sin correspondencia → null (nuevo)', () => {
    const m = matchDianFila({ numero_documento: 'XX-999', nit_emisor: '999999999', fecha: '2026-07-01', total: 10000 }, gastos.cocicp);
    expect(m).toBeNull();
  });

  it('tolera montos con formato colombiano y NIT con/sin DV', () => {
    const m = matchDianFila({ numero_documento: '', nit_emisor: '811009788-8', fecha: '2026-07-06', total: '120.000' }, gastos.cocicp);
    expect(m?.id).toBe(2);
  });
});
