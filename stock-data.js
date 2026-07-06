/* stock-data.js — capa de datos v0.1.0
   Modelo:
   - stk_productos: { [ean]: {ean, nombre, rubro, guarda, minimo, notas} }
   - stk_lotes: [{ id, ean, fechaIngreso, vencimiento, proveedor, precio, cantidad, cantidadRestante, estado }]
   - stk_cola: [{ id, ean, tipo:'reponer'|'consumir', productoNuevo:bool, timestamp, procesado:bool }]
   NOTA: por ahora todo vive en localStorage del mismo dispositivo. La sincronización
   móvil -> Drive -> PC se agrega en la próxima etapa sin tener que tocar este modelo.
*/
const StockDB = (() => {
  const KEYS = { productos: 'stk_productos', lotes: 'stk_lotes', cola: 'stk_cola', movimientos: 'stk_movimientos' };

  const _get = (k, def) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch (e) { console.error('StockDB read error', k, e); return def; }
  };
  const _set = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { console.error('StockDB write error', k, e); return false; }
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const hoy = () => new Date().toISOString().slice(0, 10);

  // ---------- Productos ----------
  function getProducto(ean) { return _get(KEYS.productos, {})[ean] || null; }
  function listProductos() {
    return Object.values(_get(KEYS.productos, {})).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
  }
  function upsertProducto(p) {
    const all = _get(KEYS.productos, {});
    all[p.ean] = { minimo: 2, guarda: '', notas: '', ...all[p.ean], ...p };
    _set(KEYS.productos, all);
    return all[p.ean];
  }

  // ---------- Lotes ----------
  function listLotes() { return _get(KEYS.lotes, []); }
  function lotesDe(ean) { return listLotes().filter(l => l.ean === ean); }
  function lotesActivos(ean) {
    return lotesDe(ean).filter(l => l.estado === 'activo' && l.cantidadRestante > 0)
      .sort((a, b) => (a.vencimiento || '9999').localeCompare(b.vencimiento || '9999'));
  }
  function stockDe(ean) { return lotesActivos(ean).reduce((s, l) => s + l.cantidadRestante, 0); }

  function agregarLote({ ean, cantidad, vencimiento, proveedor, precio, fechaIngreso }) {
    const lotes = listLotes();
    const lote = {
      id: uid(), ean, fechaIngreso: fechaIngreso || hoy(),
      vencimiento: vencimiento || null, proveedor: proveedor || '', precio: precio || null,
      cantidad: Number(cantidad) || 1, cantidadRestante: Number(cantidad) || 1,
      estado: 'activo'
    };
    lotes.push(lote);
    _set(KEYS.lotes, lotes);
    registrarMovimiento(ean, 'ingreso', lote.cantidad, lote.fechaIngreso);
    return lote;
  }

  // Consume 1 unidad del lote más próximo a vencer (FEFO). Devuelve el lote afectado o null si no hay stock.
  function editarLote(loteId, cambios) {
    const lotes = listLotes();
    const lote = lotes.find(l => l.id === loteId);
    if (!lote) return false;
    Object.assign(lote, cambios);
    _set(KEYS.lotes, lotes);
    return true;
  }

  function consumirUno(ean) {
    const lotes = listLotes();
    const activos = lotes.filter(l => l.ean === ean && l.estado === 'activo' && l.cantidadRestante > 0)
      .sort((a, b) => (a.vencimiento || '9999').localeCompare(b.vencimiento || '9999'));
    if (!activos.length) return null;
    const lote = activos[0];
    lote.cantidadRestante -= 1;
    lote.fechaUltimoEgreso = hoy();
    if (lote.cantidadRestante <= 0) lote.estado = 'consumido';
    _set(KEYS.lotes, lotes);
    registrarMovimiento(ean, 'consumo', 1, hoy());
    return lote;
  }

  // ---------- Cola de escaneos (pendientes de completar en PC) ----------
  function listCola() { return _get(KEYS.cola, []).filter(c => !c.procesado); }
  function encolarEscaneo({ ean, tipo, productoNuevo, sugerido }) {
    const cola = _get(KEYS.cola, []);
    const item = { id: uid(), ean, tipo, productoNuevo: !!productoNuevo, sugerido: sugerido || null, timestamp: Date.now(), procesado: false };
    cola.push(item);
    _set(KEYS.cola, cola);
    return item;
  }
  function marcarProcesado(id) {
    const cola = _get(KEYS.cola, []);
    const it = cola.find(c => c.id === id);
    if (it) it.procesado = true;
    _set(KEYS.cola, cola);
  }

  // ---------- Vencimientos / alertas ----------
  function proximosAVencer(diasUmbral = 5) {
    return listLotes()
      .filter(l => l.estado === 'activo' && l.cantidadRestante > 0 && l.vencimiento)
      .map(l => ({ ...l, dias: Math.ceil((new Date(l.vencimiento) - new Date()) / 86400000) }))
      .filter(l => l.dias <= diasUmbral)
      .sort((a, b) => a.dias - b.dias);
  }
  function bajoMinimo() {
    return listProductos().filter(p => stockDe(p.ean) < (p.minimo ?? 2))
      .map(p => ({ ...p, stock: stockDe(p.ean) }));
  }

  function eliminarProducto(ean) {
    const productos = _get(KEYS.productos, {});
    delete productos[ean];
    _set(KEYS.productos, productos);
    // se eliminan también sus lotes, para no dejar historial huérfano
    const lotes = listLotes().filter(l => l.ean !== ean);
    _set(KEYS.lotes, lotes);
    // se descartan pendientes en cola de tipo "consumir" para este ean (ya no hay nada que descontar);
    // los de tipo "reponer" se conservan, van a re-ofrecerse como alta de producto nuevo
    const cola = _get(KEYS.cola, []).map(c =>
      (c.ean === ean && c.tipo === 'consumir' && !c.procesado) ? { ...c, procesado: true, descartadoPorBorrado: true } : c
    );
    _set(KEYS.cola, cola);
  }

  function mezclarColaRemota(itemsRemotos) {
    const cola = _get(KEYS.cola, []);
    const idsLocales = new Set(cola.map(c => c.id));
    let agregados = 0;
    (itemsRemotos || []).forEach(it => {
      if (!idsLocales.has(it.id)) { cola.push(it); agregados++; }
    });
    if (agregados) _set(KEYS.cola, cola);
    return agregados;
  }

  function listProveedores() {
    const set = new Set();
    listLotes().forEach(l => { if (l.proveedor && l.proveedor.trim()) set.add(l.proveedor.trim()); });
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  // ---------- Respaldo: snapshots locales (máx 10) + export/import completo ----------
  const SNAP_KEY = 'stk_snapshots';

  function exportarTodo() {
    return {
      productos: _get(KEYS.productos, {}),
      lotes: _get(KEYS.lotes, []),
      cola: _get(KEYS.cola, []),
      movimientos: _get(KEYS.movimientos, []),
      guardado: Date.now()
    };
  }

  function guardarSnapshot() {
    try {
      const snaps = _get(SNAP_KEY, []);
      snaps.push(exportarTodo());
      if (snaps.length > 10) snaps.splice(0, snaps.length - 10);
      _set(SNAP_KEY, snaps);
      return true;
    } catch (e) { console.error('Error al guardar snapshot', e); return false; }
  }

  function listSnapshots() { return _get(SNAP_KEY, []); }

  function restaurarSnapshot(indice) {
    const snaps = listSnapshots();
    const snap = snaps[indice];
    if (!snap) return false;
    _set(KEYS.productos, snap.productos || {});
    _set(KEYS.lotes, snap.lotes || []);
    _set(KEYS.cola, snap.cola || []);
    return true;
  }

  function importarTodo(data) {
    if (!data || typeof data !== 'object') return false;
    _set(KEYS.productos, data.productos || {});
    _set(KEYS.lotes, data.lotes || []);
    _set(KEYS.cola, data.cola || []);
    _set(KEYS.movimientos, data.movimientos || []);
    return true;
  }

  // ---------- Movimientos: historial de ingresos y consumos ----------
  function registrarMovimiento(ean, tipo, cantidad, fecha) {
    const movs = _get(KEYS.movimientos, []);
    movs.push({ id: uid(), ean, tipo, cantidad, fecha: fecha || hoy(), timestamp: Date.now() });
    if (movs.length > 2000) movs.splice(0, movs.length - 2000); // límite razonable
    _set(KEYS.movimientos, movs);
  }
  function listMovimientos() {
    return _get(KEYS.movimientos, []).sort((a, b) => b.timestamp - a.timestamp);
  }

  return {
    getProducto, listProductos, upsertProducto, eliminarProducto,
    listLotes, lotesDe, lotesActivos, stockDe, agregarLote, editarLote, consumirUno,
    listCola, encolarEscaneo, marcarProcesado, mezclarColaRemota,
    proximosAVencer, bajoMinimo, listProveedores, listMovimientos,
    exportarTodo, guardarSnapshot, listSnapshots, restaurarSnapshot, importarTodo,
    uid, hoy
  };
})();
