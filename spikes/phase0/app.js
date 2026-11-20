// Phase 0 Assumption Spikes interactive browser harness (throwaway PoC).

const DB_NAME = 'flashcards-phase0-spikes';
const STORE_NAME = 'kv';
const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

function $(id) {
  return document.getElementById(id);
}

function logTo(id, message, obj) {
  const el = $(id);
  const ts = new Date().toLocaleTimeString();
  const suffix = obj !== undefined ? '\n' + JSON.stringify(obj, null, 2) : '';
  el.textContent = `[${ts}] ${message}${suffix}\n\n` + el.textContent;
}

// --- Tiny IndexedDB KV helper (supports storing FileSystemDirectoryHandle & refresh_token) ---
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// --- Service Worker registration ---
async function initServiceWorker() {
  const badges = $('env-badges');
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
  badges.innerHTML = `<span class="pill">${standalone ? 'STANDALONE PWA' : 'BROWSER TAB'}</span> <span class="pill">${navigator.onLine ? 'ONLINE' : 'OFFLINE'}</span>`;

  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      logTo('out-s1', 'Service Worker registered', { scope: reg.scope });
    } catch (err) {
      logTo('out-s1', `Service Worker registration failed: ${err}`);
    }
  }
}

// --- Spike 0.1: Shared <audio> unlock + audioSession + Storage Persist ---
const sharedAudio = new Audio();
sharedAudio.preload = 'auto';
let audioUnlocked = false;

function unlockSharedAudioSync() {
  if ('audioSession' in navigator && navigator.audioSession) {
    try {
      navigator.audioSession.type = 'playback';
    } catch {
      // Ignore unsupported audioSession assignment
    }
  }
  if (!audioUnlocked) {
    sharedAudio.src = './chime.wav';
    sharedAudio.load();
    audioUnlocked = true;
  }
}

async function playSharedChime(rate) {
  unlockSharedAudioSync();
  sharedAudio.src = './chime.wav';
  sharedAudio.playbackRate = rate;
  sharedAudio.preservesPitch = true;
  try {
    await sharedAudio.play();
    logTo('out-s1', `Played chime.wav at ${rate}x`, {
      audioSessionType: navigator.audioSession?.type ?? 'unsupported',
      preservesPitch: sharedAudio.preservesPitch,
      online: navigator.onLine,
    });
  } catch (err) {
    logTo('out-s1', `Audio playback failed: ${err}`);
  }
}

$('btn-s1-env').addEventListener('click', () => {
  const style = getComputedStyle(document.body);
  logTo('out-s1', 'PWA environment telemetry', {
    standaloneMedia: window.matchMedia('(display-mode: standalone)').matches,
    navigatorStandalone: Boolean(navigator.standalone),
    online: navigator.onLine,
    serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
    audioSessionSupported: 'audioSession' in navigator,
    audioSessionType: navigator.audioSession?.type ?? null,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    userAgent: navigator.userAgent,
  });
});

