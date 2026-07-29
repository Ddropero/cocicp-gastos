# COCICP Gastos — Plan de Integracion Consolidado

Generado: 2026-04-06
Fuente: 10 archivos *-integration.txt

---

## Indice de Features

| # | Feature | Worker Endpoints | Archivos Nuevos | Secrets/Config |
|---|---------|-----------------|-----------------|----------------|
| 1 | PDF Fiscal Report | GET /api/reporte | report-pdf.js | — |
| 2 | Recurrentes | GET /api/recurrentes | recurrentes.js | — |
| 3 | Cruce Bancario | POST /api/cruce-banco | — | — |
| 4 | PWA | — | manifest.json, manifest-captura.json, sw.js | — |
| 5 | Document Viewer | — | — | — |
| 6 | Tendencias (Charts) | GET /api/tendencias | — | CDN: Chart.js |
| 7 | Comparativo Mensual | GET /api/comparativo | — | — |
| 8 | Auto-Confirm | (modifica POST /api/upload) | — | — |
| 9 | WhatsApp (Twilio) | GET+POST /api/whatsapp/webhook | — | TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN |
| 10 | Recordatorios DIAN | GET /api/estado-mes | — | — |

---

## PARTE A — WORKER.JS

### A.1 Imports (al inicio del archivo, junto a los otros imports)

```
import { checkRecurrentes } from './recurrentes.js';
```

### A.2 Funciones auxiliares (ANTES de `export default {`)

**De whatsapp-integration.txt:**

```js
// Formato COP sin decimales
function formatCOP(value) { ... }

// Enviar respuesta por WhatsApp via Twilio REST API
async function sendWhatsAppReply(env, to, message) { ... }

// (Opcional) Validacion de firma Twilio
async function validateTwilioSignature(request, authToken, webhookUrl) { ... }
```

### A.3 Modificacion a endpoint existente: POST /api/upload

**De autoconfirm-integration.txt:**

Despues de construir el preview y verificar duplicados (lineas ~147-153), ANTES del `return json({ ok: true, preview })`, agregar bloque de auto-confirmacion que:
- Lee `form.get('auto_confirm') === '1'`
- Verifica 4 condiciones: en_catalogo, confianza_global==='alta', sin duplicado, total>0
- Si se cumplen: INSERT en D1 con estado='confirmado', retorna `{ ok: true, preview, auto_confirmado: true, numero }`
- Si no: retorna el preview normal para revision manual

### A.4 Nuevos endpoints (todos van ANTES de `return json({ error: 'Not found' }, 404)`)

Orden sugerido de insercion:

#### 1. GET /api/reporte
- Fuente: report-integration.txt
- Recibe: `?desde=YYYY-MM-DD&hasta=YYYY-MM-DD`
- Accion: Query D1, genera PDF via `import('./report-pdf.js')`
- Responde: application/pdf como descarga

#### 2. GET /api/recurrentes
- Fuente: recurrentes-integration.txt
- Recibe: `?mes=N&anio=YYYY`
- Accion: `checkRecurrentes(env.DB, mes, anio)` del modulo recurrentes.js
- Responde: `{ ok, faltantes[], ok[] }`

#### 3. POST /api/cruce-banco
- Fuente: cruce-banco-integration.txt
- Recibe: JSON `{ movimientos: [{fecha, descripcion, valor, referencia}] }`
- Accion: Cruza movimientos bancarios contra gastos en D1 usando 3 estrategias de match (referencia, fecha+total exacto, fecha aproximada+total)
- Responde: `{ conciliados[], sin_soporte[], solo_en_sistema[] }` con stats

#### 4. GET /api/tendencias
- Fuente: charts-integration.txt
- Recibe: `?meses=N` (default 6, max 24)
- Accion: GROUP BY mes, categoria con SUM(total)
- Responde: `{ meses: [{ mes, total, categorias: {} }] }`

