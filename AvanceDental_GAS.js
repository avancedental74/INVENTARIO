// ═══════════════════════════════════════════════════════════════
//  AVANCE DENTAL — Google Apps Script Backend  v3.1
//  Compatible con index.html v3.1 (parche MVF)
//
//  INSTALACIÓN:
//    1. Abre tu Google Sheet → Extensiones → Apps Script
//    2. Borra todo el código existente y pega este archivo completo
//    3. Guarda (Ctrl+S)
//    4. Clic en "Implementar" → "Nueva implementación"
//       · Tipo: Aplicación web
//       · Ejecutar como: Yo (tu cuenta Google)
//       · Acceso: Cualquier usuario (Anyone)
//    5. Copia la URL que aparece y pégala en la app
//       (Ajustes → Google Sheets → pega la URL → Conectar)
//    6. Si cambias el código: Implementar → Gestionar implementaciones
//       → edita la implementación existente → "Nueva versión" → Actualizar
//
//  ESTRUCTURA DE LA HOJA "Inventario":
//    Col A: id (número)
//    Col B: nombre
//    Col C: categoria
//    Col D: stock (número)
//    Col E: minimo (número)
//    Col F: updatedAt (timestamp ms — nuevo en v3.1)
//
//  ESTRUCTURA DE LA HOJA "Meta":
//    Col A: key
//    Col B: value (JSON serializado)
//
//  CONTRATO JSON (frontend ↔ backend):
//    GET  ?action=ping          → { ok, version, serverTs }
//    GET  ?action=getAll        → { ok, products[], categories[], quickIds[], compraList[], history[], serverTs }
//    POST { action:'useStock',  id, qty, device }          → { ok, stock, conflict }
//    POST { action:'addStock',  id, qty, device }          → { ok, stock }
//    POST { action:'editProduct', id, changes{}, device }  → { ok }
//    POST { action:'addProduct',  product{}, device }      → { ok, id }
//    POST { action:'deleteProduct', id, device }           → { ok }
//    POST { action:'addAllProducts', products[], categories[], quickIds[], compraList[], device } → { ok, count }
//    POST { action:'setMeta', key, value, device }         → { ok }
//    Errores siempre: { ok: false, error: '...' }
// ═══════════════════════════════════════════════════════════════

const SHEET_INVENTORY = 'Inventario';
const SHEET_META      = 'Meta';
const GAS_VERSION     = '3.1';

// Columnas de la hoja Inventario (base 1)
const COL_ID         = 1;
const COL_NOMBRE     = 2;
const COL_CATEGORIA  = 3;
const COL_STOCK      = 4;
const COL_MINIMO     = 5;
const COL_UPDATED_AT = 6;

// ── Punto de entrada GET ─────────────────────────────────────
function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || '';

    if (action === 'ping') {
      return jsonResponse({ ok: true, version: GAS_VERSION, serverTs: Date.now() });
    }

    if (action === 'getAll') {
      return jsonResponse(handleGetAll());
    }

    return jsonResponse({ ok: false, error: 'Acción GET no reconocida: ' + action });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ── Punto de entrada POST ────────────────────────────────────
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || '';

    switch (action) {
      case 'useStock':       return jsonResponse(handleUseStock(body));
      case 'addStock':       return jsonResponse(handleAddStock(body));
      case 'editProduct':    return jsonResponse(handleEditProduct(body));
      case 'addProduct':     return jsonResponse(handleAddProduct(body));
      case 'deleteProduct':  return jsonResponse(handleDeleteProduct(body));
      case 'addAllProducts': return jsonResponse(handleAddAllProducts(body));
      case 'setMeta':        return jsonResponse(handleSetMeta(body));
      default:
        return jsonResponse({ ok: false, error: 'Acción POST no reconocida: ' + action });
    }
  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

// ═══════════════════════════════════════════════════════════════
//  HANDLERS
// ═══════════════════════════════════════════════════════════════