$('btn-s1-persist').addEventListener('click', async () => {
  try {
    const before = (await navigator.storage?.persisted?.()) ?? null;
    const granted = (await navigator.storage?.persist?.()) ?? null;
    const estimate = (await navigator.storage?.estimate?.()) ?? null;
    const prevSentinel = await idbGet('s1-sentinel');
    const nextSentinel = {
      count: (prevSentinel?.count ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await idbSet('s1-sentinel', nextSentinel);
    logTo('out-s1', 'Storage persistence & IndexedDB sentinel', {
      persistedBefore: before,
      persistGranted: granted,
      quotaMB: estimate?.quota ? Math.round(estimate.quota / 1048576) : null,
      usageKB: estimate?.usage ? Math.round(estimate.usage / 1024) : null,
      previousSentinel: prevSentinel ?? null,
      savedSentinel: nextSentinel,
    });
  } catch (err) {
    logTo('out-s1', `Storage persist error: ${err}`);
  }
});

$('btn-s1-audio-1x').addEventListener('click', () => {
  void playSharedChime(1.0);
});

$('btn-s1-audio-slow').addEventListener('click', () => {
  void playSharedChime(0.75);
});

$('btn-s1-voices').addEventListener('click', () => {
  const voices = window.speechSynthesis?.getVoices?.() ?? [];
  const filtered = voices
    .filter((v) => /^(ja|zh|ko|en)/i.test(v.lang))
    .map((v) => ({ name: v.name, lang: v.lang, localService: v.localService }));
  logTo('out-s1', `Found ${voices.length} total voices (${filtered.length} CJK/EN)`, filtered);
});

// --- Spike 0.2: Google OAuth Redirect + PKCE + Worker + drive.appdata ---
const CONFIG_KEY = 'flashcards-phase0-oauth-config';
function loadOAuthConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return;
    const cfg = JSON.parse(raw);
    if (cfg.clientId) $('inp-client-id').value = cfg.clientId;
    if (cfg.workerUrl) $('inp-worker-url').value = cfg.workerUrl;
    if (cfg.apiKey) $('inp-api-key').value = cfg.apiKey;
  } catch {
    // ignore
  }
}

function saveOAuthConfig() {
  const cfg = {
    clientId: $('inp-client-id').value.trim(),
    workerUrl: $('inp-worker-url').value.trim().replace(/\/+$/, ''),
    apiKey: $('inp-api-key').value.trim(),
  };
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

function base64UrlEncode(bytes) {
  let str = '';
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function createPkcePair() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  return { verifier, challenge };
}

function getRedirectUri() {
  return window.location.origin + window.location.pathname;
}

$('btn-s2-health').addEventListener('click', async () => {
  const { workerUrl } = saveOAuthConfig();
  if (!workerUrl) {
    logTo('out-s2', 'Enter your deployed Worker URL first.');
    return;
  }
  try {
    const res = await fetch(`${workerUrl}/health`);
    logTo('out-s2', `Worker /health HTTP ${res.status}`, await res.json());
  } catch (err) {
    logTo('out-s2', `Worker /health failed: ${err}`);
  }
});

$('btn-s2-login').addEventListener('click', async () => {
  const { clientId } = saveOAuthConfig();
  if (!clientId) {
    logTo('out-s2', 'Enter Google OAuth Web Client ID first.');
    return;
  }
  const { verifier, challenge } = await createPkcePair();
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(16)));
  await idbSet('oauth-pkce', { verifier, state, createdAt: Date.now() });

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: getRedirectUri(),
    response_type: 'code',
    scope: OAUTH_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  window.location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

async function handleOAuthCallbackIfPresent() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  if (!code && !error) return;

  // Clean URL immediately
  window.history.replaceState({}, document.title, getRedirectUri());

  if (error) {
    logTo('out-s2', `Google OAuth returned error: ${error}`);
    return;
  }

  const pkce = await idbGet('oauth-pkce');
  if (!pkce || pkce.state !== state) {
    logTo('out-s2', 'OAuth state mismatch (or opened in Safari instead of standalone PWA!).', {
      expectedStatePresent: Boolean(pkce),
      standalone: window.matchMedia('(display-mode: standalone)').matches,
    });
    return;
  }

  const { workerUrl } = saveOAuthConfig();
  if (!workerUrl) {
    logTo('out-s2', 'Missing Worker URL to exchange auth code.');
    return;
  }

  try {
    const res = await fetch(`${workerUrl}/auth/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        redirect_uri: getRedirectUri(),
        code_verifier: pkce.verifier,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      logTo('out-s2', `Worker /auth/exchange HTTP ${res.status}`, data);
      return;
    }
    await idbSet('oauth-tokens', {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? null,
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
      scope: data.scope,
    });
    await idbDelete('oauth-pkce');
    logTo('out-s2', 'OAuth exchange succeeded & stored in IndexedDB!', {
      hasRefreshToken: Boolean(data.refresh_token),
      expiresIn: data.expires_in,
      scope: data.scope,
      standaloneAfterRedirect: window.matchMedia('(display-mode: standalone)').matches,
    });
  } catch (err) {
    logTo('out-s2', `OAuth exchange error: ${err}`);
  }
}

$('btn-s2-refresh').addEventListener('click', async () => {
  const { workerUrl } = saveOAuthConfig();
  const tokens = await idbGet('oauth-tokens');
  if (!workerUrl || !tokens?.refreshToken) {
    logTo('out-s2', 'Need Worker URL and stored refresh_token (Sign In first).');
    return;
  }
  try {
    const res = await fetch(`${workerUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refreshToken }),
    });
    const data = await res.json();
    if (!res.ok) {
      logTo('out-s2', `/auth/refresh HTTP ${res.status}`, data);
      return;
    }
    await idbSet('oauth-tokens', {
      ...tokens,
      accessToken: data.access_token,
      expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
    });
    logTo('out-s2', 'Silent /auth/refresh succeeded!', {
      expiresIn: data.expires_in,
      scope: data.scope,
    });
  } catch (err) {
    logTo('out-s2', `/auth/refresh error: ${err}`);
  }
});