#### 5. GET /api/comparativo
- Fuente: comparativo-integration.txt
- Recibe: `?mes1=YYYY-MM&mes2=YYYY-MM`
- Accion: Compara dos meses por categoria con diferencia y porcentaje
- Responde: `{ resumen: {totales, diferencia, %}, categorias[] }`

#### 6. GET /api/estado-mes
- Fuente: recordatorio-integration.txt
- Recibe: `?mes=N&anio=YYYY`
- Accion: Calcula alertas (revision pendiente, recurrentes faltantes, inactividad, mes vacio)
- Responde: `{ alertas[], nivel_global, total_gastos, dias_sin_registro, recurrentes_faltantes[] }`

#### 7. GET /api/whatsapp/webhook
- Fuente: whatsapp-integration.txt
- Accion: Verificacion Twilio (responde 200 OK)

#### 8. POST /api/whatsapp/webhook
- Fuente: whatsapp-integration.txt
- Recibe: FormData de Twilio (From, Body, NumMedia, MediaUrl0, MediaContentType0)
- Accion: Valida numero autorizado, descarga imagen, corre 3 agentes, auto-confirma o marca revision, responde por WhatsApp
- Mapa de numeros autorizados: `NUMEROS_AUTORIZADOS` (hardcoded, actualizar con numeros reales)

---

## PARTE B — INDEX.HTML

### B.1 Adiciones al `<head>`

**De pwa-integration.txt:**

```html
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0d0f0e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

### B.2 Adiciones CSS (dentro de `<style>`)

| Feature | Clases | Insertar |
|---------|--------|----------|
| Recurrentes | `.rec-ok`, `.rec-warn`, `.rec-dot`, `.rec-summary`, `@keyframes pulse` | Antes de `/* -- Main content -- */` |
| Document Viewer | `.preview-panel.has-viewer`, `.preview-viewer`, `.preview-fields-col` + media queries | Antes de `</style>` |
| Charts | `.chart-section`, `.btn-tendencias`, `.chart-container`, `.chart-loading`, `#tendencias-canvas` | Al final antes de `</style>` |
| Comparativo | `#comp-overlay`, `.comp-controls`, `.comp-field`, `.comp-result-table`, `.comp-up/down/neutral`, `.comp-pct`, `.comp-summary`, `.comp-empty` | Despues de estilos `.dian-*` |
| Recordatorios | `.estado-banner`, `.estado-icon`, `.estado-resumen`, `.estado-alertas`, `.estado-alerta`, `.estado-dismiss` + variantes green/yellow/red | Despues de estilos `.upload-bar` |

### B.3 Adiciones HTML — Sidebar `<nav>`

Orden de secciones en el sidebar (de arriba a abajo):

1. **(existente)** Periodo
2. **(existente)** DIAN
3. **NUEVO** Banco (cruce-banco-integration.txt)
   ```html
   <div class="nav-section">
     <div class="nav-label">Banco</div>
     <div class="nav-item" onclick="document.getElementById('banco-file').click()" style="color:var(--accent2)">
       <div class="nav-dot" style="background:var(--accent2)"></div> Cruce Bancario
     </div>
     <input type="file" id="banco-file" accept=".xlsx,.xls,.csv" style="display:none" onchange="procesarBanco(this.files[0])">
   </div>
   ```
4. **NUEVO** Recurrentes (recurrentes-integration.txt)
   ```html
   <div class="nav-section" id="recurrentes-section" style="display:none">
     <div class="nav-label">Recurrentes</div>
     <div id="recurrentes-warn"></div>
   </div>
   ```
5. **(existente)** Exportar — modificar para agregar PDF Fiscal:
   ```html
   <div class="nav-item" onclick="exportarPDF()" style="color:var(--accent)">
     <div class="nav-dot"></div> PDF Fiscal
   </div>
   ```
   (Va ANTES de Excel y CSV)
6. **NUEVO** Analisis (comparativo-integration.txt)
   ```html
   <div class="nav-section">
     <div class="nav-label">Analisis</div>
     <div class="nav-item" onclick="abrirComparativo()" style="color:var(--accent2)">
       <div class="nav-dot" style="background:var(--accent2)"></div> Comparativo
     </div>
   </div>
   ```