// ── getAll: devuelve el inventario completo ──────────────────
function handleGetAll() {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const data  = sheet.getDataRange().getValues();

  const products = [];
  for (let i = 1; i < data.length; i++) {  // fila 0 = cabecera
    const row = data[i];
    if (!row[COL_ID - 1] && row[COL_ID - 1] !== 0) continue; // fila vacía
    products.push({
      id:        Number(row[COL_ID - 1]),
      nombre:    String(row[COL_NOMBRE - 1] || ''),
      categoria: String(row[COL_CATEGORIA - 1] || ''),
      stock:     Number(row[COL_STOCK - 1] || 0),
      minimo:    Number(row[COL_MINIMO - 1] || 2),
      updatedAt: Number(row[COL_UPDATED_AT - 1] || 0),
    });
  }

  return {
    ok:          true,
    products:    products,
    categories:  getMeta('categories') || [],
    quickIds:    getMeta('quickIds')   || [],
    compraList:  getMeta('compraList') || [],
    history:     getMeta('history')    || [],
    serverTs:    Date.now(),
  };
}

// ── useStock: descuenta qty del stock actual en Sheets ───────
// Operación atómica: usa LockService para evitar race conditions
// si dos dispositivos envían useStock al mismo tiempo.
function handleUseStock(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000); // espera hasta 10s para obtener el lock
  try {
    const sheet = getOrCreateSheet(SHEET_INVENTORY);
    const row   = findRowById(sheet, Number(body.id));
    if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

    const currentStock = Number(sheet.getRange(row, COL_STOCK).getValue());
    const clientStock  = body.clientStock !== undefined ? Number(body.clientStock) : undefined;

    // Detectar conflicto: el cliente tenía un stock distinto al actual en Sheets
    const conflict = (clientStock !== undefined && clientStock !== currentStock);

    // Siempre descontamos del valor real en Sheets (no del valor del cliente)
    // Esto garantiza que no se pierda ningún descuento aunque lleguen casi simultáneos
    const newStock  = Math.max(0, currentStock - Number(body.qty || 0));
    const updatedAt = Date.now();

    sheet.getRange(row, COL_STOCK).setValue(newStock);
    sheet.getRange(row, COL_UPDATED_AT).setValue(updatedAt);

    return { ok: true, stock: newStock, updatedAt: updatedAt, conflict: conflict };
  } finally {
    lock.releaseLock();
  }
}

// ── addStock: suma qty al stock actual ───────────────────────
function handleAddStock(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet(SHEET_INVENTORY);
    const row   = findRowById(sheet, Number(body.id));
    if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

    const currentStock = Number(sheet.getRange(row, COL_STOCK).getValue());
    const newStock     = currentStock + Number(body.qty || 0);
    const updatedAt    = Date.now();

    sheet.getRange(row, COL_STOCK).setValue(newStock);
    sheet.getRange(row, COL_UPDATED_AT).setValue(updatedAt);

    return { ok: true, stock: newStock, updatedAt: updatedAt };
  } finally {
    lock.releaseLock();
  }
}

// ── editProduct: modifica campos de un producto ──────────────
function handleEditProduct(body) {
  const sheet   = getOrCreateSheet(SHEET_INVENTORY);
  const row     = findRowById(sheet, Number(body.id));
  if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

  const changes   = body.changes || {};
  const updatedAt = Date.now();

  if (changes.nombre    !== undefined) sheet.getRange(row, COL_NOMBRE).setValue(changes.nombre);
  if (changes.categoria !== undefined) sheet.getRange(row, COL_CATEGORIA).setValue(changes.categoria);
  if (changes.stock     !== undefined) sheet.getRange(row, COL_STOCK).setValue(Number(changes.stock));
  if (changes.minimo    !== undefined) sheet.getRange(row, COL_MINIMO).setValue(Number(changes.minimo));
  sheet.getRange(row, COL_UPDATED_AT).setValue(updatedAt);

  return { ok: true, updatedAt: updatedAt };
}