async function getAccessToken() {
  const tokens = await idbGet('oauth-tokens');
  if (!tokens?.accessToken) {
    throw new Error('No access_token in IndexedDB. Complete Spike 0.2 Sign In first.');
  }
  return tokens.accessToken;
}

$('btn-s2-appdata').addEventListener('click', async () => {
  try {
    const token = await getAccessToken();
    const listUrl =
      'https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)';
    const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    const listData = await listRes.json();
    if (!listRes.ok) {
      logTo('out-s2', `appDataFolder list failed (${listRes.status})`, listData);
      return;
    }

    const existing = (listData.files ?? []).find((f) => f.name === 'sync-spike.json');
    const payload = JSON.stringify({
      device: navigator.userAgent.slice(0, 60),
      updatedAt: new Date().toISOString(),
      nonce: Math.random().toString(36).slice(2, 10),
    });

    let fileId = existing?.id;
    if (!fileId) {
      const boundary = 'flashcards-spike-boundary';
      const meta = JSON.stringify({ name: 'sync-spike.json', parents: ['appDataFolder'] });
      const body =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const createRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
          },
          body,
        },
      );
      const created = await createRes.json();
      if (!createRes.ok) {
        logTo('out-s2', `appDataFolder create failed (${createRes.status})`, created);
        return;
      }
      fileId = created.id;
    } else {
      const updateRes = await fetch(
        `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: payload,
        },
      );
      if (!updateRes.ok) {
        logTo(
          'out-s2',
          `appDataFolder update failed (${updateRes.status})`,
          await updateRes.json(),
        );
        return;
      }
    }

    const readRes = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const readBack = await readRes.json();
    logTo('out-s2', 'appDataFolder CRUD succeeded!', {
      fileId,
      existingFilesCount: (listData.files ?? []).length,
      readBack,
    });
  } catch (err) {
    logTo('out-s2', `appDataFolder error: ${err}`);
  }
});

$('btn-s2-logout').addEventListener('click', async () => {
  await idbDelete('oauth-tokens');
  await idbDelete('oauth-pkce');
  logTo('out-s2', 'Cleared local IndexedDB tokens.');
});

// --- Spike 0.3: Google Picker (multi-select) + Sheets FORMULA + batchUpdate + Docs Markdown ---
let gapiLoaded = false;
function loadGooglePickerApi() {
  return new Promise((resolve, reject) => {
    if (gapiLoaded && window.google?.picker) {
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi.load('picker', () => {
        gapiLoaded = true;
        resolve();
      });
    };
    script.onerror = () => reject(new Error('Failed to load https://apis.google.com/js/api.js'));
    document.head.appendChild(script);
  });
}

$('btn-s3-picker').addEventListener('click', async () => {
  try {
    const { apiKey } = saveOAuthConfig();
    if (!apiKey) {
      logTo('out-s3', 'Enter your referrer-restricted Browser API Key in Spike 0.2 first.');
      return;
    }
    const token = await getAccessToken();
    await loadGooglePickerApi();

    const sheetsView = new window.google.picker.DocsView(window.google.picker.ViewId.SPREADSHEETS);
    const docsView = new window.google.picker.DocsView(window.google.picker.ViewId.DOCUMENTS);
    const picker = new window.google.picker.PickerBuilder()
      .enableFeature(window.google.picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token)
      .setDeveloperKey(apiKey)
      .addView(sheetsView)
      .addView(docsView)
      .setCallback((data) => {
        if (data.action === window.google.picker.Action.PICKED) {
          const docs = (data.docs ?? []).map((d) => ({
            id: d.id,
            name: d.name,
            mimeType: d.mimeType,
          }));
          for (const d of docs) {
            if (d.mimeType === 'application/vnd.google-apps.spreadsheet') {
              $('inp-sheet-id').value = d.id;
            }
            if (d.mimeType === 'application/vnd.google-apps.document') {
              $('inp-doc-id').value = d.id;
            }
          }
          logTo('out-s3', `Picker selected ${docs.length} file(s)`, docs);
        }
      })
      .build();
    picker.setVisible(true);
  } catch (err) {
    logTo('out-s3', `Picker error: ${err}`);
  }
});

$('btn-s3-read-sheet').addEventListener('click', async () => {
  try {
    const sheetId = $('inp-sheet-id').value.trim();
    if (!sheetId) throw new Error('Pick or enter a Sheet ID first.');
    const token = await getAccessToken();
    const res = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/A1:Z20?valueRenderOption=FORMULA`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = await res.json();
    logTo('out-s3', `Sheets values.get (FORMULA) HTTP ${res.status}`, data);
  } catch (err) {
    logTo('out-s3', `Read sheet error: ${err}`);
  }
});

