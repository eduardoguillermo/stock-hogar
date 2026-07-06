/* stock-data.js — capa de datos v0.1.0
   Modelo:
   - stk_productos: { [ean]: {ean, nombre, rubro, guarda, minimo, notas} }
   - stk_lotes: [{ id, ean, fechaIngreso, vencimiento, proveedor, precio, cantidad, cantidadRestante, estado }]
   - stk_cola: [{ id, ean, tipo:'reponer'|'consumir', productoNuevo:bool, timestamp, procesado:bool }]
   NOTA: por ahora todo vive en localStorage del mismo dispositivo. La sincronización
   móvil -> Drive -> PC se agrega en la próxima etapa sin tener que tocar este modelo.
*/
const StockDB = (() => {
  const KEYS = { productos: 'stk_productos', lotes: 'stk_lotes', cola: 'stk_cola' };

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
  function listProductos() { return Object.values(_get(KEYS.productos, {})); }
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
    return lote;
  }

  // Consume 1 unidad del lote más próximo a vencer (FEFO). Devuelve el lote afectado o null si no hay stock.
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
    return lote;
  }

  // ---------- Cola de escaneos (pendientes de completar en PC) ----------
  function listCola() { return _get(KEYS.cola, []).filter(c => !c.procesado); }
  function encolarEscaneo({ ean, tipo, productoNuevo }) {
    const cola = _get(KEYS.cola, []);
    const item = { id: uid(), ean, tipo, productoNuevo: !!productoNuevo, timestamp: Date.now(), procesado: false };
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
    const limite = new Date(); limite.setDate(limite.getDate() + diasUmbral);
    return listLotes()
      .filter(l => l.estado === 'activo' && l.cantidadRestante > 0 && l.vencimiento)
      .map(l => ({ ...l, dias: Math.ceil((new Date(l.vencimiento) - new Date()) / 86400000) }))
      .sort((a, b) => a.dias - b.dias);
  }
  function bajoMinimo() {
    return listProductos().filter(p => stockDe(p.ean) < (p.minimo ?? 2))
      .map(p => ({ ...p, stock: stockDe(p.ean) }));
  }

  return {
    getProducto, listProductos, upsertProducto,
    listLotes, lotesDe, lotesActivos, stockDe, agregarLote, consumirUno,
    listCola, encolarEscaneo, marcarProcesado,
    proximosAVencer, bajoMinimo, uid, hoy
  };
})();
