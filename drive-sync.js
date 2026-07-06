/* drive-sync.js — v0.1.0
   Sincroniza la cola de escaneos (stk_cola) contra un archivo en Drive,
   en una carpeta propia "StockEnCasa" para no mezclarse con otras apps.
   Requiere: CLIENT_ID de OAuth (mismo proyecto de Google Cloud que tus otras apps).
*/
const DriveSync = (() => {
  const CLIENT_ID = '1049169592532-is5j1j4s1bmgrc9tsq48slrgul8fbj17.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.file';
  const CARPETA = 'StockEnCasa';
  const ARCHIVO = 'escaneos_pendientes.json';

  let tokenClient = null;
  let accessToken = null;
  let folderId = null;
  let fileId = null;
  let renewTimer = null;
  const TOKEN_KEY = 'stk_drive_token';

  function log(...args) { console.log('[DriveSync]', ...args); }

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
          if (resp.error) { log('Error de token', resp); return; }
          accessToken = resp.access_token;
          guardarToken(accessToken, resp.expires_in || 3600);
          programarRenovacion();
          if (onReady) onReady();
        }
      });
    }
    // Si ya hay un token vigente guardado, lo reusamos sin pedir nada
    const guardado = tokenGuardadoValido();
    if (guardado) {
      accessToken = guardado;
      programarRenovacion();
      if (onReady) onReady();
    }
  }

  function conectar() {
    if (accessToken) return; // ya conectado (sesión en memoria o token guardado vigente)
    if (!tokenClient) { log('tokenClient no inicializado todavía'); return; }
    tokenClient.requestAccessToken({ prompt: '' }); // intento silencioso primero
  }

  function forzarReconexion() {
    accessToken = null;
    localStorage.removeItem(TOKEN_KEY);
    if (tokenClient) tokenClient.requestAccessToken({ prompt: 'consent' });
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
      tokenClient.requestAccessToken({ prompt: '' });
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

  async function ensureFolder() {
    if (folderId) return folderId;
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
  }

  async function ensureFile() {
    if (fileId) return fileId;
    await ensureFolder();
    const q = encodeURIComponent(`name='${ARCHIVO}' and '${folderId}' in parents and trashed=false`);
    const resp = await api(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
    const data = await resp.json();
    if (data.files && data.files.length) { fileId = data.files[0].id; return fileId; }

    // Archivo no existe: se crea vacío
    fileId = await subirJSON({ items: [] }, true);
    return fileId;
  }

  async function subirJSON(obj, creando = false) {
    await ensureFolder();
    const boundary = 'stockencasa_boundary';
    const metadata = creando
      ? { name: ARCHIVO, parents: [folderId], mimeType: 'application/json' }
      : { mimeType: 'application/json' };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(obj)}\r\n--${boundary}--`;

    const url = creando
      ? 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      : `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart`;

    const resp = await api(url, {
      method: creando ? 'POST' : 'PATCH',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body
    });
    const data = await resp.json();
    return data.id;
  }

  async function descargarJSON() {
    await ensureFile();
    const resp = await api(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    return resp.json();
  }

  // ---------- Uso desde el escáner: sube la cola completa (pendientes) ----------
  async function subirCola(itemsCola) {
    await ensureFile();
    await subirJSON({ items: itemsCola, actualizado: Date.now() });
  }

  // ---------- Uso desde gestión PC: baja la cola remota ----------
  async function bajarCola() {
    try {
      const data = await descargarJSON();
      return data.items || [];
    } catch (e) {
      log('Error al bajar cola', e);
      return [];
    }
  }

  return { init, conectar, forzarReconexion, subirCola, bajarCola, get conectado() { return !!accessToken; } };
})();