$('btn-s3-write-id').addEventListener('click', async () => {
  try {
    const sheetId = $('inp-sheet-id').value.trim();
    if (!sheetId) throw new Error('Pick or enter a Sheet ID first.');
    const token = await getAccessToken();
    const readRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/A1:Z5?valueRenderOption=FORMATTED_VALUE`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const grid = await readRes.json();
    const headers = grid.values?.[0] ?? [];
    const colIdx = headers.findIndex((h) => String(h).trim().toLowerCase() === 'card id');
    if (colIdx < 0) {
      logTo(
        'out-s3',
        'No "Card ID" column found in row 1. Add a "Card ID" header on a test sheet.',
        {
          headers,
        },
      );
      return;
    }
    const row2 = grid.values?.[1] ?? [];
    if (row2[colIdx]) {
      logTo(
        'out-s3',
        `Row 2 already has Card ID "${row2[colIdx]}" — skipping write (race guard OK).`,
      );
      return;
    }
    const colLetter = String.fromCharCode(65 + colIdx);
    const uuid = crypto.randomUUID();
    const writeRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          valueInputOption: 'RAW',
          data: [{ range: `${colLetter}2`, values: [[uuid]] }],
        }),
      },
    );
    logTo(
      'out-s3',
      `batchUpdate ${colLetter}2 = ${uuid} (HTTP ${writeRes.status})`,
      await writeRes.json(),
    );
  } catch (err) {
    logTo('out-s3', `batchUpdate error: ${err}`);
  }
});

$('btn-s3-export-doc').addEventListener('click', async () => {
  try {
    const docId = $('inp-doc-id').value.trim();
    if (!docId) throw new Error('Pick or enter a Google Doc ID first.');
    const token = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(docId)}/export?mimeType=text%2Fmarkdown`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const md = await res.text();
    logTo(
      'out-s3',
      `Docs export text/markdown HTTP ${res.status} (${md.length} chars):\n\n${md.slice(0, 1500)}`,
    );
  } catch (err) {
    logTo('out-s3', `Docs export error: ${err}`);
  }
});

