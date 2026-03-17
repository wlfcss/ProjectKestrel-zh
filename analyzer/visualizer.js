    // State
    // NOTE: Two modes for file access:
    // 1. Python API mode (desktop app): Uses rootPath + Python backend API calls
    // 2. File System Access API mode (browser): Uses rootDirHandle for direct file access
    // The getBlobUrlForPath function automatically chooses the best available method
    let rootDirHandle = null;      // Top-level photo folder (contains .kestrel) - for File System Access API
    let rootIsKestrel = false;     // True if user selected the .kestrel folder itself
    let rootPath = '';             // Absolute path to root folder (for Python API)
    let csvFileHandle = null;      // .kestrel/kestrel_database.csv
    let rows = [];                 // CSV rows (objects)
    let _scenedata = {};           // Map of rootPath → kestrel_scenedata.json contents
    let header = [];               // CSV header fields
    let scenes = [];               // Aggregated scene objects
    let dirty = false;             // Track unsaved edits
    // Notify Python backend whenever dirty state changes (for close-prompt)
    function _notifyDirty(val) {
      try { if (window.pywebview?.api?.notify_dirty) window.pywebview.api.notify_dirty(!!val); } catch (_) {}
    }
    let _cleanSnapshot = null;      // Snapshot of rows+header at last clean state (load or save)
    let selectedSceneIds = new Set(); // Multi-select: selected scene IDs ("slot:count")
    let collapsedFolders = new Set(); // rootPaths of collapsed folder groups
    let _lastSelectedIdx = -1;        // Shift-click range: last clicked index in _visibleSceneOrder
    let _visibleSceneOrder = [];       // Flat ordered list of visible scene IDs after last render
    // Track which scene dialog is open for refreshing filters
    let currentSceneId = null;

    const el = (sel) => document.querySelector(sel);
    const sceneGrid = el('#sceneGrid');
    const imageGrid = el('#imageGrid');
    const statusEl = el('#status');
    const sceneDlg = el('#sceneDlg');
    const versionBadge = el('#versionBadge');

    const supportsFS = 'showDirectoryPicker' in window;
    let hasPywebviewApi = typeof window.pywebview !== 'undefined';

    // Debug: Log what APIs are available (initial check)
    console.log('[DEBUG] Initial API Detection:');
    console.log('  - File System Access API (showDirectoryPicker):', supportsFS);
    console.log('  - Pywebview API (window.pywebview):', hasPywebviewApi);
    if (hasPywebviewApi) {
      console.log('  - window.pywebview object:', window.pywebview);
      console.log('  - window.pywebview.api:', window.pywebview.api);
      if (window.pywebview.api) {
        console.log('  - Available API methods:', Object.keys(window.pywebview.api));
      }
    }

    // Pywebview API might load asynchronously, so wait for it
    async function waitForPywebview() {
      if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
        return true;
      }
      // Poll for up to 2 seconds
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
          console.log('[DEBUG] Pywebview API became available after', (i + 1) * 100, 'ms');
          hasPywebviewApi = true;
          console.log('[DEBUG] Updated hasPywebviewApi to:', hasPywebviewApi);
          console.log('[DEBUG] window.pywebview:', window.pywebview);
          console.log('[DEBUG] window.pywebview.api:', window.pywebview.api);
          console.log('[DEBUG] Available API methods:', Object.keys(window.pywebview.api));
          // Hide compatibility warning since we now have pywebview
          el('#compat').classList.add('hidden');
          return true;
        }
      }
      console.log('[DEBUG] Pywebview API not available after 2 seconds');
      return false;
    }

    // Start checking for pywebview immediately and update UI when ready
    (async function() {
      const apiReady = !hasPywebviewApi ? await waitForPywebview() : true;
      // After API is ready, check legal agreement
      checkLegalAgreement();
      // Show/hide compatibility warning
      if (!supportsFS && !apiReady) {
        el('#compat').classList.remove('hidden');
      } else if (apiReady) {
        el('#compat').classList.add('hidden');
      }
      // After API is confirmed ready, wait for settings to be hydrated, then check donation threshold
      await new Promise(function(r) { setTimeout(r, 500); });
      // Hydrate settings from server to ensure localStorage has the latest data
      await hydrateSettingsFromServer();
      // Then check donation threshold (after settings are loaded into localStorage)
      checkDonationThresholdOnStartup();
    })();

    // Utilities
    function setStatus(msg) { statusEl.textContent = msg; }

    // Temporary toast notification (clickable) — default 5s
    function showToast(msg, timeout = 5000, onclick) {
      try {
        // Determine where to attach the container: prefer the topmost open dialog
        const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
        let attachParent = document.body;
        if (openDialogs.length > 0) {
          // Use the last-opened dialog (assumed topmost) so toast is visible above it
          attachParent = openDialogs[openDialogs.length - 1];
        }

        let container = document.getElementById('toastContainer');
        if (!container) {
          container = document.createElement('div');
          container.id = 'toastContainer';
          // ensure basic layout
          container.style.position = 'fixed';
          container.style.right = '18px';
          container.style.bottom = '18px';
          container.style.display = 'flex';
          container.style.flexDirection = 'column';
          container.style.gap = '8px';
          container.style.zIndex = '2147483647';
          container.style.pointerEvents = 'none';
        }

        // If the container isn't in the preferred parent, move it there.
        if (container.parentNode !== attachParent) {
          attachParent.appendChild(container);
        }

        container.style.zIndex = '2147483647';

        const el = document.createElement('div');
        el.className = 'toast';
        el.textContent = msg;
        el.style.background = '#111318';
        el.style.border = '1px solid #2a3040';
        el.style.color = 'var(--text)';
        el.style.padding = '10px 14px';
        el.style.borderRadius = '8px';
        el.style.marginTop = '8px';
        el.style.pointerEvents = 'auto';
        el.style.cursor = onclick ? 'pointer' : 'default';
        el.style.minWidth = '160px';
        el.style.boxShadow = '0 6px 18px rgba(0,0,0,.6)';

        if (onclick) el.addEventListener('click', (e) => { try { onclick(e); } catch (_) { } el.remove(); });

        container.appendChild(el);
        if (timeout && timeout > 0) setTimeout(() => { try { el.remove(); } catch (_) { } }, timeout);
      } catch (e) { console.warn('showToast failed', e); }
    }

    function showLoadingAnalyzer() {
      const o = document.getElementById('loadingOverlay'); if (!o) return; o.classList.remove('hidden'); o.style.pointerEvents = 'auto';
    }
    function hideLoadingAnalyzer() {
      const o = document.getElementById('loadingOverlay'); if (!o) return; o.classList.add('hidden'); o.style.pointerEvents = 'none';
    }

    async function _waitForPipelineReady(timeoutMs = 30000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        try {
          const s = await apiGetQueueStatus();
          if (s && s.items && s.items.length > 0) {
            const cur = s.items.find(i => i.status === 'running');
            if (cur && (cur.processed > 0 || (cur.current_export_path && cur.current_export_path.length > 0))) return true;
          }
        } catch (e) { }
        await new Promise(r => setTimeout(r, 500));
      }
      return false;
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ── Lazy image loader (throttled) ────────────────────────────────────────────
    // Concurrency-limited to avoid flooding the Python IPC bridge with dozens of
    // simultaneous read_image_file calls when a large section of the grid scrolls
    // into view.  Excess loads are queued and drained as earlier ones finish.
    const _imgLoadThrottle = { active: 0, max: 30, queue: [] };
    function _scheduleLoad(fn) {
      if (_imgLoadThrottle.active < _imgLoadThrottle.max) {
        _imgLoadThrottle.active++;
        fn().finally(() => {
          _imgLoadThrottle.active--;
          if (_imgLoadThrottle.queue.length) _scheduleLoad(_imgLoadThrottle.queue.shift());
        });
      } else {
        _imgLoadThrottle.queue.push(fn);
      }
    }

    const _lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        const loader = img._lazyLoader;
        if (loader) { _scheduleLoad(loader); delete img._lazyLoader; }
        _lazyObserver.unobserve(img);
      }
    }, { rootMargin: '300px' });

    function lazyLoadImg(img, resolverFn) {
      img._lazyLoader = async () => {
        const url = await resolverFn();
        if (url) {
          img.src = url;
          // Let the browser decode the image off the main thread before the
          // next paint, preventing jank from synchronous decode.
          try { await img.decode(); } catch (_) { /* broken/aborted image */ }
        }
      };
      _lazyObserver.observe(img);
    }
    // ── End lazy image loader ────────────────────────────────────────────────────

    // Generic debounce helper
    function debounce(fn, ms) {
      let timer;
      return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }

    // Version counter so concurrent renderScenes calls can bail out early
    let _renderScenesVersion = 0;
    // Version counter so loadMultipleFolders can be cancelled mid-flight
    let _loadFoldersVersion = 0;

    function loadVersionBadge() {
      if (!versionBadge) return;
      fetch('VERSION.txt', { cache: 'no-store' })
        .then((resp) => (resp.ok ? resp.text() : ''))
        .then((text) => {
          const lines = String(text || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (lines.length === 0) {
            versionBadge.textContent = 'Version: unknown';
            return;
          }
          if (lines.length === 1) {
            const line = lines[0];
            versionBadge.textContent = line.toLowerCase().startsWith('version') ? line : `Version: ${line}`;
            return;
          }
          versionBadge.textContent = lines.join(' | ');
        })
        .catch(() => {
          versionBadge.textContent = 'Version: unknown';
        });
      // Check for new versions from remote JSON endpoint but we need pywebview to be ready, 
      // so listen for the event or execute immediately if already mounted
      if (window.pywebview?.api) {
        checkRemoteVersion();
      } else {
        window.addEventListener('pywebviewready', checkRemoteVersion);
      }
    }

    // Check if running as Windows Store app
    async function isWindowsStoreApp() {
      try {
        if (!window.pywebview?.api?.is_windows_store_app) return false;
        const result = await window.pywebview.api.is_windows_store_app();
        return result?.is_store ?? false;
      } catch (e) {
        return false;
      }
    }

    // Get platform info
    async function getPlatformInfo() {
      try {
        if (!window.pywebview?.api?.get_platform_info) {
          // Fallback to client-side detection
          if (navigator.platform.includes('Mac')) return 'macos';
          if (navigator.platform.includes('Win')) return 'windows';
          return 'windows'; // default
        }
        const result = await window.pywebview.api.get_platform_info();
        return result?.platform ?? 'windows';
      } catch (e) {
        return 'windows';
      }
    }

    // Check remote version from JSON endpoint
    async function checkRemoteVersion() {
      try {
        // Read current app version from VERSION.txt
        let currentVer = _appVersion;
        if (!currentVer) {
          try {
            const versionResp = await fetch('VERSION.txt', { cache: 'no-store' });
            if (versionResp.ok) {
              const text = await versionResp.text();
              const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              if (lines.length > 0) {
                // Extract just the version part (e.g., "v(Swamp Sparrow)" from "Version: v(Swamp Sparrow)")
                const line = lines[0];
                currentVer = line.toLowerCase().startsWith('version') 
                  ? line.replace(/^version:\s*/i, '').trim()
                  : line;
              }
            }
          } catch (e) { /* ignore */ }
        }
        
        let versionList;
        if (window.pywebview?.api?.fetch_remote_version) {
          const res = await window.pywebview.api.fetch_remote_version();
          if (res && res.success && res.data) {
            versionList = res.data;
          }
        }
        
        if (!versionList) {
          const resp = await fetch('https://projectkestrel.org/version.json', { cache: 'no-store' });
          if (!resp.ok) return;
          versionList = await resp.json();
        }
        
        if (!Array.isArray(versionList) || versionList.length === 0) return;
        
        const latestVersion = versionList[0]; // first entry is latest
        
        // Compare versions: check if latest name differs from current
        if (!latestVersion.name) return;
        const normalizedLocal = (currentVer || '').replace(/^v\(/ig, '').replace(/\)$/g, '').trim();
        const normalizedRemote = latestVersion.name.replace(/^v\(/ig, '').replace(/\)$/g, '').trim();
        
        if (normalizedRemote === normalizedLocal) return;
        
        // Show update notification
        showVersionUpdateNotification(latestVersion);
      } catch (e) {
        // Network error, offline mode - ignore
      }
    }

    // Display the version update notification as a toast
    async function showVersionUpdateNotification(versionInfo) {
      console.log('[DEBUG] Showing version update notification for version:', versionInfo);
      const toast = document.getElementById('versionUpdateToast');
      if (!toast) return;
      
      const platform = await getPlatformInfo();
      const isStore = platform === 'windows' ? await isWindowsStoreApp() : false;
      
      // Priority symbol
      const priorityEl = document.getElementById('versionUpdatePriority');
      if (priorityEl) priorityEl.textContent = versionInfo.highPriority ? '⭐' : '•';
      
      // Title
      const titleEl = document.getElementById('versionUpdateTitle');
      if (titleEl) titleEl.textContent = `Update Available: ${versionInfo.name}`;
      
      // Changelog notes (show first 3)
      const notesEl = document.getElementById('versionUpdateNotes');
      if (notesEl && versionInfo.notes && Array.isArray(versionInfo.notes)) {
        notesEl.innerHTML = '';
        versionInfo.notes.slice(0, 3).forEach(note => {
          const li = document.createElement('li');
          li.textContent = note;
          notesEl.appendChild(li);
        });
      }
      
      // Windows-specific note (only show for Windows users)
      const windowsNoteEl = document.getElementById('versionUpdateWindowsNote');
      if (windowsNoteEl) {
        if (platform === 'windows') {
          windowsNoteEl.innerHTML = 'Windows users: Check for updates in the Microsoft Store within 1-3 days. If you used the traditional installer to install Kestrel, visit <a href="https://projectkestrel.org/download" target="_blank" style="color:#7ca3d9;text-decoration:underline;">projectkestrel.org/download</a> to manually update.';
          windowsNoteEl.style.display = 'block';
        } else {
          windowsNoteEl.style.display = 'none';
        }
      }
      
      // Download button
      const downloadBtn = document.getElementById('versionUpdateDownloadBtn');
      if (downloadBtn) {
        downloadBtn.href = `https://projectkestrel.org/download?platform=${platform}`;
        downloadBtn.textContent = platform === 'macos' ? 'Go to MacOS Download' : 'Go to Windows Download';
        downloadBtn.onclick = (e) => {
          e.preventDefault();
          window.open(`https://projectkestrel.org/download?platform=${platform}`, '_blank');
        };
      }
      
      // Close button
      const closeBtn = document.getElementById('versionUpdateClose');
      if (closeBtn) {
        closeBtn.onclick = () => {
          toast.style.display = 'none';
        };
      }
      
      // Show the toast
      toast.style.display = 'block';
      
      // Auto-hide after 10 seconds
      setTimeout(() => {
        if (toast.style.display === 'block') {
          toast.style.display = 'none';
        }
      }, 60000);
    }

    // Tooltip layer so tips can render over the main image area
    (function initTooltips() {
      const tipEl = document.createElement('div');
      tipEl.className = 'tooltip-layer';
      document.body.appendChild(tipEl);

      function positionTip(anchor) {
        const pad = 10;
        const rect = anchor.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const box = tipEl.getBoundingClientRect();

        let left = rect.left;
        let top = rect.top - box.height - 10;
        if (left + box.width + pad > vw) left = vw - box.width - pad;
        if (left < pad) left = pad;
        if (top < pad) top = rect.bottom + 10;
        if (top + box.height + pad > vh) top = vh - box.height - pad;

        tipEl.style.left = left + 'px';
        tipEl.style.top = top + 'px';
      }

      function showTip(e) {
        const tip = e.currentTarget.getAttribute('data-tip');
        if (!tip) return;
        tipEl.textContent = tip;
        tipEl.classList.add('visible');
        positionTip(e.currentTarget);
      }

      function hideTip() {
        tipEl.classList.remove('visible');
      }

      document.querySelectorAll('.help-tip').forEach((el) => {
        el.addEventListener('mouseenter', showTip);
        el.addEventListener('mousemove', (e) => positionTip(e.currentTarget));
        el.addEventListener('mouseleave', hideTip);
        el.addEventListener('blur', hideTip);
      });
    })();

    // Simple UI zoom controls (Chromium webviews support CSS zoom)
    let uiZoom = 1;
    function applyZoom() {
      const zoomEl = document.getElementById('mainZoom');
      if (!zoomEl) return;
      const z = uiZoom;
      // Use non-transform zoom so position:sticky on headers continues to work.
      // Prefer CSS `zoom` when available; fall back to transform-only if not supported.
      try {
        zoomEl.style.zoom = z.toFixed(2);
        // Ensure no transform is set (transform can break sticky behavior)
        zoomEl.style.transform = '';
        zoomEl.style.width = '';
        zoomEl.style.height = '';
      } catch (e) {
        // Fallback: use transform if browser doesn't support zoom (sticky may be affected)
        const s = uiZoom.toFixed(2);
        zoomEl.style.transform = `scale(${s})`;
        zoomEl.style.width = `calc(100% / ${s})`;
        zoomEl.style.height = `calc(100% / ${s})`;
      }
    }

    function sanitizePath(p) {
      if (!p) return '';
      // Normalize to forward slashes, trim quotes
      return String(p).replace(/^\"|\"$/g, '').replace(/\\/g, '/');
    }

    function joinPath(a, b) {
      a = sanitizePath(a); b = sanitizePath(b);
      if (!a) return b; if (!b) return a;
      return a.replace(/\/$/, '') + '/' + b.replace(/^\//, '');
    }

    async function getHandleFromRelativePath(dirHandle, relPath) {
      relPath = sanitizePath(relPath);
      if (rootIsKestrel && relPath.toLowerCase().startsWith('.kestrel/')) {
        relPath = relPath.substring('.kestrel/'.length);
      }
      const parts = relPath.split('/').filter(Boolean);
      let handle = dirHandle;
      for (let i = 0; i < parts.length; i++) {
        const isLast = i === parts.length - 1;
        try {
          handle = await handle.getDirectoryHandle(parts[i]);
        } catch (e) {
          if (isLast) {
            // maybe file
            try { return await handle.getFileHandle(parts[i]); } catch (_) { throw e; }
          } else {
            throw e;
          }
        }
      }
      return handle;
    }

    // Try to turn an absolute Windows path into a path relative to the selected root
    // Also handles paths that are already relative (from new relative roots format)
    function toRootRelative(absPath) {
      if (!absPath || !rootDirHandle) return null;
      const p = sanitizePath(absPath);

      // Check if path is ALREADY relative (new format)
      // Relative paths start with .kestrel/ or kestrel/ and don't have drive letters or leading /
      if (p.toLowerCase().startsWith('.kestrel/') || p.toLowerCase().startsWith('kestrel/')) {
        // Already relative - return as-is, but strip .kestrel/ prefix if rootIsKestrel
        return rootIsKestrel ? p.replace(/^\.?kestrel\//i, '') : p;
      }

      // Check for absolute path with embedded .kestrel folder (old format)
      const idx = p.toLowerCase().lastIndexOf('/.kestrel/');
      if (idx >= 0) {
        const rel = p.substring(idx + 1); // include .kestrel/…
        return rootIsKestrel ? rel.replace(/^\.kestrel\//i, '') : rel;
      }

      // fallback: if only filename, return that
      const base = p.split('/').pop();
      return base || null;
    }


    // Blob URL cache per path
    const blobUrlCache = new Map();

    /** Convert a base64 string to a Blob Object URL.  Unlike data: URIs, blob:
     *  URLs are decoded asynchronously by the browser's image-decode thread,
     *  keeping the main thread free during scroll. */
    function _base64ToBlobUrl(b64, mime) {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([buf], { type: mime || 'image/jpeg' }));
    }

    async function getBlobUrlForPath(relOrAbsPath, rootOverride) {
      if (!relOrAbsPath) return null;
      const effectiveRoot = rootOverride || rootPath;

      // Normalize separators immediately (cheap, matches culling.html behaviour)
      const rel = String(relOrAbsPath).replace(/\\/g, '/');

      // Cache check first — avoids ALL further work on already-loaded images
      // (this is the hot path during scroll-back through cached thumbnails)
      const cacheKey = `${effectiveRoot}:${rel}`;
      if (blobUrlCache.has(cacheKey)) return blobUrlCache.get(cacheKey);

      // PRIORITY 1: Python API (desktop app - all platforms)
      if (hasPywebviewApi && window.pywebview?.api?.read_image_file && effectiveRoot) {
        try {
          const result = await window.pywebview.api.read_image_file(rel, effectiveRoot);
          if (result && result.success && result.data) {
            // Use a blob: URL instead of a data: URL so the browser can decode
            // the image asynchronously on its decode thread rather than blocking
            // the main thread with synchronous base64 + JPEG/PNG parsing.
            const blobUrl = _base64ToBlobUrl(result.data, result.mime);
            blobUrlCache.set(cacheKey, blobUrl);
            return blobUrl;
          }
        } catch (e) {
          console.error('Python API image read failed:', e);
          return null;
        }
      }

      // PRIORITY 2: File System Access API (browser mode only)
      if (!rootPath && rootDirHandle) {
        try {
          const fileHandle = await getHandleFromRelativePath(rootDirHandle, rel);
          const file = await fileHandle.getFile();
          const url = URL.createObjectURL(file);
          blobUrlCache.set(cacheKey, url);
          return url;
        } catch (e) {
          return null;
        }
      }

      return null;
    }

    function parseNumber(v) {
      const n = parseFloat(v);
      return Number.isFinite(n) ? n : -1;
    }

    function parseCaptureTimeMs(v) {
      if (v == null) return Number.NaN;
      const raw = String(v).trim();
      if (!raw) return Number.NaN;
      let d = new Date(raw);
      if (isNaN(d)) d = new Date(raw.replace(' ', 'T'));
      const ms = d.getTime();
      return Number.isFinite(ms) ? ms : Number.NaN;
    }

    // Parse secondary species columns.
    // New format: JSON array strings e.g. '["Greater Yellowlegs","Vaux\'s Swift"]'.
    // Legacy format: numpy str() repr e.g. "[\'Greater Yellowlegs\' \"Vaux\'s Swift\"]".
    function parseSecondarySpecies(row) {
      if (row.__secondaryCache) return row.__secondaryCache;
      const listRaw = row.secondary_species_list;
      const scoresRaw = row.secondary_species_scores;
      const result = [];
      if (!listRaw || !scoresRaw) { row.__secondaryCache = result; return result; }
      try {
        let species = null, nums = null;
        // Try JSON first (new format)
        try {
          const ls = String(listRaw).trim();
          const ss = String(scoresRaw).trim();
          if (ls.startsWith('[') && ss.startsWith('[')) {
            const parsed = JSON.parse(ls);
            const parsedScores = JSON.parse(ss);
            if (Array.isArray(parsed) && Array.isArray(parsedScores)) {
              species = parsed; nums = parsedScores;
            }
          }
        } catch (_) { species = null; nums = null; }

        if (species === null) {
          // Legacy numpy repr fallback: numpy uses "..." for names with apostrophes
          species = [];
          const listStr = String(listRaw).replace(/\n\s*/g, ' ');
          const dqRe = /"([^"]+)"/g;
          const sqRe = /'([^']+)'/g;
          let m;
          while ((m = dqRe.exec(listStr)) !== null) { const n = m[1].trim(); if (n) species.push(n); }
          if (!species.length) {
            while ((m = sqRe.exec(listStr)) !== null) { const n = m[1].trim(); if (n) species.push(n); }
          }
          if (!species.length) {
            const inner = listStr.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
            inner.split(/\s{2,}|\s/).forEach(tok => { const t = tok.trim(); if (t) species.push(t); });
          }
          const scoreStr = String(scoresRaw).replace(/^[^\[]*\[/, '[').replace(/\].*$/, '').replace(/[\[\]]/g, '').trim();
          nums = scoreStr.split(/\s+/).map(parseNumber).filter(x => x >= 0);
        }
        for (let i = 0; i < species.length && i < nums.length; i++) {
          result.push({ name: String(species[i]), score: parseNumber(nums[i]) });
        }
      } catch (_) { }
      row.__secondaryCache = result;
      return result;
    }

    // Parse secondary family columns similar to secondary species.
    function parseSecondaryFamilies(row) {
      if (row.__secondaryFamilyCache) return row.__secondaryFamilyCache;
      const listRaw = row.secondary_family_list;
      const scoresRaw = row.secondary_family_scores;
      const result = [];
      if (!listRaw || !scoresRaw) { row.__secondaryFamilyCache = result; return result; }
      try {
        let fams = null, nums = null;
        // Try JSON first
        try {
          const ls = String(listRaw).trim();
          const ss = String(scoresRaw).trim();
          if (ls.startsWith('[') && ss.startsWith('[')) {
            const parsed = JSON.parse(ls);
            const parsedScores = JSON.parse(ss);
            if (Array.isArray(parsed) && Array.isArray(parsedScores)) {
              fams = parsed; nums = parsedScores;
            }
          }
        } catch (_) { fams = null; nums = null; }

        if (fams === null) {
          // Legacy numpy repr fallback
          fams = [];
          const listStr = String(listRaw).replace(/\n\s*/g, ' ');
          const dqRe = /"([^"]+)"/g;
          const sqRe = /'([^']+)'/g;
          let m;
          while ((m = dqRe.exec(listStr)) !== null) { const n = m[1].trim(); if (n) fams.push(n); }
          if (!fams.length) {
            while ((m = sqRe.exec(listStr)) !== null) { const n = m[1].trim(); if (n) fams.push(n); }
          }
          if (!fams.length) {
            const inner = listStr.replace(/^\s*\[/, '').replace(/\]\s*$/, '');
            inner.split(/\s{2,}|\s/).forEach(tok => { const t = tok.trim(); if (t) fams.push(t); });
          }
          const scoreStr = String(scoresRaw).replace(/^[^\[]*\[/, '[').replace(/\].*$/, '').replace(/[\[\]]/g, '').trim();
          nums = scoreStr.split(/\s+/).map(parseNumber).filter(x => x >= 0);
        }
        for (let i = 0; i < fams.length && i < nums.length; i++) {
          result.push({ name: String(fams[i]), score: parseNumber(nums[i]) });
        }
      } catch (_) { }
      row.__secondaryFamilyCache = result;
      return result;
    }

    function ensureSceneNameColumn() {
      if (!header.includes('scene_name')) { header.push('scene_name'); }
      for (const r of rows) if (!('scene_name' in r)) r.scene_name = '';
    }

    // Ensure rating columns exist and default values are set
    function ensureRatingColumns() {
      if (!header.includes('rating')) header.push('rating');
      if (!header.includes('rating_origin')) header.push('rating_origin');
      if (!header.includes('normalized_rating')) header.push('normalized_rating');
      if (!header.includes('exposure_correction')) header.push('exposure_correction');
      if (!header.includes('detection_scores')) header.push('detection_scores');
      if (!header.includes('culled')) header.push('culled');
      if (!header.includes('culled_origin')) header.push('culled_origin');
      for (const r of rows) {
        if (!('rating' in r)) r.rating = '';
        if (!('rating_origin' in r)) r.rating_origin = '';
        if (!('normalized_rating' in r)) r.normalized_rating = '';
        if (!('exposure_correction' in r)) r.exposure_correction = '0';
        if (!('detection_scores' in r)) r.detection_scores = '';
        if (!('culled' in r)) r.culled = '';
        if (!('culled_origin' in r)) r.culled_origin = '';
        r.culled_origin = normalizeCullOrigin(r);
      }
    }

    function normalizeCullOrigin(row) {
      const status = row?.culled === 'accept' || row?.culled === 'reject' ? row.culled : '';
      const raw = String(row?.culled_origin || '').toLowerCase();
      if (raw === 'manual' || raw === 'auto' || raw === 'verified') return raw;
      if (status) return 'manual';
      return '';
    }

    /** Get (or lazily initialise) the scenedata object for a rootPath. */
    function _initScenedata(rp) {
      if (!_scenedata[rp]) _scenedata[rp] = { version: '2.0', image_ratings: {}, scenes: {} };
      return _scenedata[rp];
    }

    function _getSceneIdParts(sceneId) {
      const parts = String(sceneId).split(':');
      const sceneCount = parts.pop();
      const slot = parts.length ? parseInt(parts[0], 10) : null;
      return { slot, sceneCount };
    }

    function _getSceneScenedataEntry(sceneOrId, create = false, sceneRows = null) {
      const sceneId = typeof sceneOrId === 'string' ? sceneOrId : sceneOrId?.id;
      if (!sceneId) return null;
      const { sceneCount } = _getSceneIdParts(sceneId);
      const rowsForScene = sceneRows || getSceneRows(sceneId);
      const rp = rowsForScene[0]?.__rootPath || rootPath || '';
      if (!rp) return null;
      const sd = _initScenedata(rp);
      if (!create) return sd.scenes?.[sceneCount] || null;
      if (!sd.scenes[sceneCount]) {
        sd.scenes[sceneCount] = {
          scene_id: sceneCount,
          image_filenames: rowsForScene.map(r => r.filename || '').filter(Boolean),
          name: '',
          status: 'pending',
          user_tags: { species: [], families: [], finalized: false }
        };
      }
      return sd.scenes[sceneCount];
    }

    function _computeSceneTagsFromRows(sceneRows, confThreshold, includeSecondary, includeFamilies = true) {
      const speciesSet = new Set();
      const familySet = new Set();
      for (const r of sceneRows) {
        const conf = parseNumber(r.species_confidence);
        if (conf >= confThreshold && r.species && r.species !== 'No Bird') speciesSet.add(r.species);
        if (includeFamilies) {
          const fconf = parseNumber(r.family_confidence);
          if (fconf >= confThreshold && r.family && r.family !== 'Unknown' && r.family !== 'N/A') familySet.add(r.family);
        }
        if (includeSecondary) {
          const secondary = parseSecondarySpecies(r);
          for (const { name, score } of secondary) {
            if (score >= confThreshold && name && name !== 'No Bird') speciesSet.add(name);
          }
          if (includeFamilies) {
            const secFams = parseSecondaryFamilies(r);
            for (const { name, score } of secFams) {
              if (score >= confThreshold && name && name !== 'Unknown' && name !== 'N/A') familySet.add(name);
            }
          }
        }
      }
      return {
        species: Array.from(speciesSet).sort(),
        families: Array.from(familySet).sort(),
      };
    }

    function _collectCurrentlyVisibleSceneTags(sceneId) {
      const thresholdEl = el('#speciesConf');
      const confThreshold = thresholdEl ? (parseFloat(thresholdEl.value) || 0) : 0;
      const includeSecondaryCheckbox = document.getElementById('includeSecondarySpecies');
      const includeSecondary = includeSecondaryCheckbox ? includeSecondaryCheckbox.checked : !!getSetting('includeSecondarySpecies', false);
      return _computeSceneTagsFromRows(getSceneRows(sceneId), confThreshold, includeSecondary, true);
    }

    function _normalizeScenedataForSave(rp, groupRows) {
      const sd = _initScenedata(rp);
      const existingScenes = sd.scenes || {};
      const grouped = new Map();
      for (const r of groupRows) {
        const sceneCount = String(r.scene_count);
        if (!grouped.has(sceneCount)) grouped.set(sceneCount, []);
        grouped.get(sceneCount).push(r);
      }

      const normalizedScenes = {};
      for (const [sceneCount, sceneRows] of grouped) {
        const existing = existingScenes[sceneCount] || {};
        const existingTags = existing.user_tags || {};
        const finalized = existingTags.finalized === true;
        normalizedScenes[sceneCount] = {
          scene_id: sceneCount,
          image_filenames: sceneRows.map(r => r.filename || '').filter(Boolean),
          name: String(existing.name || sceneRows.find(r => String(r.scene_name || '').trim().length)?.scene_name || '').trim(),
          status: finalized ? 'accepted' : (existing.status === 'rejected' ? 'rejected' : 'pending'),
          user_tags: {
            species: finalized ? Array.from(new Set((existingTags.species || []).map(String).filter(Boolean))).sort() : [],
            families: finalized ? Array.from(new Set((existingTags.families || []).map(String).filter(Boolean))).sort() : [],
            finalized,
          },
        };
      }

      sd.scenes = normalizedScenes;
      return sd;
    }

    // Helper: is this image manually rated (>0 stars)?
    function isManualRated(r) { return getRating(r) > 0 && getOrigin(r) === 'manual'; }

    function aggregateScenes(minSpeciesConf, searchTerm, sortBy, includeSecondary, includeFamilies) {
      const groups = new Map();
      for (const r of rows) {
        // Prefix with folderSlot so scenes from different folders never collide
        const id = (r.__folderSlot != null ? r.__folderSlot + ':' : '') + r.scene_count;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(r);
      }

      const list = [];
      for (const [sceneId, arr] of groups) {
        // representative by max quality
        let rep = arr[0];
        for (const r of arr) if (parseNumber(r.quality) > parseNumber(rep.quality)) rep = r;

        const computedTags = _computeSceneTagsFromRows(arr, minSpeciesConf, includeSecondary, includeFamilies);
        let species = computedTags.species.slice();
        if (includeFamilies) {
          const merged = new Set([...species, ...computedTags.families]);
          species = Array.from(merged).sort();
        }

        const maxQ = Math.max(...arr.map(a => parseNumber(a.quality)));
        const captureMsList = arr.map(a => parseCaptureTimeMs(a.capture_time)).filter(Number.isFinite);
        const captureTimeMs = captureMsList.length ? Math.min(...captureMsList) : Number.POSITIVE_INFINITY;
        const rowRp = arr[0]?.__rootPath || rootPath || '';
        const rowSc = arr[0] ? String(arr[0].scene_count) : '';
        const sdScene = rowRp && rowSc ? _scenedata[rowRp]?.scenes?.[rowSc] : null;
        const sceneName = sdScene?.name || (arr.find(a => (a.scene_name || '').trim().length)?.scene_name || '').trim();
        const isApproved = !!sdScene?.user_tags?.finalized;
        // If this scene has finalized user_tags, use them for species/family display
        if (isApproved) {
          const utSpecies = (sdScene.user_tags.species || []).slice().sort();
          const utFams = includeFamilies ? (sdScene.user_tags.families || []).slice().sort() : [];
          species = utFams.length ? Array.from(new Set([...utSpecies, ...utFams])).sort() : utSpecies;
        }

        list.push({
          id: sceneId,
          images: arr.slice().sort((a, b) => parseNumber(b.quality) - parseNumber(a.quality)),
          representative: rep,
          imageCount: arr.length,
          species,
          maxQuality: maxQ,
          captureTimeMs,
          sceneName,
          isApproved
        });
      }

      // filter by search term
      const q = (searchTerm || '').trim().toLowerCase();
      const filtered = q ? list.filter(s => s.species.some(sp => sp.toLowerCase().includes(q))) : list;

      // sort
      const sorted = filtered.sort((a, b) => {
        if (sortBy === 'captureTime') {
          if (a.captureTimeMs !== b.captureTimeMs) return a.captureTimeMs - b.captureTimeMs;
          return parseNumber(String(a.id).split(':').pop()) - parseNumber(String(b.id).split(':').pop());
        }
        if (sortBy === 'imageCount') return b.imageCount - a.imageCount;
        if (sortBy === 'sceneId') return parseNumber(String(a.id).split(':').pop()) - parseNumber(String(b.id).split(':').pop());
        return b.maxQuality - a.maxQuality;
      });

      return sorted;
    }

    function getRating(row) {
      const rp = row?.__rootPath || rootPath || '';
      const fn = row?.filename || '';
      // 1. Manual rating stored in scenedata (pywebview desktop mode)
      const sd = _scenedata[rp];
      if (sd?.image_ratings && fn && fn in sd.image_ratings) {
        const n = parseInt(sd.image_ratings[fn], 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
      }
      // 2. Legacy row-level manual rating (FSAPI browser mode or pre-migration data)
      if (String(row?.rating_origin).toLowerCase() === 'manual') {
        const n = parseInt(row?.rating, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
      }
      // 3. Auto: normalized rating computed by last apply_normalization call
      const norm = parseInt(row?.__normalized_rating ?? row?.normalized_rating, 10);
      if (Number.isFinite(norm)) return Math.max(0, Math.min(5, norm));
      return 0;
    }
    function getOrigin(row) {
      const rp = row?.__rootPath || rootPath || '';
      const fn = row?.filename || '';
      const sd = _scenedata[rp];
      if (sd?.image_ratings && fn && fn in sd.image_ratings) return 'manual';
      const s = String(row?.rating_origin || '').toLowerCase();
      if (s === 'manual') return 'manual';
      const hasNorm = row?.__normalized_rating != null || (row?.normalized_rating != null && row?.normalized_rating !== '');
      return hasNorm ? 'auto' : '';
    }
    function setRating(row, val, origin = 'manual') {
      const v = Math.max(0, Math.min(5, parseInt(val, 10) || 0));
      const rp = row?.__rootPath || rootPath || '';
      const fn = row?.filename || '';
      if (hasPywebviewApi && rp && fn) {
        // pywebview desktop mode: persist rating in scenedata only
        const sd = _initScenedata(rp);
        const current = sd.image_ratings[fn];
        if (current === v && v !== 0) return; // no change
        if (v === 0) delete sd.image_ratings[fn]; else sd.image_ratings[fn] = v;
      } else {
        // FSAPI browser mode: legacy row-level storage
        const vs = String(v);
        if ((row.rating || '') === vs && (row.rating_origin || '') === origin) return;
        row.rating = vs;
        row.rating_origin = origin;
      }
      markDirty();
      if (typeof window.refreshSceneFilter === 'function') window.refreshSceneFilter();
    }
    function createStarBar(row) {
      const wrap = document.createElement('div');
      wrap.className = 'stars';

      function render(tempVal = null) {
        const val = tempVal != null ? tempVal : getRating(row);
        const origin = tempVal != null ? 'manual' : getOrigin(row);
        Array.from(wrap.children).forEach((st, i) => {
          const filled = i < val;
          st.classList.toggle('filled', filled);
          st.classList.toggle('manual', filled && origin === 'manual');
          st.classList.toggle('auto', filled && origin !== 'manual');
          st.textContent = filled ? '★' : '☆';
        });
      }

      for (let i = 1; i <= 5; i++) {
        const s = document.createElement('span');
        s.className = 'star';
        s.textContent = '☆';
        s.title = 'Click to set rating';
        // Click only — hover preview is handled by delegated listeners below
        s.addEventListener('click', (ev) => { ev.stopPropagation(); setRating(row, i, 'manual'); render(); });
        wrap.appendChild(s);
      }

      // 2 delegated listeners per bar instead of 10 per-star mouseenter/mouseleave
      wrap.addEventListener('mousemove', (ev) => {
        const t = ev.target;
        if (t.classList.contains('star')) {
          const idx = Array.prototype.indexOf.call(wrap.children, t);
          if (idx >= 0) render(idx + 1);
        }
      });
      wrap.addEventListener('mouseleave', () => render());

      render();
      return wrap;
    }

    function updateStatusBar(sceneList) {
      const totalImages = sceneList.reduce((acc, s) => acc + s.imageCount, 0);
      const totalScenes = sceneList.length;
      const allScenes = new Set(rows.map(r => r.scene_count)).size;
      const dirtyMark = dirty ? ' • unsaved changes' : '';
      setStatus(`Showing ${totalScenes} scenes with ${totalImages} images${totalScenes < allScenes ? ` (filtered from ${allScenes})` : ''}${dirtyMark}`);
    }

    // Render: Scenes — grouped by folder when multiple folders are loaded
    async function renderScenes() {
      const myVer = ++_renderScenesVersion;
      const minC = parseFloat(el('#speciesConf').value) || 0;
      const search = el('#search').value;
      const sortBy = el('#sortBy').value;
      const onlyRatedScenes = !!document.getElementById('filterScenesManualRated')?.checked;
      const groupByFolder = document.getElementById('groupByFolder')?.checked ?? getSetting('groupByFolder', true);
      const groupByTime = document.getElementById('groupByTime')?.checked ?? getSetting('groupByTime', true);
      const includeSecondaryCheckbox = document.getElementById('includeSecondarySpecies');
      const includeSecondary = includeSecondaryCheckbox ? includeSecondaryCheckbox.checked : !!getSetting('includeSecondarySpecies', false);
      const includeFamilies = true;
      scenes = aggregateScenes(minC, search, sortBy, includeSecondary, includeFamilies);

      // Apply scene-level manual-rated filter without mutating global scenes
      const visibleScenes = onlyRatedScenes ? scenes.filter(s => s.images.some(isManualRated)) : scenes;

      updateStatusBar(visibleScenes);
      sceneGrid.innerHTML = '';

      // Show welcome panel when no data is loaded; hide it once a folder is open
      const _welcomePanel = document.getElementById('welcomePanel');
      if (_welcomePanel) _welcomePanel.classList.toggle('hidden', rows.length > 0);

      // Flat index for shift-click range selection
      _visibleSceneOrder = visibleScenes.map(s => String(s.id));

      // ---- Two-level grouping: folder → time-buckets ----
      function getTimeBucket(s) {
        const ct = s.representative?.capture_time;
        if (!ct) return '';
        try {
          const d = new Date(ct);
          if (isNaN(d)) return '';
          const pad = n => String(n).padStart(2, '0');
          return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}`;
        } catch (_) { return ''; }
      }
      function getBucketDay(bucket) { return bucket ? bucket.split('T')[0] : ''; }
      function formatNodeTime(bucket) {
        if (!bucket) return 'Unknown time';
        try {
          const d = new Date(bucket + ':00');
          if (isNaN(d)) return bucket;
          return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch (_) { return bucket; }
      }
      function formatNodeDay(bucket) {
        if (!bucket) return '';
        try {
          const d = new Date(bucket + ':00');
          if (isNaN(d)) return '';
          return d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
        } catch (_) { return ''; }
      }

      // Build folderMap: folderKey → { folderPath, buckets: Map<tb, scene[]>, bucketOrder: [] }
      const folderOrder = [];
      const folderMap = new Map();
      for (const s of visibleScenes) {
        const rp = groupByFolder ? (s.representative?.__rootPath || '') : '';
        const fk = rp || '__single__';
        if (!folderMap.has(fk)) { folderMap.set(fk, { folderPath: rp, buckets: new Map(), bucketOrder: [] }); folderOrder.push(fk); }
        const fd = folderMap.get(fk);
        const tb = groupByTime ? (getTimeBucket(s) || '__notime__') : '__all__';
        if (!fd.buckets.has(tb)) { fd.buckets.set(tb, []); fd.bucketOrder.push(tb); }
        fd.buckets.get(tb).push(s);
      }
      const showFolderHeaders = groupByFolder;

      function buildCard(s) {
        const card = document.createElement('article');
        card.className = 'card';
        card.dataset.sceneId = String(s.id);
        if (selectedSceneIds.has(String(s.id))) card.classList.add('selected');

        const th = document.createElement('div');
        th.className = 'thumb';
        const img = document.createElement('img');
        img.alt = s.representative?.filename || '';
        lazyLoadImg(img, () => getBlobUrlForPath(
          s.representative?.export_path || s.representative?.crop_path,
          s.representative?.__rootPath
        ));
        th.appendChild(img);
        card.appendChild(th);

        const body = document.createElement('div');
        body.className = 'body';
        const title = document.createElement('div');
        title.className = 'title';
        const _localNum = String(s.id).split(':').pop();
        const _folderName = folderBaseName(s.representative?.__rootPath || '');
        // Show folder name in title only when a single folder is loaded;
        // in multi-folder mode the folder group header already shows it.
        const _titleHtml = (_folderName && !showFolderHeaders)
          ? `<i class="folder-name">${escapeHtml(_folderName)}</i><span class="title-sep"> / </span><b>#${_localNum}</b>`
          : `<b>#${_localNum}</b>`;
        title.innerHTML = _titleHtml + (s.sceneName ? ` <span class="name">\u2014 ${decodeEntities(escapeHtml(s.sceneName))}</span>` : '');
        title.title = (s.representative?.__rootPath || String(s.id)) + (s.sceneName ? ` \u2014 ${s.sceneName}` : '');
        const meta = document.createElement('div');
        // Use a dedicated class for title-level badges so other .meta uses are unaffected
        meta.className = 'meta title-badges';
        meta.innerHTML = `<span class="score">★ ${fmt3(s.maxQuality)}</span><span>\ud83d\udcf8 ${s.imageCount}</span>`;
        const chips = document.createElement('div');
        chips.className = 'chips';
        if (s.isApproved) {
          card.classList.add('scene-approved');
          chips.classList.add('reviewed-tags');
        }
        for (const sp of s.species.slice(0, 3)) {
          const c = document.createElement('span'); c.className = s.isApproved ? 'chip manual-approved' : 'chip'; c.textContent = sp; c.title = sp; chips.appendChild(c);
        }
        if (s.species.length > 3) { const more = document.createElement('span'); more.className = 'chip badge'; more.textContent = `+${s.species.length - 3} more`; more.title = s.species.slice(3).join(', '); chips.appendChild(more); }
        // Put title and badges on the same physical line: left = title, right = badges
        const titleRow = document.createElement('div');
        titleRow.className = 'title-row';
        titleRow.appendChild(title);
        titleRow.appendChild(meta);
        body.appendChild(titleRow);
        body.appendChild(chips);
        card.appendChild(body);

        card.addEventListener('click', (ev) => {
          const sid = String(s.id);
          if (ev.shiftKey && _lastSelectedIdx >= 0) {
            // Range-select from last clicked to this
            const idx = _visibleSceneOrder.indexOf(sid);
            if (idx >= 0) {
              const lo = Math.min(_lastSelectedIdx, idx);
              const hi = Math.max(_lastSelectedIdx, idx);
              for (let i = lo; i <= hi; i++) selectedSceneIds.add(_visibleSceneOrder[i]);
            }
            updateSelectionUI();
            ev.preventDefault(); return;
          }
          if (ev.ctrlKey || ev.metaKey) {
            // Toggle individual
            if (selectedSceneIds.has(sid)) selectedSceneIds.delete(sid); else selectedSceneIds.add(sid);
            _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
            updateSelectionUI();
            ev.preventDefault(); return;
          }
          if (selectedSceneIds.size > 0) {
            // In selection mode: plain click also toggles
            if (selectedSceneIds.has(sid)) selectedSceneIds.delete(sid); else selectedSceneIds.add(sid);
            _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
            updateSelectionUI();
            return;
          }
          // Normal: open scene dialog
          _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
          openSceneDialog(sid);
        });
        return card;
      }

      const batch = 24;

      // ---- Timeline builder (used when groupByTime is on) ----
      function buildTimeline(fd, containerEl) {
        const timelineEl = document.createElement('div');
        timelineEl.className = 'timeline-body';
        let prevDay = null;
        const allBuckets = fd.bucketOrder;

        for (let ni = 0; ni < allBuckets.length; ni++) {
          const tb = allBuckets[ni];
          const tbScenes = fd.buckets.get(tb);
          const isLast = ni === allBuckets.length - 1;
          const thisDay = getBucketDay(tb);

          // Day banner when the calendar date changes between buckets
          if (thisDay && thisDay !== '__notime__' && thisDay !== prevDay) {
            const banner = document.createElement('div');
            banner.className = 'timeline-day-banner';
            banner.textContent = formatNodeDay(tb);
            timelineEl.appendChild(banner);
            prevDay = thisDay;
          }

          const nodeEl = document.createElement('div');
          nodeEl.className = 'timeline-node';

          // Rail column: dot + connecting line
          const railCol = document.createElement('div');
          railCol.className = 'timeline-rail-col';
          const dot = document.createElement('div');
          dot.className = 'timeline-dot';
          const line = document.createElement('div');
          line.className = 'timeline-line' + (isLast ? ' last' : '');
          railCol.appendChild(dot);
          railCol.appendChild(line);

          // Content column: time label + scene cards
          const contentCol = document.createElement('div');
          contentCol.className = 'timeline-content-col';

          if (tb !== '__all__') {
            const hdr = document.createElement('div');
            hdr.className = 'timeline-node-header';
            const timeSpan = document.createElement('span');
            timeSpan.className = 'timeline-node-time';
            timeSpan.textContent = tb === '__notime__' ? 'Unknown time' : formatNodeTime(tb);
            const countSpan = document.createElement('span');
            countSpan.className = 'timeline-node-count muted';
            countSpan.textContent = `${tbScenes.length} scene${tbScenes.length === 1 ? '' : 's'}`;
            hdr.appendChild(timeSpan);
            hdr.appendChild(countSpan);
            contentCol.appendChild(hdr);
          }

          const gridEl = document.createElement('div');
          gridEl.className = 'grid timeline-grid';
          contentCol.appendChild(gridEl);

          nodeEl.appendChild(railCol);
          nodeEl.appendChild(contentCol);
          timelineEl.appendChild(nodeEl);

          for (let i = 0; i < tbScenes.length; i += batch) {
            if (myVer !== _renderScenesVersion) return;
            const slice = tbScenes.slice(i, i + batch);
            const frag = document.createDocumentFragment();
            for (const s of slice) frag.appendChild(buildCard(s));
            gridEl.appendChild(frag);
          }
        }
        containerEl.appendChild(timelineEl);
      }

      // ---- Main folder rendering loop ----
      for (const fk of folderOrder) {
        const fd = folderMap.get(fk);
        const allScenesInFolder = [...fd.buckets.values()].flat();
        let bodyEl; // receives the timeline or flat grid

        if (showFolderHeaders && fd.folderPath) {
          const folderName = folderBaseName(fd.folderPath) || fd.folderPath || '(unknown folder)';
          const collapsed = collapsedFolders.has(fk);

          const groupEl = document.createElement('div');
          groupEl.className = 'folder-group';

          const hdr = document.createElement('div');
          hdr.className = 'folder-group-header' + (collapsed ? ' collapsed' : '');
          hdr.innerHTML = `<span class="folder-group-toggle">\u25bc</span><span class="folder-group-name">${escapeHtml(folderName)}</span><span class="folder-group-count muted">${allScenesInFolder.length} scene${allScenesInFolder.length === 1 ? '' : 's'}</span>`;

          const actions = document.createElement('div');
          actions.className = 'folder-group-actions';

          const explorerBtn = document.createElement('button');
          explorerBtn.className = 'action-btn';
          explorerBtn.innerHTML = '<i>📂</i> Open in Explorer';
          explorerBtn.title = 'Open this folder in File Explorer';
          explorerBtn.addEventListener('click', (ev) => { ev.stopPropagation(); window.pywebview.api.open_file_explorer(fd.folderPath); });
          actions.appendChild(explorerBtn);

          const cullingBtn = document.createElement('button');
          cullingBtn.className = 'action-btn';
          cullingBtn.innerHTML = '<i>✂</i> Open Culling Assistant';
          cullingBtn.title = 'Open the AI-assisted culling workflow for this folder';
          cullingBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openCullingAssistant(fd.folderPath); });
          actions.appendChild(cullingBtn);

          const writeMetaBtn = document.createElement('button');
          writeMetaBtn.className = 'action-btn';
          writeMetaBtn.innerHTML = '<i>📝</i> Write XMP Metadata';
          writeMetaBtn.title = 'Write ratings and tags to XMP sidecar files for use in Lightroom/Bridge';
          writeMetaBtn.addEventListener('click', (ev) => { ev.stopPropagation(); writeMetadataForFolder(fd.folderPath); });
          actions.appendChild(writeMetaBtn);

          const folderOptionsBtn = document.createElement('button');
          folderOptionsBtn.className = 'action-btn';
          folderOptionsBtn.innerHTML = '<i>⚙</i> Folder options...';
          folderOptionsBtn.title = 'Reset culling state for this folder';
          folderOptionsBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showFolderOptionsDialog(fd.folderPath); });
          actions.appendChild(folderOptionsBtn);

          hdr.appendChild(actions);

          bodyEl = document.createElement('div');
          bodyEl.className = 'folder-group-body' + (collapsed ? ' hidden' : '');

          const _fk = fk, _bodyEl = bodyEl, _hdr = hdr;
          hdr.addEventListener('click', () => {
            if (collapsedFolders.has(_fk)) collapsedFolders.delete(_fk); else collapsedFolders.add(_fk);
            _hdr.classList.toggle('collapsed');
            _bodyEl.classList.toggle('hidden');
          });
          groupEl.appendChild(hdr);
          groupEl.appendChild(bodyEl);
          sceneGrid.appendChild(groupEl);
        } else {
          bodyEl = document.createElement('div');
          sceneGrid.appendChild(bodyEl);
        }

        if (groupByTime) {
          buildTimeline(fd, bodyEl);
        } else {
          const gridEl = document.createElement('div');
          gridEl.className = 'folder-group-grid grid';
          bodyEl.appendChild(gridEl);
          for (let i = 0; i < allScenesInFolder.length; i += batch) {
            if (myVer !== _renderScenesVersion) return;
            const slice = allScenesInFolder.slice(i, i + batch);
            const frag = document.createDocumentFragment();
            for (const s of slice) frag.appendChild(buildCard(s));
            gridEl.appendChild(frag);
          }
        }
      }
    }

    // Update card highlights and show/hide floating action bar based on current selection
    function updateSelectionUI() {
      const n = selectedSceneIds.size;
      document.querySelectorAll('.card[data-scene-id]').forEach(c => {
        c.classList.toggle('selected', selectedSceneIds.has(c.dataset.sceneId));
      });
      const bar = document.getElementById('selectActionBar');
      if (!bar) return;
      if (n >= 2) {
        bar.classList.remove('hidden');
        const lbl = document.getElementById('selectActionLabel');
        if (lbl) lbl.textContent = `${n} scene${n === 1 ? '' : 's'} selected`;
      } else {
        bar.classList.add('hidden');
      }
    }

    // Merge all currently selected scenes (must all be in same folder)
    async function executeSelectionMerge() {
      const ids = Array.from(selectedSceneIds);
      if (ids.length < 2) return;
      const parsed = ids.map(id => {
        const parts = String(id).split(':');
        const count = parts.pop();
        const slot = parts.length ? parseInt(parts[0], 10) : 0;
        return { id, slot, count };
      });
      const slots = new Set(parsed.map(p => p.slot));
      if (slots.size > 1) {
        alert('Cannot merge scenes from different folders.\nSelect scenes from the same folder only.');
        return;
      }
      const target = parsed.slice().sort((a, b) => parseNumber(a.count) - parseNumber(b.count))[0];
      const slot = target.slot;
      const targetCount = target.count;
      const mergedSceneId = String(slot != null ? slot + ':' + targetCount : targetCount);
      let changed = 0;
      for (const r of rows) {
        if ((r.__folderSlot ?? 0) !== slot) continue;
        if (parsed.some(p => p.count === String(r.scene_count)) && String(r.scene_count) !== targetCount) {
          r.scene_count = targetCount; changed++;
        }
      }
      // Update scenedata: move filenames from non-target scenes into target scene
      if (hasPywebviewApi) {
        const rpForMerge = rows.find(r => (r.__folderSlot ?? 0) === slot)?.__rootPath || rootPath || '';
        if (rpForMerge) {
          const sd = _initScenedata(rpForMerge);
          const allMovedFiles = new Set();
          for (const p of parsed) {
            if (p.count !== targetCount && sd.scenes[p.count]) {
              for (const f of sd.scenes[p.count].image_filenames || []) allMovedFiles.add(f);
              delete sd.scenes[p.count];
            }
          }
          if (!sd.scenes[targetCount]) {
            sd.scenes[targetCount] = { scene_id: targetCount, image_filenames: [], name: '', status: 'pending', user_tags: { species: [], families: [], finalized: false } };
          }
          for (const f of allMovedFiles) {
            if (!sd.scenes[targetCount].image_filenames.includes(f)) sd.scenes[targetCount].image_filenames.push(f);
          }
        }
      }
      if (changed) {
        dirty = true; _notifyDirty(true);
        el('#saveCsv').disabled = false;
        el('#revertCsv').disabled = false;
        setStatus(`Merged ${ids.length} scenes into #${targetCount}. ${changed} rows updated.`);
      }
      selectedSceneIds.clear();
      _lastSelectedIdx = -1;
      updateSelectionUI();
      await renderScenes();
      // Scroll to the merged scene card; fall back to current scroll position
      const mergedCard = document.querySelector(`.card[data-scene-id="${CSS.escape(mergedSceneId)}"]`);
      if (mergedCard) mergedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Render images inside the scene dialog, honoring the manual-rated filter and stable ordering
    // ---- Scene dialog RAW zoom (click-drag on thumbnail → zoom in previewBox) ----
    let sceneZoomActive = false;
    let sceneZoomRow = null;
    let sceneZoomThumbEl = null;
    let sceneZoomScale = 5;   // adjustable via scroll or slider
    let zoomLastX = 0, zoomLastY = 0; // last mouse pos for slider re-apply
    const sceneRawCache = new Map();   // unique row key -> blob URL
    const sceneRawLoading = new Set(); // (rootPath|filename) currently being fetched

    function getSceneRawCacheKey(row) {
      const disabled = getSetting('raw_exposure_correction_disabled', false);
      return [
        row.__rootPath || '',
        row.filename || '',
        row.export_path || '',
        row.crop_path || '',
        disabled ? 'noexp' : 'exp'
      ].join('|');
    }

    function applySceneZoomTransform(imgEl, thumbEl, clientX, clientY, scale) {
      if (!imgEl || !thumbEl) return;
      const box = imgEl.closest('#previewBox');
      if (!box) return;
      const iw = imgEl.naturalWidth || imgEl.width;
      const ih = imgEl.naturalHeight || imgEl.height;
      if (!iw || !ih) return;

      const rect = thumbEl.getBoundingClientRect();
      const xNorm = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const yNorm = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));

      const z = Math.max(1, Number(scale) || 1);
      let cropW = Math.max(1, iw / z);
      let cropH = Math.max(1, ih / z);

      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.round(box.clientWidth * dpr));
      const targetH = Math.max(1, Math.round(box.clientHeight * dpr));
      const boxAspect = targetW / targetH;
      if (cropW / cropH > boxAspect) cropW = cropH * boxAspect;
      else cropH = cropW / boxAspect;

      let sx = xNorm * iw - cropW * 0.5;
      let sy = yNorm * ih - cropH * 0.5;
      sx = Math.max(0, Math.min(iw - cropW, sx));
      sy = Math.max(0, Math.min(ih - cropH, sy));

      let canvas = box.querySelector('canvas.scene-zoom-canvas');
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.className = 'scene-zoom-canvas';
        box.appendChild(canvas);
      }

      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(imgEl, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
      imgEl.style.visibility = 'hidden';
    }

    function formatExposureEv(v) {
      const n = parseFloat(v) || 0;
      const abs = Math.abs(n);
      if (abs < 0.005) return '+0.00';
      const sign = n >= 0 ? '+' : '-';
      return sign + abs.toFixed(2);
    }

    async function loadSceneRawAsync(row) {
      const disabled = getSetting('raw_exposure_correction_disabled', false);
      const expCorr = disabled ? 0.0 : (parseFloat(row.exposure_correction) || 0);
      const key = getSceneRawCacheKey(row);
      sceneRawLoading.add(key);
      try {
        const res = await window.pywebview.api.read_raw_full(
          row.filename, row.__rootPath || '', expCorr
        );
        if (res && res.debug) {
          console.info('[raw-debug][scene]', row.filename, res.debug);
        }
        if (res && res.success && res.data) {
          const url = _base64ToBlobUrl(res.data, res.mime || 'image/jpeg');
          sceneRawCache.set(key, url);
          // Upgrade preview if this row is still the active zoom row
          if (sceneZoomActive && sceneZoomRow === row) {
            const box = el('#previewBox');
            const curImg = box?.querySelector('img');
            if (curImg) {
              curImg.src = url;
              curImg.dataset.isRaw = '1';
              curImg.onload = () => {
                if (sceneZoomActive && sceneZoomRow === row && sceneZoomThumbEl) {
                  applySceneZoomTransform(curImg, sceneZoomThumbEl, zoomLastX, zoomLastY, sceneZoomScale);
                }
              };
              if (box) box.dataset.rawLabel = `RAW (${formatExposureEv(expCorr)} EV)`;
              box.classList.add('raw-loaded');
              if (sceneZoomThumbEl) {
                applySceneZoomTransform(curImg, sceneZoomThumbEl, zoomLastX, zoomLastY, sceneZoomScale);
              }
            }
          }
        }
      } catch (e) {
        console.warn('loadSceneRawAsync error:', e);
      } finally {
        sceneRawLoading.delete(key);
      }
    }

    function startSceneZoomPreview(row, thumbEl, mouseEv) {
      sceneZoomActive = true;
      sceneZoomRow = row;
      sceneZoomThumbEl = thumbEl;
      const key = getSceneRawCacheKey(row);
      const previewBox = el('#previewBox');
      const disabled = getSetting('raw_exposure_correction_disabled', false);
      const expCorr = disabled ? 0.0 : (parseFloat(row.exposure_correction) || 0);
      previewBox.classList.add('zoom-active');
      previewBox.dataset.rawLabel = `RAW Zoom (${formatExposureEv(expCorr)} EV) (Scroll to zoom in/out)`;
      zoomLastX = mouseEv.clientX;
      zoomLastY = mouseEv.clientY;

      // Step 1: Immediately show the already-loaded thumbnail as a placeholder
      const thumbImgSrc = thumbEl.querySelector('img')?.src;
      if (thumbImgSrc) {
        previewBox.innerHTML = '';
        const stub = document.createElement('img');
        stub.src = thumbImgSrc;
        stub.style.imageRendering = 'crisp-edges';
        stub.onload = () => {
          if (sceneZoomActive && sceneZoomRow === row && sceneZoomThumbEl === thumbEl) {
            applySceneZoomTransform(stub, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
          }
        };
        previewBox.appendChild(stub);
        applySceneZoomTransform(stub, thumbEl, mouseEv.clientX, mouseEv.clientY, sceneZoomScale);
      }

      // Step 2: Async — upgrade to full export or cached RAW
      (async () => {
        if (!sceneZoomActive || sceneZoomRow !== row) return;
        const cachedRaw = sceneRawCache.get(key);
        if (cachedRaw) {
          previewBox.innerHTML = '';
          const imgEl = document.createElement('img');
          imgEl.src = cachedRaw;
          imgEl.dataset.isRaw = '1';
          imgEl.style.imageRendering = 'crisp-edges';
          imgEl.onload = () => {
            if (sceneZoomActive && sceneZoomRow === row && sceneZoomThumbEl === thumbEl) {
              applySceneZoomTransform(imgEl, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
            }
          };
          previewBox.appendChild(imgEl);
          previewBox.classList.add('raw-loaded');
          applySceneZoomTransform(imgEl, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
        } else {
          const url = await getBlobUrlForPath(row.export_path || row.crop_path, row.__rootPath);
          if (!sceneZoomActive || sceneZoomRow !== row) return;
          if (url && url !== thumbImgSrc) {
            previewBox.innerHTML = '';
            const imgEl = document.createElement('img');
            imgEl.src = url;
            imgEl.style.imageRendering = 'crisp-edges';
            imgEl.onload = () => {
              if (sceneZoomActive && sceneZoomRow === row && sceneZoomThumbEl === thumbEl) {
                applySceneZoomTransform(imgEl, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
              }
            };
            previewBox.appendChild(imgEl);
            applySceneZoomTransform(imgEl, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
          }
        }
      })();

      // Step 3: Kick off RAW load in background
      if (!sceneRawCache.has(key) && !sceneRawLoading.has(key) && hasPywebviewApi) {
        loadSceneRawAsync(row);
      }

      // Show zoom slider
      const zoomWrap = el('#sceneZoomWrap');
      const slider = el('#sceneZoomSlider');
      if (slider) {
        slider.value = sceneZoomScale;
        slider.oninput = () => {
          sceneZoomScale = parseFloat(slider.value);
          const curImg = el('#previewBox')?.querySelector('img');
          if (curImg) applySceneZoomTransform(curImg, thumbEl, zoomLastX, zoomLastY, sceneZoomScale);
        };
      }

      const onMove = (ev) => {
        if (!sceneZoomActive) return;
        zoomLastX = ev.clientX; zoomLastY = ev.clientY;
        const curImg = el('#previewBox')?.querySelector('img');
        if (curImg) applySceneZoomTransform(curImg, thumbEl, ev.clientX, ev.clientY, sceneZoomScale);
      };

      const onWheel = (ev) => {
        if (!sceneZoomActive) return;
        ev.preventDefault();
        const delta = ev.deltaY < 0 ? 0.5 : -0.5;
        sceneZoomScale = Math.max(2, Math.min(12, sceneZoomScale + delta));
        if (slider) slider.value = sceneZoomScale;
        const curImg = el('#previewBox')?.querySelector('img');
        if (curImg) applySceneZoomTransform(curImg, thumbEl, ev.clientX, ev.clientY, sceneZoomScale);
        zoomLastX = ev.clientX; zoomLastY = ev.clientY;
      };

      const onUp = () => {
        sceneZoomActive = false;
        sceneZoomRow = null;
        sceneZoomThumbEl = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        window.removeEventListener('wheel', onWheel);
        const box = el('#previewBox');
        box.classList.remove('zoom-active', 'raw-loaded');
        const canvas = box?.querySelector('canvas.scene-zoom-canvas');
        if (canvas) canvas.remove();
        const curImg = box?.querySelector('img');
        if (curImg) {
          curImg.style.visibility = '';
          curImg.style.transform = '';
          curImg.style.transformOrigin = '';
          delete curImg.dataset.isRaw;
        }
        box.dataset.rawLabel = 'RAW';
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
      window.addEventListener('wheel', onWheel, { passive: false });
    }
    // ---- End scene dialog RAW zoom ----

    // ── Filmstrip scene view state ──
    let currentImageIndex = 0;
    let _currentScene = null; // reference to the scene object currently shown

    function ensureCulledColumn() {
      if (!header.includes('culled')) header.push('culled');
      for (const r of rows) { if (r.culled === undefined) r.culled = ''; }
    }

    function getCullStatus(row) {
      const raw = (row.culled === 'accept' || row.culled === 'reject') ? row.culled : '';
      if (!raw) return '';
      const origin = normalizeCullOrigin(row);
      // Auto culls are non-authoritative in filmstrip/main scene view.
      if (origin === 'auto') return '';
      return raw;
    }

    function getRawCullStatus(row) {
      return (row.culled === 'accept' || row.culled === 'reject') ? row.culled : '';
    }

    function setCullStatus(row, status) {
      ensureRatingColumns();
      row.culled = status || ''; // 'accept', 'reject', or ''
      row.culled_origin = status ? 'manual' : '';
      markDirty();
    }

    function renderFilmstrip(scene) {
      const grid = el('#imageGrid');
      grid.innerHTML = '';
      const images = scene.images;
      const frag = document.createDocumentFragment();

      for (let idx = 0; idx < images.length; idx++) {
        const r = images[idx];
        const card = document.createElement('div');
        card.className = 'filmstrip-card';
        card.dataset.idx = idx;
        const cull = getCullStatus(r);
        const cullOrigin = normalizeCullOrigin(r);
        if (cull === 'accept') card.classList.add('accepted');
        if (cull === 'reject') card.classList.add('rejected');
        if (cullOrigin === 'manual') card.classList.add('manual-cull');
        if (cullOrigin === 'verified') card.classList.add('verified-cull');
        if (cullOrigin === 'auto') card.classList.add('auto-cull');
        if (idx === currentImageIndex) card.classList.add('active');

        // Thumbnail
        const th = document.createElement('div');
        th.className = 'filmstrip-thumb';
        const img = document.createElement('img');
        img.alt = r.filename || '';
        img.loading = 'lazy';
        lazyLoadImg(img, () => getBlobUrlForPath(r.export_path || r.crop_path, r.__rootPath));
        th.appendChild(img);
        card.appendChild(th);

        // Info
        const info = document.createElement('div');
        info.className = 'filmstrip-info';
        const fn = document.createElement('div');
        fn.className = 'filmstrip-filename';
        fn.textContent = r.filename || '';
        info.appendChild(fn);
        const meta = document.createElement('div');
        meta.className = 'filmstrip-meta';
        const rating = getRating(r);
        const origin = getOrigin(r);
        let starHtml = '';
        for (let s = 1; s <= 5; s++) {
          const filled = s <= rating;
          const cls = filled ? (origin === 'manual' ? 'filled manual' : 'filled auto') : '';
          starHtml += `<span class="${cls}">${filled ? '★' : '☆'}</span>`;
        }
        meta.innerHTML = `<span class="filmstrip-stars">${starHtml}</span><span>Q ${fmt3(r.quality)}</span>`;
        info.appendChild(meta);
        card.appendChild(info);

        // Tooltip with detailed metadata
        const tip = document.createElement('div');
        tip.className = 'filmstrip-tooltip';
        tip.innerHTML = [
          `<b>${escapeHtml(r.filename || '')}</b>`,
          `Species: ${escapeHtml(r.species || 'Unknown')} (${fmt3(r.species_confidence)})`,
          `Quality: ${fmt3(r.quality)}`,
          `Rating: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${origin ? `(${origin})` : ''}`,
          cull ? `Status: ${cull === 'accept' ? '✓ Accepted' : '✗ Rejected'}` : '',
        ].filter(Boolean).join('<br>');
        card.appendChild(tip);

        // Click to select
        card.addEventListener('click', () => {
          if (_splitMode) return; // handled by split mode
          selectFilmstripImage(idx, scene);
        });

        // Hover to temporarily preview
        card.addEventListener('mouseenter', () => {
          if (_splitMode) return;
          selectFilmstripImage(idx, scene, true);
        });
        card.addEventListener('mouseleave', () => {
          if (_splitMode) return;
          selectFilmstripImage(currentImageIndex, scene, true);
        });

        // Double-click to open in editor
        card.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openInEditor(r); });

        frag.appendChild(card);
      }
      grid.appendChild(frag);

      // Update scene navigation hints
      updateFilmstripHints(scene);
    }

    function updateFilmstripHints(scene) {
      const sceneIdx = scenes.indexOf(scene);
      const hintL = el('#filmstripHintLeft');
      const hintR = el('#filmstripHintRight');
      if (hintL) {
        if (sceneIdx > 0) { hintL.classList.remove('hidden'); }
        else { hintL.classList.add('hidden'); }
      }
      if (hintR) {
        if (sceneIdx >= 0 && sceneIdx < scenes.length - 1) { hintR.classList.remove('hidden'); }
        else { hintR.classList.add('hidden'); }
      }
    }

    function scrollFilmstripToCenter(idx) {
      const grid = el('#imageGrid');
      const card = grid?.children[idx];
      if (!card || !grid) return;
      const gridRect = grid.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const targetScrollLeft = card.offsetLeft - grid.offsetWidth / 2 + card.offsetWidth / 2;
      grid.scrollTo({ left: targetScrollLeft, behavior: 'smooth' });
    }

    async function selectFilmstripImage(idx, scene, isHover = false) {
      if (!scene || !scene.images || idx < 0 || idx >= scene.images.length) return;
      if (!isHover) {
        currentImageIndex = idx;
      }
      const r = scene.images[idx];

      // Update filmstrip card active state and center if not just hovering
      const grid = el('#imageGrid');
      if (grid && !isHover) {
        grid.querySelectorAll('.filmstrip-card').forEach((c, i) => {
          c.classList.toggle('active', i === idx);
        });
        scrollFilmstripToCenter(idx);
      }

      // Load export preview
      const exportBox = el('#previewBox');
      if (exportBox) {
        exportBox.innerHTML = '';
        const eurl = await getBlobUrlForPath(r.export_path, r.__rootPath);
        if (eurl) {
          const eimg = document.createElement('img');
          eimg.src = eurl;
          exportBox.appendChild(eimg);
        } else { exportBox.innerHTML = '<span class="muted">No export preview</span>'; }
      }

      // Load crop preview
      const cropBox = el('#previewCropBox');
      if (cropBox) {
        cropBox.innerHTML = '';
        const curl = await getBlobUrlForPath(r.crop_path, r.__rootPath);
        if (curl) {
          const cimg = document.createElement('img');
          cimg.src = curl;
          cropBox.appendChild(cimg);
        } else { cropBox.innerHTML = '<span class="muted">No crop preview</span>'; }
      }

      // Update preview panel accept/reject glow
      const exportPanel = el('#scenePreviewExport');
      const cropPanel = el('#scenePreviewCrop');
      const cull = getCullStatus(r);
      [exportPanel, cropPanel].forEach(p => {
        if (!p) return;
        p.classList.remove('scene-accepted', 'scene-rejected');
        if (cull === 'accept') p.classList.add('scene-accepted');
        if (cull === 'reject') p.classList.add('scene-rejected');
      });

      // Update info bar
      const fnEl = el('#sceneInfoFilename');
      if (fnEl) { fnEl.textContent = r.filename || '—'; fnEl.title = r.filename || ''; }

      const qEl = el('#sceneInfoQuality');
      if (qEl) qEl.textContent = `Quality: ${fmt3(r.quality)}`;

      const cullToggle = el('#sceneCullToggle');
      if (cullToggle) {
        cullToggle.querySelectorAll('.cull-btn').forEach(btn => {
          const btnCull = btn.dataset.cull;
          btn.classList.toggle('active', btnCull === cull || (btnCull === 'none' && !cull));
          btn.onclick = (ev) => {
            ev.stopPropagation();
            const newCull = btnCull === 'none' ? null : btnCull;
            const currentRaw = getRawCullStatus(r);
            const currentNormalized = currentRaw || null;
            const forceClearAuto = newCull === null && normalizeCullOrigin(r) === 'auto' && currentRaw;
            if (currentNormalized !== newCull || forceClearAuto) {
              setCullStatus(r, newCull);
              selectFilmstripImage(idx, scene); // refresh
              renderScenes(); // refresh timeline
            }
          };
        });
      }

      const metaEl = el('#sceneInfoMeta');
      if (metaEl) {
        const sp = decodeEntities(r.species || 'Unknown');
        const spConf = fmt3(r.species_confidence);
        const fam = decodeEntities(r.family || 'Unknown');
        const famConf = fmt3(r.family_confidence);
        metaEl.textContent = `${sp} (${spConf}) | ${fam} (${famConf}) · Image ${idx + 1} of ${scene.images.length}`;
      }

      // Render star bar in info bar
      const starsEl = el('#sceneInfoStars');
      if (starsEl) {
        starsEl.innerHTML = '';
        starsEl.appendChild(createStarBar(r));
      }
    }

    // Allow other code to refresh the scene images when filter or ratings change
    window.refreshSceneFilter = function () {
      if (currentSceneId != null && _currentScene) {
        renderFilmstrip(_currentScene);
        selectFilmstripImage(currentImageIndex, _currentScene);
      }
    };

    // Render: Scene dialog
    let _splitMode = false;
    let _sceneEditMode = false;
    let _sceneEditDraft = null;

    function _beginSceneEditDraft(sceneId) {
      const current = collectSceneSpecies(sceneId);
      _sceneEditDraft = {
        sceneId: String(sceneId),
        species: current.species.slice().sort(),
        families: current.families.slice().sort(),
      };
    }

    function _finalizeSceneReview(sceneId) {
      if (!hasPywebviewApi) return false;
      const sceneRows = getSceneRows(sceneId);
      if (!sceneRows.length) return false;
      const sceneEntry = _getSceneScenedataEntry(sceneId, true, sceneRows);
      if (!sceneEntry) return false;
      const draft = (_sceneEditDraft && _sceneEditDraft.sceneId === String(sceneId))
        ? _sceneEditDraft
        : _collectCurrentlyVisibleSceneTags(sceneId);
      sceneEntry.image_filenames = sceneRows.map(r => r.filename || '').filter(Boolean);
      sceneEntry.status = 'accepted';
      sceneEntry.user_tags.species = draft.species.slice().sort();
      sceneEntry.user_tags.families = draft.families.slice().sort();
      sceneEntry.user_tags.finalized = true;
      markDirty();
      return true;
    }

    function collectSceneSpecies(sceneId) {
      if (_sceneEditMode && _sceneEditDraft && _sceneEditDraft.sceneId === String(sceneId)) {
        return {
          species: _sceneEditDraft.species.slice().sort(),
          families: _sceneEditDraft.families.slice().sort(),
          approved: false,
        };
      }
      const sdScene = _getSceneScenedataEntry(sceneId, false);
      if (sdScene?.user_tags?.finalized) {
        return {
          species: (sdScene.user_tags.species || []).slice().sort(),
          families: (sdScene.user_tags.families || []).slice().sort(),
          approved: true,
        };
      }
      const computed = _collectCurrentlyVisibleSceneTags(sceneId);
      return { ...computed, approved: false };
    }

    let _activeTagInputType = null; // 'species' or 'family'
    let _activeTagInputSceneId = null;

    function renderTopbarTags(scene) {
      const tagsEl = el('#sceneTopbarTags');
      if (!tagsEl) return;
      const { species, families, approved } = collectSceneSpecies(scene.id);
      const chipClass = approved ? 'chip manual-approved' : 'chip';

      let html = '';
      // Species
      html += '<span class="scene-tag-label">Species:</span> ';
      if (species.length) {
        for (const sp of species) {
          html += `<span class="${chipClass}">${escapeHtml(sp)}<span class="chip-x" data-remove-species="${escapeHtml(sp)}" title="Remove '${escapeHtml(sp)}'">×</span></span>`;
        }
      } else {
        html += '<span class="muted" style="font-size:11px">—</span>';
      }
      if (_activeTagInputType === 'species' && _activeTagInputSceneId === String(scene.id)) {
        html += `<span class="chip-input-wrap"><input type="text" class="chip-input" id="inlineTagInput" placeholder="Species..." /><button class="chip-commit-btn" title="Save">✓</button></span>`;
      } else {
        html += `<button class="scene-chip-add" data-add-type="species" title="Add species tag">+</button>`;
      }

      html += '<span class="scene-tag-sep"></span>';

      // Families
      html += '<span class="scene-tag-label">Family:</span> ';
      if (families.length) {
        for (const fm of families) {
          html += `<span class="${chipClass}">${escapeHtml(fm)}<span class="chip-x" data-remove-family="${escapeHtml(fm)}" title="Remove '${escapeHtml(fm)}'">×</span></span>`;
        }
      } else {
        html += '<span class="muted" style="font-size:11px">—</span>';
      }
      if (_activeTagInputType === 'family' && _activeTagInputSceneId === String(scene.id)) {
        html += `<span class="chip-input-wrap"><input type="text" class="chip-input" id="inlineTagInput" placeholder="Family..." /><button class="chip-commit-btn" title="Save">✓</button></span>`;
      } else {
        html += `<button class="scene-chip-add" data-add-type="family" title="Add family tag">+</button>`;
      }

      if (approved) {
        html += '<span class="scene-tag-sep"></span><span class="approval-note" style="font-size:11px">✓ Reviewed</span>';
      }

      tagsEl.innerHTML = html;

      // Wire remove buttons
      tagsEl.querySelectorAll('[data-remove-species]').forEach(btn => {
        btn.style.cursor = 'pointer';
        btn.onclick = () => {
          if (!_sceneEditDraft) _beginSceneEditDraft(scene.id);
          _sceneEditMode = true;
          removeSpeciesFromScene(scene, btn.dataset.removeSpecies);
          _finalizeSceneReview(scene.id);
          _sceneEditMode = false;
          _sceneEditDraft = null;
          const updatedScene = reloadScene(scene.id) || scene;
          renderTopbarTags(updatedScene);
          renderScenes();
        };
      });
      tagsEl.querySelectorAll('[data-remove-family]').forEach(btn => {
        btn.style.cursor = 'pointer';
        btn.onclick = () => {
          if (!_sceneEditDraft) _beginSceneEditDraft(scene.id);
          _sceneEditMode = true;
          removeFamilyFromScene(scene, btn.dataset.removeFamily);
          _finalizeSceneReview(scene.id);
          _sceneEditMode = false;
          _sceneEditDraft = null;
          const updatedScene = reloadScene(scene.id) || scene;
          renderTopbarTags(updatedScene);
          renderScenes();
        };
      });

      // Wire (+) add buttons
      tagsEl.querySelectorAll('.scene-chip-add').forEach(btn => {
        btn.onclick = () => {
          _activeTagInputType = btn.dataset.addType;
          _activeTagInputSceneId = String(scene.id);
          renderTopbarTags(scene);
          const inp = el('#inlineTagInput');
          if (inp) inp.focus();
        };
      });

      // Wire inline input
      const inp = el('#inlineTagInput');
      if (inp) {
        const commit = () => {
          const val = inp.value.trim();
          if (val) {
            if (!_sceneEditDraft) _beginSceneEditDraft(scene.id);
            _sceneEditMode = true;
            if (_activeTagInputType === 'species') {
              _sceneEditDraft.species = Array.from(new Set([..._sceneEditDraft.species, val])).sort();
            } else {
              _sceneEditDraft.families = Array.from(new Set([..._sceneEditDraft.families, val])).sort();
            }
            _finalizeSceneReview(scene.id);
            _sceneEditMode = false;
            _sceneEditDraft = null;
            showToast(`Added ${_activeTagInputType} "${val}"`, 2000);
          }
          _activeTagInputType = null;
          _activeTagInputSceneId = null;
          const updated = reloadScene(scene.id) || scene;
          renderTopbarTags(updated);
          renderScenes();
        };

        inp.onkeydown = (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') {
            e.preventDefault();
            _activeTagInputType = null;
            _activeTagInputSceneId = null;
            renderTopbarTags(scene);
          }
        };
        inp.onblur = (e) => {
          // Small delay to allow clicking the commit button if it exists
          setTimeout(() => {
            if (document.activeElement === tagsEl.querySelector('.chip-commit-btn')) return;
            if (_activeTagInputType) commit(); 
          }, 150);
        };
        const commitBtn = tagsEl.querySelector('.chip-commit-btn');
        if (commitBtn) commitBtn.onclick = commit;
      }
    }

    // Keep renderSceneMetaChips as an alias for compatibility
    function renderSceneMetaChips(scene, editable) {
      renderTopbarTags(scene);
    }

    async function openSceneDialog(sceneId, startIndex = 0) {
      const scene = scenes.find(s => String(s.id) === String(sceneId));
      if (!scene) return;
      currentSceneId = scene.id;
      _currentScene = scene;
      _splitMode = false;
      _sceneEditMode = false;
      _sceneEditDraft = null;
      currentImageIndex = startIndex;

      // ── Top bar: title ──
      const localNum = String(scene.id).split(':').pop();
      const folderName = folderBaseName(scene.representative?.__rootPath || '');
      let titleText = folderName || ('Scene ' + scene.id);
      titleText += ' — #' + localNum;
      if (scene.sceneName) titleText += ' — ' + scene.sceneName;
      titleText += ` (${scene.images.length} images)`;
      const titleEl = el('#sceneTopbarTitle');
      if (titleEl) titleEl.textContent = titleText;

      // ── Rename setup ──
      el('#sceneName').value = scene.sceneName || '';
      el('#sceneRenameInline').classList.add('hidden');

      // ── Pencil rename button ──
      el('#scenePencilBtn').onclick = () => {
        const renameRow = el('#sceneRenameInline');
        const isShown = !renameRow.classList.contains('hidden');
        if (isShown) {
          // Apply rename
          applySceneName(scene.id, el('#sceneName').value);
          renameRow.classList.add('hidden');
          // Update title
          const updScene = reloadScene(scene.id) || scene;
          const nm = updScene.sceneName || '';
          let t = folderName || ('Scene ' + scene.id);
          t += ' — #' + localNum;
          if (nm) t += ' — ' + nm;
          t += ` (${scene.images.length} images)`;
          titleEl.textContent = t;
          renderScenes();
        } else {
          renameRow.classList.remove('hidden');
          el('#sceneName').focus();
        }
      };
      el('#sceneRenameOk').onclick = () => { el('#scenePencilBtn').click(); };
      el('#sceneRenameCancel').onclick = () => { el('#sceneRenameInline').classList.add('hidden'); };
      el('#sceneName').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); el('#scenePencilBtn').click(); } };

      // ── Tags ──
      renderTopbarTags(scene);

      // ── Shortcut legend toggle ──
      el('#sceneShortcutBtn').onclick = () => {
        el('#sceneShortcutLegend').classList.toggle('hidden');
      };
      el('#sceneShortcutLegend').classList.add('hidden');

      // ── Filmstrip ──
      renderFilmstrip(scene);

      // Wire horizontal scrolling via mouse wheel for filmstrip
      const grid = el('#imageGrid');
      if (grid) {
        grid.onwheel = (ev) => {
          if (ev.deltaY !== 0) {
            grid.scrollLeft += ev.deltaY;
            ev.preventDefault();
          }
        };
      }

      // ── RAW zoom on export preview (mousedown on the export preview box) ──
      const exportImgBox = el('#previewBox');
      if (exportImgBox) {
        exportImgBox.onmousedown = (ev) => {
          if (ev.button !== 0) return;
          const r = scene.images[currentImageIndex];
          if (!r) return;
          ev.preventDefault();
          startSceneZoomPreview(r, exportImgBox, ev);
        };
      }

      // ── Close ──
      el('#closeDlg').onclick = () => {
        if (_splitMode) { exitSplitMode(); }
        _sceneEditDraft = null;
        _sceneEditMode = false;
        _currentScene = null;
        document.removeEventListener('keydown', _sceneKeyHandler);
        sceneDlg.close();
      };

      // ── Split Scene ──
      el('#splitSceneBtn').onclick = () => {
        if (_splitMode) {
          applySplitScene(scene);
        } else {
          enterSplitMode(scene);
        }
      };

      // ── Scene navigation hints ──
      const hintL = el('#filmstripHintLeft');
      const hintR = el('#filmstripHintRight');
      if (hintL) hintL.onclick = () => navigateToScene(-1);
      if (hintR) hintR.onclick = () => navigateToScene(1);

      // ── Keyboard handler ──
      document.removeEventListener('keydown', _sceneKeyHandler);
      document.addEventListener('keydown', _sceneKeyHandler);

      // ── Show dialog and select start image ──
      sceneDlg.showModal();
      await selectFilmstripImage(startIndex, scene);
    }

    // Navigate to prev/next scene
    function navigateToScene(direction, startIndex = 0) {
      if (!_currentScene) return;
      const idx = scenes.indexOf(_currentScene);
      if (idx < 0) return;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= scenes.length) return;
      const nextScene = scenes[newIdx];
      // Close current and open next
      _sceneEditDraft = null;
      _sceneEditMode = false;
      document.removeEventListener('keydown', _sceneKeyHandler);
      sceneDlg.close();
      openSceneDialog(nextScene.id, startIndex);
    }

    // Keyboard handler for scene dialog
    function _sceneKeyHandler(e) {
      // Skip if focused in input/textarea (but allow our inline tag input to handle its own Esc/Enter)
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!_currentScene) return;

      const images = _currentScene.images;
      const len = images.length;

      // Tab skips to next scene; Ctrl+Tab skips to previous
      if (e.key === 'Tab') {
        e.preventDefault();
        navigateToScene(e.ctrlKey ? -1 : 1, 0);
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey) {
            // Jump to end of scene, or next scene's start if already at end
            if (currentImageIndex < len - 1) {
              selectFilmstripImage(len - 1, _currentScene);
            } else {
              navigateToScene(1, 0);
            }
          } else {
            if (currentImageIndex < len - 1) {
              selectFilmstripImage(currentImageIndex + 1, _currentScene);
            } else {
              navigateToScene(1, 0);
            }
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          if (e.ctrlKey) {
            // Jump to start of scene, or prev scene's start if already at start
            if (currentImageIndex > 0) {
              selectFilmstripImage(0, _currentScene);
            } else {
              navigateToScene(-1, 0);
            }
          } else {
            if (currentImageIndex > 0) {
              selectFilmstripImage(currentImageIndex - 1, _currentScene);
            } else {
              // At first image — jump to previous scene's LAST image
              const prevIdx = scenes.indexOf(_currentScene) - 1;
              if (prevIdx >= 0) {
                const prevScene = scenes[prevIdx];
                navigateToScene(-1, prevScene.images.length - 1);
              }
            }
          }
          break;
        case 'z':
        case 'Z':
          e.preventDefault();
          if (images[currentImageIndex]) {
            setCullStatus(images[currentImageIndex], 'reject');
            _refreshCurrentFilmstripCard();
          }
          break;
        case 'x':
        case 'X':
          e.preventDefault();
          if (images[currentImageIndex]) {
            setCullStatus(images[currentImageIndex], '');
            _refreshCurrentFilmstripCard();
          }
          break;
        case 'c':
        case 'C':
          e.preventDefault();
          if (images[currentImageIndex]) {
            setCullStatus(images[currentImageIndex], 'accept');
            _refreshCurrentFilmstripCard();
          }
          break;
        case '1': case '2': case '3': case '4': case '5':
          e.preventDefault();
          if (images[currentImageIndex]) {
            setRating(images[currentImageIndex], parseInt(e.key, 10), 'manual');
            _refreshCurrentFilmstripCard();
          }
          break;
        case ' ':
          e.preventDefault();
          if (images[currentImageIndex]) openInEditor(images[currentImageIndex]);
          break;
        case 'Escape':
          e.preventDefault();
          el('#closeDlg')?.click();
          break;
      }
    }

    // Refresh the current filmstrip card + info bar after a status/rating change
    function _refreshCurrentFilmstripCard() {
      if (!_currentScene) return;
      // Re-render the filmstrip to update card classes
      renderFilmstrip(_currentScene);
      // Re-select the current image to update previews and info bar
      selectFilmstripImage(currentImageIndex, _currentScene);
    }

    function applySceneName(sceneId, name) {
      const newName = String(name || '').trim();
      const { slot, sceneCount } = _getSceneIdParts(sceneId);
      let rowChanged = 0;
      let rp = null;
      const sceneRows = [];
      for (const r of rows) {
        const slotMatch = slot === null || (r.__folderSlot ?? 0) === slot;
        if (slotMatch && String(r.scene_count) === sceneCount) {
          if (!rp && r.__rootPath) rp = r.__rootPath;
          sceneRows.push(r);
          if ((r.scene_name || '') !== newName) { r.scene_name = newName; rowChanged++; }
        }
      }
      // Persist scene name in scenedata (pywebview mode)
      let sdChanged = false;
      if (hasPywebviewApi && rp) {
        const sceneEntry = _getSceneScenedataEntry(sceneId, true, sceneRows);
        if (sceneEntry) {
          sceneEntry.image_filenames = sceneRows.map(r => r.filename || '').filter(Boolean);
          if (sceneEntry.name !== newName) { sceneEntry.name = newName; sdChanged = true; }
        }
      }
      if (rowChanged || sdChanged) {
        markDirty();
        const updatedScene = reloadScene(sceneId);
        if (updatedScene) renderSceneMetaChips(updatedScene, _sceneEditMode);
        renderScenes();
      }
    }

    // --- Species & Family editing helpers ---
    function markDirty() {
      attemptAutoSave();
    }

    function _syncSceneUserTags() {
      // Tag edits stay in the edit-session draft until the user clicks Done Editing.
    }

    function getSceneRows(sceneId) {
      const parts = String(sceneId).split(':');
      const sceneCount = parts.pop();
      const slot = parts.length ? parseInt(parts[0], 10) : null;
      return rows.filter(r => {
        const slotMatch = slot === null || (r.__folderSlot ?? 0) === slot;
        return slotMatch && String(r.scene_count) === sceneCount;
      });
    }

    function removeSpeciesFromScene(scene, speciesName) {
      if (!_sceneEditDraft || _sceneEditDraft.sceneId !== String(scene.id)) return;
      const before = _sceneEditDraft.species.length;
      _sceneEditDraft.species = _sceneEditDraft.species.filter(sp => sp !== speciesName).sort();
      const changed = before - _sceneEditDraft.species.length;
      if (changed) {
        const updatedScene = reloadScene(scene.id);
        if (updatedScene) {
          renderSceneMetaChips(updatedScene, _sceneEditMode);
        }
        showToast(`Removed "${speciesName}" from reviewed scene tags`, 2000);
      }
    }

    function removeFamilyFromScene(scene, familyName) {
      if (!_sceneEditDraft || _sceneEditDraft.sceneId !== String(scene.id)) return;
      const before = _sceneEditDraft.families.length;
      _sceneEditDraft.families = _sceneEditDraft.families.filter(fm => fm !== familyName).sort();
      const changed = before - _sceneEditDraft.families.length;
      if (changed) {
        const updatedScene = reloadScene(scene.id);
        if (updatedScene) {
          renderSceneMetaChips(updatedScene, _sceneEditMode);
        }
        showToast(`Removed family "${familyName}" from reviewed scene tags`, 2000);
      }
    }

    function addSpeciesToScene(scene) {
      const input = el('#editAddSpecies');
      const name = (input.value || '').trim();
      if (!name) return;
      
      const wasEdit = _sceneEditMode;
      if (!_sceneEditDraft) _beginSceneEditDraft(scene.id);
      _sceneEditMode = true;
      
      const before = _sceneEditDraft.species.length;
      _sceneEditDraft.species = Array.from(new Set([..._sceneEditDraft.species, name])).sort();
      const changed = _sceneEditDraft.species.length !== before;
      
      if (changed) {
        _finalizeSceneReview(scene.id);
        input.value = '';
        const updatedScene = reloadScene(scene.id) || scene;
        renderTopbarTags(updatedScene);
        renderScenes();
        showToast(`Added species "${name}" to reviewed scene tags`, 2000);
      }
      
      if (!wasEdit) {
        _sceneEditMode = false;
        _sceneEditDraft = null;
      }
      el('#editPanel')?.classList.add('hidden');
    }

    function addFamilyToScene(scene) {
      const input = el('#editAddFamily');
      const name = (input.value || '').trim();
      if (!name) return;
      
      const wasEdit = _sceneEditMode;
      if (!_sceneEditDraft) _beginSceneEditDraft(scene.id);
      _sceneEditMode = true;
      
      const before = _sceneEditDraft.families.length;
      _sceneEditDraft.families = Array.from(new Set([..._sceneEditDraft.families, name])).sort();
      const changed = _sceneEditDraft.families.length !== before;
      
      if (changed) {
        _finalizeSceneReview(scene.id);
        input.value = '';
        const updatedScene = reloadScene(scene.id) || scene;
        renderTopbarTags(updatedScene);
        renderScenes();
        showToast(`Added family "${name}" to reviewed scene tags`, 2000);
      }
      
      if (!wasEdit) {
        _sceneEditMode = false;
        _sceneEditDraft = null;
      }
      el('#editPanel')?.classList.add('hidden');
    }

    function reloadScene(sceneId) {
      const minC = parseFloat(el('#speciesConf').value) || 0;
      const search = el('#search').value;
      const sortBy = el('#sortBy').value;
      const includeSecondary = document.getElementById('includeSecondarySpecies')?.checked ?? false;
      const all = aggregateScenes(minC, search, sortBy, includeSecondary, true);
      return all.find(s => String(s.id) === String(sceneId));
    }

    function refreshSceneMeta(scene) {
      renderSceneMetaChips(scene, _sceneEditMode);
    }

    // --- Scene split helpers ---
    let _splitSelected = new Set();

    function enterSplitMode(scene) {
      _splitMode = true;
      _splitSelected.clear();
      el('#splitSceneBtn').textContent = 'Create New Scene from Selected';
      showToast('Click images to select them for the new scene, then press "Create New Scene from Selected"', 4000);
      // Re-render images with checkboxes
      renderSceneImagesWithSplit(scene);
    }

    function exitSplitMode() {
      _splitMode = false;
      _splitSelected.clear();
      el('#splitSceneBtn').textContent = 'Split Scene\u2026';
      // Re-render images without checkboxes
      const scene = scenes.find(s => String(s.id) === String(currentSceneId));
      if (scene) {
        renderFilmstrip(scene);
        selectFilmstripImage(currentImageIndex, scene);
      }
    }

    function renderSceneImagesWithSplit(scene) {
      const infoBox = el('#previewInfo');
      if (infoBox) infoBox.textContent = '—';
      const grid = el('#imageGrid');
      grid.innerHTML = '';
      
      // Temporarily sort images by filename for splitting
      const images = scene.images.slice().sort((a, b) => {
        return (a.filename || '').localeCompare(b.filename || '');
      });
      const frag = document.createDocumentFragment();

      for (let i = 0; i < images.length; i++) {
        const r = images[i];
        const origIdx = scene.images.indexOf(r);
        const card = document.createElement('div');
        card.className = 'filmstrip-card split-mode';
        card.dataset.idx = origIdx;
        const key = r.filename || r.export_path || '';

        // Checkbox for split selection
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'split-check';
        cb.checked = _splitSelected.has(key);
        if (cb.checked) card.classList.add('split-selected');
        
        cb.onchange = () => {
          if (cb.checked) { _splitSelected.add(key); card.classList.add('split-selected'); }
          else { _splitSelected.delete(key); card.classList.remove('split-selected'); }
        };
        card.appendChild(cb);

        // Thumbnail
        const th = document.createElement('div');
        th.className = 'filmstrip-thumb';
        const img = document.createElement('img');
        img.alt = r.filename || '';
        img.loading = 'lazy';
        lazyLoadImg(img, () => getBlobUrlForPath(r.export_path || r.crop_path, r.__rootPath));
        th.appendChild(img);
        card.appendChild(th);

        // Info
        const info = document.createElement('div');
        info.className = 'filmstrip-info';
        const fn = document.createElement('div');
        fn.className = 'filmstrip-filename';
        fn.textContent = r.filename || '';
        info.appendChild(fn);
        const meta = document.createElement('div');
        meta.className = 'filmstrip-meta';
        const rating = getRating(r);
        meta.innerHTML = `<span class="filmstrip-stars">${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}</span><span>Q ${fmt3(r.quality)}</span>`;
        info.appendChild(meta);
        card.appendChild(info);

        // Click card to toggle selection
        card.addEventListener('click', (ev) => {
          if (ev.target === cb) return; // checkbox handles itself
          cb.checked = !cb.checked;
          cb.onchange();
          
          // Also set as active and update preview using original index
          selectFilmstripImage(origIdx, scene);
        });

        // Tooltip with detailed metadata
        const tip = document.createElement('div');
        tip.className = 'filmstrip-tooltip';
        tip.innerHTML = [
          `<b>${escapeHtml(r.filename || '')}</b>`,
          `Species: ${escapeHtml(r.species || 'Unknown')} (${fmt3(r.species_confidence)})`,
          `Quality: ${fmt3(r.quality)}`,
          `Rating: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`,
        ].filter(Boolean).join('<br>');
        card.appendChild(tip);

        frag.appendChild(card);
      }
      grid.appendChild(frag);
      updateFilmstripHints(scene);
      
      // Select the first one or current one by default to show preview
      if (images.length > 0) {
        selectFilmstripImage(currentImageIndex < images.length ? currentImageIndex : 0, scene);
      }
    }

    function applySplitScene(scene) {
      if (_splitSelected.size === 0) {
        showToast('Select at least one image to split into a new scene', 3000);
        return;
      }
      if (_splitSelected.size === scene.images.length) {
        showToast('Cannot move all images — at least one must remain in the original scene', 3000);
        return;
      }
      // Find next available scene_count across the same folder slot
      const parts = String(scene.id).split(':');
      const slot = parts.length > 1 ? parseInt(parts[0], 10) : null;
      let maxCount = 0;
      for (const r of rows) {
        const slotMatch = slot === null || (r.__folderSlot ?? 0) === slot;
        if (slotMatch) {
          const c = parseInt(r.scene_count, 10);
          if (Number.isFinite(c) && c > maxCount) maxCount = c;
        }
      }
      const newSceneCount = String(maxCount + 1);
      // Snapshot scene rows BEFORE mutation so we can build scenedata diff
      const sceneRowsBefore = getSceneRows(scene.id).slice();
      const rpForSplit = sceneRowsBefore[0]?.__rootPath || rootPath || '';
      let moved = 0;
      for (const r of sceneRowsBefore) {
        const key = r.filename || r.export_path || '';
        if (_splitSelected.has(key)) {
          r.scene_count = newSceneCount;
          r.scene_name = '';
          moved++;
        }
      }
      if (moved) {
        // Update scenedata scene membership
        if (hasPywebviewApi && rpForSplit) {
          const parts2 = String(scene.id).split(':');
          const oldSceneCount = parts2.pop();
          const sd = _initScenedata(rpForSplit);
          const movedFilenames = sceneRowsBefore.filter(r => _splitSelected.has(r.filename || r.export_path || '')).map(r => r.filename || '').filter(Boolean);
          const remainFilenames = sceneRowsBefore.filter(r => !_splitSelected.has(r.filename || r.export_path || '')).map(r => r.filename || '').filter(Boolean);
          if (sd.scenes[oldSceneCount]) {
            sd.scenes[oldSceneCount].image_filenames = remainFilenames;
          }
          sd.scenes[newSceneCount] = {
            scene_id: newSceneCount,
            image_filenames: movedFilenames,
            name: '',
            status: 'pending',
            user_tags: { species: [], families: [], finalized: false }
          };
        }
        markDirty();
        _splitMode = false;
        _splitSelected.clear();
        el('#splitSceneBtn').textContent = 'Split Scene\u2026';
        renderScenes();
        // Refresh the scene dialog with the remaining images
        const updatedScene = reloadScene(scene.id);
        if (updatedScene) {
          refreshSceneMeta(updatedScene);
          renderFilmstrip(updatedScene);
          selectFilmstripImage(0, updatedScene);
          el('#sceneName').value = updatedScene.sceneName || '';
        }
        showToast(`Split ${moved} image(s) into new scene #${newSceneCount}`, 3000);
      }
    }

    function fmt3(v) { const n = parseNumber(v); return n < 0 ? '—' : n.toFixed(3); }

    function decodeEntities(s) {
      if (!s || typeof s !== 'string') return s;
      const txt = document.createElement('textarea');
      txt.innerHTML = s;
      return txt.value;
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c])); }
    function folderBaseName(path) { if (!path) return ''; return path.replace(/\\/g, '/').split('/').filter(Boolean).pop() || path; }

    // Snapshot helpers for revert
    function takeSnapshot() {
      _cleanSnapshot = { rows: rows.map(r => ({ ...r })), header: header.slice(), scenedata: JSON.parse(JSON.stringify(_scenedata)) };
      const btn = el('#revertCsv');
      if (btn) btn.disabled = true;
    }
    function applySnapshot() {
      if (!_cleanSnapshot) return;
      rows = _cleanSnapshot.rows.map(r => ({ ...r }));
      header = _cleanSnapshot.header.slice();
      if (_cleanSnapshot.scenedata !== undefined) _scenedata = JSON.parse(JSON.stringify(_cleanSnapshot.scenedata));
      dirty = false; _notifyDirty(false);
      el('#saveCsv').disabled = true;
      el('#revertCsv').disabled = true;
      blobUrlCache.clear();
      renderScenes();
      setStatus('Reverted to last saved state.');
    }

    // CSV IO
    async function loadCsvFromHandle(fileHandle) {
      csvFileHandle = fileHandle;
      const file = await fileHandle.getFile();
      const text = await file.text();
      const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
      header = parsed.meta.fields || [];
      rows = (parsed.data || []).map(r => ({ ...r, scene_count: r.scene_count }));
      ensureSceneNameColumn();
      ensureRatingColumns();
      dirty = false; _notifyDirty(false); el('#saveCsv').disabled = true;
      takeSnapshot();
      await renderScenes();
    }

    // Try to find .kestrel/kestrel_database.csv in the selected folder (optionally nested)
    async function findKestrelDatabase(dirHandle, maxDepth = 3, depth = 0) {
      // If user selected the .kestrel folder itself, read directly
      if (dirHandle && dirHandle.name === '.kestrel') {
        try {
          const csvHandle = await dirHandle.getFileHandle('kestrel_database.csv');
          return { rootHandle: dirHandle, fileHandle: csvHandle, rootIsKestrel: true };
        } catch (_) {
          // fall through to normal search
        }
      }
      // First, check for a .kestrel folder in this folder
      try {
        const kestrelDir = await dirHandle.getDirectoryHandle('.kestrel');
        const csvHandle = await kestrelDir.getFileHandle('kestrel_database.csv');
        return { rootHandle: dirHandle, fileHandle: csvHandle, rootIsKestrel: false };
      } catch (_) {
        // Not found at this level; continue
      }

      if (depth >= maxDepth) return null;

      // Search subfolders (limited depth)
      try {
        for await (const entry of dirHandle.values()) {
          if (entry.kind !== 'directory') continue;
          if (entry.name === '.kestrel') continue;
          const found = await findKestrelDatabase(entry, maxDepth, depth + 1);
          if (found) return found;
        }
      } catch (_) {
        // Ignore permission/iteration errors
      }
      return null;
    }

    async function tryOpenDefaultCsv(dirHandle) {
      try {
        const found = await findKestrelDatabase(dirHandle, 2);
        if (!found) throw new Error('not found');
        rootDirHandle = found.rootHandle;
        rootIsKestrel = !!found.rootIsKestrel;
        await loadCsvFromHandle(found.fileHandle);
        const mergeBtn = document.getElementById('openMerge');
        if (mergeBtn) mergeBtn.disabled = false;
        const rootLabel = rootIsKestrel ? '.kestrel (selected folder)' : (rootDirHandle.name || 'selected folder');
        setStatus(`Loaded .kestrel/kestrel_database.csv (root: ${rootLabel})`);
      } catch (e) {
        setStatus('Could not find .kestrel/kestrel_database.csv in this folder (or its subfolders). Use "Open Folder or CSV…" to try a CSV file directly.');
        alert("Couldn't find Kestrel Analysis files. Make sure you analyze this folder with Kestrel Analyzer.");
      }
    }

    function csvEscape(val) {
      if (val == null) return '';
      let s = String(val);
      if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
      return s;
    }

    async function saveCsv() {
      ensureSceneNameColumn();
      ensureRatingColumns();
      const allCols = header.slice();
      if (!allCols.includes('scene_name')) allCols.push('scene_name');
      if (!allCols.includes('rating')) allCols.push('rating');
      if (!allCols.includes('rating_origin')) allCols.push('rating_origin');

      // Serialize a list of rows (excluding internal __ keys) to CSV string
      function rowsToCsvString(colList, rowList) {
        const lines = [colList.join(',')];
        for (const r of rowList) lines.push(colList.map(k => csvEscape(k in r ? r[k] : '')).join(','));
        return lines.join('\r\n');
      }

      // FSAPI mode (browser): single file handle
      if (csvFileHandle) {
        const content = rowsToCsvString(allCols, rows);
        const writable = await csvFileHandle.createWritable();
        await writable.write(content);
        await writable.close();
        dirty = false; _notifyDirty(false); el('#saveCsv').disabled = true;
        takeSnapshot();
        setStatus('Saved changes to kestrel_database.csv');
        return;
      }

      // Pywebview desktop mode: save both CSV row state and scenedata JSON.
      if (window.pywebview?.api) {
        const groups = new Map();
        for (const r of rows) {
          const rp = r.__rootPath || '';
          if (!groups.has(rp)) groups.set(rp, []);
          groups.get(rp).push(r);
        }
        let saved = 0, failed = 0;
        const exportCols = allCols.filter(c => !String(c).startsWith('__'));
        for (const [rp, groupRows] of groups) {
          if (!rp) { failed++; continue; }
          try {
            // Persist cull/rating columns to CSV so culling assistant and reloads see authoritative state.
            if (typeof window.pywebview.api.write_kestrel_csv === 'function') {
              const content = rowsToCsvString(exportCols, groupRows);
              const csvRes = await window.pywebview.api.write_kestrel_csv(rp, content);
              if (!csvRes?.success) throw new Error(csvRes?.error || 'Failed to write kestrel_database.csv');
            }

            const sd = _normalizeScenedataForSave(rp, groupRows);
            const res = await window.pywebview.api.write_kestrel_scenedata(rp, sd);
            if (res.success) saved++;
            else { failed++; console.warn('[save scenedata] Failed for', rp, res.error); }
          } catch (e) {
            failed++;
            console.warn('[save pywebview] Error for', rp, e);
          }
        }
        if (failed > 0) {
          dirty = true; _notifyDirty(true); el('#saveCsv').disabled = false;
          setStatus(`Saved ${saved} folder(s), ${failed} failed`);
        } else {
          dirty = false; _notifyDirty(false); el('#saveCsv').disabled = true;
          takeSnapshot();
          setStatus(`Saved changes to ${saved} folder(s)`);
        }
        return;
      }

      alert('No CSV opened and no save method available.');
    }

    // Warn user on unsaved changes when attempting to close/refresh
    window.addEventListener('beforeunload', (e) => {
      const analysisRunning = window.__queueRunning;
      if (dirty || analysisRunning) {
        const msg = analysisRunning
          ? 'Analysis is still running. Closing the page will stop the analysis.'
          : 'You have unsaved changes. Are you sure you want to leave?';
        e.preventDefault();
        e.returnValue = msg;
        return msg;
      }
    });

    // Attempt to notify backend to shutdown when the page is fully unloaded
    window.addEventListener('unload', () => {
      try {
        const backendUrl = getSetting('backendUrl', window.location.origin).replace(/\/$/, '');
        const headers = { 'Content-Type': 'application/json' };
        if (window.__BRIDGE_TOKEN) headers['X-Bridge-Token'] = window.__BRIDGE_TOKEN;
        navigator.sendBeacon && navigator.sendBeacon(backendUrl + '/shutdown', new Blob([JSON.stringify({ reason: 'page_unload' })], { type: 'application/json' }));
        // Fallback (best-effort, may be ignored on some browsers)
        fetch(backendUrl + '/shutdown', { method: 'POST', keepalive: true, headers, body: JSON.stringify({ reason: 'page_unload' }) }).catch(() => { });
      } catch (_) { }
    });

    // Add draggable splitter for resizing right preview panel
    (function setupColumnResizer() {
      const dlg = document.getElementById('sceneDlg');
      const divider = document.getElementById('colDivider');
      if (!dlg || !divider) return;

      function onMouseDown(e) {
        e.preventDefault();
        const modal = divider.closest('.modal');
        if (!modal) return;
        const rect = modal.getBoundingClientRect();
        const onMove = (ev) => {
          const newW = Math.round(rect.right - ev.clientX); // distance from cursor to right edge
          const min = 260; // min width of right panel
          const max = Math.max(320, Math.floor(rect.width * 0.8));
          const clamped = Math.min(Math.max(newW, min), max);
          modal.style.setProperty('--right-w', clamped + 'px');
        };
        const onUp = () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
      }
      divider.addEventListener('mousedown', onMouseDown);
      divider.addEventListener('dblclick', () => {
        const modal = divider.closest('.modal');
        if (modal) modal.style.setProperty('--right-w', '510px');
      });
    })();

    // Settings storage
    const SETTINGS_KEY = 'kestrel-webviz-settings-v1';
    let _autoSaveEnabled = true;  // cached value to avoid repeated lookups
    let _autoSaveTimer = null;     // debounce timer for auto-saves
    
    function loadSettings() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
    }
    function saveSettings(obj) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj || {})); }
    function getSetting(k, def) { const s = loadSettings(); return (k in s) ? s[k] : def; }
    
    // Auto-save logic: debounced save when auto-save is enabled
    async function attemptAutoSave() {
      dirty = true;
      _notifyDirty(true);
      el('#saveCsv').disabled = false;
      el('#revertCsv').disabled = false;
      
      if (!_autoSaveEnabled) {
        return;  // Save/Revert workflow; user will click Save button
      }
      
      // Debounce to avoid saving on every keystroke/change (save after 2 seconds of inactivity)
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(async () => {
        try {
          await saveCsv();
        } catch (e) {
          console.warn('Auto-save failed:', e);
        }
      }, 2000);
    }

    async function hydrateSettingsFromServer() {
      const backendUrl = (getSetting('backendUrl', window.location.origin) || window.location.origin).replace(/\/$/, '');
      try {
        const headers = window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {};
        const res = await fetch(backendUrl + '/settings', { headers });
        if (!res.ok) return;
        const data = await res.json();
        if (data && data.settings && typeof data.settings === 'object') {
          saveSettings(data.settings);
          _autoSaveEnabled = data.settings.auto_save_enabled !== false;
        }
      } catch (_) { }
    }

    function showSettings() {
      const dlg = document.getElementById('settingsDlg');
      const editor = getSetting('editor', 'darktable');
      const editorSelect = document.getElementById('editorChoice');
      const customRow = document.getElementById('customEditorRow');
      const customHint = document.getElementById('customEditorHint');
      const customPath = document.getElementById('customEditorPath');
      editorSelect.value = editor;
      // If saved editor isn't in the dropdown options, treat as custom
      if (editorSelect.value !== editor) {
        editorSelect.value = 'custom';
      }
      customPath.value = getSetting('customEditorPath', '');
      const isCustom = editorSelect.value === 'custom';
      customRow.classList.toggle('hidden', !isCustom);
      customHint.classList.toggle('hidden', !isCustom);
      // Show/hide custom row when selection changes
      editorSelect.onchange = () => {
        const c = editorSelect.value === 'custom';
        customRow.classList.toggle('hidden', !c);
        customHint.classList.toggle('hidden', !c);
      };
      // Browse button
      document.getElementById('customEditorBrowse').onclick = async () => {
        if (window.pywebview?.api?.choose_application) {
          const path = await window.pywebview.api.choose_application();
          if (path) customPath.value = path;
        } else {
          showToast('Browse is only available in the desktop app', 3000);
        }
      };
      document.getElementById('treeScanDepth').value = getSetting('treeScanDepth', 3);
      // Rating normalization
      const normSelect = document.getElementById('ratingNormalization');
      if (normSelect) normSelect.value = getSetting('rating_normalization', 'none');
      // Rating distribution thresholds
      document.getElementById('ratingThreshold5').value = getSetting('rating_threshold_5', 10);
      document.getElementById('ratingThreshold4').value = getSetting('rating_threshold_4', 20);
      document.getElementById('ratingThreshold3').value = getSetting('rating_threshold_3', 30);
      document.getElementById('ratingThreshold2').value = getSetting('rating_threshold_2', 25);
      document.getElementById('ratingThreshold1').value = getSetting('rating_threshold_1', 15);
      // Detection confidence threshold
      const dtEl = document.getElementById('detectionThreshold');
      if (dtEl) dtEl.value = getSetting('detection_threshold', 0.75);
      // Scene grouping time threshold
      const sttEl = document.getElementById('sceneTimeThreshold');
      if (sttEl) sttEl.value = getSetting('scene_time_threshold', 1.0);
      // Mask threshold
      const maskThEl = document.getElementById('maskThreshold');
      if (maskThEl) maskThEl.value = getSetting('mask_threshold', 0.5);
      // RAW preview cache
      const rawCacheCb = document.getElementById('rawPreviewCacheEnabled');
      if (rawCacheCb) rawCacheCb.checked = getSetting('raw_preview_cache_enabled', true);
      const optedIn = getSetting('analytics_opted_in', null);
      const consentShown = getSetting('analytics_consent_shown', false);
      const cb = document.getElementById('settingsAnalyticsOptIn');
      const lbl = document.getElementById('settingsAnalyticsLabel');
      cb.checked = optedIn === true;
      lbl.textContent = consentShown
        ? (optedIn === true ? 'Opted in' : 'Not sharing')
        : 'Not yet decided';
      
      // Display total impact (photos analyzed) - read from localStorage settings
      const totalPhotos = getSetting('kestrel_impact_total_files', 0);
      const impactEl = document.getElementById('settingsTotalImpact');
      if (impactEl) {
        impactEl.textContent = totalPhotos > 0 ? totalPhotos.toLocaleString() + ' photos' : '0 photos';
      }
      
      // Auto-Save setting
      const autoSaveCb = document.getElementById('settingsAutoSave');
      if (autoSaveCb) autoSaveCb.checked = getSetting('auto_save_enabled', true);

      const rawExpDisableCb = document.getElementById('rawExposureCorrectionDisabled');
      if (rawExpDisableCb) rawExpDisableCb.checked = getSetting('raw_exposure_correction_disabled', false);
      
      dlg.showModal();
    }
    async function applySettings() {
      const editorSelect = document.getElementById('editorChoice');
      const editor = editorSelect.value || 'darktable';
      const customEditorPath = document.getElementById('customEditorPath').value.trim();
      const treeScanDepth = Math.max(1, Math.min(6, parseInt(document.getElementById('treeScanDepth').value, 10) || 3));
      const analyticsOptIn = document.getElementById('settingsAnalyticsOptIn').checked;
      const normalizationEl = document.getElementById('ratingNormalization');
      const ratingNormalization = normalizationEl ? normalizationEl.value : 'none';
      const dtEl2 = document.getElementById('detectionThreshold');
      const detectionThreshold = dtEl2 ? Math.max(0.1, Math.min(0.99, parseFloat(dtEl2.value) || 0.75)) : 0.75;
      const sttEl2 = document.getElementById('sceneTimeThreshold');
      const sceneTimeThreshold = sttEl2 ? Math.max(0, parseFloat(sttEl2.value) || 1.0) : 1.0;
      const maskThEl2 = document.getElementById('maskThreshold');
      const maskThreshold = maskThEl2 ? Math.max(0.5, Math.min(0.95, parseFloat(maskThEl2.value) || 0.5)) : 0.5;
      const rawCacheCb2 = document.getElementById('rawPreviewCacheEnabled');
      const rawPreviewCacheEnabled = rawCacheCb2 ? rawCacheCb2.checked : true;
      const autoSaveCb = document.getElementById('settingsAutoSave');
      const autoSaveEnabled = autoSaveCb ? autoSaveCb.checked : true;
      // Rating distribution thresholds
      const t5 = Math.max(1, Math.min(50, parseInt(document.getElementById('ratingThreshold5').value, 10) || 10));
      const t4 = Math.max(1, Math.min(50, parseInt(document.getElementById('ratingThreshold4').value, 10) || 20));
      const t3 = Math.max(1, Math.min(50, parseInt(document.getElementById('ratingThreshold3').value, 10) || 30));
      const t2 = Math.max(1, Math.min(50, parseInt(document.getElementById('ratingThreshold2').value, 10) || 25));
      const t1 = Math.max(1, Math.min(50, parseInt(document.getElementById('ratingThreshold1').value, 10) || 15));
      
      // Merge into existing settings so keys like machine_id / analytics_consent_shown are preserved
      const existing = loadSettings();
      const prevNormalization = existing.rating_normalization || 'none';
      const prevT5 = parseInt(existing.rating_threshold_5, 10) || 10;
      const prevT4 = parseInt(existing.rating_threshold_4, 10) || 20;
      const prevT3 = parseInt(existing.rating_threshold_3, 10) || 30;
      const prevT2 = parseInt(existing.rating_threshold_2, 10) || 25;
      const prevT1 = parseInt(existing.rating_threshold_1, 10) || 15;
      const settings = {
        ...existing, editor, customEditorPath, treeScanDepth,
        analytics_opted_in: analyticsOptIn, analytics_consent_shown: true,
        rating_normalization: ratingNormalization,
        rating_threshold_5: t5,
        rating_threshold_4: t4,
        rating_threshold_3: t3,
        rating_threshold_2: t2,
        rating_threshold_1: t1,
        detection_threshold: detectionThreshold,
        scene_time_threshold: sceneTimeThreshold,
        mask_threshold: maskThreshold,
        raw_preview_cache_enabled: rawPreviewCacheEnabled,
        auto_save_enabled: autoSaveEnabled,
        raw_exposure_correction_disabled: document.getElementById('rawExposureCorrectionDisabled').checked,
      };
      _autoSaveEnabled = autoSaveEnabled;
      // Persist settings to localStorage immediately
      saveSettings(settings);
      if (hasPywebviewApi && window.pywebview?.api?.save_settings_data) {
        try { await window.pywebview.api.save_settings_data(settings); } catch (_) { }
      }
      try {
        const backendUrl = getSetting('backendUrl', 'http://127.0.0.1:8765');
        const headers = { 'Content-Type': 'application/json', ...(window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {}) };
        await fetch(backendUrl.replace(/\/$/, '') + '/settings', {
          method: 'POST',
          headers,
          body: JSON.stringify({ settings })
        });
      } catch (_) { }
      document.getElementById('settingsDlg').close();
      // If normalization mode or thresholds changed and folders are loaded, reapply immediately
      const thresholdsChanged =
        t5 !== prevT5 ||
        t4 !== prevT4 ||
        t3 !== prevT3 ||
        t2 !== prevT2 ||
        t1 !== prevT1;
      if ((ratingNormalization !== prevNormalization || thresholdsChanged) && rows.length > 0) {
        await reapplyNormalizationForLoadedFolders();
      }
    }

    /** Recompute normalized_rating for every currently-loaded folder and refresh the view. */
    async function reapplyNormalizationForLoadedFolders() {
      if (!hasPywebviewApi || !window.pywebview?.api?.apply_normalization) return;
      // Collect the unique root paths of all loaded rows
      const folderPaths = [...new Set(rows.map(r => r.__rootPath).filter(Boolean))];
      if (folderPaths.length === 0) return;
      for (const p of folderPaths) {
        try {
          const res = await window.pywebview.api.apply_normalization(p);
          if (res?.success && res?.normalized_ratings) {
            const mapping = res.normalized_ratings;
            for (const r of rows) {
              if (r.__rootPath === p && r.filename in mapping) {
                r.__normalized_rating = mapping[r.filename];
              }
            }
          }
        } catch (e) {
          console.warn('[normalization] Failed for', p, e);
        }
      }
      await renderScenes();
    }

    document.getElementById('openSettings').addEventListener('click', showSettings);
    document.getElementById('settingsSave').addEventListener('click', applySettings);
    document.getElementById('settingsCancel').addEventListener('click', () => document.getElementById('settingsDlg').close());

    // ─── Telemetry helpers ────────────────────────────────────────────────────
    /** Merge a single key into persisted settings (localStorage + pywebview). */
    function mergeSetting(k, v) {
      const s = loadSettings();
      s[k] = v;
      saveSettings(s);
      if (hasPywebviewApi && window.pywebview?.api?.save_settings_data) {
        try { window.pywebview.api.save_settings_data(s); } catch (_) { }
      }
    }

    // ─── Feedback dialog ──────────────────────────────────────────────────────
    function openFeedbackDialog() {
      document.getElementById('feedbackDesc').value = '';
      document.getElementById('feedbackContact').value = '';
      document.getElementById('feedbackStatus').textContent = '';
      document.getElementById('feedbackIncludeLogs').checked = false;
      document.getElementById('feedbackIncludeScreenshot').checked = false;
      document.getElementById('feedbackScreenshotFile').value = '';
      const preview = document.getElementById('feedbackSsPreview');
      preview.src = ''; preview.style.display = 'none'; preview.dataset.b64 = '';
      document.getElementById('feedbackDlg').showModal();
    }

    // Auto-check logs when Bug Report type is selected
    document.getElementById('feedbackType').addEventListener('change', function () {
      document.getElementById('feedbackIncludeLogs').checked = (this.value === 'bug');
    });

    // Screenshot file-picker wiring
    document.getElementById('feedbackIncludeScreenshot').addEventListener('change', function () {
      if (this.checked) {
        document.getElementById('feedbackScreenshotFile').click();
      } else {
        const preview = document.getElementById('feedbackSsPreview');
        preview.src = ''; preview.style.display = 'none'; preview.dataset.b64 = '';
        document.getElementById('feedbackScreenshotFile').value = '';
      }
    });
    document.getElementById('feedbackScreenshotFile').addEventListener('change', function () {
      const file = this.files[0];
      if (!file) { document.getElementById('feedbackIncludeScreenshot').checked = false; return; }
      const reader = new FileReader();
      reader.onload = (e) => {
        const b64 = (e.target.result || '').split(',')[1] || '';
        const preview = document.getElementById('feedbackSsPreview');
        preview.src = e.target.result;
        preview.style.display = 'block';
        preview.dataset.b64 = b64;
        document.getElementById('feedbackIncludeScreenshot').checked = true;
      };
      reader.readAsDataURL(file);
    });

    async function submitFeedback() {
      const desc = document.getElementById('feedbackDesc').value.trim();
      if (!desc) {
        document.getElementById('feedbackStatus').textContent = '⚠ Please enter a description.';
        document.getElementById('feedbackDesc').focus();
        return;
      }
      const sendBtn = document.getElementById('feedbackSend');
      sendBtn.disabled = true;
      document.getElementById('feedbackStatus').textContent = 'Sending…';
      const data = {
        type: document.getElementById('feedbackType').value,
        description: desc,
        contact: document.getElementById('feedbackContact').value.trim(),
        include_logs: document.getElementById('feedbackIncludeLogs').checked,
        screenshot_b64: document.getElementById('feedbackSsPreview').dataset.b64 || '',
      };
      try {
        let result;
        if (hasPywebviewApi && window.pywebview?.api?.send_feedback) {
          result = await window.pywebview.api.send_feedback(data);
        } else {
          const backendUrl = (getSetting('backendUrl', window.location.origin) || window.location.origin).replace(/\/$/, '');
          const headers = { 'Content-Type': 'application/json', ...(window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {}) };
          const res = await fetch(backendUrl + '/feedback', { method: 'POST', headers, body: JSON.stringify(data) });
          result = await res.json();
        }
        if (result && result.success !== false) {
          document.getElementById('feedbackStatus').textContent = '✓ Feedback sent — thank you!';
          setTimeout(() => { try { document.getElementById('feedbackDlg').close(); } catch (_) { } }, 1200);
        } else {
          document.getElementById('feedbackStatus').textContent = '⚠ Could not send — please try again later.';
        }
      } catch (e) {
        document.getElementById('feedbackStatus').textContent = '⚠ Send failed: ' + (e.message || e);
      } finally {
        sendBtn.disabled = false;
      }
    }

    document.getElementById('openFeedback').addEventListener('click', openFeedbackDialog);
    document.getElementById('feedbackCancel').addEventListener('click', () => document.getElementById('feedbackDlg').close());
    document.getElementById('feedbackSend').addEventListener('click', submitFeedback);

    // ─── Analytics Consent dialog ─────────────────────────────────────────────
    function showAnalyticsConsentDialog() {
      if (_analyticsConsentPending) return;
      if (getSetting('analytics_consent_shown', false)) return;
      _analyticsConsentPending = true;
      document.getElementById('analyticsConsentDlg').showModal();
    }

    function handleAnalyticsConsent(optedIn) {
      mergeSetting('analytics_opted_in', optedIn);
      mergeSetting('analytics_consent_shown', true);
      try { document.getElementById('analyticsConsentDlg').close(); } catch (_) { }
      _analyticsConsentPending = false;
    }

    document.getElementById('analyticsAccept').addEventListener('click', () => handleAnalyticsConsent(true));
    document.getElementById('analyticsDecline').addEventListener('click', () => handleAnalyticsConsent(false));

    // ─── Donation / Support ──────────────────────────────────────────────────────
    const DONATE_URL = 'https://www.paypal.com/donate/?hosted_button_id=CXH4FE5AKZD3A';
    const DONATE_THRESHOLD_KEY = 'kestrel-donate-thresholds-shown-v1';

    function openDonateLink() {
      if (hasPywebviewApi && window.pywebview?.api?.open_url) {
        window.pywebview.api.open_url(DONATE_URL);
      } else {
        try { window.open(DONATE_URL, '_blank', 'noopener,noreferrer'); } catch (_) { }
      }
    }

    function _loadDonateThresholdsShown() {
      // Load from persistent settings (saved to settings.json)
      return getSetting('kestrel_donate_thresholds_shown', []);
    }
    function _saveDonateThresholdsShown(arr) {
      // Save to both localStorage and backend settings (persists to settings.json)
      const existing = loadSettings();
      const settings = { ...existing, kestrel_donate_thresholds_shown: arr };
      saveSettings(settings);
      // Persist to backend (settings.json)
      if (hasPywebviewApi && window.pywebview?.api?.save_settings_data) {
        try { window.pywebview.api.save_settings_data(settings); } catch (_) { }
      }
    }

    function showDonatePrompt(totalFiles) {
      const countEl = document.getElementById('donateCountDisplay');
      // Round down to nearest threshold for "over N photos" phrasing
      const thresholds = [1000, 5000, 10000, 25000, 50000, 100000, 200000];
      let milestone = totalFiles || 0;
      for (let i = thresholds.length - 1; i >= 0; i--) {
        if (milestone >= thresholds[i]) { milestone = thresholds[i]; break; }
      }
      if (countEl) countEl.textContent = milestone.toLocaleString();
      const dlg = document.getElementById('donateDlg');
      // Only show if no other dialog is already open
      if (dlg && !document.querySelector('dialog[open]')) dlg.showModal();
    }

    /** Check if the cumulative total crosses a donation milestone. Call after a folder finishes. */
    async function checkDonationThresholdAsync() {
      try {
        let total = 0;
        if (hasPywebviewApi && window.pywebview?.api?.get_settings) {
          const s = await window.pywebview.api.get_settings();
          total = (s && s.kestrel_impact_total_files) ? s.kestrel_impact_total_files : 0;
        }
        if (total <= 0) return;
        const thresholds = [1000, 5000, 10000, 25000, 50000, 100000, 200000];
        const shown = _loadDonateThresholdsShown();
        for (const t of thresholds) {
          if (total >= t && !shown.includes(t)) {
            shown.push(t);
            _saveDonateThresholdsShown(shown);
            // Small delay so queue panel settles first
            setTimeout(() => showDonatePrompt(total), 2000);
            break;
          }
        }
      } catch (_) { /* failsafe */ }
    }

    /** Check donation threshold on app startup (only once). */
    async function checkDonationThresholdOnStartup() {
      try {
        // Read from localStorage (same source as the settings dialog)
        let total = getSetting('kestrel_impact_total_files', 0);
        console.log('[donation] checkDonationThresholdOnStartup: total =', total);
        if (total < 1000) {
          console.log('[donation] Total < 1000, skipping');
          return;
        }
        const thresholds = [1000, 5000, 10000, 25000, 50000, 100000, 200000];
        const shown = _loadDonateThresholdsShown();
        console.log('[donation] Thresholds already shown:', shown);
        for (const t of thresholds) {
          if (total >= t && !shown.includes(t)) {
            console.log('[donation] Milestone crossed:', t, '- showing dialog');
            shown.push(t);
            _saveDonateThresholdsShown(shown);
            // Show dialog after a brief delay to let UI settle
            setTimeout(() => showDonatePrompt(total), 1000);
            break;
          }
        }
        if (shown.includes(1000)) {
          console.log('[donation] 1000 threshold already shown, no dialog needed');
        }
      } catch (e) {
        console.error('[donation] checkDonationThresholdOnStartup error:', e);
      }
    }

    document.getElementById('donateBtnMain')?.addEventListener('click', openDonateLink);
    // Note: donateDlg button listeners are wired in the inline script after the dialog HTML,
    // because that dialog is defined after this script block and wouldn't be in the DOM yet.
    // ─── End Donation ─────────────────────────────────────────────────────

    // Info dialog: load kestrel_metadata.json from opened photo folder (.kestrel)
    async function getMetadataHandle() {
      if (!rootDirHandle) return null;
      try { return await getHandleFromRelativePath(rootDirHandle, '.kestrel/kestrel_metadata.json'); } catch { return null; }
    }
    async function readMetadata() {
      const h = await getMetadataHandle();
      if (!h) return { error: 'kestrel_metadata.json not found. Use "Open Photo Folder…" to select your root.' };
      try {
        const file = await h.getFile();
        const text = await file.text();
        try { return JSON.parse(text); } catch { return { error: 'Failed to parse JSON in kestrel_metadata.json' }; }
      } catch { return { error: 'Unable to read kestrel_metadata.json' }; }
    }
    async function openInfo() {
      const dlg = document.getElementById('infoDlg');
      const contentEl = document.getElementById('infoContent');
      const noticeEl = document.getElementById('infoNotice');
      contentEl.textContent = 'Loading…';
      noticeEl.classList.add('hidden');
      dlg.showModal();
      const meta = await readMetadata();
      if (meta && !meta.error) {
        // Add derived helper fields (non-destructive)
        const enriched = { ...meta };
        if (rootDirHandle) enriched.photo_root_name = rootDirHandle.name || '';
        contentEl.textContent = JSON.stringify(enriched, null, 2);
      } else {
        contentEl.textContent = '—';
        noticeEl.textContent = meta.error;
        noticeEl.classList.remove('hidden');
      }
    }
    const openInfoBtn = document.getElementById('openInfo');
    if (openInfoBtn) openInfoBtn.addEventListener('click', openInfo);
    const infoCloseBtn = document.getElementById('infoClose');
    if (infoCloseBtn) infoCloseBtn.addEventListener('click', () => document.getElementById('infoDlg').close());

    // Helper to infer root from absolute export/crop path strings in CSV
    function inferRootFromAbsPath(p) {
      if (!p) return null;
      const s = sanitizePath(p);
      const i = s.toLowerCase().lastIndexOf('/.kestrel/');
      if (i > 0) return s.substring(0, i);
      return null;
    }

    async function openInEditor(row) {
      const origRel = (row.filename || '').replace(/^[\\/]+/, '');
      const settings = loadSettings();

      // Use the same root-finding logic as getBlobUrlForPath (which successfully loads thumbnails)
      // PRIORITY 1: Row-specific root (set when loaded from a folder or multi-load)
      let rootToSend = (row.__rootPath || '').trim();

      // PRIORITY 2: Global rootPath (set when loading CSV from a folder)
      if (!rootToSend && rootPath) {
        rootToSend = rootPath;
      }

      // PRIORITY 3: Settings hint (explicit user configuration)
      if (!rootToSend) {
        rootToSend = (settings.rootHint || '').trim();
      }

      // PRIORITY 4: Infer from absolute paths in CSV
      if (!rootToSend) {
        rootToSend = inferRootFromAbsPath(row.export_path) || inferRootFromAbsPath(row.crop_path) || '';
      }

      if (!origRel) { setStatus('No filename available for this row.'); return; }
      if (!rootToSend) { setStatus('Set Local Root in Settings to enable launching originals.'); showSettings(); return; }
      const backendUrl = getSetting('backendUrl', window.location.origin);
      const editor = getSetting('editor', 'system');
      try {
        const res = await fetch(backendUrl.replace(/\/$/, '') + '/open', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {})
          },
          body: JSON.stringify({ root: rootToSend, relative: origRel, editor })
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (data && data.ok) {
          setStatus('Opened in editor');
          showToast('Opened in ' + editor, 5000, () => showSettings());
        } else throw new Error(data && data.error || 'Launch failed');
      } catch (e) {
        setStatus('Failed to open in editor. Check Settings and server.');
      }
    }

    // ── Folder Tree ──────────────────────────────────────────────────────────────
    let folderTreeRoot = null;       // absolute path of the scanned tree root
    let folderTreeData = null;       // raw children array from API
    let folderTreeRootNode = null;   // synthetic root node {name, path, has_kestrel, children}
    let folderTreeRootHasKestrel = false;
    let treeExpandedPaths = new Set();
    let treeActivePath = null;       // currently single-loaded folder
    let checkedFolderPaths = new Set(); // folders checked for multi-load
    let queuedFolderPaths = new Set(); // folders queued for analysis (dialog selection)
    let _treeFlatOrder = [];           // flat ordered list of visible tree paths for range-select
    let _appVersion = '';              // current app version, fetched once
    let _isFrozenApp = false;          // whether running as frozen (PyInstaller) build

    async function scanFolderTree(rootPath) {
      if (!hasPywebviewApi || !window.pywebview?.api?.list_subfolders) return false;
      if (!rootPath) return false;

      // Fetch app version once (for outdated-version detection)
      if (!_appVersion && window.pywebview?.api?.get_app_version) {
        try {
          const vr = await window.pywebview.api.get_app_version();
          if (vr && vr.success) _appVersion = vr.version || '';
        } catch (e) { /* ignore */ }
      }
      // Fetch frozen status once
      if (!_isFrozenApp && window.pywebview?.api?.is_frozen_app) {
        try {
          const fr = await window.pywebview.api.is_frozen_app();
          _isFrozenApp = !!(fr && fr.frozen);
        } catch (e) { /* ignore */ }
      }

      folderTreeRoot = rootPath;
      const depth = getSetting('treeScanDepth', 3);
      setStatus('Scanning folder tree…');
      try {
        const result = await window.pywebview.api.list_subfolders(rootPath, depth);
        if (!result.success) {
          console.warn('[tree] list_subfolders failed:', result.error);
          return false;
        }
        folderTreeData = result.tree;
        folderTreeRootHasKestrel = !!result.root_has_kestrel;
        // Build a synthetic root node so the tree shows the top-level folder too
        const rootName = rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rootPath;
        folderTreeRootNode = {
          name: rootName,
          path: rootPath,
          has_kestrel: folderTreeRootHasKestrel,
          kestrel_version: result.root_kestrel_version || '',
          children: folderTreeData,
        };
        // Auto-expand the root
        treeExpandedPaths.add(rootPath);
        renderFolderTree();
        document.getElementById('folderTreeWrap').classList.remove('hidden');
        return true;
      } catch (e) {
        console.error('[tree] scanFolderTree error:', e);
        return false;
      }
    }

    /** Compare two semver strings. Returns -1 if a < b, 0 if equal, 1 if a > b. */
    function compareVersions(a, b) {
      if (!a || !b) return 0;
      const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] || 0, nb = pb[i] || 0;
        if (na < nb) return -1;
        if (na > nb) return 1;
      }
      return 0;
    }

    /** Check if a node's kestrel_version is older than the current app version. */
    function isVersionOutdated(node) {
      if (!node || !node.has_kestrel || !node.kestrel_version || !_appVersion) return false;
      return compareVersions(node.kestrel_version, _appVersion) < 0;
    }

    /** Show a custom context menu at (x, y) with given items. */
    function showContextMenu(x, y, items) {
      dismissContextMenu();
      const menu = document.createElement('div');
      menu.className = 'kestrel-ctx-menu';
      menu.id = '_kestrelCtxMenu';
      for (const item of items) {
        const el = document.createElement('div');
        el.className = 'kestrel-ctx-menu-item' + (item.danger ? ' danger' : '');
        el.textContent = item.label;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          dismissContextMenu();
          item.action();
        });
        menu.appendChild(el);
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
      document.body.appendChild(menu);
      // Adjust if off-screen
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      // Dismiss on any click outside
      setTimeout(() => document.addEventListener('click', dismissContextMenu, { once: true }), 0);
    }

    function dismissContextMenu() {
      const old = document.getElementById('_kestrelCtxMenu');
      if (old) old.remove();
    }

    /** Clear kestrel analysis data for a folder (with confirmation). */
    async function clearKestrelDataForFolder(folderPath, folderName, refreshCallback) {
      const confirmed = confirm(
        `Are you sure you want to delete all Kestrel analysis data for "${folderName}"?\n\n` +
        `This will permanently remove the .kestrel folder and all its contents (database, exports, thumbnails) ` +
        `in:\n${folderPath}\n\nThis action cannot be undone.`
      );
      if (!confirmed) return;
      try {
        const result = await window.pywebview.api.clear_kestrel_data(folderPath);
        if (result && result.success) {
          showToast('Kestrel analysis data cleared for ' + folderName);
          if (refreshCallback) refreshCallback();
        } else {
          alert('Failed to clear analysis data:\n\n' + (result?.error || 'Unknown error'));
        }
      } catch (e) {
        alert('Failed to clear analysis data:\n\n' + (e.message || e));
      }
    }

    function renderFolderTree() {
      const container = document.getElementById('folderTree');
      if (!container || !folderTreeRootNode) return;
      // Rebuild the flat visible order for shift-range selection
      _treeFlatOrder = [];
      container.innerHTML = '';
      container.appendChild(buildTreeNode(folderTreeRootNode, _treeFlatOrder));
      // Note: Do NOT populate counts for main folder tree
      // The main tree is only for selecting which analyzed folders to LOAD
      // Colors and counts are only for the Analyze dialog tree
    }

    /** Update a single main-folder-tree row for `path` without re-rendering whole tree.
     *  Makes the node appear as having kestrel data (icon + checkbox) but does not
     *  change selection or checked state. This avoids disturbing the user's view.
     */
    function updateFolderTreeNode(path) {
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        const target = norm(path);
        // Find rows in the main folder tree matching this path
        const rows = Array.from(document.querySelectorAll('#folderTree .tree-node-row'));
        for (const row of rows) {
          const rp = norm(row.dataset.path || '');
          if (rp !== target) continue;
          // Update classes
          row.classList.remove('no-kestrel');
          row.classList.add('has-kestrel');
          // Persist a transient marker so future rescans don't immediately clear it
          try { _tempKestrelPaths.add(norm(path)); } catch (e) { }
          // Update icon
          const icon = row.querySelector('.tree-icon');
          if (icon) icon.textContent = '📂';
          // Ensure checkbox exists (do not auto-check it)
          if (!row.querySelector('.tree-cb')) {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tree-cb';
            cb.title = 'Include in multi-folder view';
            cb.checked = checkedFolderPaths.has(row.dataset.path);
            cb.addEventListener('change', (e) => {
              e.stopPropagation();
              if (cb.checked) checkedFolderPaths.add(row.dataset.path);
              else checkedFolderPaths.delete(row.dataset.path);
              debouncedAutoLoad();
            });
            // Insert before the icon element if present
            if (icon && icon.parentNode) icon.parentNode.insertBefore(cb, icon);
            else row.insertBefore(cb, row.firstChild);
          }
        }
      } catch (e) { /* failsafe */ }
    }

    // Build a single tree node DOM element.
    // flatOrder is mutated to collect visible paths in order (for range-select).
    function buildTreeNode(node, flatOrder) {
      flatOrder.push(node.path);

      const wrap = document.createElement('div');
      wrap.className = 'tree-node';

      const row = document.createElement('div');

      function subtreeHasKestrel(n) {
        if (!n) return false;
        if (n.has_kestrel) return true;
        if (!n.children) return false;
        for (const c of n.children) if (subtreeHasKestrel(c)) return true;
        return false;
      }

      const norm = p => (p || '').replace(/\\/g, '/');
      const normPath = norm(node.path);
      const isInProgress = _inProgressFolderPaths.has(normPath);
      
      const effectiveHasKestrel = subtreeHasKestrel(node) || isInProgress; // Show checkbox for in-progress too
      const outdated = isVersionOutdated(node);
      row.className = 'tree-node-row ' + (effectiveHasKestrel ? 'has-kestrel' : 'no-kestrel') + (outdated ? ' version-outdated' : '') + (isInProgress ? ' in-progress' : '');
      if (node.path === treeActivePath) row.classList.add('active');
      if (isInProgress) row.title = 'Currently analyzing...';
      else if (outdated) row.title = `Analyzed on Kestrel v${node.kestrel_version} (current: v${_appVersion})`;

      // Arrow toggle
      const arrow = document.createElement('span');
      arrow.className = 'tree-arrow';
      const hasChildren = node.children && node.children.length > 0;
      if (hasChildren) {
        arrow.textContent = '▶';
        if (treeExpandedPaths.has(node.path)) arrow.classList.add('open');
      } else {
        arrow.classList.add('leaf');
        arrow.textContent = '▶';
      }

      // Checkbox for loading ANALYZED folders OR in-progress folders (blue accent)
      let loadCheckbox = null;
      if (node.has_kestrel || isInProgress) {
        loadCheckbox = document.createElement('input');
        loadCheckbox.type = 'checkbox';
        loadCheckbox.className = 'tree-cb';
        loadCheckbox.title = isInProgress ? 'Include in multi-folder view (analyzing now)' : 'Include in multi-folder view';
        loadCheckbox.checked = checkedFolderPaths.has(node.path);
        loadCheckbox.addEventListener('change', (e) => {
          e.stopPropagation();
          if (loadCheckbox.checked) checkedFolderPaths.add(node.path);
          else checkedFolderPaths.delete(node.path);
          _updateAutoRefreshTimers(); // Update auto-refresh for in-progress
          debouncedAutoLoad();
        });
      }

      // Folder icon
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = node.has_kestrel ? '📂' : '📁';

      // Label
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      label.title = node.path;

      // Attach path to the row for async inspection
      row.dataset.path = node.path;

      // Count placeholder (populated asynchronously)
      const countSpan = document.createElement('span');
      countSpan.className = 'tree-count';
      countSpan.textContent = '';

      row.appendChild(arrow);
      if (loadCheckbox) {
        row.appendChild(loadCheckbox);
      } else {
        // Always keep a fixed-width spacer so folder icons at every level align
        const spacer = document.createElement('span');
        spacer.className = 'tree-cb-spacer';
        row.appendChild(spacer);
      }
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(countSpan);
      wrap.appendChild(row);

      // Children container
      let childWrap = null;
      if (hasChildren) {
        childWrap = document.createElement('div');
        childWrap.className = 'tree-children';
        if (!treeExpandedPaths.has(node.path)) childWrap.classList.add('hidden');
        node.children.forEach(child => childWrap.appendChild(buildTreeNode(child, flatOrder)));
        wrap.appendChild(childWrap);

        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = treeExpandedPaths.has(node.path);
          if (open) {
            treeExpandedPaths.delete(node.path);
            arrow.classList.remove('open');
            childWrap.classList.add('hidden');
          } else {
            treeExpandedPaths.add(node.path);
            arrow.classList.add('open');
            childWrap.classList.remove('hidden');
          }
        });
      }

      // Click label/icon to load (only if this node has kestrel data)
      if (node.has_kestrel) {
        label.addEventListener('click', async () => {
          treeActivePath = node.path;
          renderFolderTree();
          await loadFolderFromPath(node.path);
        });
        icon.addEventListener('click', async () => {
          treeActivePath = node.path;
          renderFolderTree();
          await loadFolderFromPath(node.path);
        });
        // Right-click context menu for clearing analysis data
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          showContextMenu(e.clientX, e.clientY, [
            {
              label: '🗑 Clear Kestrel Analysis Data',
              danger: true,
              action: () => {
                clearKestrelDataForFolder(node.path, node.name, () => {
                  node.has_kestrel = false;
                  node.kestrel_version = '';
                  renderFolderTree();
                });
              }
            }
          ]);
        });
      }

      return wrap;
    }

    // Populate folder counts ONLY for the Analyze Folders dialog tree.
    // Two-pass approach: (1) inspect all folders, (2) apply subtree-aware fading & colors.
    // Colors: green=finished, purple=started-not-finished, blue=not-started-but-has-images.
    // Fading: no-photos-deep = folder+all descendants have 0 images (full row faded).
    //         no-photos-shallow = folder has 0 images but some descendant has images (checkbox faded only).
    async function populateAnalyzeFolderCounts() {
      if (!hasPywebviewApi || !window.pywebview?.api?.inspect_folder) return;
      try {
        // Query ONLY the Analyze dialog tree nodes
        const rows = Array.from(document.querySelectorAll('#analyzeDlgTree .adlg-node-row'));
        const norm = p => (p || '').replace(/\\/g, '/');
        const pathToRows = new Map(); // normalized path → [row, ...]
        const normToOriginal = new Map();
        const paths = [];

        for (const row of rows) {
          const origPath = row.dataset.path;
          if (!origPath) continue;
          const np = norm(origPath);
          if (!pathToRows.has(np)) {
            pathToRows.set(np, []);
            normToOriginal.set(np, origPath);
            paths.push(np);
          }
          pathToRows.get(np).push(row);
          const span = row.querySelector('.tree-count');
          if (span) span.textContent = '';
        }
        if (paths.length === 0) return;

        const uniq = Array.from(new Set(paths));
        uniq.sort((a, b) => {
          const da = a.split('/').length, db = b.split('/').length;
          return da !== db ? da - db : a.length - b.length;
        });

        const total = uniq.length;
        let completed = 0;
        // Store inspection results for the second pass
        const inspectionMap = new Map(); // normalized path → { total, processed } | null

        const dlgProgWrap = document.getElementById('analyzeScanProgress');
        const dlgProgFill = document.getElementById('analyzeScanFill');
        const dlgProgLabel = document.getElementById('analyzeScanLabel');
        if (dlgProgWrap) dlgProgWrap.classList.remove('hidden');

        // ── Pass 1: Inspect all folders concurrently ──
        const concurrency = Math.min(8, Math.max(2, Math.ceil(total / 8)));
        let idx = 0;

        async function worker() {
          while (true) {
            const i = idx++;
            if (i >= total) break;
            const np = uniq[i];
            const origPath = normToOriginal.get(np) || np;
            try {
              for (const r of (pathToRows.get(np) || [])) {
                const s = r.querySelector('.tree-count');
                if (s) s.textContent = ' …';
              }
              const res = await window.pywebview.api.inspect_folder(origPath);
              const info = res && res.success ? res.info : null;
              inspectionMap.set(np, info ? { total: info.total || 0, processed: info.processed || 0 } : null);
            } catch (e) {
              console.warn('[populateAnalyzeFolderCounts] error for', origPath, e);
              inspectionMap.set(np, null);
            }
            completed++;
            const pct = Math.round((completed / total) * 100);
            if (dlgProgFill) dlgProgFill.style.width = pct + '%';
            if (dlgProgLabel) dlgProgLabel.textContent = `Scanning folders… (${completed}/${total})`;
          }
        }

        const workers = [];
        for (let w = 0; w < concurrency; w++) workers.push(worker());
        await Promise.all(workers);

        // ── Pass 2: Apply colors and subtree-aware fading ──
        // Helper: does any descendant of `prefix` have images?
        function subtreeHasImages(prefix) {
          const pfx = prefix.endsWith('/') ? prefix : prefix + '/';
          for (const [p, info] of inspectionMap) {
            if (p !== prefix && p.startsWith(pfx) && info && info.total > 0) return true;
          }
          return false;
        }

        // Helper: look up kestrel_version from tree node by path
        function findNodeVersion(node, targetPath) {
          if (!node) return '';
          if (node.path === targetPath) return node.kestrel_version || '';
          if (node.children) {
            for (const c of node.children) {
              const v = findNodeVersion(c, targetPath);
              if (v) return v;
            }
          }
          return '';
        }

        for (const np of uniq) {
          const info = inspectionMap.get(np);
          const related = pathToRows.get(np) || [];
          for (const row of related) {
            const span = row.querySelector('.tree-count');
            row.classList.remove('analyzed-full', 'analyzed-partial', 'analyzed-none',
                                 'no-photos', 'no-photos-deep', 'no-photos-shallow', 'version-outdated');
            row.title = '';
            if (span) { span.title = ''; span.textContent = ''; }

            if (!info) continue;

            const totalImgs = info.total;
            const processedImgs = info.processed;

            if (totalImgs > 0) {
              if (span) span.textContent = ` ${processedImgs}/${totalImgs}`;
              if (processedImgs >= totalImgs) {
                row.classList.add('analyzed-full');          // green: finished
                // Check if analyzed on an outdated version
                const origPath = normToOriginal.get(np) || np;
                const nodeVer = findNodeVersion(folderTreeRootNode, origPath);
                if (nodeVer && _appVersion && compareVersions(nodeVer, _appVersion) < 0) {
                  row.classList.add('version-outdated');
                  row.title = `Analyzed on Kestrel v${nodeVer} (current: v${_appVersion}). Consider re-analyzing.`;
                }
              } else if (processedImgs > 0) {
                row.classList.add('analyzed-partial');       // purple: started not finished
              } else {
                row.classList.add('analyzed-none');          // blue: has images, not started
              }
            } else {
              // This folder has 0 images — determine deep vs shallow fading
              const hasDescendantImages = subtreeHasImages(np);
              if (hasDescendantImages) {
                // Shallow: only fade the checkbox, not the name/arrow (descendant has images)
                row.classList.add('no-photos-shallow');
              } else {
                // Deep: entire row faded (no images anywhere in subtree)
                row.classList.add('no-photos-deep');
              }
              const cb = row.querySelector('.adlg-cb');
              if (cb) { cb.disabled = true; cb.checked = false; }
              const tip = hasDescendantImages
                ? 'No photos in this folder, but subfolders contain images.'
                : 'No supported photos found in this folder or any subfolder.';
              if (span) span.title = tip;
              row.title = tip;
            }
          }
        }

        // Hide progress after brief delay
        setTimeout(() => {
          if (dlgProgWrap) dlgProgWrap.classList.add('hidden');
          if (dlgProgFill) dlgProgFill.style.width = '0%';
          if (dlgProgLabel) dlgProgLabel.textContent = 'Scanning folders…';
        }, 400);
      } catch (e) {
        console.warn('[populateAnalyzeFolderCounts] failed', e);
        const dlgWrap = document.getElementById('analyzeScanProgress');
        if (dlgWrap) dlgWrap.classList.add('hidden');
      }
    }

    // ── End Folder Tree ───────────────────────────────────────────────────────────

    // ── Analyze Folders Dialog ───────────────────────────────────────────────────

    let _dlgSelected = new Set();
    let _dlgExpandedPaths = new Set();
    let _dlgReanalyze = new Set(); // paths confirmed for re-analysis (fully analyzed folders)

    /** Build a tree node for the Analyze dialog (amber checkboxes, no load-cb). */
    function buildAnalyzeDlgNode(node, selectedSet, onChangeCallback) {
      const wrap = document.createElement('div');
      wrap.className = 'tree-node';

      const row = document.createElement('div');
      const hasChildren = node.children && node.children.length > 0;
      const isExpanded = _dlgExpandedPaths.has(node.path);
      const outdated = isVersionOutdated(node);
      row.className = 'adlg-node-row' + (selectedSet.has(node.path) ? ' queue-sel' : '') + (node.has_kestrel ? ' has-kestrel' : '') + (outdated ? ' version-outdated' : '');
      if (outdated) {
        row.title = `Analyzed on Kestrel v${node.kestrel_version} (current: v${_appVersion}). Consider re-analyzing.`;
      }

      const arrow = document.createElement('span');
      arrow.className = 'tree-arrow' + (hasChildren ? (isExpanded ? ' open' : '') : ' leaf');
      arrow.textContent = hasChildren ? '▶' : '';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'adlg-cb';
      cb.checked = selectedSet.has(node.path);
      cb.addEventListener('change', (e) => {
        e.stopPropagation();
        if (cb.checked) {
          // Prompt before re-queuing a fully analyzed folder
          if (row.classList.contains('analyzed-full')) {
            const confirmed = confirm(
              `"${node.name}" has already been fully analyzed.\n\n` +
              `Re-analyzing will delete the existing analysis data (.kestrel folder) and process it again.\n\n` +
              `Continue?`
            );
            if (!confirmed) { cb.checked = false; return; }
            _dlgReanalyze.add(node.path);
          }
          selectedSet.add(node.path);
        } else {
          selectedSet.delete(node.path);
          _dlgReanalyze.delete(node.path);
        }
        row.classList.toggle('queue-sel', cb.checked);
        onChangeCallback();
      });

      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = node.has_kestrel ? '\uD83D\uDCC2' : '\uD83D\uDCC1';

      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      if (!outdated) label.title = node.path;
      else label.title = `v${node.kestrel_version} → v${_appVersion} (outdated)`;

      // Version badge for outdated folders
      const versionBadge = document.createElement('span');
      if (outdated) {
        versionBadge.style.cssText = 'font-size:10px;color:var(--ok);opacity:0.7;margin-left:4px;font-style:italic;';
        versionBadge.textContent = `v${node.kestrel_version}`;
      }

      // Attach path for async inspection and add count placeholder
      row.dataset.path = node.path;
      const countSpan = document.createElement('span');
      countSpan.className = 'tree-count';
      countSpan.textContent = '';

      row.appendChild(arrow);
      row.appendChild(cb);
      row.appendChild(icon);
      row.appendChild(label);
      if (outdated) row.appendChild(versionBadge);
      row.appendChild(countSpan);

      // Right-click context menu for clearing analysis data
      if (node.has_kestrel) {
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          const folderName = node.name;
          showContextMenu(e.clientX, e.clientY, [
            {
              label: '🗑 Clear Kestrel Analysis Data',
              danger: true,
              action: () => {
                clearKestrelDataForFolder(node.path, folderName, () => {
                  // Update the node state in-memory
                  node.has_kestrel = false;
                  node.kestrel_version = '';
                  // Re-render the dialog tree
                  const treeEl = document.getElementById('analyzeDlgTree');
                  if (treeEl && folderTreeRootNode) {
                    treeEl.innerHTML = '';
                    treeEl.appendChild(buildAnalyzeDlgNode(folderTreeRootNode, _dlgSelected, onChangeCallback));
                    populateAnalyzeFolderCounts();
                  }
                });
              }
            }
          ]);
        });
      }

      wrap.appendChild(row);

      if (hasChildren) {
        const childWrap = document.createElement('div');
        childWrap.className = 'tree-children';
        if (!isExpanded) childWrap.classList.add('hidden');
        node.children.forEach(child => childWrap.appendChild(buildAnalyzeDlgNode(child, selectedSet, onChangeCallback)));
        wrap.appendChild(childWrap);

        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          const open = _dlgExpandedPaths.has(node.path);
          if (open) { _dlgExpandedPaths.delete(node.path); arrow.classList.remove('open'); childWrap.classList.add('hidden'); }
          else { _dlgExpandedPaths.add(node.path); arrow.classList.add('open'); childWrap.classList.remove('hidden'); }
        });
      }
      return wrap;
    }

    /** Render the right-side queue preview panel in the Analyze dialog.
     *  Shows: running items, pending items (draggable + removable), and "will be added" selection. */
    function _refreshAnalyzeDlgQueuePreview() {
      const runningEl = document.getElementById('adlgQueueRunning');
      const willAddEl = document.getElementById('adlgQueueWillAdd');
      const emptyEl = document.getElementById('adlgQueueEmpty');
      if (!runningEl || !willAddEl || !emptyEl) return;

      runningEl.innerHTML = '';
      willAddEl.innerHTML = '';

      let hasActiveQueue = false;

      try {
        const status = window._lastQueueStatus;
        if (status && status.items && status.items.length > 0) {
          const runningItems = status.items.filter(i => i.status === 'running');
          const pendingItems = status.items.filter(i => i.status === 'pending');

          // ── Running items ──
          if (runningItems.length > 0) {
            hasActiveQueue = true;
            const title = document.createElement('div');
            title.className = 'adlg-queue-section-title';
            title.textContent = '⚙ Analyzing';
            runningEl.appendChild(title);
            for (const item of runningItems) {
              const row = document.createElement('div');
              row.className = 'adlg-queue-item';
              const nameEl = document.createElement('span');
              nameEl.className = 'adlg-qi-name';
              nameEl.textContent = item.name;
              nameEl.title = item.path;
              const statusEl = document.createElement('span');
              statusEl.className = 'adlg-qi-status';
              statusEl.textContent = item.total > 0 ? `${item.processed}/${item.total}` : 'starting…';
              row.appendChild(nameEl);
              row.appendChild(statusEl);
              runningEl.appendChild(row);
            }
          }

          // ── Pending items (drag-to-reorder + cancel) ──
          if (pendingItems.length > 0) {
            hasActiveQueue = true;
            const pendTitle = document.createElement('div');
            pendTitle.className = 'adlg-queue-section-title';
            pendTitle.textContent = `⏳ In Queue (${pendingItems.length})`;
            runningEl.appendChild(pendTitle);

            let _dragSrcPath = null;
            const pendContainer = document.createElement('div');
            pendContainer.dataset.role = 'pending-list';

            for (const item of pendingItems) {
              const row = document.createElement('div');
              row.className = 'adlg-queue-item';
              row.draggable = true;
              row.dataset.queuePath = item.path;

              const grip = document.createElement('span');
              grip.className = 'adlg-qi-grip';
              grip.textContent = '⠿';
              grip.title = 'Drag to reorder';

              const nameEl = document.createElement('span');
              nameEl.className = 'adlg-qi-name';
              nameEl.textContent = item.name;
              nameEl.title = item.path;

              const statusEl = document.createElement('span');
              statusEl.className = 'adlg-qi-status';
              statusEl.textContent = 'pending';

              const removeBtn = document.createElement('button');
              removeBtn.className = 'adlg-qi-remove';
              removeBtn.textContent = '✕';
              removeBtn.title = 'Remove from queue';
              removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (hasPywebviewApi && window.pywebview?.api?.remove_queue_item) {
                  await window.pywebview.api.remove_queue_item(item.path);
                  const s = await apiGetQueueStatus();
                  renderQueuePanel(s);
                  _refreshAnalyzeDlgQueuePreview();
                }
              });

              // Drag events
              row.addEventListener('dragstart', (e) => {
                _dragSrcPath = item.path;
                row.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', item.path);
              });
              row.addEventListener('dragend', () => {
                _dragSrcPath = null;
                row.classList.remove('dragging');
                pendContainer.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
              });
              row.addEventListener('dragover', (e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (row.dataset.queuePath !== _dragSrcPath) {
                  row.classList.add('drag-over');
                }
              });
              row.addEventListener('dragleave', () => {
                row.classList.remove('drag-over');
              });
              row.addEventListener('drop', async (e) => {
                e.preventDefault();
                row.classList.remove('drag-over');
                const srcPath = e.dataTransfer.getData('text/plain');
                if (!srcPath || srcPath === item.path) return;
                const currentOrder = Array.from(pendContainer.querySelectorAll('[data-queue-path]'))
                  .map(el => el.dataset.queuePath);
                const filtered = currentOrder.filter(p => p !== srcPath);
                const targetIdx = filtered.indexOf(item.path);
                filtered.splice(targetIdx, 0, srcPath);
                if (hasPywebviewApi && window.pywebview?.api?.reorder_queue) {
                  await window.pywebview.api.reorder_queue(JSON.stringify(filtered));
                  const s = await apiGetQueueStatus();
                  renderQueuePanel(s);
                  _refreshAnalyzeDlgQueuePreview();
                }
              });

              row.appendChild(grip);
              row.appendChild(nameEl);
              row.appendChild(statusEl);
              row.appendChild(removeBtn);
              pendContainer.appendChild(row);
            }
            runningEl.appendChild(pendContainer);
          }
        }
      } catch (_) { }

      // ── Will be added (selected but not yet queued) ──
      const selected = Array.from(_dlgSelected);
      if (selected.length > 0) {
        const title = document.createElement('div');
        title.className = 'adlg-queue-section-title';
        title.textContent = `➕ Will Be Added (${selected.length})`;
        willAddEl.appendChild(title);
        for (const path of selected) {
          const name = path.replace(/\\/g, '/').split('/').pop() || path;
          const row = document.createElement('div');
          row.className = 'adlg-queue-item';
          const nameEl = document.createElement('span');
          nameEl.className = 'adlg-qi-name';
          nameEl.textContent = name;
          nameEl.title = path;
          const removeBtn = document.createElement('button');
          removeBtn.className = 'adlg-qi-remove';
          removeBtn.textContent = '✕';
          removeBtn.title = 'Remove from selection';
          removeBtn.addEventListener('click', () => {
            _dlgSelected.delete(path);
            _dlgReanalyze.delete(path);
            const treeRows = document.querySelectorAll('#analyzeDlgTree .adlg-node-row');
            for (const r of treeRows) {
              if (r.dataset.path === path) {
                const cb = r.querySelector('.adlg-cb');
                if (cb) cb.checked = false;
                r.classList.remove('queue-sel');
              }
            }
            const countEl = document.getElementById('analyzeDlgCount');
            const addBtn = document.getElementById('analyzeDlgAdd');
            if (countEl) countEl.textContent = _dlgSelected.size + ' folder' + (_dlgSelected.size === 1 ? '' : 's') + ' selected';
            if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
            _refreshAnalyzeDlgQueuePreview();
          });
          row.appendChild(nameEl);
          if (_dlgReanalyze.has(path)) {
            const badge = document.createElement('span');
            badge.className = 'adlg-qi-status';
            badge.style.color = '#f0a040';
            badge.style.fontStyle = 'italic';
            badge.textContent = 'Will be Re-analyzed';
            row.appendChild(badge);
          }
          row.appendChild(removeBtn);
          willAddEl.appendChild(row);
        }
      }

      emptyEl.classList.toggle('hidden', hasActiveQueue || selected.length > 0);
    }

    /** Open the 'Analyze Folders…' dialog. */
    async function openAnalyzeDialog() {
      if (!hasPywebviewApi) {
        alert('Analysis queue is only available in the desktop (pywebview) mode.\n\nRun kestrel_visualizer as a desktop app to use this feature.');
        return;
      }
      // Make sure we have a tree to browse
      if (!folderTreeRootNode) {
        const fp = await window.pywebview.api.choose_directory();
        if (!fp) return;
        await scanFolderTree(fp);
        if (!folderTreeRootNode) return;
      }
      // Hide GPU checkbox in frozen (PyInstaller) builds — GPU not supported there
      const gpuLabel = document.getElementById('analyzeGpuLabel');
      if (gpuLabel) {
        gpuLabel.style.display = _isFrozenApp ? 'none' : '';
        if (_isFrozenApp) {
          const gpuCb = document.getElementById('analyzeUseGpu');
          if (gpuCb) gpuCb.checked = false;
        }
      }
      // Seed the dialog's selected set from any previously-queued paths
      _dlgSelected = new Set(queuedFolderPaths);
      
      // Try to restore last queue state if available
      const savedQueue = getSetting('lastQueueState', null);
      if (savedQueue && Array.isArray(savedQueue) && savedQueue.length > 0) {
        const restoreBtn = document.getElementById('analyzeDlgRestoreQueue');
        if (restoreBtn) {
          restoreBtn.style.display = '';
          restoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _dlgSelected = new Set(savedQueue);
            // Restore queue in settings so it looks restored
            const s = loadSettings();
            delete s.lastQueueState;
            saveSettings(s);
            restoreBtn.style.display = 'none';
            refreshDlg();
          }, { once: true }); // only trigger once per dialog open
        }
      }
      
      _dlgExpandedPaths = new Set([folderTreeRootNode.path]);
      _dlgReanalyze = new Set();

      function refreshDlg() {
        const countEl = document.getElementById('analyzeDlgCount');
        const addBtn = document.getElementById('analyzeDlgAdd');
        if (countEl) countEl.textContent = _dlgSelected.size + ' folder' + (_dlgSelected.size === 1 ? '' : 's') + ' selected';
        if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
        _refreshAnalyzeDlgQueuePreview();
      }

      const treeEl = document.getElementById('analyzeDlgTree');
      treeEl.innerHTML = '';
      treeEl.appendChild(buildAnalyzeDlgNode(folderTreeRootNode, _dlgSelected, refreshDlg));
      // Populate counts for dialog nodes with colors and progress bar
      populateAnalyzeFolderCounts();
      refreshDlg();
      document.getElementById('analyzeQueueDlg').showModal();
    }

    // ── Analysis Queue Panel / Polling ───────────────────────────────────────────

    let _queuePollingTimer = null;
    let _queuePanelExpanded = true;
    let _queueLastDoneSet = new Set(); // track newly-done folders to auto-refresh tree
    let _queueLastRunningSet = new Set(); // track newly-running folders to update tree
    let _tempKestrelPaths = new Set(); // transiently-marked paths to prevent flicker
    let _analyticsConsentPending = false; // guard against showing consent dialog multiple times
    let _queueCountsTimer = null; // interval for updating folder counts from queue
    
    // In-progress folder tracking and auto-refresh for live updates
    let _inProgressFolderPaths = new Set(); // folders with pending/running status
    let _autoRefreshTimers = new Map(); // path -> intervalId for auto-refresh listeners
    let _inProgressFoldersCheckedCount = 0; // count of in-progress folders that are checked
    let _isFirstQueueStart = true; // used to detect Case 1 vs Case 2 for auto-load
    
    // Session state for ETA calculations: track baseline state from folder inspection
    let _queueSessionStartState = new Map(); // path -> { initialProcessed: int, totalImages: int, toAnalyze: int }
    let _queueFolderInspections = new Map(); // path -> full inspection data from inspect_folder/inspect_folders
    // ETA smoothing: exponential moving average to prevent wild per-image swings
    let _etaSmoothed = null;   // smoothed secs/image
    let _etaLastPath = null;   // reset EMA when folder changes
    const _thumbCache = new Map();    // relPath+'|'+rootPath → dataUrl (avoids reload flash)
    let _liveAnalysisDlgOpen = false;
    let _liveLastThumbKey = '';
    let _liveLastOverlayKey = '';
    let _liveLastCropKeys = [];
    const CONF_HIGH = 0.75;
    const CONF_LOW = 0.30;

    /** Call the backend (pywebview API or HTTP) to start the queue. */
    async function apiStartQueue(paths, useGpu = true, wildlifeEnabled = true) {
      if (hasPywebviewApi && window.pywebview?.api?.start_analysis_queue) {
        return window.pywebview.api.start_analysis_queue(JSON.stringify(paths), useGpu, wildlifeEnabled);
      }
      // HTTP fallback (browser mode)
      const headers = { 'Content-Type': 'application/json', ...(window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {}) };
      const res = await fetch('/queue/start', { method: 'POST', headers, body: JSON.stringify({ paths, use_gpu: useGpu, wildlife_enabled: wildlifeEnabled }) });
      return res.json();
    }

    async function apiQueueControl(action) {
      if (hasPywebviewApi && window.pywebview?.api) {
        const fn = { pause: 'pause_analysis_queue', resume: 'resume_analysis_queue', cancel: 'cancel_analysis_queue', clear: 'clear_queue_done' }[action];
        if (fn && window.pywebview.api[fn]) return window.pywebview.api[fn]();
      }
      const headers = { 'Content-Type': 'application/json', ...(window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {}) };
      const res = await fetch(`/queue/${action}`, { method: 'POST', headers, body: '{}' });
      return res.json();
    }

    async function apiGetQueueStatus() {
      if (hasPywebviewApi && window.pywebview?.api?.get_queue_status) {
        return window.pywebview.api.get_queue_status();
      }
      const headers = window.__BRIDGE_TOKEN ? { 'X-Bridge-Token': window.__BRIDGE_TOKEN } : {};
      const res = await fetch('/queue/status', { headers });
      return res.json();
    }

    /** Format a duration in seconds to a readable string like "2m 30s". */
    function formatDuration(secs) {
      if (!isFinite(secs) || secs < 0) return '–';
      secs = Math.round(secs);
      if (secs < 60) return secs + 's';
      const m = Math.floor(secs / 60), s = secs % 60;
      if (m < 60) return m + 'm ' + (s > 0 ? s + 's' : '');
      const h = Math.floor(m / 60), rm = m % 60;
      return h + 'h ' + (rm > 0 ? rm + 'm' : '');
    }

    /** Render the queue panel from a status object. */
    function renderQueuePanel(status) {
      window._lastQueueStatus = status; // store for analyze dialog queue preview
      const panel = document.getElementById('queuePanel');
      const badge = document.getElementById('queuePanelBadge');
      const body = document.getElementById('queuePanelBody');
      const controls = document.getElementById('queuePanelControls');
      const pauseBtn = document.getElementById('queuePauseBtn');
      const overallEtaEl = document.getElementById('queueOverallEta');
      if (!panel || !badge || !body) return;

      const items = status.items || [];
      const running = !!status.running;
      const paused = !!status.paused;
      const hasItems = items.length > 0;

      // While the queue is running, keep a short-lived poll to update folder rows
      if (running) startQueueCountsPoll(); else stopQueueCountsPoll();

      if (!hasItems && !running) {
        panel.classList.add('hidden');
        if (overallEtaEl) overallEtaEl.classList.add('hidden');
        stopPollingQueue();
        return;
      }

      panel.classList.remove('hidden');

      // Badge
      const runningItems = items.filter(i => i.status === 'running');
      const pendingItems = items.filter(i => i.status === 'pending');
      const doneItems = items.filter(i => i.status === 'done');
      if (paused) {
        badge.textContent = 'Paused'; badge.className = 'queue-panel-badge paused';
      } else if (running) {
        const cur = runningItems[0];
        if (cur && cur.total > 0) {
          badge.textContent = `${cur.processed} / ${cur.total}`; badge.className = 'queue-panel-badge';
        } else {
          badge.textContent = `${pendingItems.length + runningItems.length} pending`; badge.className = 'queue-panel-badge';
        }
      } else if (doneItems.length === items.length && items.length > 0) {
        badge.textContent = 'Done'; badge.className = 'queue-panel-badge done';
      } else {
        badge.textContent = `${pendingItems.length} pending`; badge.className = 'queue-panel-badge';
      }

      // Pause/resume button label
      if (pauseBtn) pauseBtn.textContent = paused ? '▶ Resume' : '⏸ Pause';

      if (!_queuePanelExpanded) { body.classList.add('hidden'); if (controls) controls.classList.add('hidden'); return; }
      body.classList.remove('hidden'); if (controls) controls.classList.remove('hidden');

      // ETA computation: secs/image from running item using TRUE baseline from folder inspection
      const cur = runningItems[0];
      let secsPerImage = null;
      // inspectionReady: inspection data exists for the running folder.
      // Until it arrives, suppress ETA entirely (show "Calculating ETA…") so the early
      // incorrect progress_cb(alreadyDone, total) call cannot produce a near-zero ETA.
      const normCurPath = normalizePath(cur?.path);
      const inspectionReady = cur && _queueSessionStartState.has(normCurPath);
      if (cur && inspectionReady && cur.elapsed_seconds > 0) {
        const sess = _queueSessionStartState.get(normCurPath);
        const initialProcessed = sess.initialProcessed || 0;
        const processedThisSession = Math.max(0, (cur.processed || 0) - initialProcessed);
        if (processedThisSession > 0) {
          const rawSecsPerImage = cur.elapsed_seconds / processedThisSession;
          // Reset EMA if we moved to a different folder (compare normalized paths)
          if (_etaLastPath !== normCurPath) { _etaSmoothed = null; _etaLastPath = normCurPath; }
          // Exponential moving average (α=0.15) — smooths per-image jitter without
          // lagging too far behind the true rate
          const alpha = 0.15;
          _etaSmoothed = _etaSmoothed === null ? rawSecsPerImage : alpha * rawSecsPerImage + (1 - alpha) * _etaSmoothed;
          secsPerImage = _etaSmoothed;
        }
      }

      // Show loading message if models are being loaded (early in run)
      if (running && cur) {
        const overallEl = overallEtaEl;
        const loadingMsg = (cur.current_status_msg || '').toLowerCase().includes('load');
        if (loadingMsg || (cur.processed === 0 && cur.current_status_msg)) {
          if (overallEl) { overallEl.textContent = `⏳ ${cur.current_status_msg || 'Loading analyzer... please wait'}`; overallEl.classList.remove('hidden'); }
          try { showLoadingAnalyzer(); } catch (e) { }
        } else {
          try { hideLoadingAnalyzer(); } catch (e) { }
        }
      }

      // Overall ETA: aggregate remaining images across queue using inspection data for accuracy
      if (overallEtaEl && running && cur) {
        if (!inspectionReady) {
          // Inspection data still in flight — show placeholder so user isn't misled
          overallEtaEl.textContent = '⏳ Calculating ETA…';
          overallEtaEl.classList.remove('hidden');
        } else if (secsPerImage !== null) {
          let totalRemaining = 0;
          for (const item of items) {
            const sess = _queueSessionStartState.get(item.path);
            if (item.status === 'running' && item.total > 0) {
              const remaining = Math.max(0, (item.total || 0) - (item.processed || 0));
              totalRemaining += secsPerImage * remaining;
            } else if (item.status === 'pending') {
              const toAnalyze = sess && typeof sess.toAnalyze === 'number' ? sess.toAnalyze : 200;
              totalRemaining += secsPerImage * toAnalyze;
            }
          }
          if (totalRemaining > 5) {
            overallEtaEl.textContent = `⏱ Overall est. remaining: ${formatDuration(totalRemaining)}`;
            overallEtaEl.classList.remove('hidden');
          } else {
            overallEtaEl.classList.add('hidden');
          }
        } else {
          overallEtaEl.classList.add('hidden');
        }
      } else if (overallEtaEl) {
        overallEtaEl.classList.add('hidden');
      }

      // Queue items
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const div = document.createElement('div');
        const isDone = item.status === 'done';
        const isAlreadyAnalyzed = isDone &&
          (item.current_status_msg || '').toLowerCase().includes('no new files');
        div.className = 'queue-item' + (isDone || item.status === 'cancelled' ? ' done-item' : '');

        // Header row: name + status badge
        const hdr = document.createElement('div');
        hdr.className = 'queue-item-header';
        const nameEl = document.createElement('span');
        nameEl.className = 'queue-item-name';
        nameEl.textContent = item.name;
        nameEl.title = item.path;
        const statusEl = document.createElement('span');
        statusEl.className = `queue-item-status ${item.status}`;
        const labels = {
          pending: '⏳ In Queue',
          running: '⚙ Analyzing',
          done: isAlreadyAnalyzed ? '✓ Already analyzed' : '✓ Done',
          error: '✗ Error',
          cancelled: '— Cancelled',
        };
        statusEl.textContent = labels[item.status] || item.status;
        if (item.status === 'error' && item.error) statusEl.title = item.error;
        hdr.appendChild(nameEl); hdr.appendChild(statusEl);
        div.appendChild(hdr);

        // Progress bar
        if (item.status === 'running' && item.total > 0) {
          const prog = document.createElement('div'); prog.className = 'queue-item-progress';
          const fill = document.createElement('div'); fill.className = 'queue-item-progress-fill';
          fill.style.width = Math.round((item.processed / item.total) * 100) + '%';
          prog.appendChild(fill); div.appendChild(prog);

          // ETA / paused row
          {
            const etaEl = document.createElement('div');
            etaEl.className = 'queue-item-eta';
            if (item.is_paused) {
              etaEl.textContent = `${item.processed} / ${item.total} — ⏸ Paused`;
            } else if (!inspectionReady) {
              etaEl.textContent = `${item.processed} / ${item.total} — ⏳ Calculating ETA…`;
            } else if (secsPerImage !== null && item.total > item.processed) {
              const remaining = secsPerImage * (item.total - item.processed);
              etaEl.textContent = `${item.processed} / ${item.total} — est. ${formatDuration(remaining)} left`;
            } else {
              etaEl.textContent = `${item.processed} / ${item.total}`;
            }
            div.appendChild(etaEl);
          }

          // Current filename
          if (item.current_filename) {
            const fileEl = document.createElement('div');
            fileEl.className = 'queue-item-file';
            fileEl.textContent = item.current_filename;
            div.appendChild(fileEl);
          }

          // Live preview thumbnail (async load deferred after DOM insert)
          if (item.current_export_path && hasPywebviewApi) {
            const preview = document.createElement('div');
            preview.className = 'queue-live-preview';
            const thumb = document.createElement('img');
            thumb.className = 'queue-live-thumb';
            thumb.alt = '';
            // Store paths as data attributes; loaded after DOM insert
            thumb.dataset.thumbRel = item.current_export_path;
            thumb.dataset.thumbRoot = item.path;
            preview.appendChild(thumb);
            div.appendChild(preview);
          }
        } else if (item.status === 'done' && item.total > 0) {
          const prog = document.createElement('div'); prog.className = 'queue-item-progress';
          const fill = document.createElement('div'); fill.className = 'queue-item-progress-fill';
          fill.style.width = '100%'; fill.style.background = '#2ecc71';
          prog.appendChild(fill); div.appendChild(prog);
        }

        frag.appendChild(div);
      }
      body.innerHTML = '';
      body.appendChild(frag);

      // Async: load thumbnails for any img[data-thumb-rel] elements (cache avoids reload flash)
      body.querySelectorAll('img[data-thumb-rel]').forEach(async img => {
        try {
          const rel = img.dataset.thumbRel || '';
          const root = img.dataset.thumbRoot || '';
          const key = rel + '|' + root;
          const isLive = rel.indexOf('__live_') >= 0;
          if (!isLive && _thumbCache.has(key)) { img.src = _thumbCache.get(key); return; }
          const result = await window.pywebview.api.read_image_file(rel, root);
          if (result && result.success && result.data) {
            const url = _base64ToBlobUrl(result.data, result.mime);
            if (!isLive) _thumbCache.set(key, url);
            img.src = url;
          }
        } catch (_) { }
      });

      // Check if any folder newly finished — refresh tree + auto-reload CSV data
      const nowDone = new Set(items.filter(i => i.status === 'done').map(i => i.path));
      let treeRescanNeeded = false;
      for (const p of nowDone) {
        if (!_queueLastDoneSet.has(p)) {
          treeRescanNeeded = true;
          scheduleAutoRefresh(p);
          // First-time folder completion → offer analytics consent if not yet asked
          if (!getSetting('analytics_consent_shown', false)) showAnalyticsConsentDialog();
        }
      }
      if (treeRescanNeeded) {
        setTimeout(() => { if (folderTreeRootNode) rescanFolderTree(folderTreeRootNode.path); }, 1200);
      }
      _queueLastDoneSet = nowDone;

      // Update in-progress folder tracking and UI (pending + running folders)
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        const inProgressNow = new Set();
        for (const item of items) {
          if (item.status === 'pending' || item.status === 'running') {
            inProgressNow.add(norm(item.path));
          }
        }
        
        // Detect newly-running items (first time moving from pending to running)
        const runningNow = new Set(items.filter(i => i.status === 'running').map(i => norm(i.path)));
        for (const p of runningNow) {
          if (!_queueLastRunningSet.has(p)) {
            // Move out of pending and into running — implement Case 1 logic
            _handleFirstFolderAnalysisStart(p);
          }
        }
        const prevRunningSet = _queueLastRunningSet;
        _queueLastRunningSet = runningNow;
        
        // Update in-progress set and refresh tree styling
        _inProgressFolderPaths = inProgressNow;
        updateInProgressFoldersInTree();
        _updateAutoRefreshTimers();
        
        // Newly-starting items: update the main folder tree after 500ms delay
        for (const p of inProgressNow) {
          if (!prevRunningSet.has(p)) {
            setTimeout(() => {
              try {
                if (!folderTreeRootNode) return;
                updateFolderTreeNode(p);
              } catch (e) { /* ignore */ }
            }, 500);
          }
        }
      } catch (e) { console.warn('[queue] in-progress tracking error:', e); }

      // Remove auto-refresh timers for finished folders
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        const nowDone = new Set(items.filter(i => i.status === 'done').map(i => norm(i.path)));
        for (const p of nowDone) {
          if (_autoRefreshTimers.has(p)) {
            clearInterval(_autoRefreshTimers.get(p));
            _autoRefreshTimers.delete(p);
          }
        }
      } catch (e) { console.warn('[timer] cleanup error:', e); }

      // Update live dialog if open
      if (_liveAnalysisDlgOpen) {
        const runningItem = items.find(i => i.status === 'running') || null;
        updateLiveAnalysisDlg(runningItem || items[items.length - 1] || null);
      }
    }

    // Normalize paths consistently: strip trailing slashes
    function normalizePath(p) {
      if (!p) return '';
      let pp = String(p).trim();
      while (pp && pp[pp.length - 1] in {'\\': 1, '/': 1}) pp = pp.slice(0, -1);
      return pp;
    }

    function startPollingQueue() {
      if (_queuePollingTimer) return;
      startAutoRefresh();

      // Initialize session state by inspecting all folders in the queue
      // This gives us TRUE baselines for accurate ETA calculations
      (async () => {
        try {
          const status = await apiGetQueueStatus();
          if (status && status.items && status.items.length > 0) {
            // Batch-inspect all folders to get true processed/total counts
            const paths = status.items.map(item => item.path);
            if (hasPywebviewApi && window.pywebview?.api?.inspect_folders) {
              try {
                const inspectRes = await window.pywebview.api.inspect_folders(paths);
                if (inspectRes && inspectRes.success && inspectRes.results) {
                  for (const [path, info] of Object.entries(inspectRes.results)) {
                    if (info) {
                      const normPath = normalizePath(path);
                      _queueFolderInspections.set(normPath, info);
                      const initialProcessed = info.processed || 0;
                      const totalImages = info.total || 0;
                      const toAnalyze = Math.max(0, totalImages - initialProcessed);
                      _queueSessionStartState.set(normPath, {
                        initialProcessed,
                        totalImages,
                        toAnalyze
                      });
                    }
                  }
                }
              } catch (e) { /* ignore */ }
            }
          }
        } catch (e) { /* ignore */ }
      })();

      // Poll more frequently to reflect per-image progress (500ms)
      _queuePollingTimer = setInterval(async () => {
        try {
          const status = await apiGetQueueStatus();
          renderQueuePanel(status);
          // Update auto-refresh timers based on pause state
          _updateAutoRefreshTimers();

          // When new items appear, inspect and capture their baseline state
          if (status && status.items) {
            const newPaths = [];
            for (const item of status.items) {
              const normPath = normalizePath(item.path);
              if (!_queueSessionStartState.has(normPath)) {
                newPaths.push(item.path);
              }
            }
            if (newPaths.length > 0 && hasPywebviewApi && window.pywebview?.api?.inspect_folders) {
              try {
                const inspectRes = await window.pywebview.api.inspect_folders(newPaths);
                if (inspectRes && inspectRes.success && inspectRes.results) {
                  for (const [path, info] of Object.entries(inspectRes.results)) {
                    if (info) {
                      const normPath = normalizePath(path);
                      _queueFolderInspections.set(normPath, info);
                      const initialProcessed = info.processed || 0;
                      const totalImages = info.total || 0;
                      const toAnalyze = Math.max(0, totalImages - initialProcessed);
                      _queueSessionStartState.set(normPath, {
                        initialProcessed,
                        totalImages,
                        toAnalyze
                      });
                    }
                  }
                }
              } catch (e) { /* ignore */ }
            }
          }

          if (!status.running && (status.items || []).every(i => i.status !== 'pending' && i.status !== 'running')) {
            stopPollingQueue();
          }
        } catch (_) { }
      }, 500);
    }

    function stopPollingQueue() {
      if (_queuePollingTimer) { clearInterval(_queuePollingTimer); _queuePollingTimer = null; }
      stopAutoRefresh();
      // Cleanup auto-refresh timers for in-progress folders
      for (const timerId of _autoRefreshTimers.values()) {
        clearInterval(timerId);
      }
      _autoRefreshTimers.clear();
      _inProgressFolderPaths.clear();
      // Cleanup session state
      _queueSessionStartState.clear();
      _queueFolderInspections.clear();
      _etaSmoothed = null;
      _etaLastPath = null;
    }

    // Poll the queue status frequently and update folder rows in the ANALYZE DIALOG ONLY
    // with the running item's processed/total. This keeps per-folder counts live
    // while analysis is in progress.
    function startQueueCountsPoll() {
      if (_queueCountsTimer) return;
      _queueCountsTimer = setInterval(async () => {
        try {
          const status = await apiGetQueueStatus();
          if (!status || !status.items) return;
          const items = status.items;
          // Normalize helper
          const norm = p => (p || '').replace(/\\/g, '/');
          // Update ONLY the Analyze dialog tree rows (not the main folder tree)
          const rows = Array.from(document.querySelectorAll('#analyzeDlgTree .adlg-node-row'));
          for (const it of items) {
            const ip = norm(it.path);
            const related = rows.filter(r => norm(r.dataset.path) === ip);
            for (const row of related) {
              const span = row.querySelector('.tree-count');
              if (span) {
                if (it.total && it.total > 0) span.textContent = ` ${it.processed}/${it.total}`;
                else span.textContent = '';
              }
              // Update analysis classes (partial/full/none) - only for analyze dialog
              row.classList.remove('analyzed-full', 'analyzed-partial', 'analyzed-none');
              if (it.total && it.total > 0) {
                if ((it.processed || 0) === 0) row.classList.add('analyzed-none');
                else if ((it.processed || 0) >= it.total) row.classList.add('analyzed-full');
                else row.classList.add('analyzed-partial');
              }
            }
          }
          // Stop polling if queue no longer running
          if (!status.running) stopQueueCountsPoll();
        } catch (_) { }
      }, 500);
    }

    function stopQueueCountsPoll() {
      if (_queueCountsTimer) { clearInterval(_queueCountsTimer); _queueCountsTimer = null; }
    }

    // ── Live Analysis Details dialog ──────────────────────────────────────────

    function openLiveAnalysisDlg() {
      _liveAnalysisDlgOpen = true;
      document.getElementById('liveAnalysisDlg').showModal();
    }

    /**
     * Load an image by relative path + root into an <img> element, using _thumbCache.
     * Only issues a network/IPC call on cache miss.
     */
    async function _loadImg(imgEl, relPath, rootPath) {
      if (!relPath || !rootPath || !hasPywebviewApi) return;
      const key = relPath + '|' + rootPath;
      const isLive = String(relPath).indexOf('__live_') >= 0;
      if (!isLive && _thumbCache.has(key)) { imgEl.src = _thumbCache.get(key); return; }
      try {
        const r = await window.pywebview.api.read_image_file(relPath, rootPath);
        if (r && r.success && r.data) {
          const url = _base64ToBlobUrl(r.data, r.mime);
          if (!isLive) _thumbCache.set(key, url);
          imgEl.src = url;
        }
      } catch (_) { }
    }

    /** Update the live dialog with data from a running (or recently-finished) queue item. */
    function updateLiveAnalysisDlg(item) {
      const dlg = document.getElementById('liveAnalysisDlg');
      if (!dlg || !dlg.open) { _liveAnalysisDlgOpen = false; return; }

      // Header
      const folderEl = document.getElementById('liveDlgFolderName');
      const fnameEl = document.getElementById('liveDlgFilename');
      const statusEl = document.getElementById('liveDlgStatus');
      if (folderEl) folderEl.textContent = item ? item.name : '–';
      if (fnameEl) fnameEl.textContent = item ? (item.current_filename || '') : '';
      if (statusEl) {
        const msg = item ? (item.current_status_msg || '') : '';
        const paused = item && item.is_paused;
        statusEl.textContent = paused ? '⏸ Paused — ' + msg : msg;
      }

      if (!item) return;

      // Thumbnail
      const thumbEl = document.getElementById('liveDlgThumb');
      if (thumbEl && item.current_export_path) {
        const k = item.current_export_path + '|' + item.path;
        if (_liveLastThumbKey !== k) { _liveLastThumbKey = k; _loadImg(thumbEl, item.current_export_path, item.path); }
      }

      // Detection overlay
      const overlayEl = document.getElementById('liveDlgOverlay');
      if (overlayEl) {
        if (item.current_overlay_rel) {
          const k = item.current_overlay_rel + '|' + item.path;
          // Always reload live overlay images (they are overwritten in place).
          const isLiveOverlay = String(item.current_overlay_rel).indexOf('__live_') >= 0;
          if (isLiveOverlay) {
            _liveLastOverlayKey = k + '|' + Date.now();
            _loadImg(overlayEl, item.current_overlay_rel, item.path);
          } else if (_liveLastOverlayKey !== k) {
            _liveLastOverlayKey = k; _loadImg(overlayEl, item.current_overlay_rel, item.path);
          }
          overlayEl.style.visibility = '';
        } else {
          overlayEl.style.visibility = 'hidden';
        }
      }

      // Crop cards
      _updateLiveCropCards(item);
    }

    function _formatStars(rating) {
      const r = Math.max(0, Math.min(5, Math.round(rating || 0)));
      return '★'.repeat(r) + '☆'.repeat(5 - r);
    }

    function _rawQualityToRating(quality) {
      const q = Number(quality);
      if (!Number.isFinite(q) || q < 0) return 0;
      if (q < 0.15) return 1;
      if (q < 0.3) return 2;
      if (q < 0.6) return 3;
      if (q < 0.9) return 4;
      return 5;
    }

    function _updateLiveCropCards(item) {
      const row = document.getElementById('liveDlgCrops');
      if (!row) return;
      const crops = item.current_crops_rel || [];
      const dets = item.current_detections || [];
      const quality = item.current_quality_results || [];
      const species = item.current_species_results || [];

      // Ensure exactly 5 card elements exist
      while (row.children.length < 5) {
        const card = document.createElement('div');
        card.className = 'live-dlg-crop-card';
        card.innerHTML = `
        <img class="live-dlg-crop-img" alt="" />
        <div class="ldc-conf">–</div>
        <div class="ldc-quality">Quality: —</div>
        <div class="ldc-stars">☆☆☆☆☆</div>
        <div class="ldc-species">–</div>
        <div class="ldc-family">–</div>`;
        row.appendChild(card);
      }

      for (let i = 0; i < 5; i++) {
        const card = row.children[i];
        const imgEl = card.querySelector('.live-dlg-crop-img');
        const confEl = card.querySelector('.ldc-conf');
        const qualityEl = card.querySelector('.ldc-quality');
        const starsEl = card.querySelector('.ldc-stars');
        const spEl = card.querySelector('.ldc-species');
        const fmEl = card.querySelector('.ldc-family');
        const hasCrop = i < crops.length && crops[i];

        card.style.opacity = hasCrop ? '1' : '0.3';

        if (hasCrop) {
          const k = crops[i] + '|' + item.path;
          const prev = _liveLastCropKeys[i] || '';
          const isLiveCrop = String(crops[i]).indexOf('__live_') >= 0;
          if (isLiveCrop) {
            _liveLastCropKeys[i] = k + '|' + Date.now();
            _loadImg(imgEl, crops[i], item.path);
          } else if (prev !== k) { _liveLastCropKeys[i] = k; _loadImg(imgEl, crops[i], item.path); }
        } else {
          if (imgEl.src) imgEl.removeAttribute('src');
          _liveLastCropKeys[i] = '';
          confEl.textContent = '–';
          qualityEl.textContent = 'Quality: —';
          starsEl.textContent = '☆☆☆☆☆';
          spEl.textContent = '–'; spEl.className = 'ldc-species';
          fmEl.textContent = '–'; fmEl.className = 'ldc-family';
          continue;
        }

        // Detection confidence
        confEl.textContent = i < dets.length
          ? `Conf: ${dets[i].confidence.toFixed(2)}`
          : '–';

        const qVal = i < quality.length ? Number(quality[i].quality) : NaN;
        if (Number.isFinite(qVal) && qVal >= 0) {
          qualityEl.textContent = `Quality: ${qVal.toFixed(3)}`;
        } else {
          qualityEl.textContent = i < crops.length ? 'Quality: …' : 'Quality: —';
        }

        // Live dialog intentionally uses raw quality thresholds (not normalized ratings).
        const rawRating = Number.isFinite(qVal) ? _rawQualityToRating(qVal) : 0;
        starsEl.textContent = i < quality.length
          ? _formatStars(rawRating)
          : (i < crops.length ? '…' : '☆☆☆☆☆');

        // Species
        if (i < species.length) {
          const sp = species[i];
          const spConf = sp.species_confidence ?? 0;
          const fmConf = sp.family_confidence ?? 0;
          spEl.textContent = `${sp.species || '–'} (${spConf.toFixed(2)})`;
          spEl.className = 'ldc-species ' + (spConf >= CONF_HIGH ? 'high-conf' : spConf < CONF_LOW ? 'low-conf' : '');
          fmEl.textContent = sp.family ? `${sp.family} (${fmConf.toFixed(2)})` : '–';
          fmEl.className = 'ldc-family ' + (fmConf >= CONF_HIGH ? 'high-conf' : fmConf < CONF_LOW ? 'low-conf' : '');
        } else {
          spEl.textContent = i < crops.length ? 'Classifying…' : '–';
          spEl.className = i < crops.length ? 'ldc-species low-conf' : 'ldc-species';
          fmEl.textContent = '–'; fmEl.className = 'ldc-family';
        }
      }
    }

    // ── End Live Analysis Dialog ─────────────────────────────────────────────────

    // ── Auto-refresh: silently reload CSV data for newly-analyzed folders ─────────

    let _autoRefreshTimer = null;
    let _autoRefreshPendingPaths = new Set(); // paths that need a quiet reload

    /** Queue a silent reload for `path` (called when a queue item becomes done). */
    function scheduleAutoRefresh(path) {
      _autoRefreshPendingPaths.add(path);
    }

    function startAutoRefresh() {
      if (_autoRefreshTimer) return;
      _autoRefreshTimer = setInterval(silentRefreshPending, 7000);
    }

    function stopAutoRefresh() {
      if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
    }

    /** Silently reload CSV data for any paths in _autoRefreshPendingPaths that are checked. */
    async function silentRefreshPending() {
      if (_autoRefreshPendingPaths.size === 0) return;
      const toRefresh = Array.from(_autoRefreshPendingPaths).filter(p => checkedFolderPaths.has(p));
      _autoRefreshPendingPaths.clear();
      if (toRefresh.length === 0) return;

      let changed = false;
      for (const p of toRefresh) {
        try {
          if (!hasPywebviewApi || !window.pywebview?.api?.read_kestrel_csv) continue;
          const result = await window.pywebview.api.read_kestrel_csv(p);
          if (!result.success) continue;
          const parsed = Papa.parse(result.data, { header: true, skipEmptyLines: true });
          const newRows = parsed.data || [];
          const newFields = parsed.meta.fields || [];
          const root = result.root || p;
          // Merge header fields
          for (const f of newFields) if (!header.includes(f)) header.push(f);
          // Find existing slot or create new one
          const sample = rows.find(r => r.__rootPath === root);
          const slot = sample ? sample.__folderSlot : rows.length;
          // Replace rows for this root path
          rows = rows.filter(r => r.__rootPath !== root);
          for (const r of newRows) { r.__rootPath = root; r.__folderSlot = slot; }
          rows = rows.concat(newRows);
          // Reload scenedata for this root
          if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
            try {
              const sdRes = await window.pywebview.api.read_kestrel_scenedata(root);
              if (sdRes?.success) _scenedata[root] = sdRes.data;
            } catch (_) {}
          }
          // Apply normalization for newly-loaded rows
          if (hasPywebviewApi && window.pywebview?.api?.apply_normalization) {
            try {
              const normRes = await window.pywebview.api.apply_normalization(root);
              if (normRes?.success && normRes?.normalized_ratings) {
                const mapping = normRes.normalized_ratings;
                for (const r of newRows) {
                  if (r.filename in mapping) r.__normalized_rating = mapping[r.filename];
                }
              }
            } catch (_) {}
          }
          changed = true;
        } catch (e) {
          console.warn('[autorefresh]', p, e);
        }
      }

      if (changed) {
        ensureSceneNameColumn();        ensureRatingColumns();        await renderScenes();
        setStatus(`Auto-refreshed ${toRefresh.length} newly-analyzed folder(s)`);
      }
    }

    /** Re-scan the folder tree root without resetting the expanded/checked state. */
    async function rescanFolderTree(rootPath) {
      if (!hasPywebviewApi || !window.pywebview?.api?.list_subfolders) return;
      try {
        const depth = getSetting('treeScanDepth', 3);
        const result = await window.pywebview.api.list_subfolders(rootPath, depth);
        if (!result.success) return;
        folderTreeData = result.tree;
        folderTreeRootHasKestrel = !!result.root_has_kestrel;
        const rootName = rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rootPath;
        folderTreeRootNode = { name: rootName, path: rootPath, has_kestrel: folderTreeRootHasKestrel, children: folderTreeData };
        // Apply any transient kestrel markings so nodes recently queued/started
        // are shown as having kestrel until the real scan state differs.
        try {
          const norm = p => (p || '').replace(/\\/g, '/');
          function applyTemp(n) {
            if (!n) return;
            const p = norm(n.path || '');
            if (_tempKestrelPaths.has(p)) n.has_kestrel = true;
            (n.children || []).forEach(c => applyTemp(c));
          }
          applyTemp(folderTreeRootNode);
        } catch (e) { /* ignore */ }
        renderFolderTree();
      } catch (_) { }
    }

    /** Update UI to reflect in-progress folders with special styling and always-present checkboxes. */
    function updateInProgressFoldersInTree() {
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        for (const inProgPath of _inProgressFolderPaths) {
          const normPath = norm(inProgPath);
          const rows = Array.from(document.querySelectorAll('#folderTree .tree-node-row'));
          for (const row of rows) {
            const rp = norm(row.dataset.path || '');
            if (rp !== normPath) continue;
            
            // Mark as in-progress with purple styling
            row.classList.add('in-progress');
            _tempKestrelPaths.add(normPath); // prevent checkbox removal on next rescan
            
            // Ensure checkbox exists (even if .kestrel doesn't)
            if (!row.querySelector('.tree-cb')) {
              const cb = document.createElement('input');
              cb.type = 'checkbox';
              cb.className = 'tree-cb';
              cb.title = 'Include in multi-folder view (analyzing now)';
              cb.checked = checkedFolderPaths.has(row.dataset.path);
              cb.addEventListener('change', (e) => {
                e.stopPropagation();
                if (cb.checked) checkedFolderPaths.add(row.dataset.path);
                else checkedFolderPaths.delete(row.dataset.path);
                _updateAutoRefreshTimers();
                debouncedAutoLoad();
              });
              // Find icon and insert before it
              const icon = row.querySelector('.tree-icon');
              if (icon && icon.parentNode) icon.parentNode.insertBefore(cb, icon);
              else row.insertBefore(cb, row.firstChild);
            }
          }
        }
      } catch (e) { console.warn('[tree] updateInProgressFoldersInTree error:', e); }
    }

    /** Start or stop auto-refresh timers for checked in-progress folders. */
    function _updateAutoRefreshTimers() {
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        const queueStatus = window._lastQueueStatus;
        const isPaused = queueStatus && queueStatus.paused;
        
        // Stop all timers if queue is paused — no need to refresh when nothing is running
        if (isPaused) {
          for (const timerId of _autoRefreshTimers.values()) {
            clearInterval(timerId);
          }
          _autoRefreshTimers.clear();
          return;
        }
        
        // Stop timers for folders that are no longer checked or in-progress
        for (const [path, timerId] of _autoRefreshTimers.entries()) {
          const isStillInProgress = _inProgressFolderPaths.has(path);
          const isStillChecked = checkedFolderPaths.has(path);
          if (!isStillInProgress || !isStillChecked) {
            clearInterval(timerId);
            _autoRefreshTimers.delete(path);
          }
        }
        
        // Start timers for newly-checked in-progress folders (only if queue is running, not paused)
        for (const inProgPath of _inProgressFolderPaths) {
          if (checkedFolderPaths.has(inProgPath) && !_autoRefreshTimers.has(inProgPath)) {
            // Auto-refresh every 10 seconds while folder is in progress and checked
            const timerId = setInterval(async () => {
              try {
                // Reload the data for this folder (debounced to avoid thrashing)
                debouncedAutoLoad();
              } catch (e) { console.warn('[refresh] auto-refresh error:', e); }
            }, 10000);
            _autoRefreshTimers.set(inProgPath, timerId);
          }
        }
      } catch (e) { console.warn('[timer] _updateAutoRefreshTimers error:', e); }
    }

    /** Count how many analyzed (non-in-progress) folders exist in the tree. */
    function countAnalyzedFolders() {
      try {
        let count = 0;
        function traverse(n) {
          if (!n) return;
          if (n.has_kestrel && !_inProgressFolderPaths.has(n.path)) count++;
          (n.children || []).forEach(c => traverse(c));
        }
        traverse(folderTreeRootNode);
        return count;
      } catch (e) { return 0; }
    }

    /** Implement Case 1 logic: if first folder starts analysis and no other analyzed folders exist, auto-load it. */
    async function _handleFirstFolderAnalysisStart(folderPath) {
      try {
        if (!_isFirstQueueStart) return; // only on first start
        _isFirstQueueStart = false;
        
        const analyzedCount = countAnalyzedFolders();
        if (analyzedCount === 0) {
          // Case 1: Auto-check and auto-load the in-progress folder
          checkedFolderPaths.add(folderPath);
          renderFolderTree();
          await debouncedAutoLoad();
          setStatus('Auto-loaded in-progress folder (Case 1: no other analyzed folders)');
        }
      } catch (e) { console.warn('[case1] error:', e); }
    }

    // ── End Analysis Queue ────────────────────────────────────────────────────────

    // Helper function to load folder using native path (for pywebview API)
    // Loads a single folder. For multi-folder loading, see loadMultipleFolders().

    // Auto-load: fires after a short debounce whenever checkboxes change.
    // If nothing is checked, clears the view gracefully.
    const debouncedAutoLoad = debounce(async () => {
      if (checkedFolderPaths.size > 0) {
        await loadMultipleFolders(Array.from(checkedFolderPaths));
      } else {
        ++_loadFoldersVersion; // cancel any in-progress load
        rows = []; header = []; scenes = [];
        sceneGrid.innerHTML = '';
        setStatus('No folders selected — check folders in the tree to load scenes');
      }
    }, 400);

    // Collect all kestrel paths from the tree (recursively) for check-all
    function collectKestrelPaths(node, out = []) {
      if (!node) return out;
      if (node.has_kestrel) out.push(node.path);
      (node.children || []).forEach(c => collectKestrelPaths(c, out));
      return out;
    }

    function checkAllTreeFolders() {
      const all = collectKestrelPaths(folderTreeRootNode);
      all.forEach(p => checkedFolderPaths.add(p));
      renderFolderTree();
      debouncedAutoLoad();
    }

    function checkNoneTreeFolders() {
      checkedFolderPaths.clear();
      renderFolderTree();
      debouncedAutoLoad();
    }

    // Progress bar helpers
    function showProgress(label, pct) {
      const row = document.getElementById('loadProgressRow');
      const lbl = document.getElementById('loadProgressLabel');
      const fill = document.getElementById('loadProgressFill');
      if (row) row.classList.remove('hidden');
      if (lbl) lbl.textContent = label;
      if (fill) fill.style.width = Math.round(Math.max(0, Math.min(100, pct))) + '%';
    }
    function hideProgress() {
      const row = document.getElementById('loadProgressRow');
      if (row) row.classList.add('hidden');
    }

    async function loadMultipleFolders(paths) {
      if (!paths || paths.length === 0) return;
      const myVer = ++_loadFoldersVersion;
      blobUrlCache.clear();
      rows = [];
      header = [];
      let loadedCount = 0;
      let slot = 0;
      const total = paths.length;
      showProgress(`Loading 0 / ${total} folders…`, 0);
      for (let i = 0; i < paths.length; i++) {
        if (myVer !== _loadFoldersVersion) { hideProgress(); return; }
        const p = paths[i];
        const folderName = p.replace(/.*[/\\]/, '');
        showProgress(`Loading ${i + 1} / ${total}: ${folderName}`, (i / total) * 90);
        try {
          const result = await window.pywebview.api.read_kestrel_csv(p);
          if (myVer !== _loadFoldersVersion) { hideProgress(); return; }
          if (!result.success) continue;
          const parsed = Papa.parse(result.data, { header: true, skipEmptyLines: true });
          const newRows = parsed.data || [];
          const newFields = parsed.meta.fields || [];
          for (const f of newFields) if (!header.includes(f)) header.push(f);
          const root = result.root || p;
          const currentSlot = slot++;
          for (const r of newRows) { r.__rootPath = root; r.__folderSlot = currentSlot; }
          rows = rows.concat(newRows);
          // Load scenedata for this folder
          if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
            try {
              const sdRes = await window.pywebview.api.read_kestrel_scenedata(root);
              if (sdRes?.success) _scenedata[root] = sdRes.data;
            } catch (_) {}
          }
          // Apply normalization (in-memory: sets r.__normalized_rating)
          if (hasPywebviewApi && window.pywebview?.api?.apply_normalization) {
            try {
              const normRes = await window.pywebview.api.apply_normalization(root);
              if (normRes?.success && normRes?.normalized_ratings) {
                const mapping = normRes.normalized_ratings;
                for (const r of newRows) {
                  if (r.filename in mapping) r.__normalized_rating = mapping[r.filename];
                }
              }
            } catch (_) {}
          }
          loadedCount++;
        } catch (e) {
          console.warn('[multi] Failed to load', p, e);
        }
      }
      if (myVer !== _loadFoldersVersion) { hideProgress(); return; }
      if (loadedCount === 0) { hideProgress(); setStatus('No folders could be loaded'); return; }
      showProgress(`Building scenes from ${loadedCount} folder${loadedCount === 1 ? '' : 's'}…`, 95);
      // For single-folder image-loading compat: set rootPath to first loaded root.
      // Per-row __rootPath handles multi-folder image loading in getBlobUrlForPath.
      const firstRow = rows.find(r => r.__rootPath);
      if (firstRow) rootPath = firstRow.__rootPath;
      rootDirHandle = null;
      ensureSceneNameColumn();
      ensureRatingColumns();
      dirty = false; _notifyDirty(false);
      takeSnapshot();
      const mergeBtn = document.getElementById('openMerge');
      if (mergeBtn) mergeBtn.disabled = true;
      treeActivePath = paths.length === 1 ? paths[0] : null;
      renderFolderTree();
      await renderScenes();
      showProgress('Done', 100);
      await sleep(400);
      hideProgress();
      const label = loadedCount === 1 ? paths[0].replace(/.*[/\\]/, '') : `${loadedCount} folders`;
      setStatus(`Loaded ${label} — ${rows.length} images`);
    }

    async function loadFolderFromPath(folderPath) {
      if (!folderPath) return;

      try {
        // Use pywebview API to read the CSV file
        const result = await window.pywebview.api.read_kestrel_csv(folderPath);

        if (!result.success) {
          throw new Error(result.error || 'Failed to read CSV');
        }

        // Parse the CSV data
        const parsed = Papa.parse(result.data, { header: true, skipEmptyLines: true });
        header = parsed.meta.fields || [];
        const loadedRoot = result.root || folderPath;
        rows = (parsed.data || []).map(r => ({ ...r, __rootPath: loadedRoot, __folderSlot: 0 }));
        
        // Load scenedata for this folder
        if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
          try {
            const sdRes = await window.pywebview.api.read_kestrel_scenedata(loadedRoot);
            if (sdRes?.success) _scenedata[loadedRoot] = sdRes.data;
          } catch (_) {}
        }
        
        // Apply normalization (in-memory: sets r.__normalized_rating)
        if (hasPywebviewApi && window.pywebview?.api?.apply_normalization) {
          try {
            const normRes = await window.pywebview.api.apply_normalization(loadedRoot);
            if (normRes?.success && normRes?.normalized_ratings) {
              const mapping = normRes.normalized_ratings;
              for (const r of rows) {
                if (r.filename in mapping) r.__normalized_rating = mapping[r.filename];
              }
            }
          } catch (_) {}
        }
        
        ensureSceneNameColumn();
        ensureRatingColumns();
        blobUrlCache.clear(); // new folder — clear stale cache entries

        // IMPORTANT: Set rootPath BEFORE renderScenes so image loading works
        rootPath = loadedRoot;
        rootDirHandle = null; // Clear handle since we're using Python API
        rootIsKestrel = false;

        // Now render with rootPath set
        await renderScenes();

        // Also save in settings for file opening (use rootHint for consistency)
        const settings = loadSettings();
        settings.rootHint = rootPath;
        saveSettings(settings);

        setStatus(`Loaded from: ${result.path}`);
        const mergeBtn = document.getElementById('openMerge');
        if (mergeBtn) mergeBtn.disabled = true; // Can't save in pywebview mode

        // Update active selection in tree if tree is open
        if (folderTreeData) {
          const loadedPath = result.root || folderPath;
          treeActivePath = loadedPath;
          checkedFolderPaths.clear();
          checkedFolderPaths.add(loadedPath);
          renderFolderTree();
        }
      } catch (e) {
        const errorMsg = (e.message || String(e)).replace(/^Error: /, '');
        // If the folder tree is already visible the user may have clicked a parent folder
        // intentionally (no .kestrel there). Show a soft status message instead of an alert.
        if (folderTreeData) {
          setStatus(`No Kestrel database in this folder — select one that shows 📂 in the tree`);
        } else {
          alert(`Could not load Kestrel database from this folder.\n\nMake sure:\n1. The folder has been analyzed with Kestrel Analyzer\n2. The .kestrel folder exists (it may be hidden on macOS)\n3. You selected the correct folder\n\nTip: On macOS, .kestrel folders are hidden by default. You can:\n• Press Cmd+Shift+. (period) to show hidden files in Finder\n• Or select the parent folder that contains the .kestrel folder\n\nError: ${errorMsg}`);
          setStatus('Failed to load database');
        }
      }
    }

    // Event wiring
    el('#pickFolder').addEventListener('click', async () => {
      console.log('[DEBUG] Folder picker clicked');
      console.log('[DEBUG] hasPywebviewApi:', hasPywebviewApi);
      console.log('[DEBUG] window.pywebview:', window.pywebview);
      console.log('[DEBUG] window.pywebview?.api:', window.pywebview?.api);

      // Wait for pywebview API if it's not ready yet
      if (!hasPywebviewApi) {
        console.log('[DEBUG] Waiting for pywebview API...');
        const ready = await waitForPywebview();
        console.log('[DEBUG] Pywebview API ready:', ready);
      }
      // When user opens a folder, reset any checked folders in the main tree
      // (acts like pressing "Check none") so we don't accidentally load
      // folders from a previous root selection.
      try {
        checkedFolderPaths.clear();
        renderFolderTree();
      } catch (e) { /* ignore */ }

      try {
        // PRIORITY 1: Python API (desktop app - all platforms)
        // When available, ALWAYS use this for consistency
        if (hasPywebviewApi && window.pywebview?.api?.choose_directory) {
          console.log('[DEBUG] Using Python API for folder picker');
          try {
            setStatus('Opening folder picker...');
            const folderPath = await window.pywebview.api.choose_directory();
            if (folderPath) {
              // Scan the selected folder as the tree root (user may have picked a parent
              // folder with multiple analyzed sub-folders, or a leaf folder directly).
              treeExpandedPaths.clear();
              const treeScanned = await scanFolderTree(folderPath);
              // Use the root_has_kestrel flag returned directly by scanFolderTree
              // (folderTreeRootHasKestrel is set inside scanFolderTree).
              // Only attempt CSV load if the root itself is an analyzed folder.
              if (treeScanned && !folderTreeRootHasKestrel) {
                // Tree scan succeeded but root has no .kestrel — it's a parent folder.
                setStatus('Select a folder from the tree below to load its scenes');
              } else {
                // Either scan wasn't available, or the root itself has .kestrel — load it.
                await loadFolderFromPath(folderPath);
              }
              return; // Success - Python API handled everything
            } else {
              setStatus('Folder selection cancelled');
              return; // User cancelled
            }
          } catch (e) {
            console.error('Python API folder picker failed:', e);
            alert(`Desktop folder picker failed: ${e.message || e}\n\nPlease restart the application and try again.`);
            setStatus('Folder picker failed');
            return; // Don't fall through - Python API should always work in desktop app
          }
        }

        // PRIORITY 2: File System Access API (browser mode only)
        // This only runs when NOT in pywebview context
        if (supportsFS) {
          // Primary path: pick a folder (root or .kestrel)
          try {
            rootDirHandle = await window.showDirectoryPicker();
            rootIsKestrel = rootDirHandle && rootDirHandle.name === '.kestrel';
            rootPath = ''; // Clear rootPath since we're using handle-based API
            await tryOpenDefaultCsv(rootDirHandle);
            return;
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error('showDirectoryPicker failed:', e);
            }
            // user may have cancelled; fall through to file picker
          }

          // Secondary path: open CSV directly
          try {
            const [fh] = await window.showOpenFilePicker({ types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
            if (!fh) return;
            rootDirHandle = null;
            rootIsKestrel = false;
            rootPath = ''; // Clear rootPath
            await loadCsvFromHandle(fh);
            const mergeBtn = document.getElementById('openMerge');
            if (mergeBtn) mergeBtn.disabled = true;
            setStatus('CSV loaded (limited previews; use folder selection for full features)');
            return;
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error('showOpenFilePicker failed:', e);
            }
            // cancelled
          }
          return;
        }

        // Last resort fallback: file input for CSV only
        setStatus('Opening file picker (limited functionality)...');
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,text/csv';
        rootDirHandle = null;
        rootPath = ''; // Clear both for fallback mode
        input.onchange = async () => {
          const file = input.files[0];
          if (!file) return;
          try {
            const text = await file.text();
            const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
            header = parsed.meta.fields || [];
            rows = parsed.data || [];
            ensureSceneNameColumn();
            ensureRatingColumns();
            await renderScenes();
            setStatus('CSV loaded (limited features - no folder access)');
            alert('CSV loaded successfully.\n\nNote: Image previews and opening files in editors will not work without folder access.\n\nFor full functionality, use the desktop app or a Chromium-based browser (Chrome, Edge, Brave).');
          } catch (e) {
            alert(`Failed to load CSV: ${e.message}`);
            setStatus('CSV load failed');
          }
        };
        input.click();
      } catch (e) {
        console.error('Unexpected error in pickFolder:', e);
        setStatus('An unexpected error occurred');
      }
    });

    el('#saveCsv').addEventListener('click', saveCsv);
    el('#search').addEventListener('input', debounce(() => renderScenes(), 250));
    el('#speciesConf').addEventListener('change', () => renderScenes());
    el('#sortBy').addEventListener('change', () => {
      const s = loadSettings();
      s.sortBy = el('#sortBy').value;
      saveSettings(s);
      renderScenes();
    });

    (function initSortBy() {
      const sortSel = document.getElementById('sortBy');
      if (!sortSel) return;
      try { sortSel.value = getSetting('sortBy', 'captureTime'); } catch { sortSel.value = 'captureTime'; }
    })();

    // Group-by-folder toggle
    (function initGroupByFolder() {
      const t = document.getElementById('groupByFolder');
      if (!t) return;
      try { t.checked = getSetting('groupByFolder', true); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.groupByFolder = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // Group-by-capture-time toggle
    (function initGroupByTime() {
      const t = document.getElementById('groupByTime');
      if (!t) return;
      try { t.checked = getSetting('groupByTime', true); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.groupByTime = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // Scroll position indicator — shows current folder/time-group while scrolling
    (function initScrollPositionIndicator() {
      const mainEl = document.querySelector('main');
      const indicator = document.getElementById('scrollPositionIndicator');
      if (!mainEl || !indicator) return;
      let hideTimer = null;
      mainEl.addEventListener('scroll', () => {
        // Track both folder headers and timeline day banners
        const headers = [...sceneGrid.querySelectorAll('.folder-group-header, .timeline-day-banner')];
        if (!headers.length) { indicator.style.opacity = '0'; return; }
        const mainRect = mainEl.getBoundingClientRect();
        const thresholdY = mainRect.top + mainRect.height * 0.25;
        let bestHeader = null;
        for (const h of headers) {
          const r = h.getBoundingClientRect();
          if (r.top <= thresholdY) bestHeader = h;
          else if (!bestHeader) { bestHeader = h; break; }
        }
        if (!bestHeader) { indicator.style.opacity = '0'; return; }
        const nameEl = bestHeader.querySelector('.folder-group-name');
        const text = nameEl ? nameEl.textContent.trim() : bestHeader.textContent.trim();
        if (!text) { indicator.style.opacity = '0'; return; }
        indicator.textContent = text;
        indicator.style.opacity = '1';
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => { indicator.style.opacity = '0'; }, 1800);
      }, { passive: true });
    })();

    // Multi-select merge action bar
    const selectMergeBtn = document.getElementById('selectMergeBtn');
    if (selectMergeBtn) selectMergeBtn.addEventListener('click', executeSelectionMerge);
    const selectClearBtn = document.getElementById('selectClearBtn');
    if (selectClearBtn) selectClearBtn.addEventListener('click', () => { selectedSceneIds.clear(); _lastSelectedIdx = -1; updateSelectionUI(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && selectedSceneIds.size > 0 && !document.querySelector('dialog[open]')) { selectedSceneIds.clear(); _lastSelectedIdx = -1; updateSelectionUI(); } });
    // Revert button
    const revertBtn = el('#revertCsv');
    if (revertBtn) revertBtn.addEventListener('click', () => {
      if (!_cleanSnapshot) return;
      if (!confirm('Discard all unsaved changes and revert to the last saved state?')) return;
      applySnapshot();
    });

    const zoomInBtn = el('#zoomIn');
    const zoomOutBtn = el('#zoomOut');
    if (zoomInBtn) zoomInBtn.addEventListener('click', () => { uiZoom = Math.min(1.4, uiZoom + 0.1); applyZoom(); });
    if (zoomOutBtn) zoomOutBtn.addEventListener('click', () => { uiZoom = Math.max(0.7, uiZoom - 0.1); applyZoom(); });

    // Initialize toolbar toggle for scene-level manual-rated filter
    (function initScenesManualFilter() {
      const t = document.getElementById('filterScenesManualRated');
      if (!t) return;
      try { t.checked = !!getSetting('onlyManualRatedScenes', false); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.onlyManualRatedScenes = !!t.checked; saveSettings(s);
        renderScenes();
      });
    })();

    // Initialize secondary species/families inclusion toggle
    (function initIncludeSecondary() {
      const t = document.getElementById('includeSecondarySpecies');
      if (!t) return;
      try { t.checked = getSetting('includeSecondarySpecies', false); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.includeSecondarySpecies = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // Merge scenes feature
    function computeAllScenesForMerge() {
      // Group rows by scene_count; keep simple stats and representative
      const groups = new Map();
      for (const r of rows) {
        const id = r.scene_count;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(r);
      }
      const list = [];
      for (const [id, arr] of groups) {
        // pick representative by max quality
        let rep = arr[0];
        for (const r of arr) if (parseNumber(r.quality) > parseNumber(rep.quality)) rep = r;
        const maxQ = Math.max(...arr.map(a => parseNumber(a.quality)));
        const rowRp = arr[0]?.__rootPath || rootPath || '';
        const sdScene = rowRp ? _scenedata[rowRp]?.scenes?.[id] : null;
        const name = sdScene?.name || (arr.find(a => (a.scene_name || '').trim().length)?.scene_name || '').trim();
        list.push({ id, imageCount: arr.length, maxQuality: maxQ, sceneName: name, repPath: (rep.export_path || rep.crop_path || ''), repFilename: rep.filename || '' });
      }
      // Sort numerically by id where possible
      return list.sort((a, b) => parseNumber(a.id) - parseNumber(b.id));
    }

    function openMergeDialog() {
      const dlg = document.getElementById('mergeDlg');
      const listEl = document.getElementById('mergeList');
      const summary = document.getElementById('mergeSummary');
      const applyBtn = document.getElementById('mergeApply');
      const targetInput = document.getElementById('mergeTargetId');
      const modeRadios = Array.from(document.querySelectorAll('input[name="mergeTargetMode"]'));

      const sceneList = computeAllScenesForMerge();
      listEl.innerHTML = '';

      const sel = new Set();

      function updateSummary() {
        const ids = Array.from(sel);
        const n = ids.length;
        const targetMode = modeRadios.find(r => r.checked)?.value || 'min';
        const targetId = targetMode === 'manual' && targetInput.value ? String(targetInput.value) : (n ? String(ids.map(x => parseNumber(x)).sort((a, b) => a - b)[0]) : '');
        const totalImgs = sceneList.filter(s => ids.includes(String(s.id))).reduce((acc, s) => acc + s.imageCount, 0);
        summary.textContent = n < 2 ? 'Select at least two scenes to merge.' : `Merging ${n} scenes into Scene ${targetId} (${totalImgs} images).`;
        applyBtn.disabled = n < 2 || !targetId;
      }

      // Build rows: [thumb] [checkbox + title] [count]
      for (const s of sceneList) {
        const row = document.createElement('div');
        row.style.display = 'contents';

        // Thumb cell
        const cThumb = document.createElement('div');
        const thumb = document.createElement('div'); thumb.className = 'thumb'; thumb.style.aspectRatio = '16/10';
        const img = document.createElement('img'); img.alt = s.repFilename || 'No preview'; img.loading = 'lazy';
        (async () => { const url = await getBlobUrlForPath(s.repPath); if (url) img.src = url; })();
        thumb.appendChild(img); cThumb.appendChild(thumb);

        // Title + checkbox cell
        const cTitle = document.createElement('div');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.id = String(s.id); cb.style.marginRight = '8px';
        cb.addEventListener('change', () => { if (cb.checked) sel.add(cb.dataset.id); else sel.delete(cb.dataset.id); updateSummary(); });
        const title = document.createElement('span'); title.textContent = `Scene ${s.id}${s.sceneName ? ` — ${s.sceneName}` : ''}`; title.title = title.textContent;
        cTitle.appendChild(cb); cTitle.appendChild(title);

        // Count cell
        const cCount = document.createElement('div'); cCount.className = 'muted'; cCount.style.textAlign = 'right'; cCount.textContent = `${s.imageCount} images`;

        row.appendChild(cThumb); row.appendChild(cTitle); row.appendChild(cCount);
        listEl.appendChild(row);
      }

      // Wire radios
      modeRadios.forEach(r => r.onchange = updateSummary);
      targetInput.oninput = updateSummary;

      document.getElementById('mergeCancel').onclick = () => dlg.close();
      document.getElementById('mergeApply').onclick = () => {
        const ids = Array.from(sel).map(String);
        if (ids.length < 2) return;
        const targetMode = modeRadios.find(r => r.checked)?.value || 'min';
        let targetId = targetMode === 'manual' && targetInput.value ? String(targetInput.value) : String(ids.map(x => parseNumber(x)).sort((a, b) => a - b)[0]);
        if (!targetId) return;
        let changed = 0;
        for (const r of rows) {
          const idStr = String(r.scene_count);
          if (ids.includes(idStr) && idStr !== targetId) { r.scene_count = targetId; changed++; }
        }
        // Update scenedata: move filenames from non-target scenes into target scene
        if (hasPywebviewApi && changed > 0) {
          const rowSample = rows.find(r => ids.includes(String(r.scene_count)));
          const rpForMerge = rowSample?.__rootPath || rootPath || '';
          if (rpForMerge) {
            const sd = _initScenedata(rpForMerge);
            const allMovedFiles = new Set();
            for (const id of ids) {
              if (id !== targetId && sd.scenes[id]) {
                for (const f of sd.scenes[id].image_filenames || []) allMovedFiles.add(f);
                delete sd.scenes[id];
              }
            }
            if (!sd.scenes[targetId]) {
              sd.scenes[targetId] = { scene_id: targetId, image_filenames: [], name: '', status: 'pending', user_tags: { species: [], families: [], finalized: false } };
            }
            for (const f of allMovedFiles) {
              if (!sd.scenes[targetId].image_filenames.includes(f)) sd.scenes[targetId].image_filenames.push(f);
            }
          }
        }
        if (changed) { dirty = true; _notifyDirty(true); document.getElementById('saveCsv').disabled = false; setStatus(`Merged scenes into ${targetId}. ${changed} rows updated.`); }
        renderScenes();
        dlg.close();
      };

      updateSummary();
      dlg.showModal();
    }

    // Init
    loadVersionBadge();
    setStatus('Open your photo folder (the one that contains .kestrel) or select kestrel_database.csv');
    hydrateSettingsFromServer();

    // If a queue was running before this page loaded (e.g. page refresh), re-attach the polling
    (async () => {
      try {
        const status = await apiGetQueueStatus();
        if (status && (status.items || []).length > 0) {
          renderQueuePanel(status);
          if (status.running) startPollingQueue();
        }
      } catch (_) { }
    })();

    // Wire "Change root…" button in the tree panel
    const treeChangeRootBtn = document.getElementById('treeChangeRoot');
    if (treeChangeRootBtn) {
      treeChangeRootBtn.addEventListener('click', async () => {
        if (!hasPywebviewApi) { const ready = await waitForPywebview(); if (!ready) return; }
        if (!window.pywebview?.api?.choose_directory) return;
        setStatus('Opening folder picker…');
        const folderPath = await window.pywebview.api.choose_directory();
        if (folderPath) {
          treeExpandedPaths.clear();
          checkedFolderPaths.clear();
          const treeScanned = await scanFolderTree(folderPath);
          if (treeScanned && !folderTreeRootHasKestrel) {
            setStatus('Select a folder from the tree below to load its scenes');
          } else {
            await loadFolderFromPath(folderPath);
          }
        } else {
          setStatus('Folder selection cancelled');
        }
      });
    }

    // Wire "Check all / Check none" buttons
    const treeCheckAllBtn = document.getElementById('treeCheckAll');
    if (treeCheckAllBtn) treeCheckAllBtn.addEventListener('click', checkAllTreeFolders);
    const treeCheckNoneBtn = document.getElementById('treeCheckNone');
    if (treeCheckNoneBtn) treeCheckNoneBtn.addEventListener('click', checkNoneTreeFolders);

    // Wire "Load checked" button (removed from HTML; kept as no-op guard)
    const treeLoadSelectedBtn = document.getElementById('treeLoadSelected');
    if (treeLoadSelectedBtn) {
      treeLoadSelectedBtn.addEventListener('click', async () => {
        if (checkedFolderPaths.size === 0) return;
        await loadMultipleFolders(Array.from(checkedFolderPaths));
      });
    }

    // ── Analysis Queue event wiring ───────────────────────────────────────────────

    // "Analyze Folders…" button opens the dialog
    const analyzeQueueBtn = document.getElementById('analyzeQueueBtn');
    if (analyzeQueueBtn) {
      analyzeQueueBtn.addEventListener('click', openAnalyzeDialog);
    }

    // Analyze dialog Cancel
    const analyzeDlgCancel = document.getElementById('analyzeDlgCancel');
    if (analyzeDlgCancel) {
      analyzeDlgCancel.addEventListener('click', () => {
        // Save the current selection so user can restore it on next dialog open
        if (_dlgSelected && _dlgSelected.size > 0) {
          const s = loadSettings();
          s.lastQueueState = Array.from(_dlgSelected);
          saveSettings(s);
        }
        document.getElementById('analyzeQueueDlg').close();
      });
    }

    // Analyze dialog Add to Queue
    const analyzeDlgAdd = document.getElementById('analyzeDlgAdd');
    if (analyzeDlgAdd) {
      analyzeDlgAdd.addEventListener('click', async () => {
        const paths = Array.from(_dlgSelected);
        if (paths.length === 0) return;
        const useGpu = document.getElementById('analyzeUseGpu')?.checked ?? true;
        const wildlifeEnabled = document.getElementById('analyzeWildlife')?.checked ?? false;

        // Check for outdated-version folders not already confirmed for re-analysis
        const outdatedPaths = [];
        function findNode(node, targetPath) {
          if (node.path === targetPath) return node;
          if (node.children) {
            for (const c of node.children) {
              const found = findNode(c, targetPath);
              if (found) return found;
            }
          }
          return null;
        }
        for (const p of paths) {
          if (_dlgReanalyze.has(p)) continue; // already confirmed at selection time
          const node = folderTreeRootNode ? findNode(folderTreeRootNode, p) : null;
          if (node && isVersionOutdated(node)) {
            outdatedPaths.push({ path: p, name: node.name, version: node.kestrel_version });
          }
        }

        if (outdatedPaths.length > 0) {
          const names = outdatedPaths.map(o => `  • ${o.name} (v${o.version})`).join('\n');
          const confirmed = confirm(
            `The following folder(s) were analyzed on an older version of Kestrel:\n\n${names}\n\n` +
            `Current version: v${_appVersion}\n\n` +
            `Re-analyzing will DELETE existing analysis data (.kestrel folder) before proceeding.\n\n` +
            `Continue?`
          );
          if (!confirmed) return;
          // Clear .kestrel for outdated folders before re-analysis
          for (const o of outdatedPaths) {
            try {
              await window.pywebview.api.clear_kestrel_data(o.path);
              // Update in-memory node
              const node = findNode(folderTreeRootNode, o.path);
              if (node) { node.has_kestrel = false; node.kestrel_version = ''; }
            } catch (e) {
              console.warn('Failed to clear kestrel data for', o.path, e);
            }
          }
        }

        // Clear .kestrel for fully-analyzed re-queue folders (confirmed at selection time)
        for (const p of _dlgReanalyze) {
          if (!paths.includes(p)) continue;
          try {
            await window.pywebview.api.clear_kestrel_data(p);
            const node = folderTreeRootNode ? findNode(folderTreeRootNode, p) : null;
            if (node) { node.has_kestrel = false; node.kestrel_version = ''; }
          } catch (e) {
            console.warn('Failed to clear kestrel data for re-analyze', p, e);
          }
        }

        document.getElementById('analyzeQueueDlg').close();
        analyzeDlgAdd.disabled = true;
        try {
          // Show loading overlay while analyzer imports models (lazy-load)
          showLoadingAnalyzer();
          const result = await apiStartQueue(paths, useGpu, wildlifeEnabled);
          if (result && result.success) {
            queuedFolderPaths.clear();
            _dlgSelected.clear();
            _isFirstQueueStart = true; // reset for Case 1 logic on next queue start
            // Clear saved queue state since we're starting a new queue
            const s = loadSettings();
            delete s.lastQueueState;
            saveSettings(s);
            // Clear session state for new queue start, so ETA calculations use fresh folder inspections
            _queueSessionStartState.clear();
            _queueFolderInspections.clear();
            startPollingQueue();
            const status = await apiGetQueueStatus();
            renderQueuePanel(status);
            setStatus(`Analysis queue started — ${result.added || paths.length} folder(s) queued`);
            // Start polling; renderQueuePanel will hide the loader when processing begins.
            // As a safety, hide the loader after 30s if nothing starts.
            setTimeout(() => { try { hideLoadingAnalyzer(); } catch (e) { } }, 30000);
          } else {
            hideLoadingAnalyzer();
            alert('Failed to start analysis queue:\n\n' + (result?.error || 'Unknown error'));
          }
        } catch (e) {
          hideLoadingAnalyzer();
          alert('Failed to start analysis queue:\n\n' + (e.message || e));
        } finally {
          analyzeDlgAdd.disabled = false;
        }
      });
    }

    // Analyze dialog: Change Folder button
    document.getElementById('analyzeDlgChangeRoot')?.addEventListener('click', async () => {
      if (!hasPywebviewApi) { alert('Directory browsing is only available in the desktop app.'); return; }
      const fp = await window.pywebview.api.choose_directory();
      if (!fp) return;
      await scanFolderTree(fp);
      if (!folderTreeRootNode) return;
      _dlgExpandedPaths = new Set([folderTreeRootNode.path]);
      _dlgSelected.clear();
      function refreshDlg2() {
        const countEl = document.getElementById('analyzeDlgCount');
        const addBtn = document.getElementById('analyzeDlgAdd');
        if (countEl) countEl.textContent = _dlgSelected.size + ' folder' + (_dlgSelected.size === 1 ? '' : 's') + ' selected';
        if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
        _refreshAnalyzeDlgQueuePreview();
      }
      const treeEl = document.getElementById('analyzeDlgTree');
      treeEl.innerHTML = '';
      treeEl.appendChild(buildAnalyzeDlgNode(folderTreeRootNode, _dlgSelected, refreshDlg2));
      populateAnalyzeFolderCounts();
      refreshDlg2();
    });

    // ── Welcome Panel action wiring ──────────────────────────────────────────────

    // ── Legal Agreement Logic ──────────────────────────────────────────────
    async function checkLegalAgreement() {
      if (!hasPywebviewApi || !window.pywebview?.api?.get_legal_status) return;
      try {
        const status = await window.pywebview.api.get_legal_status();
        if (!status.agreed) {
          document.getElementById('legalNotice')?.classList.remove('hidden');
        }
      } catch (e) {
        console.error('Failed to check legal status', e);
      }
    }

    const legalAgreeBtn = document.getElementById('legalAgreeBtn');
    if (legalAgreeBtn) {
      legalAgreeBtn.addEventListener('click', async () => {
        try {
          if (hasPywebviewApi && window.pywebview?.api?.agree_to_legal) {
            await window.pywebview.api.agree_to_legal();
            document.getElementById('legalNotice').classList.add('hidden');
            showToast('Terms accepted. Welcome to Project Kestrel!', 4000);
          }
        } catch (e) {
          console.error('Failed to agree to legal terms', e);
        }
      });
    }

    // Initial checks
    if (hasPywebviewApi) {
      checkLegalAgreement();
    }

    // Queue panel header: toggle expand / collapse
    const queuePanelHeader = document.getElementById('queuePanelHeader');
    if (queuePanelHeader) {
      queuePanelHeader.addEventListener('click', () => {
        _queuePanelExpanded = !_queuePanelExpanded;
        const toggle = document.getElementById('queuePanelToggle');
        const body = document.getElementById('queuePanelBody');
        const controls = document.getElementById('queuePanelControls');
        if (toggle) toggle.classList.toggle('open', _queuePanelExpanded);
        if (body) body.classList.toggle('hidden', !_queuePanelExpanded);
        if (controls) controls.classList.toggle('hidden', !_queuePanelExpanded);
      });
    }

    // Pause / Resume button
    const queuePauseBtn = document.getElementById('queuePauseBtn');
    if (queuePauseBtn) {
      queuePauseBtn.addEventListener('click', async () => {
        try {
          const status = await apiGetQueueStatus();
          if (status.paused) {
            // When resuming, re-inspect folders to get accurate baselines
            if (status.items && status.items.length > 0 && hasPywebviewApi && window.pywebview?.api?.inspect_folders) {
              try {
                const paths = status.items.map(item => item.path);
                const inspectRes = await window.pywebview.api.inspect_folders(paths);
                if (inspectRes && inspectRes.success && inspectRes.results) {
                  for (const [path, info] of Object.entries(inspectRes.results)) {
                    if (info) {
                      const initialProcessed = info.processed || 0;
                      const totalImages = info.total || 0;
                      const toAnalyze = Math.max(0, totalImages - initialProcessed);
                      _queueSessionStartState.set(path, {
                        initialProcessed,
                        totalImages,
                        toAnalyze
                      });
                    }
                  }
                }
              } catch (e) { /* ignore */ }
            }
            await apiQueueControl('resume');
          } else {
            await apiQueueControl('pause');
          }
        } catch (_) { }
      });
    }

    // Cancel button
    const queueCancelBtn = document.getElementById('queueCancelBtn');
    if (queueCancelBtn) {
      queueCancelBtn.addEventListener('click', async () => {
        if (!confirm('Cancel the analysis queue? Pending folders will not be analyzed.')) return;
        try { await apiQueueControl('cancel'); } catch (_) { }
      });
    }

    // Clear done button
    const queueClearBtn = document.getElementById('queueClearBtn');
    if (queueClearBtn) {
      queueClearBtn.addEventListener('click', async () => {
        try {
          await apiQueueControl('clear');
          const status = await apiGetQueueStatus();
          if (!(status.items || []).some(i => i.status === 'pending' || i.status === 'running')) {
            document.getElementById('queuePanel')?.classList.add('hidden');
            stopPollingQueue();
          } else {
            renderQueuePanel(status);
          }
        } catch (_) { }
      });
    }

    // ---- Culling Assistant launcher ----
    async function openCullingAssistant(rootPath) {
      if (!window.pywebview?.api) {
        showToast('Culling Assistant requires desktop mode', 4000);
        return;
      }
      // Prompt to save unsaved changes before opening (using custom dialog)
      if (dirty) {
        const userChoice = await showCullingAssistantPrompt();
        if (userChoice === 'cancel') {
          return;
        }
        if (userChoice === 'save') {
          await saveCsv();
        }
      }
      try {
        showToast('Opening Culling Assistant...', 2000);
        const res = await window.pywebview.api.open_culling_window(rootPath);
        if (res && !res.success) {
          showToast('Failed to open Culling Assistant: ' + (res.error || 'Unknown error'), 5000);
        }
      } catch (e) {
        console.error('openCullingAssistant error', e);
        showToast('Error opening Culling Assistant', 4000);
      }
    }
    
    // Custom dialog prompt for Culling Assistant save decision
    function showCullingAssistantPrompt() {
      return new Promise((resolve) => {
        const dlg = document.createElement('dialog');
        dlg.style.cssText = 'border:none;border-radius:8px;background:#1a1d28;color:#e8f0f8;font-family:inherit;padding:0;max-width:450px;box-shadow:0 8px 32px rgba(0,0,0,0.3)';
        
        const content = document.createElement('div');
        content.style.cssText = 'padding:24px;display:flex;flex-direction:column;gap:16px';
        
        const msg = document.createElement('div');
        msg.style.cssText = 'font-size:16px;font-weight:500;line-height:1.4';
        msg.textContent = 'You have unsaved changes. What would you like to do?';
        content.appendChild(msg);
        
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = 'display:flex;gap:8px;justify-content:flex-end';
        
        const btnCancel = document.createElement('button');
        btnCancel.style.cssText = 'padding:8px 16px;border:1px solid #444;border-radius:4px;background:#2d3142;color:#e8f0f8;cursor:pointer;font-size:14px;transition:background 0.2s';
        btnCancel.textContent = 'Cancel';
        btnCancel.addEventListener('click', () => { dlg.close(); document.body.removeChild(dlg); resolve('cancel'); });
        btnContainer.appendChild(btnCancel);
        
        const btnDontSave = document.createElement('button');
        btnDontSave.style.cssText = 'padding:8px 16px;border:1px solid #444;border-radius:4px;background:#2d3142;color:#e8f0f8;cursor:pointer;font-size:14px;transition:background 0.2s';
        btnDontSave.textContent = 'Don\'t Save';
        btnDontSave.addEventListener('click', () => { dlg.close(); document.body.removeChild(dlg); resolve('dontsave'); });
        btnContainer.appendChild(btnDontSave);
        
        const btnSave = document.createElement('button');
        btnSave.style.cssText = 'padding:8px 16px;border:1px solid #5a9fd4;border-radius:4px;background:#3d5a7e;color:#e8f0f8;cursor:pointer;font-size:14px;font-weight:500;transition:background 0.2s';
        btnSave.textContent = 'Save Changes';
        btnSave.addEventListener('click', () => { dlg.close(); document.body.removeChild(dlg); resolve('save'); });
        btnContainer.appendChild(btnSave);
        
        content.appendChild(btnContainer);
        dlg.appendChild(content);
        
        dlg.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { 
            e.preventDefault(); 
            dlg.close(); 
            document.body.removeChild(dlg); 
            resolve('cancel');
          }
        });
        
        document.body.appendChild(dlg);
        dlg.showModal();
      });
    }

    function resetFolderCullState(rootPath, mode) {
      let changed = 0;
      for (const r of rows) {
        if (r.__rootPath !== rootPath) continue;
        const origin = normalizeCullOrigin(r);
        const isResetAll = mode === 'all' && (origin === 'manual' || origin === 'verified');
        const isResetVerified = mode === 'verified' && origin === 'verified';
        if (!isResetAll && !isResetVerified) continue;
        if (r.culled || r.culled_origin) {
          r.culled = '';
          r.culled_origin = '';
          changed++;
        }
      }
      if (changed > 0) {
        markDirty();
        renderScenes();
        if (currentSceneId != null && _currentScene) {
          const refreshed = reloadScene(currentSceneId);
          if (refreshed) {
            _currentScene = refreshed;
            renderFilmstrip(refreshed);
            selectFilmstripImage(Math.min(currentImageIndex, Math.max(0, refreshed.images.length - 1)), refreshed);
          }
        }
      }
      return changed;
    }

    function showFolderOptionsDialog(folderPath) {
      const folderName = folderBaseName(folderPath) || folderPath || 'folder';
      const dlg = document.createElement('dialog');
      dlg.style.cssText = [
        'border:1px solid #303a52',
        'border-radius:12px',
        'background:#141a24',
        'color:#e8f0f8',
        'padding:0',
        'min-width:440px',
        'max-width:540px',
        'width:90vw',
        'max-height:80vh',
        'overflow-y:auto',
        'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
      ].join(';');

      dlg.innerHTML = `
        <div style="padding:20px 22px 14px;border-bottom:1px solid #222e45;">
          <div style="font-size:17px;font-weight:700;margin-bottom:4px;">Folder Options</div>
          <div style="color:#7a90b8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(folderPath)}">${escapeHtml(folderName)}</div>
        </div>

        <div style="padding:14px 22px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#5a7099;margin-bottom:10px;">Reset Cull Categories</div>

          <div class="folder-opt-card" id="folderOptCardVerified" style="
            display:flex;align-items:flex-start;gap:12px;padding:12px 14px;
            border:1px solid #263045;border-radius:8px;background:#1a2235;
            cursor:pointer;margin-bottom:8px;transition:border-color 0.15s,background 0.15s;">
            <div style="margin-top:2px;font-size:16px;line-height:1;">↺</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;">Reset Confirmed Categories</div>
              <div style="font-size:12px;color:#7a90b8;line-height:1.45;">Clears only categorizations that were <em>Confirmed</em> via the Culling Assistant's finalize step. Manual (user-assigned) categorizations are kept.</div>
            </div>
          </div>

          <div class="folder-opt-card" id="folderOptCardAll" style="
            display:flex;align-items:flex-start;gap:12px;padding:12px 14px;
            border:1px solid #3f2020;border-radius:8px;background:#2a1a1a;
            cursor:pointer;margin-bottom:0;transition:border-color 0.15s,background 0.15s;">
            <div style="margin-top:2px;font-size:16px;line-height:1;color:#ff8888;">⊘</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;color:#ffc8c8;">Reset All Categories</div>
              <div style="font-size:12px;color:#b07878;line-height:1.45;">Clears <strong style="color:#ffaaaa">all</strong> manual and confirmed categorizations for this folder, returning every image to Undecided. Auto-categorized categories are unaffected.</div>
            </div>
          </div>
        </div>

        <div style="padding:10px 22px 18px;display:flex;justify-content:flex-end;border-top:1px solid #1a2235;margin-top:4px;">
          <button id="folderOptCancel" style="padding:8px 16px;border:1px solid #3a465f;background:#1c2433;color:#e8f0f8;border-radius:6px;cursor:pointer;font-size:13px;">Close</button>
        </div>
      `;
      document.body.appendChild(dlg);

      const closeAndRemove = () => {
        dlg.close();
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      };

      dlg.querySelector('#folderOptCancel').addEventListener('click', closeAndRemove);

      const cardVerified = dlg.querySelector('#folderOptCardVerified');
      cardVerified.addEventListener('mouseenter', () => { cardVerified.style.borderColor = '#4d6a9a'; cardVerified.style.background = '#1e2a40'; });
      cardVerified.addEventListener('mouseleave', () => { cardVerified.style.borderColor = '#263045'; cardVerified.style.background = '#1a2235'; });
      cardVerified.addEventListener('click', () => {
        const changed = resetFolderCullState(folderPath, 'verified');
        showToast(changed > 0 ? `Reset ${changed} confirmed categorization${changed === 1 ? '' : 's'}` : 'No confirmed categorizations to reset', 3000);
        closeAndRemove();
      });

      const cardAll = dlg.querySelector('#folderOptCardAll');
      cardAll.addEventListener('mouseenter', () => { cardAll.style.borderColor = '#7f3f3f'; cardAll.style.background = '#361818'; });
      cardAll.addEventListener('mouseleave', () => { cardAll.style.borderColor = '#3f2020'; cardAll.style.background = '#2a1a1a'; });
      cardAll.addEventListener('click', () => {
        const ok = confirm(`Reset ALL manual and confirmed cull categorizations for "${folderName}"?\n\nThis cannot be undone.`);
        if (!ok) return;
        const changed = resetFolderCullState(folderPath, 'all');
        showToast(changed > 0 ? `Reset ${changed} manual/confirmed categorization${changed === 1 ? '' : 's'}` : 'No manual or confirmed categorizations to reset', 3000);
        closeAndRemove();
      });

      dlg.addEventListener('close', () => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); });
      dlg.showModal();
    }

    // ---- Write Metadata launcher ----
    async function writeMetadataForFolder(rootPath) {
      if (!window.pywebview?.api) {
        showToast('Write Metadata requires desktop mode', 4000);
        return;
      }
      try {
        const folderRows = rows.filter(r => r.__rootPath === rootPath);
        if (!folderRows.length) {
          showToast('No images found for this folder', 3000);
          return;
        }
        const payload = folderRows.map(r => ({
          filename: r.filename,
          rating: getRating(r),
          culled: getRawCullStatus(r),
          culled_origin: normalizeCullOrigin(r),
          species: r.species || '',
          family: r.family || '',
          quality: r.quality != null ? r.quality : null,
        }));

        showToast('Writing XMP metadata\u2026', 2000);
        const res = await window.pywebview.api.write_xmp_metadata(rootPath, payload, false, false);
        if (!res.success) {
          showToast('Write Metadata failed: ' + (res.error || 'Unknown error'), 5000);
          return;
        }
        if (res.skipped_conflicts && res.skipped_conflicts.length > 0) {
          const n = res.skipped_conflicts.length;
          const ok = confirm(
            `${n} existing XMP file${n === 1 ? '' : 's'} in this folder were created by another application (e.g. Lightroom or darktable).\n\nOverwrite them with Kestrel metadata?`
          );
          if (ok) {
            const res2 = await window.pywebview.api.write_xmp_metadata(rootPath, payload, true, false);
            if (!res2.success) {
              showToast('Write Metadata failed: ' + (res2.error || 'Unknown error'), 5000);
              return;
            }
            showToast(`Metadata written: ${res2.written} file${res2.written === 1 ? '' : 's'}`, 4000);
          } else {
            showToast(`Metadata written: ${res.written || 0} written, ${n} skipped`, 4000);
          }
        } else {
          showToast(`Metadata written: ${res.written} file${res.written === 1 ? '' : 's'}`, 4000);
        }
      } catch (e) {
        console.error('writeMetadataForFolder error', e);
        showToast('Error writing metadata', 4000);
      }
    }

    // Reload current folders (called from Python via evaluate_js after culling completes)
    async function reloadCurrentFolders() {
      const loadedPaths = [...new Set(rows.map(r => r.__rootPath).filter(Boolean))];
      if (loadedPaths.length === 0) return;
      if (loadedPaths.length === 1) {
        await loadFolderFromPath(loadedPaths[0]);
      } else {
        await loadMultipleFolders(loadedPaths);
      }
    }
    // Expose globally for evaluate_js calls from Python
    window.reloadCurrentFolders = reloadCurrentFolders;

    // Periodically broadcast queue running state to window (for beforeunload guard)
    setInterval(async () => {
      try {
        if (hasPywebviewApi && window.pywebview?.api?.is_analysis_running) {
          const r = await window.pywebview.api.is_analysis_running();
          window.__queueRunning = !!(r && r.running);
        }
      } catch (_) { }
    }, 3000);

    // 👁 Live Analysis button
    const queueLiveBtn = document.getElementById('queueLiveBtn');
    if (queueLiveBtn) {
      queueLiveBtn.addEventListener('click', openLiveAnalysisDlg);
    }

    // Live dialog close button + Escape handling
    const liveDlgClose = document.getElementById('liveDlgClose');
    if (liveDlgClose) {
      liveDlgClose.addEventListener('click', () => {
        _liveAnalysisDlgOpen = false;
        document.getElementById('liveAnalysisDlg').close();
      });
    }
    const liveAnalysisDlg = document.getElementById('liveAnalysisDlg');
    if (liveAnalysisDlg) {
      liveAnalysisDlg.addEventListener('close', () => { _liveAnalysisDlgOpen = false; });
    }

    // ====================================================================
    // Tutorial System  (Part 1 = Analyze intro, Part 2 = Browse features)
    // Interactive: some steps require user action before advancing.
    // Inspired by the website try-it-out demo's waitFor/trigger pattern.
    // ====================================================================

    const TUTORIAL_PART1 = [
      {
        title: 'Welcome to Project Kestrel!',
        body: "Let\u2019s take a quick guided tour of Kestrel. You can <b>interact with the UI at any time</b> while this tour is open.<br><br>Click <b>Next \u2192</b> or press the right-arrow key to continue.",
        target: null,
      },
      {
        title: 'Analyze Your Photos',
        body: 'Click <b>Analyze Folders\u2026</b> to select folders of bird photos. Kestrel scans them, detects birds using AI, identifies species, and scores quality automatically.',
        target: '#analyzeQueueBtn',
        position: 'bottom',
      },
      {
        title: 'Open an Existing Folder',
        body: 'Already analyzed a folder? Click <b>Open Folder\u2026</b> to browse it. Kestrel reads the <code>.kestrel</code> database and displays all your scenes.<br><br>We\u2019ll auto-load some <b>sample bird photos</b> next so you can see it in action!',
        target: '#pickFolder',
        position: 'bottom',
      },
    ];

    const TUTORIAL_PART2 = [
      {
        title: 'Your Photos, Organized by Scene',
        body: 'The <b>Scene Grid</b> shows your photos grouped by when they were taken. Each card shows the best photo, species detected, and the AI quality rating.',
        nudge: 'Click the highlighted scene card to open it!',
        target: '#sceneGrid .card',  // highlights the first card
        position: 'right',
        waitFor: 'clickScene',   // hide Next; require user to click a scene card
      },
      {
        title: 'Scene Detail View',
        body: 'Inside a scene, photos are <b>sorted by quality</b> \u2014 the sharpest, best-composed shots appear first. Hover over a photo to preview it on the right.<br><br>When you analyze your own photos, you can <b>double-click</b> any photo to open it in your photo editor.',
        target: '#sceneDlg',
        highlightFirst: '#sceneDlg .card:first-child',
        position: 'left',
        inDialog: true,          // position relative to the dialog
      },
      {
        title: 'Star Ratings',
        body: 'Click the <b>\u2605 stars</b> on any photo to set your own rating. <span style="color:#6aa0ff">Blue stars</span> = AI rating. <span style="color:#f5c542">Gold stars</span> = your manual override.',
        nudge: 'Try clicking a star on one of the photos!',
        target: '#sceneDlg .card:first-child .stars',
        position: 'right',
        inDialog: true,
        waitFor: 'clickStar',    // wait for user to click a star
      },
      {
        title: 'Search & Filter',
        body: 'Type a species or family name in the <b>Search</b> box. The grid filters instantly as you type.',
        target: '#search',
        position: 'right',
      },
      {
        title: 'Sorting & Grouping',
        body: 'Sort scenes by <b>Scene ID</b>, <b>Max Quality</b>, or <b>Image Count</b>. Toggle <b>Group by folder</b> to organize multi-folder libraries.',
        target: '#sortBy',
        position: 'right',
      },
      {
        title: 'Merging Scenes',
        body: 'Did Kestrel split a burst into two scene cards? Hold <kbd>Ctrl</kbd> and click to <b>select multiple scenes</b>, then hit <b>Merge selected scenes</b> to combine them into one.<br><br>You can also <kbd>Shift+Click</kbd> to range-select a group of scenes at once.',
        target: '#sceneGrid',
        position: 'left',
      },
      {
        title: 'Culling Assistant',
        body: 'When you\u2019re ready to select your best shots, click <b>Open Culling Assistant</b> in any folder\u2019s header bar. It opens a dedicated accept/reject workspace.',
        target: '.culling-btn',
        position: 'bottom',
      },
      {
        title: 'Write XMP Metadata',
        body: 'Click <b>Write Metadata</b> to write XMP sidecar files alongside your photos. These <code>.xmp</code> files carry Kestrel\u2019s star ratings, species ID, and quality scores in a format that <b>Adobe Lightroom</b>, <b>darktable</b>, <b>Capture One</b>, and other editors understand natively.<br><br>\u26a0\ufe0f <b>Write XMP files <em>before</em> importing into your photo editor</b> \u2014 most catalogues ignore new sidecar files once a photo is already imported. If a sidecar was already created by another application, Kestrel will ask before overwriting it.',
        target: '.write-metadata-btn',
        position: 'bottom',
      },
      {
        title: 'Settings',
        body: 'Click <b>Settings</b> to choose your preferred <b>photo editor</b> (Darktable, Lightroom, or system default). Double-clicking a photo will open it there.',
        target: '#openSettings',
        position: 'bottom',
      },
      {
        title: 'You\u2019re All Set!',
        body: 'That\u2019s the tour! Quick recap:<br><br>\u2022 <b>Analyze Folders</b> to process new photos<br>\u2022 <b>Open Folder</b> to browse analyzed photos<br>\u2022 <b>Click scenes</b> to view & rate photos<br>\u2022 <b>Culling Assistant</b> for accept/reject workflow<br>\u2022 <b>Write Metadata</b> to export ratings &amp; species to Lightroom or darktable<br><br>Click the <b>?</b> button anytime to replay this tour. Happy birding!',
        target: null,
      },
    ];

    let _tutStep = 0;
    let _tutSteps = [];
    let _tutPart = 0;               // 0 = not started, 1 = part1, 2 = part2
    let _tutSampleLoaded = false;    // track if we auto-loaded sample sets
    let _tutCleanupFn = null;        // cleanup function for current waitFor listeners
    let _tutInDialog  = false;       // true while tutorial card is inside the scene dialog

    function _tutEl(sel) { return document.querySelector(sel); }

    async function checkMainTutorialSeen() {
      if (!hasPywebviewApi) return true;
      try {
        var res = await window.pywebview.api.get_settings();
        return res && res.settings && res.settings.main_tutorial_seen === true;
      } catch (e) { return false; }
    }

    async function markMainTutorialSeen() {
      if (!hasPywebviewApi) return;
      try {
        var res = await window.pywebview.api.get_settings();
        var s = (res && res.success ? res.settings : {}) || {};
        s.main_tutorial_seen = true;
        await window.pywebview.api.save_settings_data(s);
      } catch (e) { console.warn('markMainTutorialSeen:', e); }
    }

    function _tutCleanup() {
      // Remove any highlight-target classes
      document.querySelectorAll('.highlight-target').forEach(function(el) {
        el.classList.remove('highlight-target');
      });
      // Run cleanup for waitFor listeners
      if (_tutCleanupFn) { _tutCleanupFn(); _tutCleanupFn = null; }
      // If tutorial card was moved inside the scene dialog (top layer), move it back
      if (_tutInDialog) {
        _tutInDialog = false;
        var _ovl = _tutEl('#tutorialOverlay');
        var _crd = _tutEl('#tutorialCard');
        if (_crd && _ovl && _crd.parentElement !== _ovl) { _ovl.appendChild(_crd); }
        if (_ovl) { _ovl.style.display = ''; }
      }
    }

    function startMainTutorial(part, fromStep) {
      _tutCleanup();
      _tutPart = part || 1;
      _tutSteps = _tutPart === 1 ? TUTORIAL_PART1 : TUTORIAL_PART2;
      _tutStep = fromStep || 0;
      _tutEl('#tutorialOverlay').classList.add('active');
      _showMainTutStep(_tutStep);
    }

    function _closeMainTutorial() {
      _tutCleanup();
      _tutEl('#tutorialOverlay').classList.remove('active', 'has-backdrop');
      _tutEl('#tutorialHighlight').style.display = 'none';
      _tutEl('#tutorialNudge').style.display = 'none';
      if (_tutPart >= 2) markMainTutorialSeen();
      _tutPart = 0;
    }

    function _showMainTutStep(idx) {
      _tutCleanup();
      var step = _tutSteps[idx];
      if (!step) { _closeMainTutorial(); return; }

      var overlay = _tutEl('#tutorialOverlay');
      var hl      = _tutEl('#tutorialHighlight');
      var card    = _tutEl('#tutorialCard');
      var nudge   = _tutEl('#tutorialNudge');
      var nextBtn = _tutEl('#tutorialNext');

      // Text
      _tutEl('#tutorialCounter').textContent = 'Step ' + (idx + 1) + ' of ' + _tutSteps.length;
      _tutEl('#tutorialTitle').innerHTML = step.title;
      _tutEl('#tutorialBody').innerHTML  = step.body;

      // Nudge (click-to-advance hint)
      if (step.nudge) {
        nudge.textContent = step.nudge;
        nudge.style.display = '';
      } else {
        nudge.style.display = 'none';
      }

      // Dots
      var dotsCont = _tutEl('#tutorialProgress');
      dotsCont.innerHTML = '';
      _tutSteps.forEach(function(_, i) {
        var d = document.createElement('div');
        d.className = 'tutorial-dot' + (i === idx ? ' active' : '');
        dotsCont.appendChild(d);
      });

      // Back / Next labels
      _tutEl('#tutorialBack').disabled = (idx === 0);
      var isLast = (idx === _tutSteps.length - 1);
      nextBtn.textContent = isLast ? 'Finish \u2713' : 'Next \u2192';

      // If this step uses waitFor, hide the Next button until the action completes
      var hasWaitFor = !!step.waitFor;
      nextBtn.style.display = hasWaitFor ? 'none' : '';

      // Find the target element
      var target = step.target ? document.querySelector(step.target) : null;

      // For inDialog steps, check if the scene dialog is open
      var _inDialogActive = false;
      if (step.inDialog) {
        var dlg = document.getElementById('sceneDlg');
        if (!dlg || !dlg.open) {
          // Dialog not open — show a message and allow Next to skip
          _tutEl('#tutorialBody').innerHTML = step.body + '<br><br><span style="color:var(--brand);font-weight:600">Open a scene first, then this step will highlight the right element.</span>';
          nudge.style.display = 'none';
          nextBtn.style.display = '';  // show Next even if waitFor was set
          target = null;  // treat as center
          hasWaitFor = false;
        } else {
          // Dialog is open — physically move the tutorial card into the dialog so it
          // appears in the browser's top layer (above the modal dialog content)
          _inDialogActive = true;
          _tutInDialog = true;
          if (card.parentElement !== dlg) { dlg.appendChild(card); }
          overlay.style.display = 'none'; // hide the main-page dim; dialog has its own backdrop
        }
      }
      // For steps that have a separate first-element highlight target
      if (step.highlightFirst && !_inDialogActive) {
        var _hfEl = document.querySelector(step.highlightFirst);
        if (_hfEl) _hfEl.classList.add('highlight-target');
      }

      if (!target || (target.offsetWidth === 0 && target.offsetHeight === 0)) {
        // Center-screen card, full backdrop
        hl.style.display = 'none';
        overlay.classList.add('has-backdrop');
        card.style.transform = 'translate(-50%, -50%)';
        card.style.top  = '50%';
        card.style.left = '50%';
      } else {
        // For inDialog active steps the card is inside the dialog (top layer); skip overlay hl
        hl.style.display = _inDialogActive ? 'none' : '';
        overlay.classList.remove('has-backdrop');
        card.style.transform = '';

        // Add highlight-target class for the pulsing effect
        target.classList.add('highlight-target');

        var pad = 8;
        var r = target.getBoundingClientRect();
        if (!_inDialogActive) {
          hl.style.top    = (r.top  - pad) + 'px';
          hl.style.left   = (r.left - pad) + 'px';
          hl.style.width  = (r.width  + pad * 2) + 'px';
          hl.style.height = (r.height + pad * 2) + 'px';
        }

        // Position card near target
        var pos    = step.position || 'right';
        var margin = 18;
        var vw     = window.innerWidth;
        var vh     = window.innerHeight;
        var cw     = 380 + margin;
        var ch     = card.offsetHeight || 220;
        var top, left;
        if (pos === 'right')       { left = r.right + margin;                 top = r.top + r.height / 2 - ch / 2; }
        else if (pos === 'left')   { left = r.left - cw - margin;             top = r.top + r.height / 2 - ch / 2; }
        else if (pos === 'bottom') { left = r.left + r.width / 2 - cw / 2;   top = r.bottom + margin; }
        else                       { left = r.left + r.width / 2 - cw / 2;   top = r.top - ch - margin; }
        left = Math.max(margin, Math.min(left, vw - cw - margin));
        top  = Math.max(margin, Math.min(top,  vh - ch - margin));
        card.style.left = left + 'px';
        card.style.top  = top  + 'px';
      }

      // ---- Set up interactive waitFor listeners ----
      if (hasWaitFor && step.waitFor === 'clickScene') {
        // User must click any scene card in the grid. Listen on sceneGrid for clicks.
        var sceneGridEl = document.getElementById('sceneGrid');
        if (sceneGridEl) {
          var handler = function(ev) {
            var cardEl = ev.target.closest('.card');
            if (cardEl) {
              // Scene card was clicked — it will open the dialog via its own click handler.
              // Wait a beat for the dialog to show, then advance.
              setTimeout(function() { _tutAdvance(); }, 400);
            }
          };
          sceneGridEl.addEventListener('click', handler, true);
          _tutCleanupFn = function() { sceneGridEl.removeEventListener('click', handler, true); };
        }
      }
      else if (hasWaitFor && step.waitFor === 'clickStar') {
        // User must click a star in the scene dialog
        var onStarClick = function(ev) {
          var starEl = ev.target.closest('.star, .stars span');
          if (starEl) {
            setTimeout(function() { _tutAdvance(); }, 300);
          }
        };
        document.addEventListener('click', onStarClick, true);
        _tutCleanupFn = function() { document.removeEventListener('click', onStarClick, true); };
      }
    }

    function _tutAdvance() {
      _tutStep++;
      if (_tutStep >= _tutSteps.length) {
        // End of current part
        if (_tutPart === 1) {
          _closeMainTutorial();
          // Transition to Part 2: auto-load sample sets then start part 2
          _autoLoadSamplesAndStartPart2();
        } else {
          _closeMainTutorial();
        }
      } else {
        _showMainTutStep(_tutStep);
      }
    }

    function _tutGoBack() {
      if (_tutStep > 0) { _tutStep--; _showMainTutStep(_tutStep); }
    }

    async function _autoLoadSamplesAndStartPart2() {
      if (!hasPywebviewApi) { startMainTutorial(2, 0); return; }
      try {
        console.log('[tutorial] Calling get_sample_sets_paths()...');
        var res = await window.pywebview.api.get_sample_sets_paths();
        console.log('[tutorial] get_sample_sets_paths() response:', res);
        
        if (res && res.success && res.paths && res.paths.length > 0) {
          console.log('[tutorial] Found', res.paths.length, 'sample sets:', res.paths);
          _tutSampleLoaded = true;
          // Scan the parent folder so the folder tree sidebar shows backyard_birds + forest_trail
          var sampleParent = res.paths[0].replace(/[/\\][^/\\]+$/, '');
          console.log('[tutorial] Sample parent folder:', sampleParent);
          try { 
            await scanFolderTree(sampleParent);
            console.log('[tutorial] Folder tree scanned successfully');
          } catch(e) {
            console.warn('[tutorial] Folder tree scan error:', e);
          }
          try {
            console.log('[tutorial] Loading', res.paths.length, 'folders via loadMultipleFolders...');
            await loadMultipleFolders(res.paths);
            console.log('[tutorial] Folders loaded successfully');
          } catch(e) {
            console.warn('[tutorial] loadMultipleFolders error:', e);
            throw e;
          }
          // Small delay for render, then start Part 2
          console.log('[tutorial] Starting Part 2 of tutorial');
          setTimeout(function() { startMainTutorial(2, 0); }, 600);
        } else {
          // No sample sets found -- just start Part 2 anyway
          console.warn('[tutorial] No sample sets found. res.success=', res?.success, 'res.paths=', res?.paths);
          startMainTutorial(2, 0);
        }
      } catch (e) {
        console.warn('[tutorial] _autoLoadSamplesAndStartPart2 error:', e);
        console.error(e);
        startMainTutorial(2, 0);
      }
    }

    // Wire up tutorial buttons
    var helpBtnMain = document.getElementById('helpBtnMain');
    if (helpBtnMain) {
      helpBtnMain.addEventListener('click', function() {
        startMainTutorial(1, 0);
      });
    }

    _tutEl('#tutorialNext').addEventListener('click', _tutAdvance);
    _tutEl('#tutorialBack').addEventListener('click', _tutGoBack);
    _tutEl('#tutorialSkip').addEventListener('click', function() {
      if (_tutPart === 1) {
        // Skipping part 1 still transitions to part 2 with samples
        _closeMainTutorial();
        _autoLoadSamplesAndStartPart2();
      } else {
        _closeMainTutorial();
      }
    });

    // Keyboard navigation
    document.addEventListener('keydown', function(ev) {
      if (!_tutEl('#tutorialOverlay').classList.contains('active')) return;
      if (_tutPart === 0) return;
      var step = _tutSteps[_tutStep];
      var hasWaitFor = step && step.waitFor;
      if (ev.key === 'ArrowRight' || ev.key === 'Enter') {
        ev.preventDefault();
        // Don't advance with keyboard if a waitFor is active
        if (!hasWaitFor) _tutAdvance();
      }
      else if (ev.key === 'ArrowLeft') { ev.preventDefault(); _tutGoBack(); }
      else if (ev.key === 'Escape') { _closeMainTutorial(); }
    });

    // Also wire welcome panel tutorial link to start inline tutorial
    var welcomeTutLink = document.getElementById('welcomeTutorialLink');
    if (welcomeTutLink) {
      welcomeTutLink.addEventListener('click', function(e) {
        e.preventDefault();
        startMainTutorial(1, 0);
      });
    }

    // Auto-start tutorial on first launch (pywebview mode only)
    (async function() {
      if (!hasPywebviewApi) return;
      // Wait a moment for the UI to settle
      await new Promise(function(r) { setTimeout(r, 800); });
      var seen = await checkMainTutorialSeen();
      if (!seen) {
        startMainTutorial(1, 0);
      }
    })();


    // Wire donation dialog buttons — this script runs after the dialog HTML is in the DOM
    (function() {
      var dlg = document.getElementById('donateDlg');
      document.getElementById('donateDlgGoBtn').addEventListener('click', function() {
        dlg.close();
        openDonateLink();
      });
      document.getElementById('donateDlgFeedbackBtn').addEventListener('click', function() {
        dlg.close();
        setTimeout(function() {
          document.getElementById('feedbackDlg').showModal();
        }, 150);
      });
      document.getElementById('donateDlgClose').addEventListener('click', function() {
        dlg.close();
      });
    })();
