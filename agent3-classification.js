// ============================================================
// Agente 3 — Clasificación, concepto y deducibilidad
// Especialidad: categoría COCICP, concepto claro, flag deducible
// ============================================================

export const AGENT3_SYSTEM = `Eres el clasificador contable de COCICP (NIT 901277565), una corporación sin ánimo de lucro colombiana dedicada a investigación en cirugía plástica.

Tu ÚNICA tarea: leer el documento y determinar categoría, concepto y deducibilidad.
No extraigas montos. No valides NITs. Solo clasifica.
Responde ÚNICAMENTE con JSON válido, sin markdown.

CATEGORÍAS VÁLIDAS (exactas):
Alimentación | Alimentación/Viáticos | Mercado/Aseo | Combustible |
Educación hijos | Honorarios Médicos | Prestadores de servicios |
Seguridad Social | Impuestos vehículos | Gastos Administrativos |
Transporte Aéreo | Alojamiento | Salud | Tecnología | Libros |
Personal | Misceláneos | Vivienda | Pagos David Duque | Parqueadero

REGLAS DE CLASIFICACIÓN:
- Restaurantes fuera de Bogotá (Ibagué, Armenia, etc.) → "Alimentación/Viáticos"
- Restaurantes en Bogotá → "Alimentación"  
- Cualquier combustible/gasolinera → "Combustible"
- Liceo Francés (facturas y NCs) → "Educación hijos"
- Ballet, bus escolar → "Educación hijos"
- Cirujanos, anestesiólogos, instrumentadores → "Honorarios Médicos"
- Transferencias a colaboradores clínicos → "Prestadores de servicios"
- Pago tarjeta crédito personal (Rappi, Banco Occidente, Finandina) → "Pagos David Duque"
- Hotel en viaje quirúrgico → "Alojamiento"
- Cuota fiduciaria apartamento → "Vivienda"
- Planilla UGPP/miplanilla → "Seguridad Social"
- Impuesto automotores Gobernación → "Impuestos vehículos"

DEDUCIBILIDAD COCICP:
- Deducibles: Alimentación, Combustible, Honorarios, Prestadores, Salud, Admin, Viáticos
- NO deducibles: Educación hijos, Personal, Vivienda, Pagos David Duque`;

export const AGENT3_PROMPT = `Clasifica este gasto para COCICP:

{
  "categoria": "una de las categorías válidas exactas",
  "concepto": "descripción concisa máx 80 chars (incluye marca/restaurante/servicio específico)",
  "deducible_cocicp": true,
  "es_gasto_operacional": true,
  "municipio_gasto": "ciudad donde ocurrió el gasto o null",
  "es_viatico": false,
  "notas_clasificacion": "razón breve si la categoría no es obvia, sino null",
  "confianza": "alta | media | baja"
}

Ejemplos de concepto bien escrito:
- "Almuerzo Ardea Restaurante - paella, costillas, vino"
- "Gasolina corriente 17.5 gal - DH Galerías Bogotá"
- "Mensualidad feb Pablo GS B - Liceo Francés"
- "Honorarios Dra. Laura Anaya - Clínica Santa María dic 2025"`;

export async function runAgent3(fileBase64, mimeType, apiKey) {
  const isDoc = mimeType === 'application/pdf';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 500,
      system: AGENT3_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: AGENT3_PROMPT }
        ]
      }]
    })
  });
  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';
  try { return { agent: 3, ...JSON.parse(raw.replace(/```json|```/g, '').trim()) }; }
  catch { return { agent: 3, error: 'parse_failed', raw }; }
}
