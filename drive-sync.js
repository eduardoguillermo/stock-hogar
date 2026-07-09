/* drive-sync.js — v0.3.0
   Sincroniza contra archivos en Drive, en una carpeta propia "StockEnCasa"
   para no mezclarse con otras apps. Maneja dos archivos:
   - escaneos_pendientes.json (cola de escaneos del celular)
   - stock_backup.json (respaldo completo: productos + lotes + cola)
   Requiere: CLIENT_ID de OAuth (mismo proyecto de Google Cloud que tus otras apps).
*/
const DriveSync = (() => {
  const CLIENT_ID = '1049169592532-is5j1j4s1bmgrc9tsq48slrgul8fbj17.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const CARPETA = 'StockEnCasa';
  const ARCHIVO_COLA = 'escaneos_pendientes.json';
  const ARCHIVO_BACKUP = 'stock_backup.json';

  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  const fileIds = {}; // cache de fileId por nombre de archivo
  let renewTimer = null;
  let _solicitando = false; // evita solicitudes de token superpuestas (init + conectar a la vez)
  const TOKEN_KEY = 'stk_drive_token';

  function log(...args) { console.log('[DriveSync]', ...args); }

  // Toda solicitud de token pasa por acá: si ya hay una en curso, no duplica
  function pedirToken(prompt) {
    if (_solicitando || !tokenClient) return;
    _solicitando = true;
    try { tokenClient.requestAccessToken({ prompt }); }
    catch (e) { _solicitando = false; log('requestAccessToken lanzó:', e); }
  }

  function guardarToken(token, expiresInSeg) {
    const vencimiento = Date.now() + (expiresInSeg * 1000) - 60000; // 1 min de margen
    localStorage.setItem(TOKEN_KEY, JSON.stringify({ token, vencimiento }));
  }
  function tokenGuardadoValido() {
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const { token, vencimiento } = JSON.parse(raw);
      if (Date.now() < vencimiento) return token;
      return null;
    } catch (e) { return null; }
  }

  function init(onReady) {
    if (!window.google || !google.accounts) {
      log('Google Identity Services todavía no cargó, reintentando...');
      setTimeout(() => init(onReady), 400);
      return;
    }
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (resp) => {
          _solicitando = false;
          if (resp.error) { log('Error de token', resp); return; }
          accessToken = resp.access_token;
          guardarToken(accessToken, resp.expires_in || 3600);
          programarRenovacion();
          if (onReady) onReady();
        },
        error_callback: (err) => { _solicitando = false; log('Intento de token falló (silencioso):', err && err.type); }
      });
    }
    // Si ya hay un token vigente guardado, lo reusamos sin pedir nada
    const guardado = tokenGuardadoValido();
    if (guardado) {
      accessToken = guardado;
      programarRenovacion();
      if (onReady) onReady();
    } else if (localStorage.getItem(TOKEN_KEY)) {
      // Hubo token antes pero venció: renovación silenciosa recién ahora, que
      // tokenClient ya existe. Antes el conectar() suelto corría con tokenClient
      // en null (GIS carga async) y la renovación podía no ocurrir nunca.
      // Si nunca hubo token, no se intenta nada: se conecta manualmente.
      pedirToken('');
    }
  }

  function conectar() {
    if (accessToken) return; // ya conectado (sesión en memoria o token guardado vigente)
    if (!tokenClient) { log('tokenClient no inicializado todavía'); return; }
    pedirToken(''); // intento silencioso; si init ya pidió, no duplica
  }

  function forzarReconexion() {
    accessToken = null;
    localStorage.removeItem(TOKEN_KEY);
    _solicitando = false; // acción manual del usuario: pisa cualquier intento colgado
    pedirToken('consent');
  }

  // Renovación silenciosa: se programa según el vencimiento real del token (o 50 min por defecto)
  function programarRenovacion() {
    if (renewTimer) clearTimeout(renewTimer);
    let delay = 50 * 60 * 1000;
    try {
      const raw = localStorage.getItem(TOKEN_KEY);
      if (raw) {
        const { vencimiento } = JSON.parse(raw);
        delay = Math.max(vencimiento - Date.now() - 60000, 5000); // 1 min antes de vencer
      }
    } catch (e) { /* usar delay por defecto */ }
    renewTimer = setTimeout(() => {
      pedirToken('');
    }, delay);
  }

  async function api(url, opts = {}) {
    const resp = await fetch(url, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${accessToken}` }
    });
    if (!resp.ok) throw new Error(`Drive API ${resp.status}: ${await resp.text()}`);
    return resp;
  }

  let _folderPromise = null;
  async function ensureFolder() {
    if (folderId) return folderId;
    if (_folderPromise) return _folderPromise; // ya hay una búsqueda/creación en curso: esperar esa misma
    _folderPromise = (async () => {
      const q = encodeURIComponent(`name='${CARPETA}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
      const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      const data = await resp.json();
      if (data.files && data.files.length) { folderId = data.files[0].id; return folderId; }

      const createResp = await api('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: CARPETA, mimeType: 'application/vnd.google-apps.folder' })
      });
      const created = await createResp.json();
      folderId = created.id;
      return folderId;
    })();
    try { return await _folderPromise; } finally { _folderPromise = null; }
  }

  const _filePromises = {}; // candado por nombre de archivo (cola y backup son independientes)
  async function ensureFile(nombreArchivo) {
    if (fileIds[nombreArchivo]) return fileIds[nombreArchivo];
    if (_filePromises[nombreArchivo]) return _filePromises[nombreArchivo]; // ídem: evita crear el archivo dos veces en paralelo
    _filePromises[nombreArchivo] = (async () => {
      await ensureFolder();
      const q = encodeURIComponent(`name='${nombreArchivo}' and '${folderId}' in parents and trashed=false`);
      const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      const data = await resp.json();
      if (data.files && data.files.length) { fileIds[nombreArchivo] = data.files[0].id; return fileIds[nombreArchivo]; }

      // Archivo no existe: se crea vacío
      fileIds[nombreArchivo] = await subirJSON(nombreArchivo, {}, true);
      return fileIds[nombreArchivo];
    })();
    try { return await _filePromises[nombreArchivo]; } finally { delete _filePromises[nombreArchivo]; }
  }

  async function subirJSON(nombreArchivo, obj, creando = false) {
    await ensureFolder();
    const boundary = 'stockencasa_boundary';
    const metadata = creando
      ? { name: nombreArchivo, parents: [folderId], mimeType: 'application/json' }
      : { mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;

    const url = creando
      ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      : `https://www.googleapis.com/upload/drive/v3/files/${fileIds[nombreArchivo]}?uploadType=multipart`;

    const resp = await api(url, {
      method: creando ? 'POST' : 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const data = await resp.json();
    return data.id;
  }

  async function descargarJSON(nombreArchivo) {
    await ensureFile(nombreArchivo);
    const resp = await api(`https://www.googleapis.com/drive/v3/files/${fileIds[nombreArchivo]}?alt=media`);
    return resp.json();
  }

  // ---------- Uso desde el escáner: sube la cola completa (pendientes) ----------
  async function subirCola(itemsCola) {
    await ensureFile(ARCHIVO_COLA);
    await subirJSON(ARCHIVO_COLA, { items: itemsCola, actualizado: Date.now() });
  }

  // ---------- Uso desde gestión PC: baja la cola remota ----------
  async function bajarCola() {
    try {
      const data = await descargarJSON(ARCHIVO_COLA);
      return data.items || [];
    } catch (e) {
      log('Error al bajar cola', e);
      return [];
    }
  }

  // ---------- Backup completo (productos + lotes + cola) ----------
  async function subirBackup(datosCompletos) {
    await ensureFile(ARCHIVO_BACKUP);
    await subirJSON(ARCHIVO_BACKUP, datosCompletos);
  }

  async function bajarBackup() {
    try {
      return await descargarJSON(ARCHIVO_BACKUP);
    } catch (e) {
      log('Error al bajar backup', e);
      return null;
    }
  }

  return {
    init, conectar, forzarReconexion,
    subirCola, bajarCola, subirBackup, bajarBackup,
    get conectado() { return !!accessToken; }
  };
})();
