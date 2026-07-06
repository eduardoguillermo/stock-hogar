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

  function log(...args) { console.log('[DriveSync]', ...args); }

  function init(onReady) {
    if (!window.google || !google.accounts) {
      log('Google Identity Services todavía no cargó, reintentando...');
      setTimeout(() => init(onReady), 400);
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { log('Error de token', resp); return; }
        accessToken = resp.access_token;
        programarRenovacion();
        if (onReady) onReady();
      }
    });
  }

  function conectar() {
    if (!tokenClient) { log('tokenClient no inicializado todavía'); return; }
    tokenClient.requestAccessToken({ prompt: accessToken ? '' : 'consent' });
  }

  // Renovación silenciosa cada 50 min, igual que en Control Financiero
  function programarRenovacion() {
    if (renewTimer) clearTimeout(renewTimer);
    renewTimer = setTimeout(() => {
      tokenClient.requestAccessToken({ prompt: '' });
    }, 50 * 60 * 1000);
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

  return { init, conectar, subirCola, bajarCola, get conectado() { return !!accessToken; } };
})();
