// ═══════════════════════════════════════════════════════════════
//  AVANCE DENTAL — Google Apps Script Backend  v3.3
//  Compatible con index.html v3.3 (Sync Multi-Device)
// ═══════════════════════════════════════════════════════════════

const SHEET_INVENTORY = 'Inventario';
const SHEET_META      = 'Meta';
const GAS_VERSION     = '3.3';

// Columnas de la hoja Inventario (base 1)
const COL_ID         = 1;
const COL_NOMBRE     = 2;
const COL_CATEGORIA  = 3;
const COL_STOCK      = 4;
const COL_MINIMO     = 5;
const COL_UPDATED_AT = 6;

function doGet(e) {
  try {
    const params = e.parameter || {};
    const action = params.action || '';
    if (action === 'ping') return jsonResponse({ ok: true, version: GAS_VERSION, serverTs: Date.now() });
    if (action === 'getAll') return jsonResponse(handleGetAll());
    return jsonResponse({ ok: false, error: 'Acción GET no reconocida: ' + action });
  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

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
      case 'mergeProducts':  return jsonResponse(handleMergeProducts(body));
      default: return jsonResponse({ ok: false, error: 'Acción POST no reconocida: ' + action });
    }
  } catch(err) {
    return jsonResponse({ ok: false, error: err.message });
  }
}

function handleGetAll() {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const data  = sheet.getDataRange().getValues();
  const products = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[COL_ID - 1] && row[COL_ID - 1] !== 0) continue;
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
    ok: true,
    products,
    categories: getMeta('categories') || [],
    quickIds:   getMeta('quickIds')   || [],
    compraList: getMeta('compraList') || [],
    history:    getMeta('history')    || [],
    serverTs:   Date.now(),
  };
}

function handleUseStock(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet(SHEET_INVENTORY);
    const row   = findRowById(sheet, Number(body.id));
    if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

    const currentStock = Number(sheet.getRange(row, COL_STOCK).getValue());
    const clientStock  = body.clientStock !== undefined ? Number(body.clientStock) : undefined;
    const conflict     = (clientStock !== undefined && clientStock !== currentStock);

    const newStock  = Math.max(0, currentStock - Number(body.qty || 0));
    const updatedAt = Date.now();

    sheet.getRange(row, COL_STOCK).setValue(newStock);
    sheet.getRange(row, COL_UPDATED_AT).setValue(updatedAt);

    return { ok: true, stock: newStock, updatedAt, conflict, serverStock: currentStock };
  } finally {
    lock.releaseLock();
  }
}

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

    return { ok: true, stock: newStock, updatedAt };
  } finally {
    lock.releaseLock();
  }
}

function handleEditProduct(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const row   = findRowById(sheet, Number(body.id));
  if (!row) return { ok: false, error: 'Producto no encontrado: ' + body.id };

  const changes = body.changes || {};
  const updatedAt = Date.now();

  if (changes.nombre    !== undefined) sheet.getRange(row, COL_NOMBRE).setValue(changes.nombre);
  if (changes.categoria !== undefined) sheet.getRange(row, COL_CATEGORIA).setValue(changes.categoria);
  if (changes.stock     !== undefined) sheet.getRange(row, COL_STOCK).setValue(Number(changes.stock));
  if (changes.minimo    !== undefined) sheet.getRange(row, COL_MINIMO).setValue(Number(changes.minimo));
  sheet.getRange(row, COL_UPDATED_AT).setValue(updatedAt);

  return { ok: true, updatedAt };
}

function handleAddProduct(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const p     = body.product || {};
  const newId = getNextId(sheet);
  const updatedAt = Date.now();

  sheet.appendRow([
    newId,
    String(p.nombre    || ''),
    String(p.categoria || ''),
    Number(p.stock     || 0),
    Number(p.minimo    || 2),
    updatedAt,
  ]);
  return { ok: true, id: newId, updatedAt };
}

function handleDeleteProduct(body) {
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const row   = findRowById(sheet, Number(body.id));
  if (!row) return { ok: false, error: 'Producto no encontrado' };
  sheet.deleteRow(row);
  return { ok: true };
}

function handleMergeProducts(body) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getOrCreateSheet(SHEET_INVENTORY);
    const incoming = body.products || [];
    const data = sheet.getDataRange().getValues();
    const existing = {};
    
    // Mapear lo que ya hay en el Sheet
    for (let i = 1; i < data.length; i++) {
       const id = Number(data[i][COL_ID - 1]);
       existing[id] = i + 1; // Guardar número de fila
    }

    let addedCount = 0;
    let updatedCount = 0;

    incoming.forEach(p => {
      const row = existing[p.id];
      const rowData = [
        Number(p.id),
        String(p.nombre),
        String(p.categoria),
        Number(p.stock),
        Number(p.minimo || 2),
        Number(p.updatedAt || Date.now())
      ];

      if (row) {
        const currentUpdatedAt = Number(sheet.getRange(row, COL_UPDATED_AT).getValue() || 0);
        const incomingUpdatedAt = Number(p.updatedAt || 0);

        // REGLA DE ORO: Solo sobreescribimos si el dato que llega es MÁS RECIENTE
        if (incomingUpdatedAt > currentUpdatedAt) {
          sheet.getRange(row, 1, 1, 6).setValues([rowData]);
          updatedCount++;
        }
      } else {
        sheet.appendRow(rowData);
        addedCount++;
      }
    });

    if (body.categories) setMeta('categories', body.categories);
    if (body.quickIds)   setMeta('quickIds',   body.quickIds);
    // Para compraList y history, al ser meta-datos, hacemos merge simple (concatenar no-duplicados)
    if (body.compraList) {
      const current = getMeta('compraList') || [];
      const merged = [...current];
      body.compraList.forEach(item => {
        if (!merged.find(m => m.id === item.id)) merged.push(item);
      });
      setMeta('compraList', merged);
    }

    return { ok: true, added: addedCount, updated: updatedCount };
  } finally {
    lock.releaseLock();
  }
}

function handleAddAllProducts(body) {
  // Solo usar para sobreescritura total inicial si se desea limpiar todo
  const sheet = getOrCreateSheet(SHEET_INVENTORY);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);

  const products = body.products || [];
  const rows = products.map(p => [
    Number(p.id), String(p.nombre), String(p.categoria), 
    Number(p.stock), Number(p.minimo), Number(p.updatedAt || Date.now())
  ]);

  if (rows.length > 0) sheet.getRange(2, 1, rows.length, 6).setValues(rows);
  return { ok: true, count: rows.length };
}

function handleSetMeta(body) {
  if (!body.key) return { ok: false, error: 'key requerida' };
  setMeta(body.key, body.value);
  return { ok: true };
}

// ── Helpers ──────────────────────────────────────────────────
function getOrCreateSheet(name) {
  const ss  = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
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

function findRowById(sheet, id) {
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (Number(data[i][COL_ID - 1]) === id) return i + 1;
  }
  return 0;
}

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

// ── Respuesta JSON ───────────────────────────────────────────
function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
