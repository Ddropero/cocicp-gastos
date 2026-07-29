import { describe, it, expect } from 'vitest';
import { parseGastoTexto, ENTIDADES_VALIDAS } from '../lib/chat-gasto.js';

const HOY = '2026-07-28';

describe('parseGastoTexto — gasto por texto en el chat', () => {
  it('caso del usuario: "gasto en gasolina 100000 por persona natural"', () => {
    const r = parseGastoTexto('gasto en gasolina 100000 por persona natural', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.entidad).toBe('personal');
    expect(r.gasto.total).toBe(100000);
    expect(r.gasto.categoria).toBe('Combustible');
    expect(r.gasto.fecha).toBe(HOY);
    expect(r.gasto.concepto.toLowerCase()).toContain('gasolina');
  });

  it('restituyo con miles CO: "almuerzo clientes 85.000 restituyo"', () => {
    const r = parseGastoTexto('almuerzo clientes 85.000 restituyo', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.entidad).toBe('restituyo');
    expect(r.gasto.total).toBe(85000);
    expect(r.gasto.categoria).toBe('Alimentación');
  });

  it('cocicp con símbolo $: "papelería $45.500 cocicp"', () => {
    const r = parseGastoTexto('papelería $45.500 cocicp', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.entidad).toBe('cocicp');
    expect(r.gasto.total).toBe(45500);
    expect(r.gasto.categoria).toBe('Gastos Administrativos');
  });

  it('sufijo k: "parqueadero 12k personal"', () => {
    const r = parseGastoTexto('parqueadero 12k personal', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.total).toBe(12000);
    expect(r.gasto.categoria).toBe('Parqueadero');
    expect(r.gasto.entidad).toBe('personal');
  });

  it('"mil": "café 8 mil personal"', () => {
    const r = parseGastoTexto('café 8 mil personal', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.total).toBe(8000);
    expect(r.gasto.categoria).toBe('Alimentación');
  });

  it('"corporación" mapea a cocicp', () => {
    const r = parseGastoTexto('gasto de mercado 250.000 para la corporación', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.entidad).toBe('cocicp');
    expect(r.gasto.categoria).toBe('Mercado/Aseo');
  });

  it('cantidad pequeña no se confunde con el monto: "2 almuerzos 50000 personal"', () => {
    const r = parseGastoTexto('2 almuerzos 50000 personal', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.total).toBe(50000);
  });

  it('"ayer" resta un día', () => {
    const r = parseGastoTexto('gasolina 90000 ayer personal', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.fecha).toBe('2026-07-27');
  });

  it('sin entidad → ok:false con motivo sin_entidad y parcial útil', () => {
    const r = parseGastoTexto('gasolina 100000', { hoy: HOY });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin_entidad');
    expect(r.parcial.total).toBe(100000);
    expect(r.parcial.categoria).toBe('Combustible');
  });

  it('defaultEntidad rellena cuando falta', () => {
    const r = parseGastoTexto('gasolina 100000', { hoy: HOY, defaultEntidad: 'personal' });
    expect(r.ok).toBe(true);
    expect(r.gasto.entidad).toBe('personal');
  });

  it('sin monto → sin_monto (no parece gasto)', () => {
    const r = parseGastoTexto('hola cómo estás', { hoy: HOY });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin_monto');
  });

  it('monto ridículo (<$100) no cuenta', () => {
    const r = parseGastoTexto('ok dame 5 personal', { hoy: HOY });
    expect(r.ok).toBe(false);
    expect(r.motivo).toBe('sin_monto');
  });

  it('sin keyword de categoría → Misceláneos', () => {
    const r = parseGastoTexto('varios 30000 personal', { hoy: HOY });
    expect(r.ok).toBe(true);
    expect(r.gasto.categoria).toBe('Misceláneos');
  });

  it('concepto queda limpio (sin monto ni entidad ni "gasto en")', () => {
    const r = parseGastoTexto('gasto en gasolina 100000 por persona natural', { hoy: HOY });
    expect(r.gasto.concepto).not.toMatch(/100000|personal|natural/i);
  });

  it('entidades válidas exportadas', () => {
    expect(ENTIDADES_VALIDAS).toEqual(['cocicp', 'restituyo', 'personal']);
  });
});
