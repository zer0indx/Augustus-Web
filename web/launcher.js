/*
 * Augustus Web launcher.
 *
 * Designed to match eZeus Web UX:
 *  - Screen 1 (Not Imported):
 *      [ PLAY (disabled) ]
 *      [ IMPORT GAME FILES (xxx MB) ]
 *      Panel: "ENGINE READY. NOW IMPORT THE GAME FILES."
 *      Footer: [ SIGN OUT ]
 *  - Screen 2 (Imported & Ready):
 *      [ PLAY (enabled) ]
 *      [ DOWNLOAD SAVES ]
 *      [ UPLOAD SAVES ]
 *      Panel: "READY."
 *      Footer: [ REMOVE GAME FILES FROM BROWSER ] [ SIGN OUT ]
 */
(function () {
  'use strict';

  var C3_DIR = '/C3';
  var DB_NAME = 'augustus-web';
  var DB_VERSION = 1;
  var DOWNLOAD_CONCURRENCY = 4;
  var EXCLUDE_RE = /(\.(exe|dll|pdf|lnk|url|ico|sav|svx|log|tmp)$)|(^|\/)(unins[^/]*|goggame[^/]*)$|(^|\/)(__support|__redist)\//i;
  var SAVE_RE = /\.(sav|svx|map|mapx)$/i;
  var ROOT_MARKERS = ['c3.sg2', 'c3.eng'];

  var $ = function (id) { return document.getElementById(id); };
  var playBtn = $('playBtn');
  var serverBtn = $('serverBtn');
  var pickFolderBtn = $('pickFolderBtn');
  var pickZipBtn = $('pickZipBtn');
  var folderInput = $('folderInput');
  var zipInput = $('zipInput');
  var savesCard = $('savesCard');
  var downloadSavesBtn = $('downloadSavesBtn');
  var uploadSavesBtn = $('uploadSavesBtn');
  var savesInput = $('savesInput');
  var clearBtn = $('clearBtn');
  var logoutBtn = $('logoutBtn');
  var statusEl = $('status');
  var progressCard = $('progressCard');
  var progressBar = $('progress');
  var progressText = $('progressText');
  var syncText = $('syncText');
  var sourceHelp = $('sourceHelp');
  var toast = $('toast');
  var busy = $('busy');
  var canvas = $('canvas');

  var db = null;
  var config = { mode: 'server', authEnabled: false, user: null };
  var serverManifest = null;
  var runtimeReady = false;
  var filesReady = false;
  var importing = false;
  var running = false;
  var toastTimer = null;

  function showToast(text, durationMs) {
    clearTimeout(toastTimer);
    toast.textContent = text;
    toast.hidden = false;
    if (durationMs) {
      toastTimer = setTimeout(function () { toast.hidden = true; }, durationMs);
    }
  }

  function setStatus(text, isBad) {
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', !!isBad);
  }

  function formatTime(d) {
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function updateSyncTime(date) {
    syncText.textContent = 'Saves synced with the server at ' + formatTime(date || new Date()) + '.';
  }

  async function fetchJson(url, init) {
    var res = await fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin' }, init || {}));
    if (!res.ok) {
      var t = await res.text().catch(function () { return ''; });
      throw new Error('HTTP ' + res.status + ' ' + url + (t ? ': ' + t : ''));
    }
    return res.json();
  }

  // ---------------------------------------------------------------- IndexedDB Cache
  function idbReq(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbTx(stores, mode, fn) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(stores, mode);
      var result;
      tx.oncomplete = function () { resolve(result); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('transaction aborted')); };
      result = fn(tx);
    });
  }

  async function openDb() {
    if (!window.indexedDB) return null;
    try {
      return await new Promise(function (resolve, reject) {
        var req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function () {
          var d = req.result;
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
    } catch (e) {
      console.warn('IndexedDB unavailable', e);
      return null;
    }
  }

  async function hasGameFiles() {
    if (!db) return false;
    try {
      var count = await idbTx(['files'], 'readonly', function (tx) {
        return idbReq(tx.objectStore('files').count());
      });
      return count > 50; // Caesar 3 has hundreds of files
    } catch (e) {
      return false;
    }
  }

  async function clearGameFiles() {
    if (!db) return;
    await idbTx(['files'], 'readwrite', function (tx) {
      tx.objectStore('files').clear();
    });
  }

  async function cacheSaveFile(path, data) {
    if (!db) return;
    try {
      await idbTx(['files'], 'readwrite', function (tx) {
        tx.objectStore('files').put(data, path);
      });
    } catch (e) {
      console.warn('Failed to cache file', path, e);
    }
  }

  async function loadAllCachedFiles() {
    var map = new Map();
    if (!db) return map;
    await idbTx(['files'], 'readonly', function (tx) {
      var req = tx.objectStore('files').openCursor();
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) return;
        var v = cursor.value;
        map.set(cursor.key, v instanceof Uint8Array ? v : new Uint8Array(v));
        cursor.continue();
      };
    });
    return map;
  }

  // ---------------------------------------------------------------- Pool helper
  async function runPool(items, concurrency, worker) {
    var next = 0;
    async function lane() {
      while (next < items.length) {
        var item = items[next++];
        await worker(item);
      }
    }
    var lanes = [];
    for (var i = 0; i < Math.min(concurrency, items.length); i++) lanes.push(lane());
    await Promise.all(lanes);
  }

  function reroot(entries) {
    var best = null;
    entries.forEach(function (e) {
      var parts = e.path.split('/');
      var base = parts[parts.length - 1].toLowerCase();
      if (ROOT_MARKERS.indexOf(base) !== -1) {
        var dir = parts.slice(0, -1).join('/');
        if (best === null || dir.length < best.length) best = dir;
      }
    });
    if (best === null) return null;
    var prefix = best ? best + '/' : '';
    return entries
      .filter(function (e) { return e.path.indexOf(prefix) === 0; })
      .map(function (e) { return Object.assign({}, e, { fsPath: e.path.slice(prefix.length) }); });
  }

  // ---------------------------------------------------------------- UI State Transition
  function refreshButtons() {
    if (importing) {
      playBtn.disabled = true;
      serverBtn.hidden = true;
      pickFolderBtn.hidden = true;
      pickZipBtn.hidden = true;
      savesCard.hidden = true;
      clearBtn.hidden = true;
      progressCard.hidden = false;
      setStatus('Importing game files…');
      return;
    }

    progressCard.hidden = true;
    logoutBtn.hidden = !config.authEnabled;

    if (!filesReady) {
      // SCREEN 1: Game files not imported
      playBtn.disabled = true;
      savesCard.hidden = true;
      clearBtn.hidden = true;

      if (config.mode === 'server') {
        serverBtn.hidden = false;
        pickFolderBtn.hidden = true;
        pickZipBtn.hidden = true;
        if (serverManifest) {
          var mb = Math.round(serverManifest.totalBytes / (1024 * 1024));
          serverBtn.textContent = 'Import Game Files (' + mb + ' MB)';
        } else {
          serverBtn.textContent = 'Import Game Files';
        }
        sourceHelp.textContent = 'The game files come from this server. Importing copies them into this browser\'s storage; it is needed once per browser.';
      } else {
        serverBtn.hidden = true;
        pickFolderBtn.hidden = false;
        pickZipBtn.hidden = false;
        sourceHelp.textContent = 'Choose your Caesar III game folder or ZIP file. Importing copies it into this browser\'s storage; it is needed once per browser.';
      }

      setStatus(runtimeReady ? 'Engine ready. Now import the game files.' : 'Loading engine…');
    } else {
      // SCREEN 2: Ready
      playBtn.disabled = !runtimeReady;
      serverBtn.hidden = true;
      pickFolderBtn.hidden = true;
      pickZipBtn.hidden = true;
      savesCard.hidden = false;
      clearBtn.hidden = false;

      sourceHelp.textContent = 'The game files come from this server. Importing copies them into this browser\'s storage; it is needed once per browser.';
      setStatus(runtimeReady ? 'Ready.' : 'Loading engine…');
    }
  }

  // ---------------------------------------------------------------- Import Logic
  async function importServerFiles() {
    if (importing) return;
    importing = true;
    refreshButtons();

    try {
      if (!serverManifest) {
        serverManifest = await fetchJson('/api/gamedata/manifest');
      }
      var entries = reroot(serverManifest.files);
      if (!entries || !entries.length) {
        throw new Error('Caesar III installation files not found on server.');
      }

      var totalBytes = entries.reduce(function (s, f) { return s + f.size; }, 0);
      var loadedBytes = 0;
      var doneFiles = 0;

      function updateProgress(currFile) {
        var pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
        progressBar.style.width = pct + '%';
        progressText.textContent = Math.round(loadedBytes / (1024 * 1024)) + ' MB / ' +
          Math.round(totalBytes / (1024 * 1024)) + ' MB (' + pct + '%) ' + (currFile ? '· ' + currFile : '');
      }
      updateProgress('');

      await runPool(entries, DOWNLOAD_CONCURRENCY, async function (entry) {
        var url = '/gamedata/' + entry.path.split('/').map(encodeURIComponent).join('/');
        var resp = await fetch(url);
        if (!resp.ok) throw new Error('Failed to fetch ' + entry.path);
        var buf = new Uint8Array(await resp.arrayBuffer());
        loadedBytes += buf.length;
        doneFiles++;
        await cacheSaveFile(entry.fsPath, buf);
        updateProgress(entry.fsPath);
      });

      filesReady = true;
      importing = false;
      refreshButtons();
      showToast('Game files imported successfully!', 3000);
    } catch (err) {
      console.error(err);
      importing = false;
      refreshButtons();
      alert('Error importing game files: ' + err.message);
    }
  }

  async function importFromEntries(entries) {
    if (!entries || !entries.length) return;
    importing = true;
    refreshButtons();

    try {
      var game = entries.filter(function (e) { return !EXCLUDE_RE.test(e.fsPath); });
      var totalBytes = game.reduce(function (s, f) { return s + f.size; }, 0);
      var loadedBytes = 0;

      for (var i = 0; i < game.length; i++) {
        var e = game[i];
        var data = await e.read();
        loadedBytes += data.length;
        await cacheSaveFile(e.fsPath, data);
        var pct = totalBytes ? Math.round((loadedBytes / totalBytes) * 100) : 0;
        progressBar.style.width = pct + '%';
        progressText.textContent = Math.round(loadedBytes / (1024 * 1024)) + ' MB / ' +
          Math.round(totalBytes / (1024 * 1024)) + ' MB (' + pct + '%)';
      }

      filesReady = true;
      importing = false;
      refreshButtons();
      showToast('Game files imported successfully!', 3000);
    } catch (err) {
      console.error(err);
      importing = false;
      refreshButtons();
      alert('Error importing files: ' + err.message);
    }
  }

  // ---------------------------------------------------------------- Saves & Sync
  async function syncSavesFromServer() {
    try {
      var list = await fetchJson('/api/saves');
      updateSyncTime(new Date());
      return list;
    } catch (e) {
      console.warn('Could not sync saves list', e);
      return [];
    }
  }

  async function downloadSavesZip() {
    try {
      showToast('Preparing saves zip…');
      var list = await fetchJson('/api/saves');
      if (!list || !list.length) {
        showToast('No saves found on server.', 2500);
        return;
      }
      var zip = new JSZip();
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        var resp = await fetch('/api/saves/' + s.path.split('/').map(encodeURIComponent).join('/'));
        if (resp.ok) {
          zip.file(s.path, await resp.arrayBuffer());
        }
      }
      var blob = await zip.generateAsync({ type: 'blob' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'caesar3_saves.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast('Saves downloaded!', 2500);
    } catch (err) {
      alert('Failed to download saves: ' + err.message);
    }
  }

  async function uploadSavesZip(file) {
    try {
      showToast('Uploading saves…');
      var zip = await JSZip.loadAsync(file);
      var count = 0;
      var promises = [];
      zip.forEach(function (relPath, entry) {
        if (!entry.dir && SAVE_RE.test(relPath)) {
          promises.push((async function () {
            var data = await entry.async('uint8array');
            var baseName = relPath.split('/').pop();
            await fetch('/api/saves/' + encodeURIComponent(baseName), {
              method: 'PUT',
              body: data,
              headers: { 'Content-Type': 'application/octet-stream' }
            });
            count++;
          })());
        }
      });
      await Promise.all(promises);
      updateSyncTime(new Date());
      showToast('Uploaded ' + count + ' save files!', 3000);
    } catch (err) {
      alert('Failed to unpack or upload saves: ' + err.message);
    }
  }

  // ---------------------------------------------------------------- FS & Augustus Bridge
  function fsApi() { return Module.FS || window.FS; }

  function mkdirs(FS, dir) {
    var cur = '';
    dir.split('/').filter(Boolean).forEach(function (part) {
      cur += '/' + part;
      try { FS.mkdir(cur); } catch (e) {}
    });
  }

  function writeFilesToEmscripten(files) {
    var FS = fsApi();
    mkdirs(FS, C3_DIR);
    files.forEach(function (data, rel) {
      var full = C3_DIR + '/' + rel;
      var slash = full.lastIndexOf('/');
      if (slash > C3_DIR.length) mkdirs(FS, full.slice(0, slash));
      try { FS.writeFile(full, data, { canOwn: true }); } catch (e) {}
    });
  }

  function scanFS() {
    var FS = fsApi();
    var out = {};
    (function walk(dir, rel) {
      FS.readdir(dir).forEach(function (name) {
        if (name === '.' || name === '..') return;
        var full = dir + '/' + name;
        var r = rel ? rel + '/' + name : name;
        var st = FS.stat(full);
        if (FS.isDir(st.mode)) walk(full, r);
        else if (FS.isFile(st.mode)) out[r] = st.size + ':' + new Date(st.mtime).getTime();
      });
    })(C3_DIR, '');
    return out;
  }

  var snapshot = null;
  var syncTimer = null;
  var syncing = false;

  async function syncBackToNAS() {
    if (syncing || !snapshot) return;
    syncing = true;
    try {
      var current = scanFS();
      var changed = Object.keys(current).filter(function (k) { return snapshot[k] !== current[k]; });
      var removed = Object.keys(snapshot).filter(function (k) { return !(k in current); });
      if (!changed.length && !removed.length) return;

      showToast('Saving to NAS…');
      var FS = fsApi();
      for (var i = 0; i < changed.length; i++) {
        var key = changed[i];
        var data = FS.readFile(C3_DIR + '/' + key);
        await fetch('/api/saves/' + encodeURIComponent(key), {
          method: 'PUT',
          body: data,
          headers: { 'Content-Type': 'application/octet-stream' }
        });
        snapshot[key] = current[key];
      }
      for (var j = 0; j < removed.length; j++) {
        await fetch('/api/saves/' + encodeURIComponent(removed[j]), { method: 'DELETE' });
        delete snapshot[removed[j]];
      }
      var now = new Date();
      updateSyncTime(now);
      showToast('Saved to NAS at ' + formatTime(now), 2500);
    } catch (e) {
      console.warn('Auto-save to NAS failed', e);
    } finally {
      syncing = false;
    }
  }

  // ---------------------------------------------------------------- Start Game
  async function startGame() {
    if (running || !runtimeReady || !filesReady) return;
    running = true;
    busy.hidden = false;

    try {
      // Load cached game files from IndexedDB
      setStatus('Loading files into game engine…');
      var files = await loadAllCachedFiles();

      // Overlay latest saves from server
      var serverSaves = await fetchJson('/api/saves').catch(function () { return []; });
      for (var i = 0; i < serverSaves.length; i++) {
        var s = serverSaves[i];
        var resp = await fetch('/api/saves/' + encodeURIComponent(s.path));
        if (resp.ok) {
          files.set(s.path, new Uint8Array(await resp.arrayBuffer()));
        }
      }

      writeFilesToEmscripten(files);
      snapshot = scanFS();
      files.clear();

      document.body.classList.add('playing');
      busy.hidden = true;
      canvas.focus();
      Module.callMain([C3_DIR]);
    } catch (err) {
      busy.hidden = true;
      running = false;
      document.body.classList.remove('playing');
      alert('Error starting Augustus: ' + err.message);
    }
  }

  // ---------------------------------------------------------------- Emscripten Module
  window.Module = {
    canvas: canvas,
    print: function (t) { console.log(t); },
    printErr: function (t) { console.warn(t); },
    setStatus: function (t) { if (t) console.log('[emscripten]', t); },
    onRuntimeInitialized: function () {
      runtimeReady = true;
      refreshButtons();
    },
    syncFS: function () {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncBackToNAS, 250);
    },
    quitGame: function (status) {
      running = false;
      document.body.classList.remove('playing');
      if (status) {
        alert('Game exited: installation files invalid.');
      } else {
        syncBackToNAS();
      }
    }
  };

  // ---------------------------------------------------------------- Event Listeners
  serverBtn.onclick = importServerFiles;

  pickFolderBtn.onclick = function () { folderInput.click(); };
  folderInput.onchange = async function () {
    var list = Array.prototype.map.call(folderInput.files, function (f) {
      return {
        path: f.webkitRelativePath || f.name,
        size: f.size,
        read: function () { return f.arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
      };
    });
    var entries = reroot(list);
    if (!entries) return alert('c3.sg2 / c3.eng not found in selected folder. Pick the Caesar III directory.');
    await importFromEntries(entries);
  };

  pickZipBtn.onclick = function () { zipInput.click(); };
  zipInput.onchange = async function () {
    if (!zipInput.files[0]) return;
    var zip = await JSZip.loadAsync(zipInput.files[0]);
    var list = [];
    zip.forEach(function (relPath, entry) {
      if (!entry.dir) list.push({
        path: relPath,
        size: entry._data ? entry._data.uncompressedSize : 0,
        read: function () { return entry.async('uint8array'); }
      });
    });
    var entries = reroot(list);
    if (!entries) return alert('c3.sg2 / c3.eng not found in zip archive.');
    await importFromEntries(entries);
  };

  playBtn.onclick = startGame;

  clearBtn.onclick = async function () {
    if (confirm('Remove Caesar III game files from this browser\'s storage?\n\nYour save games on the server will NOT be deleted.')) {
      await clearGameFiles();
      filesReady = false;
      refreshButtons();
      showToast('Game files removed from this browser.', 2500);
    }
  };

  downloadSavesBtn.onclick = downloadSavesZip;

  uploadSavesBtn.onclick = function () { savesInput.click(); };
  savesInput.onchange = function () {
    if (savesInput.files[0]) {
      uploadSavesZip(savesInput.files[0]);
      savesInput.value = '';
    }
  };

  logoutBtn.onclick = function () {
    window.location.href = '/logout';
  };

  // ---------------------------------------------------------------- Init
  async function init() {
    db = await openDb();
    filesReady = await hasGameFiles();

    try {
      config = await fetchJson('/api/config');
      if (config.mode === 'server') {
        serverManifest = await fetchJson('/api/gamedata/manifest').catch(function () { return null; });
      }
    } catch (e) {
      console.warn('Could not load config', e);
    }

    await syncSavesFromServer();
    refreshButtons();
  }

  init();
})();