7. **NUEVO** Opciones (autoconfirm-integration.txt)
   ```html
   <div class="nav-section">
     <div class="nav-label">Opciones</div>
     <label class="nav-item" style="cursor:pointer;gap:8px;">
       <input type="checkbox" id="chk-autoconfirm"
         onchange="localStorage.setItem('autoConfirm', this.checked ? '1' : '0')"
         style="accent-color:var(--accent);width:14px;height:14px;">
       Auto-confirmar conocidos
     </label>
   </div>
   ```

### B.4 Adiciones HTML — Modals/Overlays (despues de los modals existentes)

1. **Cruce Bancario modal** (cruce-banco-integration.txt)
   - `div#banco-overlay.dian-overlay` con tabla de resultados (conciliados, sin soporte, solo en sistema)
   - Boton exportar Excel

2. **Comparativo modal** (comparativo-integration.txt)
   - `div#comp-overlay` con inputs type="month", boton Comparar
   - Tabla de resultados por categoria con diferencias y porcentajes

### B.5 Adiciones HTML — Banner de estado (recordatorio-integration.txt)

Insertar DESPUES de `.upload-bar`, ANTES de `.processing-bar`:

```html
<div class="estado-banner hidden" id="estado-banner">
  <span class="estado-icon" id="estado-icon"></span>
  <span class="estado-resumen" id="estado-resumen"></span>
  <div class="estado-alertas" id="estado-alertas"></div>
  <button class="estado-dismiss" id="estado-dismiss" title="Ocultar este mes">&times;</button>
</div>
```

### B.6 Adiciones HTML — Document Viewer (viewer-integration.txt)

Modificar `<div class="preview-body">` existente para agregar:
- `div.preview-viewer` con `<img>` e `<iframe>` (ambos ocultos por defecto)
- Envolver fields existentes en `div.preview-fields-col`

### B.7 Adiciones JavaScript (dentro de `<script>`)

#### Funciones nuevas (agregar antes del DOMContentLoaded):

| Feature | Funciones | Fuente |
|---------|-----------|--------|
| PDF Report | `exportarPDF()` | report-integration.txt |
| Recurrentes | `loadRecurrentes()`, `mesNombre()` | recurrentes-integration.txt |
| Cruce Banco | `procesarBanco()`, `renderBancoResults()`, `exportarCruceBanco()`, `cerrarBanco()` | cruce-banco-integration.txt |
| Utilidades banco | `findCol()`, `parseNum()`, `parseDate()`, `loadSheetJS()` | cruce-banco-integration.txt |
| Document Viewer | `updateDocViewer()` | viewer-integration.txt |
| Comparativo | `abrirComparativo()`, `cerrarComparativo()`, `ejecutarComparativo()`, `nombreMes()`, `renderComparativo()` | comparativo-integration.txt |
| Recordatorios | `loadEstadoMes()`, `getEstadoDismissKey()`, `isEstadoDismissed()`, `dismissEstado()`, `formatCOP()` | recordatorio-integration.txt |

#### Modificaciones a funciones existentes:

1. **showPreview()** — agregar `updateDocViewer(p.archivo_r2 || null)` despues de `previewData = p;`
2. **cancelarPreview()** — agregar `updateDocViewer(null)` despues de remover clase 'show'
3. **handleFiles()** — agregar `auto_confirm` a FormData + manejar `data.auto_confirmado` + contadores separados + reload tabla si hay auto-confirmados
4. **DOMContentLoaded** — agregar llamadas:
   ```js
   loadRecurrentes();
   loadEstadoMes();
   // Restore auto-confirm checkbox
   const chk = document.getElementById('chk-autoconfirm');
   if (chk) chk.checked = localStorage.getItem('autoConfirm') === '1';
   ```

#### Script separado (antes de `</body>`):

**Charts** (charts-integration.txt) — bloque `<script>` autocontenido con IIFE que:
- Inyecta boton "Tendencias" y canvas al inicio de `<main>`
- Carga Chart.js dinamicamente desde CDN
- Renderiza stacked bars (top 5 categorias + Otras) + linea de tendencia total