// ── addProduct: añade una fila nueva ────────────────────────
function handleAddProduct(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const p     = body.product || {};

  // Generar ID: max(ids existentes) + 1
  const newId     = getNextId(sheet);
  const updatedAt = Date.now();

  sheet.appendRow([
    newId,
    String(p.nombre    || ''),
    String(p.categoria || ''),
    Number(p.stock     || 0),
    Number(p.minimo    || 2),
    updatedAt,
  ]);

  return { ok: true, id: newId, updatedAt: updatedAt };
}

// ── deleteProduct: elimina la fila del producto ──────────────
function handleDeleteProduct(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const row   = findRowById(sheet, Number(body.id));
  if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

  sheet.deleteRow(row);
  return { ok: true };
}

// ── addAllProducts: migración inicial — sube todo el inventario
// Borra las filas existentes (excepto cabecera) y recrea desde cero.
function handleAddAllProducts(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);

  // Borrar filas de datos (mantener fila 1 = cabecera)
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  const products  = body.products  || [];
  const now       = Date.now();
  const rows      = products.map(p => [
    Number(p.id        || 0),
    String(p.nombre    || ''),
    String(p.categoria || ''),
    Number(p.stock     || 0),
    Number(p.minimo    || 2),
    Number(p.updatedAt || now),
  ]);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  }

  // Guardar también los metadatos que vengan con la migración
  if (body.categories) setMeta('categories', body.categories);
  if (body.quickIds)   setMeta('quickIds',   body.quickIds);
  if (body.compraList) setMeta('compraList', body.compraList);

  return { ok: true, count: rows.length };
}

// ── setMeta: guarda un valor clave/valor en hoja Meta ────────
function handleSetMeta(body) {
  if (!body.key) return { ok: false, error: 'key requerida' };
  setMeta(body.key, body.value);
  return { ok: true };
}

// ═══════════════════════════════════════════════════════════════
//  UTILIDADES INTERNAS
// ═══════════════════════════════════════════════════════════════

// ── Hoja: obtener o crear con cabecera ───────────────────────
function getOrCreateSheet(name) {
  const ss    = SpreadsheetApp.getActiveSpreadsheet();
  let sheet   = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === SHEET_INVENTORY) {
      sheet.getRange(1, 1, 1, 6).setValues([['id', 'nombre', 'categoria', 'stock', 'minimo', 'updatedAt']]);
      sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
      sheet.setFrozenRows(1);
    } else if (name === SHEET_META) {
      sheet.getRange(1, 1, 1, 2).setValues([['key', 'value']]);
      sheet.getRange(1, 1, 1, 2).setFontWeight('bold');
      sheet.setFrozenRows(1);
    }
  }
  return sheet;
}

// ── Buscar fila por ID (devuelve número de fila 1-based, 0 si no existe)
function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][COL_ID - 1]) === id) return i + 1; // +1 porque getValues es 0-based
  }
  return 0;
}

// ── Calcular siguiente ID libre ──────────────────────────────
function getNextId(sheet) {
  const data = sheet.getDataRange().getValues();
  let maxId  = 0;
  for (let i = 1; i < data.length; i++) {
    const id = Number(data[i][COL_ID - 1]);
    if (id > maxId) maxId = id;
  }
  return maxId + 1;
}

// ── Meta: leer valor ─────────────────────────────────────────
function getMeta(key) {
  try {
    const sheet = getOrCreateSheet(SHEET_META);
    const data  = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === key) {
        const raw = data[i][1];
        return (typeof raw === 'string' && raw) ? JSON.parse(raw) : raw;
      }
    }
    return null;
  } catch(e) {
    return null;
  }
}

// ── Meta: guardar/actualizar valor ───────────────────────────
function setMeta(key, value) {
  const sheet = getOrCreateSheet(SHEET_META);
  const data  = sheet.getDataRange().getValues();
  const json  = JSON.stringify(value);

  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(json);
      return;
    }
  }
  // No existe → añadir fila nueva
  sheet.appendRow([key, json]);
}

// ── Respuesta JSON con cabeceras CORS ────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