// --- Spike 0.4: File System Access API (Windows Chrome/Edge + Drive for Desktop) ---
$('btn-s4-pick').addEventListener('click', async () => {
  if (typeof window.showDirectoryPicker !== 'function') {
    logTo('out-s4', 'showDirectoryPicker is not supported in this browser.');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'flashcards-spike', mode: 'readwrite' });
    await idbSet('s4-dir-handle', handle);
    logTo('out-s4', `Saved directory handle "${handle.name}" to IndexedDB.`, {
      name: handle.name,
      kind: handle.kind,
      permission: await handle.queryPermission({ mode: 'read' }),
    });
  } catch (err) {
    logTo('out-s4', `showDirectoryPicker error: ${err}`);
  }
});

$('btn-s4-restore').addEventListener('click', async () => {
  const handle = await idbGet('s4-dir-handle');
  if (!handle) {
    logTo('out-s4', 'No saved directory handle in IndexedDB yet.');
    return;
  }
  const readPerm = await handle.queryPermission({ mode: 'read' });
  const rwPerm = await handle.queryPermission({ mode: 'readwrite' });
  logTo('out-s4', `Restored handle "${handle.name}" from IndexedDB`, {
    readPermission: readPerm,
    readWritePermission: rwPerm,
  });
});

$('btn-s4-scan').addEventListener('click', async () => {
  const handle = await idbGet('s4-dir-handle');
  if (!handle) {
    logTo('out-s4', 'Pick a folder first.');
    return;
  }
  try {
    const perm = await handle.requestPermission({ mode: 'read' });
    if (perm !== 'granted') {
      logTo('out-s4', `Permission denied: ${perm}`);
      return;
    }
    const files = [];
    for await (const [name, entry] of handle.entries()) {
      if (entry.kind === 'file' && /\.(csv|tsv|xlsx|md|flashpkg)$/i.test(name)) {
        const f = await entry.getFile();
        files.push({ name, size: f.size, lastModified: new Date(f.lastModified).toISOString() });
      }
      if (files.length >= 25) break;
    }
    logTo('out-s4', `Scanned "${handle.name}": found ${files.length} supported file(s)`, files);
  } catch (err) {
    logTo('out-s4', `Folder scan error: ${err}`);
  }
});

// --- Spike 0.7: Browser CORS & BYO Google Cloud TTS ---
$('btn-s7-cors').addEventListener('click', async () => {
  const url = $('inp-cors-url').value.trim();
  try {
    const res = await fetch(url);
    const bytes = new Uint8Array(await res.arrayBuffer());
    logTo('out-s7', `Browser CORS fetch succeeded (HTTP ${res.status})`, {
      url,
      bytes: bytes.byteLength,
      contentType: res.headers.get('content-type'),
    });
  } catch (err) {
    logTo('out-s7', `Browser CORS fetch blocked/failed: ${err}`);
  }
});

$('btn-s7-tts').addEventListener('click', async () => {
  const apiKey = $('inp-tts-key').value.trim();
  if (!apiKey) {
    logTo('out-s7', 'Enter a temporary Google Cloud TTS API key to test direct browser synthesis.');
    return;
  }
  unlockSharedAudioSync();
  const [langCode, text] = $('sel-tts-lang').value.split('|');
  try {
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: langCode },
          audioConfig: { audioEncoding: 'MP3' },
        }),
      },
    );
    const data = await res.json();
    if (!res.ok) {
      logTo('out-s7', `Cloud TTS HTTP ${res.status}`, data);
      return;
    }
    const bin = atob(data.audioContent);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/mpeg' }));
    sharedAudio.src = url;
    sharedAudio.playbackRate = 1.0;
    await sharedAudio.play();
    logTo('out-s7', `BYO Cloud TTS CORS + playback succeeded (${bytes.byteLength} bytes MP3)`, {
      langCode,
      text,
    });
  } catch (err) {
    logTo('out-s7', `Cloud TTS error: ${err}`);
  }
});

// --- Boot ---
loadOAuthConfig();
void initServiceWorker();
void handleOAuthCallbackIfPresent();