### B.8 Service Worker (antes de `</body>`)

**De pwa-integration.txt:**

```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
</script>
```

---

## PARTE C — ARCHIVOS NUEVOS

| Archivo | Feature | Descripcion |
|---------|---------|-------------|
| `report-pdf.js` | PDF Report | Modulo que exporta `generateReport(registros, desde, hasta)` — genera PDF binario con header COCICP, resumen, desglose categorias, analisis deducibilidad |
| `recurrentes.js` | Recurrentes | Modulo que exporta `RECURRENTES` (array 6 proveedores) y `checkRecurrentes(db, mes, anio)` |
| `manifest.json` | PWA | Manifest para index.html (Dashboard) |
| `manifest-captura.json` | PWA | Manifest para app.html (Captura) |
| `sw.js` | PWA | Service Worker para cache offline |

---

## PARTE D — WRANGLER.TOML

### Adiciones a [vars]:

```toml
[vars]
ENVIRONMENT = "production"
TWILIO_WHATSAPP_FROM = "whatsapp:+14155238886"
FRONTEND_URL = "https://cocicp.davidduque.com"
```

### Nuevos secrets (via `wrangler secret put`):

```bash
wrangler secret put TWILIO_ACCOUNT_SID
wrangler secret put TWILIO_AUTH_TOKEN
# (ANTHROPIC_API_KEY ya debe estar configurado)
```

---

## PARTE E — APP.HTML (Captura)

### Adiciones PWA al `<head>`:

```html
<link rel="manifest" href="/manifest-captura.json">
<meta name="theme-color" content="#0d0f0e">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
```

### Service Worker antes de `</body>`:

```html
<script>
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js');
  }
</script>
```

---

## PARTE F — ORDEN DE IMPLEMENTACION SUGERIDO

Agrupar por dependencias y complejidad:

### Fase 1 — Solo frontend (no requiere Worker)
1. PWA (manifest + sw.js + tags en HTML)
2. Document Viewer (CSS + HTML + JS en index.html)

### Fase 2 — Endpoints simples + frontend
3. Recordatorios DIAN (GET /api/estado-mes + banner)
4. Recurrentes (GET /api/recurrentes + sidebar)
5. PDF Fiscal (GET /api/reporte + boton + report-pdf.js)

### Fase 3 — Features de analisis
6. Tendencias/Charts (GET /api/tendencias + Chart.js)
7. Comparativo (GET /api/comparativo + modal)

### Fase 4 — Features de procesamiento
8. Cruce Bancario (POST /api/cruce-banco + modal + SheetJS)
9. Auto-Confirm (modifica POST /api/upload + sidebar checkbox + handleFiles)

### Fase 5 — Integracion externa
10. WhatsApp/Twilio (webhook + secrets + setup Twilio)

---

## PARTE G — DEPENDENCIAS EXTERNAS

| Libreria | Uso | Carga |
|----------|-----|-------|
| Chart.js 4.x | Tendencias (charts) | CDN dinamico: `cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js` |
| SheetJS (XLSX) | Cruce Bancario (leer Excel) | Ya incluido/cargado via `loadSheetJS()` existente |

---

## PARTE H — RESUMEN DE ENDPOINTS FINALES

Despues de integrar todo, el Worker tendra estos endpoints:

| Metodo | Ruta | Feature |
|--------|------|---------|
| POST | /api/upload | Existente + auto-confirm |
| POST | /api/confirm | Existente |
| GET | /api/gastos | Existente |
| GET | /api/reporte | PDF Fiscal |
| GET | /api/recurrentes | Recurrentes |
| POST | /api/cruce-banco | Cruce Bancario |
| GET | /api/tendencias | Charts |
| GET | /api/comparativo | Comparativo |
| GET | /api/estado-mes | Recordatorios |
| GET | /api/whatsapp/webhook | WhatsApp verificacion |
| POST | /api/whatsapp/webhook | WhatsApp recepcion |
