    // 状态
    // 说明：文件访问分为两种模式：
    // 1. Python API 模式（桌面应用）：使用 rootPath 和 Python 后端 API 调用
    // 2. File System Access API 模式（浏览器）：使用 rootDirHandle 直接访问文件
    // getBlobUrlForPath 会自动选择当前最合适的访问方式
    let rootDirHandle = null;      // 顶层照片文件夹（包含 .kestrel），供 File System Access API 使用
    let rootIsKestrel = false;     // 当用户直接选择 .kestrel 文件夹时为 true
    let rootPath = '';             // 根目录绝对路径（供 Python API 使用）
    let csvFileHandle = null;      // .kestrel/kestrel_database.csv
    let rows = [];                 // CSV 行数据（对象）
    let _scenedata = {};           // rootPath -> kestrel_scenedata.json 内容映射
    let header = [];               // CSV 表头字段
    let scenes = [];               // 聚合后的场景对象
    let dirty = false;             // 记录是否有未保存改动
    // 在 dirty 状态变化时通知 Python 后端（用于关闭确认）
    function _notifyDirty(val) {
      try { if (window.pywebview?.api?.notify_dirty) window.pywebview.api.notify_dirty(!!val); } catch (_) {}
    }
    let _cleanSnapshot = null;      // 上一次干净状态（加载或保存后）的 rows+header 快照
    let selectedSceneIds = new Set(); // 多选：已选中的场景 ID（"slot:count"）
    let collapsedFolders = new Set(); // 已折叠文件夹分组的 rootPath 集合
    let _lastSelectedIdx = -1;        // Shift 点击范围：_visibleSceneOrder 中最后点击的索引
    let _visibleSceneOrder = [];       // 最近一次渲染后可见场景 ID 的扁平顺序列表
    let _focusedCardId = null;         // 网格中当前键盘焦点所在的场景 ID
    // 记录当前打开的是哪个场景对话框，便于刷新筛选结果
    let currentSceneId = null;

    const el = (sel) => document.querySelector(sel);
    const t = (key, vars) => window.KestrelI18n?.t ? window.KestrelI18n.t(key, vars) : key;
    const getSpeciesDisplayName = (name) => window.KestrelTaxonomy?.speciesDisplayName ? window.KestrelTaxonomy.speciesDisplayName(name) : String(name || '');
    const getFamilyDisplayName = (name) => window.KestrelTaxonomy?.familyDisplayName ? window.KestrelTaxonomy.familyDisplayName(name) : String(name || '');
    const speciesMatchesQuery = (name, query) => window.KestrelTaxonomy?.speciesMatchesQuery
      ? window.KestrelTaxonomy.speciesMatchesQuery(name, query)
      : String(name || '').toLowerCase().includes(String(query || '').toLowerCase());
    const sceneGrid = el('#sceneGrid');
    const imageGrid = el('#imageGrid');
    const statusEl = el('#status');
    const sceneDlg = el('#sceneDlg');
    const versionBadge = el('#versionBadge');

    const supportsFS = 'showDirectoryPicker' in window;
    let hasPywebviewApi = typeof window.pywebview !== 'undefined';

    // 调试：记录当前可用的 API（首次检查）
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

    // pywebview API 可能异步注入，因此需要等待
    async function waitForPywebview() {
      if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
        return true;
      }
      // 轮询最多 2 秒
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (typeof window.pywebview !== 'undefined' && window.pywebview.api) {
          console.log('[DEBUG] Pywebview API became available after', (i + 1) * 100, 'ms');
          hasPywebviewApi = true;
          console.log('[DEBUG] Updated hasPywebviewApi to:', hasPywebviewApi);
          console.log('[DEBUG] window.pywebview:', window.pywebview);
          console.log('[DEBUG] window.pywebview.api:', window.pywebview.api);
          console.log('[DEBUG] Available API methods:', Object.keys(window.pywebview.api));
          // 既然 pywebview 已可用，就隐藏兼容性提示
          el('#compat').classList.add('hidden');
          return true;
        }
      }
      console.log('[DEBUG] Pywebview API not available after 2 seconds');
      return false;
    }

    // 立即开始检查 pywebview，并在就绪后更新 UI
    (async function() {
      try { await window.KestrelTaxonomy?.load?.(); } catch (_) {}
      const apiReady = !hasPywebviewApi ? await waitForPywebview() : true;
      // API 就绪后检查法律协议状态
      checkLegalAgreement();
      // 显示或隐藏兼容性提示
      if (!supportsFS && !apiReady) {
        el('#compat').classList.remove('hidden');
      } else if (apiReady) {
        el('#compat').classList.add('hidden');
      }
      // API 确认可用后，先等待设置同步完成，再检查捐助阈值
      await new Promise(function(r) { setTimeout(r, 500); });
      // 从服务端同步设置，确保 localStorage 中是最新数据
      await hydrateSettingsFromServer();
      // 设置写入 localStorage 后再检查捐助阈值
      checkDonationThresholdOnStartup();
    })();

    // 工具函数
    function setStatus(msg) { statusEl.textContent = msg; }

    // 临时 toast 通知（可点击），默认 5 秒
    function showToast(msg, timeout = 5000, onclick) {
      try {
        // 决定把容器挂在哪：优先挂到最上层已打开的对话框
        const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
        let attachParent = document.body;
        if (openDialogs.length > 0) {
          // 使用最后打开的对话框（默认视为最上层），让 toast 显示在其上方
          attachParent = openDialogs[openDialogs.length - 1];
        }

        let container = document.getElementById('toastContainer');
        if (!container) {
          container = document.createElement('div');
          container.id = 'toastContainer';
          // 确保具备基础布局样式
          container.style.position = 'fixed';
          container.style.right = '18px';
          container.style.bottom = '18px';
          container.style.display = 'flex';
          container.style.flexDirection = 'column';
          container.style.gap = '8px';
          container.style.zIndex = '2147483647';
          container.style.pointerEvents = 'none';
        }

        // 如果容器不在期望的父元素中，就把它移动过去。
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

    // ── 懒加载图片（限流） ────────────────────────────────────────────
    // 通过限制并发，避免当大块网格进入视口时向 Python IPC 桥同时发出
    // 大量 read_image_file 请求。超出的加载任务会排队，等前面的完成后再执行。
    const _imgLoadThrottle = { active: 0, max: 100, queue: [] };
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
          // 让浏览器在主线程之外完成图片解码，
          // 避免同步解码导致下一帧卡顿。
          try { await img.decode(); } catch (_) { /* broken/aborted image */ }
        }
      };
      _lazyObserver.observe(img);
    }
    // ── 懒加载图片结束 ────────────────────────────────────────────────────

    // 通用防抖辅助函数
    function debounce(fn, ms) {
      let timer;
      return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
    }

    // 版本计数器，用于让并发的 renderScenes 调用提前退出
    let _renderScenesVersion = 0;
    // 版本计数器，用于让 loadMultipleFolders 在执行中途可被取消
    let _loadFoldersVersion = 0;

    function loadVersionBadge() {
      if (!versionBadge) return;
      
      async function updateVersionBadge() {
        try {
          // 从 VERSION.txt 读取应用版本
          let displayVersion = 'Version: unknown';
          try {
            const resp = await fetch('VERSION.txt', { cache: 'no-store' });
            if (resp.ok) {
              const text = await resp.text();
              const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              if (lines.length > 0) {
                const firstLine = lines[0];
                if (firstLine.toLowerCase().startsWith('version')) {
                  displayVersion = firstLine;
                } else {
                  displayVersion = `Version: ${firstLine}`;
                }
              }
            }
          } catch (e) {
            console.error('[loadVersionBadge] Failed to fetch VERSION.txt:', e);
          }
          
          // 通过 API 从 config.py 获取流水线版本
          if (hasPywebviewApi && window.pywebview?.api?.get_app_version) {
            try {
              const result = await window.pywebview.api.get_app_version();
              const pipelineVersion = result?.version || result;
              if (pipelineVersion && pipelineVersion !== 'unknown') {
                displayVersion += ` | Pipeline Version: ${pipelineVersion}`;
              }
            } catch (e) {
              console.error('[loadVersionBadge] Failed to fetch pipeline version:', e);
            }
          }
          
          versionBadge.textContent = displayVersion;
        } catch (e) {
          console.error('[loadVersionBadge] Unexpected error:', e);
          versionBadge.textContent = t('status.version_error');
        }
      }
      
      // 如果 API 还没准备好，就先等待
      if (!hasPywebviewApi) {
        waitForPywebview().then(() => updateVersionBadge());
      } else {
        updateVersionBadge();
      }
      
      // 从远端 JSON 端点检查新版本，但需要先确保 pywebview 已就绪，
      // 因此监听事件，或在已经挂载时立即执行
      if (window.pywebview?.api) {
        checkRemoteVersion();
      } else {
        window.addEventListener('pywebviewready', checkRemoteVersion);
      }
    }

    // 检查当前是否以 Windows Store 应用方式运行
    async function isWindowsStoreApp() {
      try {
        if (!window.pywebview?.api?.is_windows_store_app) return false;
        const result = await window.pywebview.api.is_windows_store_app();
        return result?.is_store ?? false;
      } catch (e) {
        return false;
      }
    }

    // 获取平台信息
    async function getPlatformInfo() {
      try {
        if (!window.pywebview?.api?.get_platform_info) {
          // 回退到前端侧平台检测
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

    // 从 JSON 端点检查远端版本
    async function checkRemoteVersion() {
      try {
        // 从 VERSION.txt 读取当前应用版本
        let currentVer = _appVersion;
        if (!currentVer) {
          try {
            const versionResp = await fetch('VERSION.txt', { cache: 'no-store' });
            if (versionResp.ok) {
              const text = await versionResp.text();
              const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
              if (lines.length > 0) {
                // 仅提取版本号部分（例如从 "Version: v(Swamp Sparrow)" 提取 "v(Swamp Sparrow)"）
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
        
        // 比较版本：检查最新版本名称是否与当前不同
        if (!latestVersion.name) return;
        const normalizedLocal = (currentVer || '').replace(/^v\(/ig, '').replace(/\)$/g, '').trim();
        const normalizedRemote = latestVersion.name.replace(/^v\(/ig, '').replace(/\)$/g, '').trim();
        
        if (normalizedRemote === normalizedLocal) return;
        
        // 显示更新通知
        showVersionUpdateNotification(latestVersion);
      } catch (e) {
        // 网络错误或离线模式，忽略即可
      }
    }

    // 以 toast 形式显示版本更新通知
    async function showVersionUpdateNotification(versionInfo) {
      console.log('[DEBUG] Showing version update notification for version:', versionInfo);
      const toast = document.getElementById('versionUpdateToast');
      if (!toast) return;
      
      const platform = await getPlatformInfo();
      const isStore = platform === 'windows' ? await isWindowsStoreApp() : false;
      
      // 优先级符号
      const priorityEl = document.getElementById('versionUpdatePriority');
      if (priorityEl) priorityEl.textContent = versionInfo.highPriority ? '⭐' : '•';
      
      // 标题
      const titleEl = document.getElementById('versionUpdateTitle');
      if (titleEl) titleEl.textContent = t('update.available_title', { name: versionInfo.name });
      
      // 更新说明（显示前 3 条）
      const notesEl = document.getElementById('versionUpdateNotes');
      if (notesEl && versionInfo.notes && Array.isArray(versionInfo.notes)) {
        notesEl.innerHTML = '';
        versionInfo.notes.slice(0, 3).forEach(note => {
          const li = document.createElement('li');
          li.textContent = note;
          notesEl.appendChild(li);
        });
      }
      
      // Windows 专属说明（仅对 Windows 用户显示）
      const windowsNoteEl = document.getElementById('versionUpdateWindowsNote');
      if (windowsNoteEl) {
        if (platform === 'windows') {
          windowsNoteEl.innerHTML = t('update.windows_note');
          windowsNoteEl.style.display = 'block';
        } else {
          windowsNoteEl.style.display = 'none';
        }
      }
      
      // 下载按钮
      const downloadBtn = document.getElementById('versionUpdateDownloadBtn');
      if (downloadBtn) {
        downloadBtn.href = `https://projectkestrel.org/download?platform=${platform}`;
        downloadBtn.textContent = platform === 'macos' ? t('update.download_macos') : t('update.download_windows');
        downloadBtn.onclick = (e) => {
          e.preventDefault();
          window.open(`https://projectkestrel.org/download?platform=${platform}`, '_blank');
        };
      }
      
      // 关闭按钮
      const closeBtn = document.getElementById('versionUpdateClose');
      if (closeBtn) {
        closeBtn.onclick = () => {
          toast.style.display = 'none';
        };
      }
      
      // 显示 toast
      toast.style.display = 'block';
      
      // 10 秒后自动隐藏
      setTimeout(() => {
        if (toast.style.display === 'block') {
          toast.style.display = 'none';
        }
      }, 60000);
    }

    // 提示层，确保提示信息可以显示在主图区域上方
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

    // 简单的界面缩放控制（Chromium webview 支持 CSS zoom）
    let uiZoom = 1;
    function applyZoom() {
      const zoomEl = document.getElementById('mainZoom');
      if (!zoomEl) return;
      const z = uiZoom;
      // 优先使用非 transform 的缩放方式，确保标题中的 position: sticky 继续生效。
      // 能用 CSS `zoom` 时优先使用；否则回退到仅 transform 的方案。
      try {
        zoomEl.style.zoom = z.toFixed(2);
        // 确保未设置 transform（transform 可能破坏 sticky 行为）
        zoomEl.style.transform = '';
        zoomEl.style.width = '';
        zoomEl.style.height = '';
      } catch (e) {
        // 回退：若浏览器不支持 zoom，则改用 transform（可能影响 sticky）
        const s = uiZoom.toFixed(2);
        zoomEl.style.transform = `scale(${s})`;
        zoomEl.style.width = `calc(100% / ${s})`;
        zoomEl.style.height = `calc(100% / ${s})`;
      }
    }

    function sanitizePath(p) {
      if (!p) return '';
      // 统一为正斜杠，并去掉首尾引号
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
            // 可能是文件
            try { return await handle.getFileHandle(parts[i]); } catch (_) { throw e; }
          } else {
            throw e;
          }
        }
      }
      return handle;
    }

    // 尝试把绝对 Windows 路径转换成相对当前根目录的路径
    // 同时处理本来就是相对路径的新格式
    function toRootRelative(absPath) {
      if (!absPath || !rootDirHandle) return null;
      const p = sanitizePath(absPath);

      // 检查路径是否本来就是相对路径（新格式）
      // 相对路径以 .kestrel/ 或 kestrel/ 开头，且不带盘符或前导 /
      if (p.toLowerCase().startsWith('.kestrel/') || p.toLowerCase().startsWith('kestrel/')) {
        // 已经是相对路径，直接返回；若 rootIsKestrel 为真则去掉 .kestrel/ 前缀
        return rootIsKestrel ? p.replace(/^\.?kestrel\//i, '') : p;
      }

      // 检查是否为嵌入 .kestrel 文件夹的绝对路径（旧格式）
      const idx = p.toLowerCase().lastIndexOf('/.kestrel/');
      if (idx >= 0) {
        const rel = p.substring(idx + 1); // include .kestrel/…
        return rootIsKestrel ? rel.replace(/^\.kestrel\//i, '') : rel;
      }

      // 回退：如果只有文件名，就直接返回文件名
      const base = p.split('/').pop();
      return base || null;
    }


    // 按路径缓存 Blob URL
    const blobUrlCache = new Map();

    /** 将 base64 字符串转换为 Blob 对象 URL。
     *  与 data: URI 不同，blob: URL 会由浏览器的图片解码线程异步处理，
     *  因此滚动时不会阻塞主线程。 */
    function _base64ToBlobUrl(b64, mime) {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([buf], { type: mime || 'image/jpeg' }));
    }

    async function getBlobUrlForPath(relOrAbsPath, rootOverride) {
      if (!relOrAbsPath) return null;
      const effectiveRoot = rootOverride || rootPath;

      // 立即统一路径分隔符（开销很小，并与 culling.html 的行为保持一致）
      const rel = String(relOrAbsPath).replace(/\\/g, '/');

      // 优先检查缓存，避免对已加载图片做任何额外工作
      // （这是回滚查看已缓存缩略图时的热点路径）
      const cacheKey = `${effectiveRoot}:${rel}`;
      if (blobUrlCache.has(cacheKey)) return blobUrlCache.get(cacheKey);

      // 优先级 1：Python API（桌面应用，全平台）
      if (hasPywebviewApi && window.pywebview?.api?.read_image_file && effectiveRoot) {
        try {
          const result = await window.pywebview.api.read_image_file(rel, effectiveRoot);
          if (result && result.success && result.data) {
            // 使用 blob: URL 而不是 data: URL，让浏览器在解码线程中异步处理图片，
            // 避免主线程被同步 base64 与 JPEG/PNG 解析阻塞。
            const blobUrl = _base64ToBlobUrl(result.data, result.mime);
            blobUrlCache.set(cacheKey, blobUrl);
            return blobUrl;
          }
        } catch (e) {
          console.error('Python API image read failed:', e);
          return null;
        }
      }

      // 优先级 2：File System Access API（仅浏览器模式）
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

    // 解析次级物种列。
    // 新格式：JSON 数组字符串，例如 '["Greater Yellowlegs","Vaux\'s Swift"]'。
    // 旧格式：numpy str() 的 repr，例如 "[\'Greater Yellowlegs\' \"Vaux\'s Swift\"]"。
    function parseSecondarySpecies(row) {
      if (row.__secondaryCache) return row.__secondaryCache;
      const listRaw = row.secondary_species_list;
      const scoresRaw = row.secondary_species_scores;
      const result = [];
      if (!listRaw || !scoresRaw) { row.__secondaryCache = result; return result; }
      try {
        let species = null, nums = null;
        // 先尝试按 JSON 解析（新格式）
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
          // 回退处理旧版 numpy repr：名称里带撇号时 numpy 会使用 "..."
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

    // 次级科名列的解析逻辑与次级物种类似。
    function parseSecondaryFamilies(row) {
      if (row.__secondaryFamilyCache) return row.__secondaryFamilyCache;
      const listRaw = row.secondary_family_list;
      const scoresRaw = row.secondary_family_scores;
      const result = [];
      if (!listRaw || !scoresRaw) { row.__secondaryFamilyCache = result; return result; }
      try {
        let fams = null, nums = null;
        // 先尝试按 JSON 解析
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
          // 回退处理旧版 numpy repr
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

    // 确保评分相关列存在并设置默认值
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

    /** 获取（或延迟初始化）某个 rootPath 对应的 scenedata 对象。 */
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

    // 辅助判断：这张图片是否为手动评分（大于 0 星）？
    function isManualRated(r) { return getRating(r) > 0 && getOrigin(r) === 'manual'; }

    function aggregateScenes(minSpeciesConf, searchTerm, sortBy, includeSecondary, includeFamilies) {
      const groups = new Map();
      for (const r of rows) {
        // 给 scene_id 加上 folderSlot 前缀，避免不同文件夹的场景发生冲突
        const id = (r.__folderSlot != null ? r.__folderSlot + ':' : '') + r.scene_count;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(r);
      }

      const list = [];
      for (const [sceneId, arr] of groups) {
        // 选择质量最高的图片作为代表
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
        // 如果该场景已有最终确认的 user_tags，则用它们作为物种/科展示内容
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

      // 按搜索词筛选
      const q = (searchTerm || '').trim().toLowerCase();
      const filtered = q ? list.filter(s => {
        if (s.species.some(sp => speciesMatchesQuery(sp, q))) return true;
        const families = collectSceneSpecies(s.id).families || [];
        return families.some(fm => {
          const raw = String(fm || '').toLowerCase();
          const display = String(getFamilyDisplayName(fm) || '').toLowerCase();
          return raw.includes(q) || display.includes(q);
        });
      }) : list;

      // 排序
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
      // 1. 存在 scenedata 中的手动评分（pywebview 桌面模式）
      const sd = _scenedata[rp];
      if (sd?.image_ratings && fn && fn in sd.image_ratings) {
        const n = parseInt(sd.image_ratings[fn], 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
      }
      // 2. 旧版逐行手动评分（FSAPI 浏览器模式或迁移前数据）
      if (String(row?.rating_origin).toLowerCase() === 'manual') {
        const n = parseInt(row?.rating, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
      }
      // 3. 自动评分：由最近一次 apply_normalization 计算出的标准化评分
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
        // pywebview 桌面模式：评分仅持久化到 scenedata
        const sd = _initScenedata(rp);
        const current = sd.image_ratings[fn];
        if (current === v && v !== 0) return; // no change
        if (v === 0) delete sd.image_ratings[fn]; else sd.image_ratings[fn] = v;
      } else {
        // FSAPI 浏览器模式：沿用旧版逐行存储
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
        // 这里只处理点击，悬停预览由下方的委托监听器负责
        s.addEventListener('click', (ev) => { ev.stopPropagation(); setRating(row, i, 'manual'); render(); });
        wrap.appendChild(s);
      }

      // 每个评分条只挂 2 个委托监听器，而不是每颗星各挂 mouseenter/mouseleave
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
      const dirtyMark = dirty ? t('status.unsaved') : '';
      const filtered = totalScenes < allScenes ? t('status.filtered_suffix', { all: allScenes }) : '';
      setStatus(t('status.showing', { scenes: totalScenes, images: totalImages, filtered, dirty: dirtyMark }));
    }

    // 渲染场景：多文件夹加载时按文件夹分组
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

      // 重新解析 _currentScene，确保场景数组重建后
      // 当前已打开的场景对话框仍能继续工作。
      if (_currentScene) {
        const openId = String(_currentScene.id);
        const refreshed = scenes.find(s => String(s.id) === openId);
        if (refreshed) _currentScene = refreshed;
      }

      // 在不修改全局 scenes 的前提下应用“仅显示手动评分场景”过滤
      const visibleScenes = onlyRatedScenes ? scenes.filter(s => s.images.some(isManualRated)) : scenes;

      updateStatusBar(visibleScenes);
      sceneGrid.innerHTML = '';

      // 没有加载数据时显示欢迎面板，打开文件夹后隐藏
      const _welcomePanel = document.getElementById('welcomePanel');
      if (_welcomePanel) _welcomePanel.classList.toggle('hidden', rows.length > 0);

      // 用于 Shift 点击范围选择的扁平索引
      _visibleSceneOrder = visibleScenes.map(s => String(s.id));

      // ---- 两级分组：文件夹 -> 时间桶 ----
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
        if (!bucket) return t('status.unknown_time');
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

      // 构建 folderMap：folderKey -> { folderPath, buckets: Map<tb, scene[]>, bucketOrder: [] }
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
        const qualityBadge = document.createElement('span');
        qualityBadge.className = 'badge quality';
        qualityBadge.textContent = `Q ${fmt3(s.maxQuality)}`;
        th.appendChild(qualityBadge);
        const countBadge = document.createElement('span');
        countBadge.className = 'badge count';
        countBadge.textContent = `${s.imageCount} 张`;
        th.appendChild(countBadge);
        card.appendChild(th);

        const body = document.createElement('div');
        body.className = 'body';
        const captureLabel = (() => {
          const ct = s.representative?.capture_time;
          if (!ct) return t('status.unknown_time');
          try {
            const d = new Date(ct);
            if (isNaN(d)) return t('status.unknown_time');
            return d.toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            });
          } catch (_) {
            return t('status.unknown_time');
          }
        })();
        const primarySpeciesName = s.species.length > 0 ? getSpeciesDisplayName(s.species[0]) : '未识别物种';
        const familyName = s.families.length > 0 ? getFamilyDisplayName(s.families[0]) : '未分类';
        const speciesOverflow = Math.max(0, s.species.length - 1);
        const cardMetaLine = document.createElement('div');
        cardMetaLine.className = 'scene-card-topline';
        const _folderName = folderBaseName(s.representative?.__rootPath || '');
        const secondaryMeta = showFolderHeaders || !_folderName
          ? captureLabel
          : `${_folderName} · ${captureLabel}`;
        cardMetaLine.textContent = secondaryMeta;
        const title = document.createElement('div');
        title.className = 'title';
        const _localNum = String(s.id).split(':').pop();
        // 仅在单文件夹加载时在标题中显示文件夹名；
        // 多文件夹模式下，分组头部已经会显示文件夹名。
        const _titleHtml = `<b>#${_localNum}</b>`;
        title.innerHTML = _titleHtml + (s.sceneName ? ` <span class="name">\u2014 ${decodeEntities(escapeHtml(s.sceneName))}</span>` : '');
        title.title = (s.representative?.__rootPath || String(s.id)) + (s.sceneName ? ` \u2014 ${s.sceneName}` : '');
        const primarySpecies = document.createElement('div');
        primarySpecies.className = 'scene-card-species';
        primarySpecies.textContent = primarySpeciesName;
        primarySpecies.title = primarySpeciesName;
        const subline = document.createElement('div');
        subline.className = 'scene-card-subline';
        subline.innerHTML = `
          <span class="scene-card-family">${escapeHtml(familyName)}</span>
          <span class="scene-card-sep"></span>
          <span class="scene-card-secondary">${speciesOverflow > 0 ? `+${speciesOverflow} 个其他标签` : '单一主体'}</span>
        `;
        const chips = document.createElement('div');
        chips.className = 'chips';
        if (s.isApproved) {
          card.classList.add('scene-approved');
          chips.classList.add('reviewed-tags');
        }
        for (const sp of s.species.slice(1, 3)) {
          const c = document.createElement('span');
          c.className = s.isApproved ? 'chip manual-approved' : 'chip';
          c.textContent = getSpeciesDisplayName(sp);
          c.title = sp;
          chips.appendChild(c);
        }
        if (s.species.length > 3) {
          const more = document.createElement('span');
          more.className = 'chip badge';
          more.textContent = `+${s.species.length - 3} 更多`;
          more.title = s.species.slice(3).map(getSpeciesDisplayName).join(', ');
          chips.appendChild(more);
        }
        const footer = document.createElement('div');
        footer.className = 'scene-card-footer';
        const sceneStat = document.createElement('span');
        sceneStat.className = 'scene-card-stat';
        sceneStat.textContent = `场景 #${_localNum}`;
        footer.appendChild(sceneStat);
        if (s.isApproved) {
          const reviewedStat = document.createElement('span');
          reviewedStat.className = 'scene-card-stat reviewed';
          reviewedStat.textContent = '已审核';
          footer.appendChild(reviewedStat);
        }
        body.appendChild(cardMetaLine);
        body.appendChild(title);
        body.appendChild(primarySpecies);
        body.appendChild(subline);
        if (chips.childElementCount > 0) body.appendChild(chips);
        body.appendChild(footer);
        card.appendChild(body);

        card.addEventListener('click', (ev) => {
          const sid = String(s.id);
          _focusGridCard(sid);
          if (ev.shiftKey && _lastSelectedIdx >= 0) {
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
            if (selectedSceneIds.has(sid)) selectedSceneIds.delete(sid); else selectedSceneIds.add(sid);
            _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
            updateSelectionUI();
            ev.preventDefault(); return;
          }
          if (selectedSceneIds.size > 0) {
            if (selectedSceneIds.has(sid)) selectedSceneIds.delete(sid); else selectedSceneIds.add(sid);
            _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
            updateSelectionUI();
            return;
          }
          // 常规行为：打开场景对话框
          _lastSelectedIdx = _visibleSceneOrder.indexOf(sid);
          openSceneDialog(sid);
        });
        return card;
      }

      const batch = 24;

      // ---- 时间线构建器（在 groupByTime 开启时使用） ----
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

          // 当时间桶跨天时插入日期横幅
          if (thisDay && thisDay !== '__notime__' && thisDay !== prevDay) {
            const banner = document.createElement('div');
            banner.className = 'timeline-day-banner';
            banner.textContent = formatNodeDay(tb);
            timelineEl.appendChild(banner);
            prevDay = thisDay;
          }

          const nodeEl = document.createElement('div');
          nodeEl.className = 'timeline-node';

          // 轨道列：圆点 + 连接线
          const railCol = document.createElement('div');
          railCol.className = 'timeline-rail-col';
          const dot = document.createElement('div');
          dot.className = 'timeline-dot';
          const line = document.createElement('div');
          line.className = 'timeline-line' + (isLast ? ' last' : '');
          railCol.appendChild(dot);
          railCol.appendChild(line);

          // 内容列：时间标签 + 场景卡片
          const contentCol = document.createElement('div');
          contentCol.className = 'timeline-content-col';

          if (tb !== '__all__') {
            const hdr = document.createElement('div');
            hdr.className = 'timeline-node-header';
            const timeSpan = document.createElement('span');
            timeSpan.className = 'timeline-node-time';
            timeSpan.textContent = tb === '__notime__' ? t('status.unknown_time') : formatNodeTime(tb);
            const countSpan = document.createElement('span');
            countSpan.className = 'timeline-node-count muted';
            countSpan.textContent = `${tbScenes.length} 个场景`;
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

      // ---- 主文件夹渲染循环 ----
      for (const fk of folderOrder) {
        const fd = folderMap.get(fk);
        const allScenesInFolder = [...fd.buckets.values()].flat();
        let bodyEl; // receives the timeline or flat grid

        if (showFolderHeaders && fd.folderPath) {
          const folderName = folderBaseName(fd.folderPath) || fd.folderPath || t('folder.group_unknown');
          const collapsed = collapsedFolders.has(fk);

          const groupEl = document.createElement('div');
          groupEl.className = 'folder-group';

          const hdr = document.createElement('div');
          hdr.className = 'folder-group-header' + (collapsed ? ' collapsed' : '');
          hdr.innerHTML = `<span class="folder-group-toggle">\u25bc</span><span class="folder-group-name">${escapeHtml(folderName)}</span><span class="folder-group-count muted">${allScenesInFolder.length} 个场景</span>`;

          // 左对齐的次级操作
          const leftActions = document.createElement('div');
          leftActions.className = 'folder-group-left-actions';

          const explorerBtn = document.createElement('button');
          explorerBtn.className = 'action-btn';
          explorerBtn.innerHTML = t('folder.action_open');
          explorerBtn.title = t('folder.action_open_title');
          explorerBtn.addEventListener('click', (ev) => { ev.stopPropagation(); window.pywebview.api.open_file_explorer(fd.folderPath); });
          leftActions.appendChild(explorerBtn);

          const folderOptionsBtn = document.createElement('button');
          folderOptionsBtn.className = 'action-btn';
          folderOptionsBtn.innerHTML = t('folder.action_reset');
          folderOptionsBtn.title = t('folder.action_reset_title');
          folderOptionsBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showFolderOptionsDialog(fd.folderPath); });
          leftActions.appendChild(folderOptionsBtn);

          hdr.appendChild(leftActions);

          // 占位元素把右侧操作推到最右边
          const spacer = document.createElement('div');
          spacer.style.flex = '1';
          hdr.appendChild(spacer);

          // 右对齐的主操作
          const rightActions = document.createElement('div');
          rightActions.className = 'folder-group-right-actions';

          const writeMetaBtn = document.createElement('button');
          writeMetaBtn.className = 'action-btn write-metadata-btn';
          writeMetaBtn.innerHTML = t('folder.action_write_metadata');
          writeMetaBtn.title = t('folder.action_write_metadata_title');
          writeMetaBtn.addEventListener('click', (ev) => { ev.stopPropagation(); writeMetadataForFolder(fd.folderPath); });
          rightActions.appendChild(writeMetaBtn);

          const cullingBtn = document.createElement('button');
          cullingBtn.className = 'action-btn culling-assistant-btn';
          cullingBtn.innerHTML = t('folder.action_open_culling');
          cullingBtn.title = t('folder.action_open_culling_title');
          cullingBtn.addEventListener('click', (ev) => { ev.stopPropagation(); openCullingAssistant(fd.folderPath); });
          rightActions.appendChild(cullingBtn);

          hdr.appendChild(rightActions);

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

    // 根据当前选择更新卡片高亮，并显示或隐藏浮动操作栏
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
        if (lbl) lbl.textContent = t('status.scene_selected', { count: n });
      } else {
        bar.classList.add('hidden');
      }
    }

    // 滚动到网格中的场景卡片，并为其设置键盘焦点
    function _focusGridCard(sceneId) {
      _focusedCardId = String(sceneId);
      document.querySelectorAll('.card.focused').forEach(c => c.classList.remove('focused'));
      const card = sceneGrid.querySelector(`.card[data-scene-id="${CSS.escape(_focusedCardId)}"]`);
      if (card) {
        card.classList.add('focused');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    // 清除焦点卡片高亮
    function _clearGridFocus() {
      _focusedCardId = null;
      document.querySelectorAll('.card.focused').forEach(c => c.classList.remove('focused'));
    }

    // 按 DOM 顺序获取所有可见卡片元素
    function _getVisibleCards() {
      return Array.from(sceneGrid.querySelectorAll('.card[data-scene-id]'));
    }

    // 网格键盘导航：方向键移动焦点，Enter 打开场景对话框
    function _gridKeyHandler(e) {
      if (document.querySelector('dialog[open]')) return;
      if (selectedSceneIds.size > 0) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      const isArrow = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key);
      const isEnter = e.key === 'Enter';
      if (!isArrow && !isEnter) return;
      if (!_focusedCardId) return;

      e.preventDefault();

      if (isEnter) {
        openSceneDialog(_focusedCardId);
        return;
      }

      const cards = _getVisibleCards();
      if (cards.length === 0) return;
      const curIdx = cards.findIndex(c => c.dataset.sceneId === _focusedCardId);
      if (curIdx < 0) return;
      const curCard = cards[curIdx];

      let nextIdx = -1;
      if (e.key === 'ArrowLeft') {
        nextIdx = curIdx - 1;
      } else if (e.key === 'ArrowRight') {
        nextIdx = curIdx + 1;
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const curRect = curCard.getBoundingClientRect();
        const curCenterX = curRect.left + curRect.width / 2;
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < cards.length; i++) {
          if (i === curIdx) continue;
          const r = cards[i].getBoundingClientRect();
          const rowDiff = dir > 0 ? r.top - curRect.top : curRect.top - r.top;
          if (rowDiff < 10) continue;
          const dist = Math.abs(r.left + r.width / 2 - curCenterX) + rowDiff * 2;
          if (dist < bestDist) { bestDist = dist; bestIdx = i; }
        }
        nextIdx = bestIdx;
      }

      if (nextIdx >= 0 && nextIdx < cards.length) {
        _focusGridCard(cards[nextIdx].dataset.sceneId);
      }
    }
    document.addEventListener('keydown', _gridKeyHandler);

    // 合并当前选中的全部场景（必须来自同一文件夹）
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
        alert(t('merge.cross_folder_alert'));
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
      // 更新 scenedata：把非目标场景中的文件名移动到目标场景
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
        setStatus(`已将 ${ids.length} 个场景合并到 #${targetCount}，共更新 ${changed} 行。`);
      }
      selectedSceneIds.clear();
      _lastSelectedIdx = -1;
      updateSelectionUI();
      await renderScenes();
      // 滚动到合并后的场景卡片；若失败则保持当前位置
      const mergedCard = document.querySelector(`.card[data-scene-id="${CSS.escape(mergedSceneId)}"]`);
      if (mergedCard) mergedCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // 在场景对话框中渲染图片，并遵守手动评分过滤与稳定排序
    // ---- 场景对话框 RAW 缩放（点击拖拽缩略图 -> 在 previewBox 中缩放） ----
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
          // 如果当前行仍是激活中的缩放行，则升级预览图源
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

      // 第 1 步：立即显示已加载的缩略图作为占位
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

      // 第 2 步：异步升级到完整导出图或缓存的 RAW
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

      // 第 3 步：在后台启动 RAW 加载
      if (!sceneRawCache.has(key) && !sceneRawLoading.has(key) && hasPywebviewApi) {
        loadSceneRawAsync(row);
      }

      // 显示缩放滑块
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
    // ---- 场景对话框 RAW 缩放结束 ----

    // ── 底片栏场景视图状态 ──
    let currentImageIndex = 0;
    let _currentScene = null; // 当前正在显示的场景对象引用

    function ensureCulledColumn() {
      if (!header.includes('culled')) header.push('culled');
      for (const r of rows) { if (r.culled === undefined) r.culled = ''; }
    }

    function getCullStatus(row) {
      const raw = (row.culled === 'accept' || row.culled === 'reject') ? row.culled : '';
      if (!raw) return '';
      const origin = normalizeCullOrigin(row);
      // 在底片栏/主场景视图中，自动筛片结果不视为最终权威状态。
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

        // 缩略图
        const th = document.createElement('div');
        th.className = 'filmstrip-thumb';
        const img = document.createElement('img');
        img.alt = r.filename || '';
        img.loading = 'lazy';
        lazyLoadImg(img, () => getBlobUrlForPath(r.export_path || r.crop_path, r.__rootPath));
        th.appendChild(img);
        card.appendChild(th);

        // 信息
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

        // 带详细元数据的提示框
        const tip = document.createElement('div');
        tip.className = 'filmstrip-tooltip';
        tip.innerHTML = [
          `<b>${escapeHtml(r.filename || '')}</b>`,
          `物种：${escapeHtml(getSpeciesDisplayName(r.species || 'Unknown'))} (${fmt3(r.species_confidence)})`,
          `Quality: ${fmt3(r.quality)}`,
          `Rating: ${'★'.repeat(rating)}${'☆'.repeat(5 - rating)} ${origin ? `(${origin})` : ''}`,
          cull ? `Status: ${cull === 'accept' ? '✓ Accepted' : '✗ Rejected'}` : '',
        ].filter(Boolean).join('<br>');
        card.appendChild(tip);

        // 点击选中
        card.addEventListener('click', () => {
          if (_splitMode) return; // handled by split mode
          selectFilmstripImage(idx, scene);
        });

        // 悬停时临时预览
        card.addEventListener('mouseenter', () => {
          if (_splitMode) return;
          selectFilmstripImage(idx, scene, true);
        });
        card.addEventListener('mouseleave', () => {
          if (_splitMode) return;
          selectFilmstripImage(currentImageIndex, scene, true);
        });

        // 双击在编辑器中打开
        card.addEventListener('dblclick', (ev) => { ev.stopPropagation(); openInEditor(r); });

        frag.appendChild(card);
      }
      grid.appendChild(frag);

      // 更新场景导航提示
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

      // 若不是悬停预览，则更新底片栏卡片激活状态并滚动到中央
      const grid = el('#imageGrid');
      if (grid && !isHover) {
        grid.querySelectorAll('.filmstrip-card').forEach((c, i) => {
          c.classList.toggle('active', i === idx);
        });
        scrollFilmstripToCenter(idx);
      }

      // 加载导出预览
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

      // 加载裁切预览
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

      // 更新预览面板的接受/拒绝光晕效果
      const exportPanel = el('#scenePreviewExport');
      const cropPanel = el('#scenePreviewCrop');
      const cull = getCullStatus(r);
      [exportPanel, cropPanel].forEach(p => {
        if (!p) return;
        p.classList.remove('scene-accepted', 'scene-rejected');
        if (cull === 'accept') p.classList.add('scene-accepted');
        if (cull === 'reject') p.classList.add('scene-rejected');
      });

      // 更新信息栏
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
              _refreshCurrentFilmstripCard(); // re-renders card classes (borders) + info bar
              renderScenes(); // refresh timeline
            }
          };
        });
      }

      const metaEl = el('#sceneInfoMeta');
      if (metaEl) {
        const sp = decodeEntities(getSpeciesDisplayName(r.species || 'Unknown'));
        const spConf = fmt3(r.species_confidence);
        const fam = decodeEntities(getFamilyDisplayName(r.family || 'Unknown'));
        const famConf = fmt3(r.family_confidence);
        metaEl.textContent = `${sp} (${spConf}) | ${fam} (${famConf}) · Image ${idx + 1} of ${scene.images.length}`;
      }

      // 在信息栏中渲染星级条
      const starsEl = el('#sceneInfoStars');
      if (starsEl) {
        starsEl.innerHTML = '';
        starsEl.appendChild(createStarBar(r));
      }
    }

    // 允许其它代码在筛选或评分变化时刷新场景图片
    window.refreshSceneFilter = function () {
      if (currentSceneId != null && _currentScene) {
        renderFilmstrip(_currentScene);
        selectFilmstripImage(currentImageIndex, _currentScene);
      }
    };

    // 渲染：场景对话框
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
      // 物种
      html += '<span class="scene-tag-label">物种：</span> ';
      if (species.length) {
        for (const sp of species) {
          html += `<span class="${chipClass}" title="${escapeHtml(sp)}">${escapeHtml(getSpeciesDisplayName(sp))}<span class="chip-x" data-remove-species="${escapeHtml(sp)}" title="Remove '${escapeHtml(sp)}'">×</span></span>`;
        }
      } else {
        html += '<span class="muted" style="font-size:11px">—</span>';
      }
      if (_activeTagInputType === 'species' && _activeTagInputSceneId === String(scene.id)) {
        html += `<span class="chip-input-wrap"><input type="text" class="chip-input" id="inlineTagInput" placeholder="物种..." /><button class="chip-commit-btn" title="保存">✓</button></span>`;
      } else {
        html += `<button class="scene-chip-add" data-add-type="species" title="添加物种标签">+</button>`;
      }

      html += '<span class="scene-tag-sep"></span>';

      // 科
      html += '<span class="scene-tag-label">科：</span> ';
      if (families.length) {
        for (const fm of families) {
          html += `<span class="${chipClass}" title="${escapeHtml(fm)}">${escapeHtml(getFamilyDisplayName(fm))}<span class="chip-x" data-remove-family="${escapeHtml(fm)}" title="Remove '${escapeHtml(fm)}'">×</span></span>`;
        }
      } else {
        html += '<span class="muted" style="font-size:11px">—</span>';
      }
      if (_activeTagInputType === 'family' && _activeTagInputSceneId === String(scene.id)) {
        html += `<span class="chip-input-wrap"><input type="text" class="chip-input" id="inlineTagInput" placeholder="科..." /><button class="chip-commit-btn" title="保存">✓</button></span>`;
      } else {
        html += `<button class="scene-chip-add" data-add-type="family" title="添加科标签">+</button>`;
      }

      if (approved) {
        html += '<span class="scene-tag-sep"></span><span class="approval-note" style="font-size:11px">✓ Reviewed</span>';
      }

      tagsEl.innerHTML = html;

      // 绑定删除按钮
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

      // 绑定 (+) 添加按钮
      tagsEl.querySelectorAll('.scene-chip-add').forEach(btn => {
        btn.onclick = () => {
          _activeTagInputType = btn.dataset.addType;
          _activeTagInputSceneId = String(scene.id);
          renderTopbarTags(scene);
          const inp = el('#inlineTagInput');
          if (inp) inp.focus();
        };
      });

      // 绑定内联输入框
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
          // 略微延迟，避免点击提交按钮时被 blur 提前打断
          setTimeout(() => {
            if (document.activeElement === tagsEl.querySelector('.chip-commit-btn')) return;
            if (_activeTagInputType) commit(); 
          }, 150);
        };
        const commitBtn = tagsEl.querySelector('.chip-commit-btn');
        if (commitBtn) commitBtn.onclick = commit;
      }
    }

    // 保留 renderSceneMetaChips 这个别名，以兼容旧调用方
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

      // ── 顶栏：标题 ──
      const localNum = String(scene.id).split(':').pop();
      const folderName = folderBaseName(scene.representative?.__rootPath || '');
      let titleText = folderName || ('场景 ' + scene.id);
      titleText += ' — #' + localNum;
      if (scene.sceneName) titleText += ' — ' + scene.sceneName;
      titleText += `（${scene.images.length} 张图片）`;
      const titleEl = el('#sceneTopbarTitle');
      if (titleEl) titleEl.textContent = titleText;

      // ── 重命名初始化 ──
      el('#sceneName').value = scene.sceneName || '';
      el('#sceneRenameInline').classList.add('hidden');

      // ── 铅笔重命名按钮 ──
      el('#scenePencilBtn').onclick = () => {
        const renameRow = el('#sceneRenameInline');
        const isShown = !renameRow.classList.contains('hidden');
        if (isShown) {
          // 应用重命名
          applySceneName(scene.id, el('#sceneName').value);
          renameRow.classList.add('hidden');
          // 更新标题
          const updScene = reloadScene(scene.id) || scene;
          const nm = updScene.sceneName || '';
          let t = folderName || ('场景 ' + scene.id);
          t += ' — #' + localNum;
          if (nm) t += ' — ' + nm;
          t += `（${scene.images.length} 张图片）`;
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

      // ── 标签 ──
      renderTopbarTags(scene);

      // ── 快捷键说明切换 ──
      el('#sceneShortcutBtn').onclick = () => {
        el('#sceneShortcutLegend').classList.toggle('hidden');
      };
      el('#sceneShortcutLegend').classList.add('hidden');

      // ── 底片栏 ──
      renderFilmstrip(scene);

      // 为底片栏接入鼠标滚轮横向滚动
      const grid = el('#imageGrid');
      if (grid) {
        grid.onwheel = (ev) => {
          if (ev.deltaY !== 0) {
            grid.scrollLeft += ev.deltaY;
            ev.preventDefault();
          }
        };
      }

      // ── 导出预览上的 RAW 缩放（在导出预览框内按下鼠标） ──
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

      // ── 关闭 ──
      el('#closeDlg').onclick = () => {
        if (_splitMode) { exitSplitMode(); }
        const closingId = _currentScene ? String(_currentScene.id) : null;
        _sceneEditDraft = null;
        _sceneEditMode = false;
        _currentScene = null;
        document.removeEventListener('keydown', _sceneKeyHandler);
        sceneDlg.close();
        if (closingId) _focusGridCard(closingId);
      };

      // ── 拆分场景 ──
      el('#splitSceneBtn').onclick = () => {
        if (_splitMode) {
          applySplitScene(scene);
        } else {
          enterSplitMode(scene);
        }
      };

      // ── 场景导航提示 ──
      const hintL = el('#filmstripHintLeft');
      const hintR = el('#filmstripHintRight');
      if (hintL) hintL.onclick = () => navigateToScene(-1);
      if (hintR) hintR.onclick = () => navigateToScene(1);

      // ── 键盘处理逻辑 ──
      document.removeEventListener('keydown', _sceneKeyHandler);
      document.addEventListener('keydown', _sceneKeyHandler);

      // ── 显示对话框并选中起始图片 ──
      sceneDlg.showModal();
      await selectFilmstripImage(startIndex, scene);
    }

    // 跳转到上一个/下一个场景，使用基于 ID 的查找，
    // 因此即使 scenes 被自动刷新或 renderScenes 重建也不会失效。
    function navigateToScene(direction, startIndex = 0) {
      if (!_currentScene) return;
      const curId = String(_currentScene.id);
      const idx = scenes.findIndex(s => String(s.id) === curId);
      if (idx < 0) return;
      const newIdx = idx + direction;
      if (newIdx < 0 || newIdx >= scenes.length) return;
      const nextScene = scenes[newIdx];
      _sceneEditDraft = null;
      _sceneEditMode = false;
      document.removeEventListener('keydown', _sceneKeyHandler);
      sceneDlg.close();
      openSceneDialog(nextScene.id, startIndex);
    }

    // 场景对话框的键盘处理逻辑
    function _sceneKeyHandler(e) {
      // 若焦点在 input/textarea/select 中则跳过
      // （内联标签输入框自行处理 Esc/Enter）
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      if (!_currentScene) return;

      const images = _currentScene.images;
      const len = images.length;

      // Tab 跳到下一个场景；Ctrl+Tab 跳到上一个场景
      if (e.key === 'Tab') {
        e.preventDefault();
        navigateToScene(e.ctrlKey ? -1 : 1, 0);
        return;
      }

      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          if (e.ctrlKey) {
            // 跳到当前场景末尾；若已经在末尾，则跳到下一个场景开头
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
            // 跳到当前场景开头；若已经在开头，则跳到上一个场景开头
            if (currentImageIndex > 0) {
              selectFilmstripImage(0, _currentScene);
            } else {
              navigateToScene(-1, 0);
            }
          } else {
            if (currentImageIndex > 0) {
              selectFilmstripImage(currentImageIndex - 1, _currentScene);
            } else {
              // 当前已是第一张图，则跳到上一个场景的最后一张图
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
            setCullStatus(images[currentImageIndex], 'accept');
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
            setCullStatus(images[currentImageIndex], 'reject');
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

    // 状态或评分变化后，刷新当前底片栏卡片与信息栏
    function _refreshCurrentFilmstripCard() {
      if (!_currentScene) return;
      // 重新渲染底片栏，更新卡片类名
      renderFilmstrip(_currentScene);
      // 重新选中当前图片，刷新预览与信息栏
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
      // 在 scenedata 中持久化场景名称（pywebview 模式）
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

    // --- 物种与科标签编辑辅助函数 ---
    function markDirty() {
      attemptAutoSave();
    }

    function _syncSceneUserTags() {
      // 标签编辑先停留在当前编辑会话草稿中，直到用户点击完成编辑。
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

    // --- 场景拆分辅助函数 ---
    let _splitSelected = new Set();

    function enterSplitMode(scene) {
      _splitMode = true;
      _splitSelected.clear();
      el('#splitSceneBtn').textContent = '根据所选内容创建新场景';
      showToast('点击图片以选中它们加入新场景，然后点击“根据所选内容创建新场景”', 4000);
      // 重新渲染图片，并显示复选框
      renderSceneImagesWithSplit(scene);
    }

    function exitSplitMode() {
      _splitMode = false;
      _splitSelected.clear();
      el('#splitSceneBtn').textContent = '拆分场景\u2026';
      // 重新渲染图片，并去掉复选框
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
      
      // 为拆分临时按文件名排序图片
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

        // 拆分选择用复选框
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

        // 缩略图
        const th = document.createElement('div');
        th.className = 'filmstrip-thumb';
        const img = document.createElement('img');
        img.alt = r.filename || '';
        img.loading = 'lazy';
        lazyLoadImg(img, () => getBlobUrlForPath(r.export_path || r.crop_path, r.__rootPath));
        th.appendChild(img);
        card.appendChild(th);

        // 信息
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

        // 点击卡片切换选中状态
        card.addEventListener('click', (ev) => {
          if (ev.target === cb) return; // checkbox handles itself
          cb.checked = !cb.checked;
          cb.onchange();
          
          // 同时设为当前激活项，并按原始索引更新预览
          selectFilmstripImage(origIdx, scene);
        });

        // 带详细元数据的提示框
        const tip = document.createElement('div');
        tip.className = 'filmstrip-tooltip';
        tip.innerHTML = [
          `<b>${escapeHtml(r.filename || '')}</b>`,
          `物种：${escapeHtml(getSpeciesDisplayName(r.species || '未知'))} (${fmt3(r.species_confidence)})`,
          `质量：${fmt3(r.quality)}`,
          `评分：${'★'.repeat(rating)}${'☆'.repeat(5 - rating)}`,
        ].filter(Boolean).join('<br>');
        card.appendChild(tip);

        frag.appendChild(card);
      }
      grid.appendChild(frag);
      updateFilmstripHints(scene);
      
      // 默认选中第一张或当前这张，用于显示预览
      if (images.length > 0) {
        selectFilmstripImage(currentImageIndex < images.length ? currentImageIndex : 0, scene);
      }
    }

    function applySplitScene(scene) {
      if (_splitSelected.size === 0) {
        showToast('至少选择一张图片后才能拆分出新场景', 3000);
        return;
      }
      if (_splitSelected.size === scene.images.length) {
        showToast('不能移动全部图片，原始场景中至少要保留一张', 3000);
        return;
      }
      // 在同一 folder slot 下找到下一个可用的 scene_count
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
      // 在修改前先快照场景行，以便构建 scenedata 差异
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
        // 更新 scenedata 中的场景归属关系
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
        el('#splitSceneBtn').textContent = '拆分场景\u2026';
        renderScenes();
        // 用剩余图片刷新场景对话框
        const updatedScene = reloadScene(scene.id);
        if (updatedScene) {
          refreshSceneMeta(updatedScene);
          renderFilmstrip(updatedScene);
          selectFilmstripImage(0, updatedScene);
          el('#sceneName').value = updatedScene.sceneName || '';
        }
        showToast(`已将 ${moved} 张图片拆分到新场景 #${newSceneCount}`, 3000);
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

    // 撤销用快照辅助函数
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

    // CSV 读写
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

    // 在所选文件夹中查找 .kestrel/kestrel_database.csv（可递归到子目录）
    async function findKestrelDatabase(dirHandle, maxDepth = 3, depth = 0) {
      // 如果用户直接选择了 .kestrel 文件夹，则直接读取
      if (dirHandle && dirHandle.name === '.kestrel') {
        try {
          const csvHandle = await dirHandle.getFileHandle('kestrel_database.csv');
          return { rootHandle: dirHandle, fileHandle: csvHandle, rootIsKestrel: true };
        } catch (_) {
          // 继续走常规搜索流程
        }
      }
      // 先检查当前文件夹下是否有 .kestrel 文件夹
      try {
        const kestrelDir = await dirHandle.getDirectoryHandle('.kestrel');
        const csvHandle = await kestrelDir.getFileHandle('kestrel_database.csv');
        return { rootHandle: dirHandle, fileHandle: csvHandle, rootIsKestrel: false };
      } catch (_) {
        // 当前层未找到，继续向下搜索
      }

      if (depth >= maxDepth) return null;

      // 搜索子文件夹（限制深度）
      try {
        for await (const entry of dirHandle.values()) {
          if (entry.kind !== 'directory') continue;
          if (entry.name === '.kestrel') continue;
          const found = await findKestrelDatabase(entry, maxDepth, depth + 1);
          if (found) return found;
        }
      } catch (_) {
        // 忽略权限或遍历错误
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
        setStatus(`已加载 .kestrel/kestrel_database.csv（根目录：${rootLabel}）`);
      } catch (e) {
        setStatus('当前文件夹及其子文件夹中未找到 `.kestrel/kestrel_database.csv`。你可以使用“打开文件夹…”或直接尝试打开 CSV。');
        alert(t('folder.analysis_missing_alert'));
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

      // 将一组行序列化为 CSV 字符串（排除内部 __ 键）
      function rowsToCsvString(colList, rowList) {
        const lines = [colList.join(',')];
        for (const r of rowList) lines.push(colList.map(k => csvEscape(k in r ? r[k] : '')).join(','));
        return lines.join('\r\n');
      }

      // FSAPI 模式（浏览器）：单个文件句柄
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

      // pywebview 桌面模式：同时保存 CSV 行状态与 scenedata JSON。
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
            // 将筛片/评分列写回 CSV，保证筛片助手和重新加载时读到的是权威状态。
            const sd = _normalizeScenedataForSave(rp, groupRows);
            const content = rowsToCsvString(exportCols, groupRows);
            if (typeof window.pywebview.api.write_kestrel_state === 'function') {
              const stateRes = await window.pywebview.api.write_kestrel_state(rp, content, sd);
              if (!stateRes?.success) throw new Error(stateRes?.error || 'Failed to save Kestrel state');
            } else {
              // 兼容旧版后端：分别写入，但后端单文件写入也已升级为原子替换。
              if (typeof window.pywebview.api.write_kestrel_csv === 'function') {
                const csvRes = await window.pywebview.api.write_kestrel_csv(rp, content);
                if (!csvRes?.success) throw new Error(csvRes?.error || 'Failed to write kestrel_database.csv');
              }
              const res = await window.pywebview.api.write_kestrel_scenedata(rp, sd);
              if (!res?.success) throw new Error(res?.error || 'Failed to write kestrel_scenedata.json');
            }
            saved++;
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

    // 用户尝试关闭或刷新时，对未保存改动进行提示
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

    // 在页面完全卸载时，尽量通知后端执行关闭
    window.addEventListener('unload', () => {
      try {
        const backendUrl = getSetting('backendUrl', window.location.origin).replace(/\/$/, '');
        const headers = { 'Content-Type': 'application/json' };
        if (window.__BRIDGE_TOKEN) headers['X-Bridge-Token'] = window.__BRIDGE_TOKEN;
        navigator.sendBeacon && navigator.sendBeacon(backendUrl + '/shutdown', new Blob([JSON.stringify({ reason: 'page_unload' })], { type: 'application/json' }));
        // 回退方案（尽力而为，某些浏览器可能会忽略）
        fetch(backendUrl + '/shutdown', { method: 'POST', keepalive: true, headers, body: JSON.stringify({ reason: 'page_unload' }) }).catch(() => { });
      } catch (_) { }
    });

    // 添加可拖拽分隔条，用于调整右侧预览面板宽度
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
          const newW = Math.round(rect.right - ev.clientX); // 鼠标到右边缘的距离
          const min = 260; // 右侧面板最小宽度
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

    // 设置存储
    const SETTINGS_KEY = 'kestrel-webviz-settings-v1';
    let _autoSaveEnabled = true;  // 缓存值，避免重复读取
    let _autoSaveTimer = null;     // 自动保存的防抖计时器
    
    function loadSettings() {
      try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
    }
    function saveSettings(obj) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(obj || {})); }
    function getSetting(k, def) { const s = loadSettings(); return (k in s) ? s[k] : def; }
    
    // 自动保存逻辑：启用自动保存时进行防抖写入
    async function attemptAutoSave() {
      dirty = true;
      _notifyDirty(true);
      el('#saveCsv').disabled = false;
      el('#revertCsv').disabled = false;
      
      if (!_autoSaveEnabled) {
        return;  // 使用保存/还原流程，交由用户手动点击保存按钮
      }
      
      // 使用防抖，避免每次键入/修改都触发保存（空闲 2 秒后再保存）
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
          _updateSaveRevertVisibility();
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
      // 如果已保存的编辑器不在下拉选项中，则按自定义处理
      if (editorSelect.value !== editor) {
        editorSelect.value = 'custom';
      }
      customPath.value = getSetting('customEditorPath', '');
      const isCustom = editorSelect.value === 'custom';
      customRow.classList.toggle('hidden', !isCustom);
      customHint.classList.toggle('hidden', !isCustom);
      // 选择变化时显示或隐藏自定义路径行
      editorSelect.onchange = () => {
        const c = editorSelect.value === 'custom';
        customRow.classList.toggle('hidden', !c);
        customHint.classList.toggle('hidden', !c);
      };
      // 浏览按钮
      document.getElementById('customEditorBrowse').onclick = async () => {
        if (window.pywebview?.api?.choose_application) {
          const path = await window.pywebview.api.choose_application();
          if (path) customPath.value = path;
        } else {
          showToast('Browse is only available in the desktop app', 3000);
        }
      };
      document.getElementById('treeScanDepth').value = getSetting('treeScanDepth', 3);
      // 评分配置
      const profileSelect = document.getElementById('ratingProfile');
      if (profileSelect) profileSelect.value = getSetting('rating_profile', 'balanced');
      // 检测置信度阈值
      const dtEl = document.getElementById('detectionThreshold');
      if (dtEl) dtEl.value = getSetting('detection_threshold', 0.75);
      // 场景分组时间阈值
      const sttEl = document.getElementById('sceneTimeThreshold');
      if (sttEl) sttEl.value = getSetting('scene_time_threshold', 1.0);
      // Mask 阈值
      const maskThEl = document.getElementById('maskThreshold');
      if (maskThEl) maskThEl.value = getSetting('mask_threshold', 0.5);
      // RAW 预览缓存
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
      
      // 显示总影响（已分析照片数量），从 localStorage 设置中读取
      const totalPhotos = getSetting('kestrel_impact_total_files', 0);
      const impactEl = document.getElementById('settingsTotalImpact');
      if (impactEl) {
        impactEl.textContent = totalPhotos > 0 ? totalPhotos.toLocaleString() + ' photos' : '0 photos';
      }
      
      // 自动保存设置
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
      const profileEl = document.getElementById('ratingProfile');
      const ratingProfile = profileEl ? profileEl.value : 'balanced';
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
      // 合并到现有设置中，保留 machine_id / analytics_consent_shown 等键
      const existing = loadSettings();
      const prevProfile = existing.rating_profile || 'balanced';
      const settings = {
        ...existing, editor, customEditorPath, treeScanDepth,
        analytics_opted_in: analyticsOptIn, analytics_consent_shown: true,
        rating_profile: ratingProfile,
        detection_threshold: detectionThreshold,
        scene_time_threshold: sceneTimeThreshold,
        mask_threshold: maskThreshold,
        raw_preview_cache_enabled: rawPreviewCacheEnabled,
        auto_save_enabled: autoSaveEnabled,
        raw_exposure_correction_disabled: document.getElementById('rawExposureCorrectionDisabled').checked,
      };
      _autoSaveEnabled = autoSaveEnabled;
      _updateSaveRevertVisibility();
      // 立即把设置写入 localStorage
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
      // 如果评分配置已变化且当前已加载文件夹，则立即重新应用
      if (ratingProfile !== prevProfile && rows.length > 0) {
        await reapplyNormalizationForLoadedFolders();
      }
    }

    /** 为当前所有已加载文件夹重新计算 normalized_rating，并刷新视图。 */
    async function reapplyNormalizationForLoadedFolders() {
      if (!hasPywebviewApi || !window.pywebview?.api?.apply_normalization) return;
      // 收集所有已加载行的唯一根路径
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

    /** 根据是否启用自动保存，显示或隐藏 Save/Revert 区域。 */
    function _updateSaveRevertVisibility() {
      const wrap = document.getElementById('saveRevertWrap');
      if (!wrap) return;
      if (_autoSaveEnabled) {
        wrap.classList.add('hidden');
      } else {
        wrap.classList.remove('hidden');
      }
    }

    /** 将设置保存按钮标记为脏（黄色）或干净。 */
    function _setSettingsDirty(dirty) {
      const btn = document.getElementById('settingsSave');
      if (!btn) return;
      if (dirty) btn.classList.add('dirty'); else btn.classList.remove('dirty');
    }

    // 追踪设置对话框内的改动，用于高亮保存按钮
    document.getElementById('settingsDlg').addEventListener('change', () => _setSettingsDirty(true));
    document.getElementById('settingsDlg').addEventListener('input', () => _setSettingsDirty(true));

    document.getElementById('openSettings').addEventListener('click', showSettings);
    document.getElementById('settingsSave').addEventListener('click', async () => {
      await applySettings();
      _setSettingsDirty(false);
    });
    document.getElementById('settingsCancel').addEventListener('click', () => {
      document.getElementById('settingsDlg').close();
      _setSettingsDirty(false);
    });

    // ── 侧边栏调宽 ────────────────────────────────────────────────────────
    (function initSidebarResize() {
      const resizer = document.getElementById('sidebarResizer');
      const sidebar = document.querySelector('header');
      if (!resizer || !sidebar) return;

      let dragging = false;
      let startX = 0;
      let startW = 0;

      resizer.addEventListener('mousedown', (e) => {
        dragging = true;
        startX = e.clientX;
        startW = sidebar.getBoundingClientRect().width;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!dragging) return;
        const delta = e.clientX - startX;
        const newW = Math.max(260, Math.min(600, startW + delta));
        sidebar.style.width = newW + 'px';
        sidebar.style.flex = '0 0 ' + newW + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      });
    })();

    // ─── 统计辅助函数 ────────────────────────────────────────────────────
    /** 将单个键合并进持久化设置（localStorage + pywebview）。 */
    function mergeSetting(k, v) {
      const s = loadSettings();
      s[k] = v;
      saveSettings(s);
      if (hasPywebviewApi && window.pywebview?.api?.save_settings_data) {
        try { window.pywebview.api.save_settings_data(s); } catch (_) { }
      }
    }

    // ─── 反馈对话框 ──────────────────────────────────────────────────────
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

    // 当反馈类型为缺陷报告时，自动勾选日志
    document.getElementById('feedbackType').addEventListener('change', function () {
      document.getElementById('feedbackIncludeLogs').checked = (this.value === 'bug');
    });

    // 截图文件选择器绑定逻辑
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
        document.getElementById('feedbackStatus').textContent = t('feedback.required');
        document.getElementById('feedbackDesc').focus();
        return;
      }
      const sendBtn = document.getElementById('feedbackSend');
      sendBtn.disabled = true;
      document.getElementById('feedbackStatus').textContent = t('feedback.sending');
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
          document.getElementById('feedbackStatus').textContent = t('feedback.sent');
          setTimeout(() => { try { document.getElementById('feedbackDlg').close(); } catch (_) { } }, 1200);
        } else {
          document.getElementById('feedbackStatus').textContent = t('feedback.failed');
        }
      } catch (e) {
        document.getElementById('feedbackStatus').textContent = t('feedback.failed_with_reason', { message: e.message || e });
      } finally {
        sendBtn.disabled = false;
      }
    }

    document.getElementById('openFeedback').addEventListener('click', openFeedbackDialog);
    document.getElementById('feedbackCancel').addEventListener('click', () => document.getElementById('feedbackDlg').close());
    document.getElementById('feedbackSend').addEventListener('click', submitFeedback);

    // ─── 统计分析授权对话框 ─────────────────────────────────────────────
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

    // ─── 捐助 / 支持 ──────────────────────────────────────────────────────
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
      // 从持久化设置中读取（保存于 settings.json）
      return getSetting('kestrel_donate_thresholds_shown', []);
    }
    function _saveDonateThresholdsShown(arr) {
      // 同时写入 localStorage 与后端设置（最终持久化到 settings.json）
      const existing = loadSettings();
      const settings = { ...existing, kestrel_donate_thresholds_shown: arr };
      saveSettings(settings);
      // 持久化到后端（settings.json）
      if (hasPywebviewApi && window.pywebview?.api?.save_settings_data) {
        try { window.pywebview.api.save_settings_data(settings); } catch (_) { }
      }
    }

    function showDonatePrompt(totalFiles) {
      const countEl = document.getElementById('donateCountDisplay');
      // 向下取最近的里程碑，用于“超过 N 张照片”的文案展示
      const thresholds = [1000, 5000, 10000, 25000, 50000, 100000, 200000];
      let milestone = totalFiles || 0;
      for (let i = thresholds.length - 1; i >= 0; i--) {
        if (milestone >= thresholds[i]) { milestone = thresholds[i]; break; }
      }
      if (countEl) countEl.textContent = milestone.toLocaleString();
      const dlg = document.getElementById('donateDlg');
      // 仅在当前没有其它打开的对话框时显示
      if (dlg && !document.querySelector('dialog[open]')) dlg.showModal();
    }

    /** 检查累计总数是否跨过捐助里程碑。应在某个文件夹分析完成后调用。 */
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
            // 略微延迟，先让队列面板稳定下来
            setTimeout(() => showDonatePrompt(total), 2000);
            break;
          }
        }
      } catch (_) { /* failsafe */ }
    }

    /** 在应用启动时检查捐助阈值（只执行一次）。 */
    async function checkDonationThresholdOnStartup() {
      try {
        // 从 localStorage 读取（与设置对话框使用同一来源）
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
            // 略微延迟后再显示对话框，让 UI 先稳定
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
    // 注意：donateDlg 的按钮监听器在对话框 HTML 后面的内联脚本中绑定，
    // 因为该对话框定义在本脚本块之后，此处尚未进入 DOM。
    // ─── 捐助逻辑结束 ─────────────────────────────────────────────────────

    // 信息对话框：从已打开的照片文件夹（.kestrel）中加载 kestrel_metadata.json
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
        // 添加衍生辅助字段（不改动原始数据）
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

    // 根据 CSV 中的绝对导出/裁切路径推断根目录
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

      // 复用与 getBlobUrlForPath 相同的根目录查找逻辑（缩略图加载已验证可用）
      // 优先级 1：行级根目录（从文件夹加载或多文件夹加载时写入）
      let rootToSend = (row.__rootPath || '').trim();

      // 优先级 2：全局 rootPath（从文件夹加载 CSV 时写入）
      if (!rootToSend && rootPath) {
        rootToSend = rootPath;
      }

      // 优先级 3：设置中的提示路径（用户显式配置）
      if (!rootToSend) {
        rootToSend = (settings.rootHint || '').trim();
      }

      // 优先级 4：从 CSV 内的绝对路径推断
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

    // ── 文件夹树 ──────────────────────────────────────────────────────────────
    let folderTreeRoot = null;       // 扫描树的根目录绝对路径
    let folderTreeData = null;       // API 返回的原始 children 数组
    let folderTreeRootNode = null;   // 合成的根节点 {name, path, has_kestrel, children}
    let folderTreeRootHasKestrel = false;
    let treeExpandedPaths = new Set();
    let treeActivePath = null;       // 当前单独加载的文件夹
    let checkedFolderPaths = new Set(); // 在多文件夹视图中被勾选的文件夹
    let queuedFolderPaths = new Set(); // 加入分析队列的文件夹（对话框内选择）
    let _treeFlatOrder = [];           // 可见树路径的扁平顺序列表，用于范围选择
    let _appVersion = '';              // 当前应用版本，只拉取一次
    let _isFrozenApp = false;          // 是否为冻结版（PyInstaller）构建

    async function scanFolderTree(rootPath) {
      if (!hasPywebviewApi || !window.pywebview?.api?.list_subfolders) return false;
      if (!rootPath) return false;

      // 拉取一次应用版本（用于判断是否为旧版本分析结果）
      if (!_appVersion && window.pywebview?.api?.get_app_version) {
        try {
          const vr = await window.pywebview.api.get_app_version();
          if (vr && vr.success) _appVersion = vr.version || '';
        } catch (e) { /* ignore */ }
      }
      // 拉取一次冻结状态
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
        // 构建合成根节点，让树结构也显示顶层文件夹
        const rootName = rootPath.replace(/\\/g, '/').split('/').filter(Boolean).pop() || rootPath;
        folderTreeRootNode = {
          name: rootName,
          path: rootPath,
          has_kestrel: folderTreeRootHasKestrel,
          kestrel_version: result.root_kestrel_version || '',
          children: folderTreeData,
        };
        // 默认展开根节点
        treeExpandedPaths.add(rootPath);
        renderFolderTree();
        // 启用文件夹树控制按钮，并移除空占位状态
        const treeWrap = document.getElementById('folderTreeWrap');
        treeWrap.classList.remove('folder-tree-empty');
        treeWrap.querySelectorAll('button[disabled]').forEach(b => b.removeAttribute('disabled'));
        return true;
      } catch (e) {
        console.error('[tree] scanFolderTree error:', e);
        return false;
      }
    }

    /** 比较两个 semver 字符串。a < b 返回 -1，相等返回 0，a > b 返回 1。 */
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

    /** 判断某个节点的 kestrel_version 是否早于当前应用版本。 */
    function isVersionOutdated(node) {
      if (!node || !node.has_kestrel || !node.kestrel_version || !_appVersion) return false;
      return compareVersions(node.kestrel_version, _appVersion) < 0;
    }

    /** 在 (x, y) 位置显示给定项目的自定义右键菜单。 */
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
      // 超出屏幕时进行位置修正
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      // 点击外部任意位置时关闭
      setTimeout(() => document.addEventListener('click', dismissContextMenu, { once: true }), 0);
    }

    function dismissContextMenu() {
      const old = document.getElementById('_kestrelCtxMenu');
      if (old) old.remove();
    }

    /** 清除某个文件夹的 kestrel 分析数据（带确认）。 */
    async function clearKestrelDataForFolder(folderPath, folderName, refreshCallback) {
      const confirmed = confirm(t('analysis.clear_confirm', { folder: folderName }));
      if (!confirmed) return;
      try {
        const result = await window.pywebview.api.clear_kestrel_data(folderPath);
        if (result && result.success) {
          showToast(t('analysis.clear_success', { folder: folderName }));
          if (refreshCallback) refreshCallback();
        } else {
          alert(t('analysis.clear_failed', { error: result?.error || 'Unknown error' }));
        }
      } catch (e) {
        alert(t('analysis.clear_failed', { error: e.message || e }));
      }
    }

    function renderFolderTree() {
      const container = document.getElementById('folderTree');
      if (!container || !folderTreeRootNode) return;
      // 重建可见路径的扁平顺序，用于 Shift 范围选择
      _treeFlatOrder = [];
      container.innerHTML = '';
      container.appendChild(buildTreeNode(folderTreeRootNode, _treeFlatOrder));
      // 注意：主文件夹树不要填充计数
      // 主树只用于选择要加载的已分析文件夹
      // 颜色和计数只用于“分析文件夹”对话框中的树
    }

    /** 在不重绘整棵树的前提下，更新主文件夹树中 `path` 对应的一行。
     *  让该节点表现为已有 kestrel 数据（图标 + 复选框），但不改动
     *  当前选择或勾选状态，从而避免打断用户当前视图。
     */
    function updateFolderTreeNode(path) {
      try {
        const norm = p => (p || '').replace(/\\/g, '/');
        const target = norm(path);
        // 找出主文件夹树中与该路径匹配的行
        const rows = Array.from(document.querySelectorAll('#folderTree .tree-node-row'));
        for (const row of rows) {
          const rp = norm(row.dataset.path || '');
          if (rp !== target) continue;
          // 更新类名
          row.classList.remove('no-kestrel');
          row.classList.add('has-kestrel');
          // 记录临时标记，避免后续重扫立刻把它清掉
          try { _tempKestrelPaths.add(norm(path)); } catch (e) { }
          // 更新图标
          const icon = row.querySelector('.tree-icon');
          if (icon) icon.textContent = '▣';
          // 确保复选框存在（但不要自动勾选）
          if (!row.querySelector('.tree-cb')) {
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'tree-cb';
            cb.title = 'Include in multi-folder view';
            cb.checked = _isPathChecked(row.dataset.path);
            cb.addEventListener('change', (e) => {
              e.stopPropagation();
              if (cb.checked) checkedFolderPaths.add(row.dataset.path);
              else checkedFolderPaths.delete(row.dataset.path);
              debouncedAutoLoad();
            });
            // 若图标存在，则插入到图标前面
            if (icon && icon.parentNode) icon.parentNode.insertBefore(cb, icon);
            else row.insertBefore(cb, row.firstChild);
          }
        }
      } catch (e) { /* failsafe */ }
    }

    // 构建单个树节点 DOM 元素。
    // flatOrder 会被原地写入，用于按顺序收集可见路径（供范围选择使用）。
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
      
      const effectiveHasKestrel = subtreeHasKestrel(node) || isInProgress; // 分析进行中也显示复选框
      const outdated = isVersionOutdated(node);
      row.className = 'tree-node-row ' + (effectiveHasKestrel ? 'has-kestrel' : 'no-kestrel') + (outdated ? ' version-outdated' : '') + (isInProgress ? ' in-progress' : '');
      if (node.path === treeActivePath) row.classList.add('active');
      if (isInProgress) row.title = 'Currently analyzing...';
      else if (outdated) row.title = `Analyzed on Kestrel v${node.kestrel_version} (current: v${_appVersion})`;

      // 箭头展开/折叠控件
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

      // 用于加载已分析文件夹或分析进行中文件夹的复选框（蓝色强调）
      let loadCheckbox = null;
      if (node.has_kestrel || isInProgress) {
        loadCheckbox = document.createElement('input');
        loadCheckbox.type = 'checkbox';
        loadCheckbox.className = 'tree-cb';
        loadCheckbox.title = isInProgress ? 'Include in multi-folder view (analyzing now)' : 'Include in multi-folder view';
        loadCheckbox.checked = _isPathChecked(node.path);
        loadCheckbox.addEventListener('change', (e) => {
          e.stopPropagation();
          if (loadCheckbox.checked) checkedFolderPaths.add(node.path);
          else checkedFolderPaths.delete(node.path);
          _updateAutoRefreshTimers();
          debouncedAutoLoad();
        });
      }

      // 文件夹图标
      const icon = document.createElement('span');
      icon.className = 'tree-icon';
      icon.textContent = node.has_kestrel ? '▣' : '▢';

      // 标签
      const label = document.createElement('span');
      label.className = 'tree-label';
      label.textContent = node.name;
      label.title = node.path;

      // 把路径挂到行元素上，便于异步检查
      row.dataset.path = node.path;

      // 数量占位（异步填充）
      const countSpan = document.createElement('span');
      countSpan.className = 'tree-count';
      countSpan.textContent = '';

      row.appendChild(arrow);
      if (loadCheckbox) {
        row.appendChild(loadCheckbox);
      } else {
        // 始终保留固定宽度的占位，让各层级的文件夹图标对齐
        const spacer = document.createElement('span');
        spacer.className = 'tree-cb-spacer';
        row.appendChild(spacer);
      }
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(countSpan);
      wrap.appendChild(row);

      // 子节点容器
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

      // 点击标签或图标即可加载（仅当该节点已有 kestrel 数据时）
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
        // 右键菜单：清除分析数据
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

    // 仅为“分析文件夹”对话框中的树填充文件夹计数。
    // 使用两阶段方案：1）检查所有文件夹；2）应用感知子树状态的淡化与颜色。
    // 颜色含义：绿色=已完成，紫色=已开始但未完成，蓝色=尚未开始但包含图片。
    // 淡化含义：no-photos-deep = 当前文件夹及所有后代都没有图片（整行淡化）。
    //          no-photos-shallow = 当前文件夹无图片，但后代有图片（仅复选框淡化）。
    async function populateAnalyzeFolderCounts() {
      if (!hasPywebviewApi || !window.pywebview?.api?.inspect_folder) return;
      try {
        // 只查询“分析文件夹”对话框中的树节点
        const rows = Array.from(document.querySelectorAll('#analyzeDlgTree .adlg-node-row'));
        const norm = p => (p || '').replace(/\\/g, '/');
        const pathToRows = new Map(); // 标准化路径 -> [row, ...]
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
        // 存储检查结果，供第二阶段使用
        const inspectionMap = new Map(); // 标准化路径 -> { total, processed } | null

        const dlgProgWrap = document.getElementById('analyzeScanProgress');
        const dlgProgFill = document.getElementById('analyzeScanFill');
        const dlgProgLabel = document.getElementById('analyzeScanLabel');
        if (dlgProgWrap) dlgProgWrap.classList.remove('hidden');

        // ── 第 1 阶段：并发检查所有文件夹 ──
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

        // ── 第 2 阶段：应用颜色与感知子树状态的淡化效果 ──
        // 辅助判断：`prefix` 的任意后代是否包含图片？
        function subtreeHasImages(prefix) {
          const pfx = prefix.endsWith('/') ? prefix : prefix + '/';
          for (const [p, info] of inspectionMap) {
            if (p !== prefix && p.startsWith(pfx) && info && info.total > 0) return true;
          }
          return false;
        }

        // 辅助函数：按路径从树节点中查找 kestrel_version
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
                // 检查是否由旧版本分析得到
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
              // 当前文件夹图片数为 0，需要判断使用深度还是浅度淡化
              const hasDescendantImages = subtreeHasImages(np);
              if (hasDescendantImages) {
                // 浅度淡化：仅淡化复选框，不淡化名称/箭头（后代仍有图片）
                row.classList.add('no-photos-shallow');
              } else {
                // 深度淡化：整行淡化（整个子树都没有图片）
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

        // 稍作延迟后隐藏进度条
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

    // ── 文件夹树结束 ───────────────────────────────────────────────────────────

    // ── 分析文件夹对话框 ───────────────────────────────────────────────────

    let _dlgSelected = new Set();
    let _dlgExpandedPaths = new Set();
    let _dlgReanalyze = new Set(); // 已确认允许重新分析的路径（针对已完整分析过的文件夹）

    /** 为“分析文件夹”对话框构建树节点（琥珀色复选框，不带 load-cb）。 */
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
          // 在把已完整分析的文件夹重新加入队列前进行确认
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

      // 旧版本文件夹的版本徽标
      const versionBadge = document.createElement('span');
      if (outdated) {
        versionBadge.style.cssText = 'font-size:10px;color:var(--ok);opacity:0.7;margin-left:4px;font-style:italic;';
        versionBadge.textContent = `v${node.kestrel_version}`;
      }

      // 记录路径供异步检查使用，并加入数量占位
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

      // 右键菜单：清除分析数据
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
                  // 在内存中更新节点状态
                  node.has_kestrel = false;
                  node.kestrel_version = '';
                  // 重新渲染对话框树
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

    /** 渲染“分析文件夹”对话框右侧的队列预览面板。
     *  显示内容包括：运行中项目、待处理项目（可拖拽排序与移除）、以及“将要加入”的选择项。 */
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

          // ── 运行中项目 ──
          if (runningItems.length > 0) {
            hasActiveQueue = true;
            const title = document.createElement('div');
            title.className = 'adlg-queue-section-title';
            title.textContent = t('queue.section_analyzing');
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
              statusEl.textContent = item.total > 0 ? `${item.processed}/${item.total}` : t('queue.starting');
              row.appendChild(nameEl);
              row.appendChild(statusEl);
              runningEl.appendChild(row);
            }
          }

          // ── 待处理项目（拖拽排序 + 取消） ──
          if (pendingItems.length > 0) {
            hasActiveQueue = true;
            const pendTitle = document.createElement('div');
            pendTitle.className = 'adlg-queue-section-title';
            pendTitle.textContent = t('queue.section_pending', { count: pendingItems.length });
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
              grip.title = '拖动以调整顺序';

              const nameEl = document.createElement('span');
              nameEl.className = 'adlg-qi-name';
              nameEl.textContent = item.name;
              nameEl.title = item.path;

              const statusEl = document.createElement('span');
              statusEl.className = 'adlg-qi-status';
              statusEl.textContent = t('queue.pending');

              const removeBtn = document.createElement('button');
              removeBtn.className = 'adlg-qi-remove';
              removeBtn.textContent = '✕';
              removeBtn.title = t('queue.remove_from_queue');
              removeBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (hasPywebviewApi && window.pywebview?.api?.remove_queue_item) {
                  await window.pywebview.api.remove_queue_item(item.path);
                  const s = await apiGetQueueStatus();
                  renderQueuePanel(s);
                  _refreshAnalyzeDlgQueuePreview();
                }
              });

              // 拖拽事件
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

      // ── 将要加入（已选择但尚未入队） ──
      const selected = Array.from(_dlgSelected);
      if (selected.length > 0) {
        const title = document.createElement('div');
        title.className = 'adlg-queue-section-title';
        title.textContent = t('queue.section_add', { count: selected.length });
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
          removeBtn.title = t('queue.remove_from_selection');
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
            if (countEl) countEl.textContent = t('queue.restore_count', { count: _dlgSelected.size });
            if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
            _refreshAnalyzeDlgQueuePreview();
          });
          row.appendChild(nameEl);
          if (_dlgReanalyze.has(path)) {
            const badge = document.createElement('span');
            badge.className = 'adlg-qi-status';
            badge.style.color = '#f0a040';
            badge.style.fontStyle = 'italic';
            badge.textContent = t('queue.reanalyze');
            row.appendChild(badge);
          }
          row.appendChild(removeBtn);
          willAddEl.appendChild(row);
        }
      }

      emptyEl.classList.toggle('hidden', hasActiveQueue || selected.length > 0);
    }

    /** 打开“分析文件夹…”对话框。 */
    async function openAnalyzeDialog() {
      if (!hasPywebviewApi) {
        alert(t('queue.desktop_only'));
        return;
      }
      // 确保当前有可供浏览的树
      if (!folderTreeRootNode) {
        const fp = await window.pywebview.api.choose_directory();
        if (!fp) return;
        await scanFolderTree(fp);
        if (!folderTreeRootNode) return;
      }
      // 在冻结版（PyInstaller）构建中隐藏 GPU 复选框，因为那里不支持 GPU
      const gpuLabel = document.getElementById('analyzeGpuLabel');
      if (gpuLabel) {
        gpuLabel.style.display = _isFrozenApp ? 'none' : '';
        if (_isFrozenApp) {
          const gpuCb = document.getElementById('analyzeUseGpu');
          if (gpuCb) gpuCb.checked = false;
        }
      }
      // 用之前已排队的路径初始化对话框中的已选集合
      _dlgSelected = new Set(queuedFolderPaths);
      
      // 如果有上次的队列状态，则尝试恢复
      const savedQueue = getSetting('lastQueueState', null);
      if (savedQueue && Array.isArray(savedQueue) && savedQueue.length > 0) {
        const restoreBtn = document.getElementById('analyzeDlgRestoreQueue');
        if (restoreBtn) {
          restoreBtn.style.display = '';
          restoreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            _dlgSelected = new Set(savedQueue);
            // 从设置中恢复队列，让界面也呈现为已恢复状态
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
        if (countEl) countEl.textContent = t('queue.restore_count', { count: _dlgSelected.size });
        if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
        _refreshAnalyzeDlgQueuePreview();
      }

      const treeEl = document.getElementById('analyzeDlgTree');
      treeEl.innerHTML = '';
      treeEl.appendChild(buildAnalyzeDlgNode(folderTreeRootNode, _dlgSelected, refreshDlg));
      // 为对话框节点填充数量、颜色与进度条
      populateAnalyzeFolderCounts();
      refreshDlg();
      document.getElementById('analyzeQueueDlg').showModal();
    }

    // ── 分析队列面板 / 轮询 ───────────────────────────────────────────

    let _queuePollingTimer = null;
    let _queuePanelExpanded = true;
    let _queueLastDoneSet = new Set(); // 记录刚完成的文件夹，用于自动刷新树
    let _queueLastRunningSet = new Set(); // 记录刚开始运行的文件夹，用于更新树
    let _tempKestrelPaths = new Set(); // 临时标记路径，避免 UI 闪烁
    let _analyticsConsentPending = false; // 防止统计授权对话框重复弹出
    let _queueCountsTimer = null; // 从队列刷新文件夹计数的定时器
    
    // 记录进行中的文件夹，并为实时更新控制自动刷新
    let _inProgressFolderPaths = new Set(); // 处于 pending/running 状态的文件夹
    let _autoRefreshTimers = new Map(); // path -> 自动刷新监听器的 intervalId
    let _inProgressFoldersCheckedCount = 0; // 当前已勾选的进行中文件夹数量
    let _isFirstQueueStart = true; // 用于区分自动加载逻辑中的 Case 1 / Case 2
    
    // ETA 计算的会话状态：记录从文件夹检查得到的基线数据
    let _queueSessionStartState = new Map(); // path -> { initialProcessed: int, totalImages: int, toAnalyze: int }
    let _queueFolderInspections = new Map(); // path -> inspect_folder/inspect_folders 返回的完整检查数据
    // ETA 平滑处理：使用指数移动平均，避免每张图的波动过大
    let _etaSmoothed = null;   // 平滑后的每张图耗时
    let _etaLastPath = null;   // 文件夹变化时重置 EMA
    const _thumbCache = new Map();    // relPath+'|'+rootPath -> dataUrl（避免重载闪烁）
    let _liveAnalysisDlgOpen = false;
    let _liveLastThumbKey = '';
    let _liveLastOverlayKey = '';
    let _liveLastCropKeys = [];
    const CONF_HIGH = 0.75;
    const CONF_LOW = 0.30;

    /** 调用后端（pywebview API 或 HTTP）启动队列。 */
    async function apiStartQueue(paths, useGpu = true, wildlifeEnabled = true) {
      if (hasPywebviewApi && window.pywebview?.api?.start_analysis_queue) {
        return window.pywebview.api.start_analysis_queue(JSON.stringify(paths), useGpu, wildlifeEnabled);
      }
      // HTTP 回退方案（浏览器模式）
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

    /** 将秒数格式化为可读字符串，例如 "2m 30s"。 */
    function formatDuration(secs) {
      if (!isFinite(secs) || secs < 0) return '–';
      secs = Math.round(secs);
      if (secs < 60) return secs + 's';
      const m = Math.floor(secs / 60), s = secs % 60;
      if (m < 60) return m + 'm ' + (s > 0 ? s + 's' : '');
      const h = Math.floor(m / 60), rm = m % 60;
      return h + 'h ' + (rm > 0 ? rm + 'm' : '');
    }

    /** 根据状态对象渲染队列面板。 */
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

      // 队列运行期间，保持短周期轮询以更新文件夹行状态
      if (running) startQueueCountsPoll(); else stopQueueCountsPoll();

      if (!hasItems && !running) {
        panel.classList.add('hidden');
        if (overallEtaEl) overallEtaEl.classList.add('hidden');
        stopPollingQueue();
        return;
      }

      panel.classList.remove('hidden');

      // 徽标
      const runningItems = items.filter(i => i.status === 'running');
      const pendingItems = items.filter(i => i.status === 'pending');
      const doneItems = items.filter(i => i.status === 'done');
      if (paused) {
        badge.textContent = t('queue.badge_paused'); badge.className = 'queue-panel-badge paused';
      } else if (running) {
        const cur = runningItems[0];
        if (cur && cur.total > 0) {
          badge.textContent = `${cur.processed} / ${cur.total}`; badge.className = 'queue-panel-badge';
        } else {
          badge.textContent = t('queue.badge_pending', { count: pendingItems.length + runningItems.length }); badge.className = 'queue-panel-badge';
        }
      } else if (doneItems.length === items.length && items.length > 0) {
        badge.textContent = t('queue.badge_done'); badge.className = 'queue-panel-badge done';
      } else {
        badge.textContent = t('queue.badge_pending', { count: pendingItems.length }); badge.className = 'queue-panel-badge';
      }

      // 暂停/继续按钮文案
      if (pauseBtn) pauseBtn.textContent = paused ? t('queue.resume') : t('queue.pause');

      if (!_queuePanelExpanded) { body.classList.add('hidden'); if (controls) controls.classList.add('hidden'); return; }
      body.classList.remove('hidden'); if (controls) controls.classList.remove('hidden');

      // ETA 计算：基于文件夹检查得到的真实基线，推导运行项的每张图耗时
      const cur = runningItems[0];
      let secsPerImage = null;
      // inspectionReady 表示已拿到该运行中文件夹的检查数据。
      // 在数据到达前完全不显示 ETA（显示“正在计算 ETA…”），避免早期
      // 错误的 progress_cb(alreadyDone, total) 调用产生接近 0 的误导性 ETA。
      const normCurPath = normalizePath(cur?.path);
      const inspectionReady = cur && _queueSessionStartState.has(normCurPath);
      if (cur && inspectionReady && cur.elapsed_seconds > 0) {
        const sess = _queueSessionStartState.get(normCurPath);
        const initialProcessed = sess.initialProcessed || 0;
        const processedThisSession = Math.max(0, (cur.processed || 0) - initialProcessed);
        if (processedThisSession > 0) {
          const rawSecsPerImage = cur.elapsed_seconds / processedThisSession;
          // 如果切换到了不同文件夹，则重置 EMA（比较标准化路径）
          if (_etaLastPath !== normCurPath) { _etaSmoothed = null; _etaLastPath = normCurPath; }
          // 指数移动平均（α=0.15），用于平滑每张图耗时抖动，
          // 同时又不至于落后于真实速度太多
          const alpha = 0.15;
          _etaSmoothed = _etaSmoothed === null ? rawSecsPerImage : alpha * rawSecsPerImage + (1 - alpha) * _etaSmoothed;
          secsPerImage = _etaSmoothed;
        }
      }

      // 如果当前正在加载模型，则显示加载提示（常出现在运行早期）
      if (running && cur) {
        const overallEl = overallEtaEl;
        const loadingMsg = (cur.current_status_msg || '').toLowerCase().includes('load');
        if (loadingMsg || (cur.processed === 0 && cur.current_status_msg)) {
          if (overallEl) { overallEl.textContent = t('queue.loading_analyzer', { message: cur.current_status_msg || t('queue.loading_analyzer_fallback') }); overallEl.classList.remove('hidden'); }
          try { showLoadingAnalyzer(); } catch (e) { }
        } else {
          try { hideLoadingAnalyzer(); } catch (e) { }
        }
      }

      // 总 ETA：基于检查数据统计整个队列剩余图片，提升准确性
      if (overallEtaEl && running && cur) {
        if (!inspectionReady) {
          // 检查数据仍在返回途中，先显示占位提示，避免误导用户
          overallEtaEl.textContent = t('queue.calculating_eta');
          overallEtaEl.classList.remove('hidden');
        } else if (secsPerImage !== null) {
          let totalRemaining = 0;
          for (const item of items) {
            const sess = _queueSessionStartState.get(normalizePath(item.path));
            if (item.status === 'running' && item.total > 0) {
              const remaining = Math.max(0, (item.total || 0) - (item.processed || 0));
              totalRemaining += secsPerImage * remaining;
            } else if (item.status === 'pending') {
              const toAnalyze = sess && typeof sess.toAnalyze === 'number' ? sess.toAnalyze : 200;
              totalRemaining += secsPerImage * toAnalyze;
            }
          }
          if (totalRemaining > 5) {
            overallEtaEl.textContent = t('queue.overall_eta', { time: formatDuration(totalRemaining) });
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

      // 队列项目
      const frag = document.createDocumentFragment();
      for (const item of items) {
        const div = document.createElement('div');
        const isDone = item.status === 'done';
        const isAlreadyAnalyzed = isDone &&
          (item.current_status_msg || '').toLowerCase().includes('no new files');
        div.className = 'queue-item' + (isDone || item.status === 'cancelled' ? ' done-item' : '');

        // 头部行：名称 + 状态徽标
        const hdr = document.createElement('div');
        hdr.className = 'queue-item-header';
        const nameEl = document.createElement('span');
        nameEl.className = 'queue-item-name';
        nameEl.textContent = item.name;
        nameEl.title = item.path;
        const statusEl = document.createElement('span');
        statusEl.className = `queue-item-status ${item.status}`;
        const labels = {
          pending: t('queue.status_pending'),
          running: t('queue.status_running'),
          done: isAlreadyAnalyzed ? t('queue.status_already_done') : t('queue.status_done'),
          error: t('queue.status_error'),
          cancelled: t('queue.status_cancelled'),
        };
        statusEl.textContent = labels[item.status] || item.status;
        if (item.status === 'error' && item.error) statusEl.title = item.error;
        hdr.appendChild(nameEl); hdr.appendChild(statusEl);
        div.appendChild(hdr);

        // 进度条
        if (item.status === 'running' && item.total > 0) {
          const prog = document.createElement('div'); prog.className = 'queue-item-progress';
          const fill = document.createElement('div'); fill.className = 'queue-item-progress-fill';
          fill.style.width = Math.round((item.processed / item.total) * 100) + '%';
          prog.appendChild(fill); div.appendChild(prog);

          // ETA / 暂停状态行
          {
            const etaEl = document.createElement('div');
            etaEl.className = 'queue-item-eta';
            if (item.is_paused) {
              etaEl.textContent = t('queue.eta_paused', { processed: item.processed, total: item.total });
            } else if (!inspectionReady) {
              etaEl.textContent = t('queue.eta_calculating', { processed: item.processed, total: item.total });
            } else if (secsPerImage !== null && item.total > item.processed) {
              const remaining = secsPerImage * (item.total - item.processed);
              etaEl.textContent = t('queue.eta_remaining', { processed: item.processed, total: item.total, time: formatDuration(remaining) });
            } else {
              etaEl.textContent = `${item.processed} / ${item.total}`;
            }
            div.appendChild(etaEl);
          }

          // 当前文件名
          if (item.current_filename) {
            const fileEl = document.createElement('div');
            fileEl.className = 'queue-item-file';
            fileEl.textContent = item.current_filename;
            div.appendChild(fileEl);
          }

          // 实时预览缩略图（等 DOM 插入后再异步加载）
          if (item.current_export_path && hasPywebviewApi) {
            const preview = document.createElement('div');
            preview.className = 'queue-live-preview';
            const thumb = document.createElement('img');
            thumb.className = 'queue-live-thumb';
            thumb.alt = '';
            // 先把路径写入 data 属性，等 DOM 插入后再加载
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

      // 异步加载所有 img[data-thumb-rel] 的缩略图（缓存可避免重载闪烁）
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

      // 检查是否有文件夹刚刚完成，必要时刷新树并自动重载 CSV 数据
      const nowDone = new Set(items.filter(i => i.status === 'done').map(i => i.path));
      let treeRescanNeeded = false;
      for (const p of nowDone) {
        if (!_queueLastDoneSet.has(p)) {
          treeRescanNeeded = true;
          scheduleAutoRefresh(p);
          // 首次有文件夹分析完成时，如果还未询问过，则弹出统计授权
          if (!getSetting('analytics_consent_shown', false)) showAnalyticsConsentDialog();
        }
      }
      if (treeRescanNeeded) {
        setTimeout(() => { if (folderTreeRootNode) rescanFolderTree(folderTreeRootNode.path); }, 1200);
      }
      _queueLastDoneSet = nowDone;

      // 更新进行中文件夹的跟踪与界面状态（pending + running）
      try {
        const norm = p => normalizePath(p);
        const inProgressNow = new Set();
        for (const item of items) {
          if (item.status === 'pending' || item.status === 'running') {
            inProgressNow.add(norm(item.path));
          }
        }
        
        // 识别刚开始运行的项目（首次从 pending 进入 running）
        const runningNow = new Set(items.filter(i => i.status === 'running').map(i => norm(i.path)));
        const runningRawPaths = {};
        items.filter(i => i.status === 'running').forEach(i => { runningRawPaths[norm(i.path)] = i.path; });
        for (const p of runningNow) {
          if (!_queueLastRunningSet.has(p)) {
            _handleFirstFolderAnalysisStart(runningRawPaths[p] || p);
          }
        }
        const prevRunningSet = _queueLastRunningSet;
        _queueLastRunningSet = runningNow;
        
        // 更新进行中集合，并刷新树的样式
        _inProgressFolderPaths = inProgressNow;
        updateInProgressFoldersInTree();
        _updateAutoRefreshTimers();
        
        // 对刚开始运行的项目：500ms 后更新主文件夹树
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

      // 移除已完成文件夹的自动刷新定时器
      try {
        const norm = p => normalizePath(p);
        const nowDone = new Set(items.filter(i => i.status === 'done').map(i => norm(i.path)));
        for (const p of nowDone) {
          if (_autoRefreshTimers.has(p)) {
            clearInterval(_autoRefreshTimers.get(p));
            _autoRefreshTimers.delete(p);
          }
          _autoRefreshForcedPaths.delete(p);
          _autoRefreshLastProcessed.delete(p);
        }
      } catch (e) { console.warn('[timer] cleanup error:', e); }

      // 如果实时分析对话框已打开，则同步刷新
      if (_liveAnalysisDlgOpen) {
        const runningItem = items.find(i => i.status === 'running') || null;
        updateLiveAnalysisDlg(runningItem || items[items.length - 1] || null);
      }
    }

    // 统一标准化路径：去掉结尾斜杠
    function normalizePath(p) {
      if (!p) return '';
      let pp = String(p).trim().replace(/\\/g, '/');
      while (pp && pp[pp.length - 1] in {'\\': 1, '/': 1}) pp = pp.slice(0, -1);
      return pp;
    }

    function getQueueItemByPath(path) {
      const normPath = normalizePath(path);
      const items = Array.isArray(window._lastQueueStatus?.items) ? window._lastQueueStatus.items : [];
      return items.find(item => normalizePath(item.path) === normPath) || null;
    }

    function startPollingQueue() {
      if (_queuePollingTimer) return;
      startAutoRefresh();

      // 通过检查队列中的全部文件夹来初始化会话状态
      // 这样可以得到真实基线，从而更准确地计算 ETA
      (async () => {
        try {
          const status = await apiGetQueueStatus();
          if (status && status.items && status.items.length > 0) {
            // 批量检查所有文件夹，拿到真实的 processed/total 计数
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

      // 使用更高频率轮询，以反映逐张图片的进度（500ms）
      _queuePollingTimer = setInterval(async () => {
        try {
          const status = await apiGetQueueStatus();
          renderQueuePanel(status);
          // 根据暂停状态更新自动刷新定时器
          _updateAutoRefreshTimers();

          // 当有新项目出现时，检查并记录它们的基线状态
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
      // 清理进行中文件夹的自动刷新定时器
      for (const timerId of _autoRefreshTimers.values()) {
        clearInterval(timerId);
      }
      _autoRefreshTimers.clear();
      _autoRefreshPendingPaths.clear();
      _autoRefreshForcedPaths.clear();
      _autoRefreshLastProcessed.clear();
      _inProgressFolderPaths.clear();
      // 清理会话状态
      _queueSessionStartState.clear();
      _queueFolderInspections.clear();
      _etaSmoothed = null;
      _etaLastPath = null;
    }

    // 高频轮询队列状态，并只更新“分析文件夹”对话框中的文件夹行，
    // 将运行项的 processed/total 写进去，从而在分析过程中持续保持
    // 每个文件夹的计数实时可见。
    function startQueueCountsPoll() {
      if (_queueCountsTimer) return;
      _queueCountsTimer = setInterval(async () => {
        try {
          const status = await apiGetQueueStatus();
          if (!status || !status.items) return;
          const items = status.items;
          // 标准化路径辅助函数
          const norm = p => (p || '').replace(/\\/g, '/');
          // 只更新“分析文件夹”对话框中的树行（不更新主文件夹树）
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
              // 更新分析状态类名（partial/full/none），仅作用于分析对话框
              row.classList.remove('analyzed-full', 'analyzed-partial', 'analyzed-none');
              if (it.total && it.total > 0) {
                if ((it.processed || 0) === 0) row.classList.add('analyzed-none');
                else if ((it.processed || 0) >= it.total) row.classList.add('analyzed-full');
                else row.classList.add('analyzed-partial');
              }
            }
          }
          // 队列不再运行时停止轮询
          if (!status.running) stopQueueCountsPoll();
        } catch (_) { }
      }, 500);
    }

    function stopQueueCountsPoll() {
      if (_queueCountsTimer) { clearInterval(_queueCountsTimer); _queueCountsTimer = null; }
    }

    // ── 实时分析详情对话框 ──────────────────────────────────────────

    function openLiveAnalysisDlg() {
      _liveAnalysisDlgOpen = true;
      document.getElementById('liveAnalysisDlg').showModal();
    }

    /**
     * 使用相对路径 + 根目录把图片加载到 <img> 元素中，并复用 _thumbCache。
     * 仅在缓存未命中时才发起网络/IPC 调用。
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

    /** 用运行中（或刚完成）的队列项目数据刷新实时对话框。 */
    function updateLiveAnalysisDlg(item) {
      const dlg = document.getElementById('liveAnalysisDlg');
      if (!dlg || !dlg.open) { _liveAnalysisDlgOpen = false; return; }

      // 头部
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

      // 缩略图
      const thumbEl = document.getElementById('liveDlgThumb');
      if (thumbEl && item.current_export_path) {
        const k = item.current_export_path + '|' + item.path;
        if (_liveLastThumbKey !== k) { _liveLastThumbKey = k; _loadImg(thumbEl, item.current_export_path, item.path); }
      }

      // 检测叠加图
      const overlayEl = document.getElementById('liveDlgOverlay');
      if (overlayEl) {
        if (item.current_overlay_rel) {
          const k = item.current_overlay_rel + '|' + item.path;
          // 实时叠加图总是重新加载（文件内容会被原地覆盖）。
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

      // 裁切卡片
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

      // 确保始终存在 5 个卡片元素
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

        // 检测置信度
        confEl.textContent = i < dets.length
          ? `Conf: ${dets[i].confidence.toFixed(2)}`
          : '–';

        const qVal = i < quality.length ? Number(quality[i].quality) : NaN;
        if (Number.isFinite(qVal) && qVal >= 0) {
          qualityEl.textContent = `Quality: ${qVal.toFixed(3)}`;
        } else {
          qualityEl.textContent = i < crops.length ? 'Quality: …' : 'Quality: —';
        }

        // 实时对话框故意使用原始质量阈值，而不是标准化评分。
        const rawRating = Number.isFinite(qVal) ? _rawQualityToRating(qVal) : 0;
        starsEl.textContent = i < quality.length
          ? _formatStars(rawRating)
          : (i < crops.length ? '…' : '☆☆☆☆☆');

        // 物种
        if (i < species.length) {
          const sp = species[i];
          const spConf = sp.species_confidence ?? 0;
          const fmConf = sp.family_confidence ?? 0;
          spEl.textContent = `${getSpeciesDisplayName(sp.species || '–')} (${spConf.toFixed(2)})`;
          spEl.className = 'ldc-species ' + (spConf >= CONF_HIGH ? 'high-conf' : spConf < CONF_LOW ? 'low-conf' : '');
          fmEl.textContent = sp.family ? `${getFamilyDisplayName(sp.family)} (${fmConf.toFixed(2)})` : '–';
          fmEl.className = 'ldc-family ' + (fmConf >= CONF_HIGH ? 'high-conf' : fmConf < CONF_LOW ? 'low-conf' : '');
        } else {
          spEl.textContent = i < crops.length ? 'Classifying…' : '–';
          spEl.className = i < crops.length ? 'ldc-species low-conf' : 'ldc-species';
          fmEl.textContent = '–'; fmEl.className = 'ldc-family';
        }
      }
    }

    // ── 实时分析详情对话框结束 ─────────────────────────────────────────────────

    // ── 自动刷新：为新分析完成的文件夹静默重载 CSV 数据 ─────────

    let _autoRefreshTimer = null;
    let _autoRefreshPendingPaths = new Set(); // 需要静默重载的路径
    let _autoRefreshForcedPaths = new Set();  // 无论进度是否前进都要重载的路径
    let _autoRefreshLastProcessed = new Map(); // path -> 上次静默重载时看到的 processed 计数
    let _silentRefreshRunning = false;        // 防止 silentRefreshPending 并发执行

    /** 为 `path` 安排一次静默重载（当某个队列项完成时调用）。 */
    function scheduleAutoRefresh(path) {
      const normPath = normalizePath(path);
      if (!normPath) return;
      _autoRefreshPendingPaths.add(normPath);
      _autoRefreshForcedPaths.add(normPath);
    }

    function startAutoRefresh() {
      if (_autoRefreshTimer) return;
      _autoRefreshTimer = setInterval(silentRefreshPending, 7000);
    }

    function stopAutoRefresh() {
      if (_autoRefreshTimer) { clearInterval(_autoRefreshTimer); _autoRefreshTimer = null; }
    }

    /** 对 _autoRefreshPendingPaths 中已勾选的路径执行静默 CSV 重载。 */
    async function silentRefreshPending() {
      if (_autoRefreshPendingPaths.size === 0) return;
      if (_silentRefreshRunning) return;
      _silentRefreshRunning = true;
      try {
        const toRefresh = Array.from(_autoRefreshPendingPaths).filter(p => _isPathChecked(p));
        _autoRefreshPendingPaths.clear();
        if (toRefresh.length === 0) return;

        let changed = false;
        let refreshedCount = 0;
        for (const p of toRefresh) {
          const forceRefresh = _autoRefreshForcedPaths.delete(p);
          const queueItem = getQueueItemByPath(p);
          const currentProcessed = Number.isFinite(Number(queueItem?.processed)) ? Number(queueItem.processed) : null;
          const lastProcessed = _autoRefreshLastProcessed.get(p);
          if (!forceRefresh && currentProcessed !== null && lastProcessed !== undefined && currentProcessed <= lastProcessed) {
            continue;
          }
          try {
            if (!hasPywebviewApi || !window.pywebview?.api?.read_kestrel_csv) continue;
            const result = await window.pywebview.api.read_kestrel_csv(p);
            if (!result.success) continue;
            const parsed = Papa.parse(result.data, { header: true, skipEmptyLines: true });
            const newRows = parsed.data || [];
            const newFields = parsed.meta.fields || [];
            const root = result.root || p;
            const rootN = normalizePath(root);
            for (const f of newFields) if (!header.includes(f)) header.push(f);
            const sample = rows.find(r => normalizePath(r.__rootPath) === rootN);
            const slot = sample ? sample.__folderSlot : rows.length;
            rows = rows.filter(r => normalizePath(r.__rootPath) !== rootN);
            for (const r of newRows) { r.__rootPath = root; r.__folderSlot = slot; }
            rows = rows.concat(newRows);
            if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
              try {
                const sdRes = await window.pywebview.api.read_kestrel_scenedata(root);
                if (sdRes?.success) _scenedata[root] = sdRes.data;
              } catch (_) {}
            }
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
            refreshedCount++;
            if (currentProcessed !== null) _autoRefreshLastProcessed.set(p, currentProcessed);
          } catch (e) {
            console.warn('[autorefresh]', p, e);
            if (forceRefresh) {
              _autoRefreshPendingPaths.add(p);
              _autoRefreshForcedPaths.add(p);
            }
          }
        }

        if (changed) {
          ensureSceneNameColumn();        ensureRatingColumns();        await renderScenes();
          setStatus(t('status.auto_refreshed', { count: refreshedCount }));
        }
      } finally {
        _silentRefreshRunning = false;
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
          const norm = p => normalizePath(p);
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
        const norm = p => normalizePath(p);
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
              cb.checked = _isPathChecked(row.dataset.path);
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

    // Path-insensitive check: does checkedFolderPaths contain a path matching p?
    function _isPathChecked(p) {
      const n = normalizePath(p);
      for (const cp of checkedFolderPaths) {
        if (normalizePath(cp) === n) return true;
      }
      return false;
    }

    /** Start or stop auto-refresh timers for checked in-progress folders. */
    function _updateAutoRefreshTimers() {
      try {
        const queueStatus = window._lastQueueStatus;
        const isPaused = queueStatus && queueStatus.paused;
        const runningPaths = new Set((queueStatus?.items || [])
          .filter(item => item.status === 'running')
          .map(item => normalizePath(item.path)));
        
        if (isPaused) {
          for (const timerId of _autoRefreshTimers.values()) {
            clearInterval(timerId);
          }
          _autoRefreshTimers.clear();
          return;
        }
        
        for (const [path, timerId] of _autoRefreshTimers.entries()) {
          const isStillInProgress = runningPaths.has(path);
          const isStillChecked = _isPathChecked(path);
          if (!isStillInProgress || !isStillChecked) {
            clearInterval(timerId);
            _autoRefreshTimers.delete(path);
          }
        }
        
        for (const inProgPath of _inProgressFolderPaths) {
          if (!runningPaths.has(inProgPath)) continue;
          if (_isPathChecked(inProgPath) && !_autoRefreshTimers.has(inProgPath)) {
            const capturedPath = inProgPath;
            const timerId = setInterval(async () => {
              try {
                const item = getQueueItemByPath(capturedPath);
                if (!item || item.status !== 'running') return;
                const processed = Number.isFinite(Number(item.processed)) ? Number(item.processed) : null;
                const lastProcessed = _autoRefreshLastProcessed.get(capturedPath);
                if (processed !== null && lastProcessed !== undefined && processed <= lastProcessed) return;
                _autoRefreshPendingPaths.add(capturedPath);
                silentRefreshPending();
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
          const np = (n.path || '').replace(/\\/g, '/');
          if (n.has_kestrel && !_inProgressFolderPaths.has(np)) count++;
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
          setStatus('已自动加载正在分析中的文件夹（首次启动且当前没有其他已分析文件夹）');
        }
      } catch (e) { console.warn('[case1] error:', e); }
    }

    // ── 分析队列结束 ────────────────────────────────────────────────────────

    // 使用原生路径加载文件夹的辅助函数（供 pywebview API 使用）
    // 这里只加载单个文件夹；多文件夹加载请见 loadMultipleFolders()。

    // 自动加载：复选框变化后，经过短暂防抖自动触发。
    // 如果没有勾选任何内容，则平滑清空当前视图。
    const debouncedAutoLoad = debounce(async () => {
      if (checkedFolderPaths.size > 0) {
        await loadMultipleFolders(Array.from(checkedFolderPaths));
      } else {
        ++_loadFoldersVersion; // cancel any in-progress load
        rows = []; header = []; scenes = [];
        sceneGrid.innerHTML = '';
        setStatus(t('status.no_folders_selected'));
      }
    }, 400);

    // 递归收集树中的全部 kestrel 路径，用于“全选”
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

    // 进度条辅助函数
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
          // 加载该文件夹的 scenedata
          if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
            try {
              const sdRes = await window.pywebview.api.read_kestrel_scenedata(root);
              if (sdRes?.success) _scenedata[root] = sdRes.data;
            } catch (_) {}
          }
          // 应用标准化（仅在内存中写入 r.__normalized_rating）
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
      showProgress(t('status.building_scenes', { count: loadedCount }), 95);
      // 为兼容单文件夹图片加载，把 rootPath 设为第一个已加载根目录。
      // 多文件夹模式下由逐行 __rootPath 在 getBlobUrlForPath 中负责处理。
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
      setStatus(`已加载 ${label} —— ${rows.length} 张图片`);
    }

    async function loadFolderFromPath(folderPath) {
      if (!folderPath) return;

      try {
        // 使用 pywebview API 读取 CSV 文件
        const result = await window.pywebview.api.read_kestrel_csv(folderPath);

        if (!result.success) {
          throw new Error(result.error || 'Failed to read CSV');
        }

        // 解析 CSV 数据
        const parsed = Papa.parse(result.data, { header: true, skipEmptyLines: true });
        header = parsed.meta.fields || [];
        const loadedRoot = result.root || folderPath;
        rows = (parsed.data || []).map(r => ({ ...r, __rootPath: loadedRoot, __folderSlot: 0 }));
        
        // 加载该文件夹的 scenedata
        if (hasPywebviewApi && window.pywebview?.api?.read_kestrel_scenedata) {
          try {
            const sdRes = await window.pywebview.api.read_kestrel_scenedata(loadedRoot);
            if (sdRes?.success) _scenedata[loadedRoot] = sdRes.data;
          } catch (_) {}
        }
        
        // 应用标准化（仅在内存中写入 r.__normalized_rating）
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

        // 重要：必须先设置 rootPath，再调用 renderScenes，图片加载才会正常
        rootPath = loadedRoot;
        rootDirHandle = null; // Clear handle since we're using Python API
        rootIsKestrel = false;

        // 在 rootPath 已设好的前提下进行渲染
        await renderScenes();

        // 同时写入设置，供打开文件时使用（统一使用 rootHint）
        const settings = loadSettings();
        settings.rootHint = rootPath;
        saveSettings(settings);

        setStatus(t('folder.loaded_from', { path: result.path }));
        const mergeBtn = document.getElementById('openMerge');
        if (mergeBtn) mergeBtn.disabled = true; // Can't save in pywebview mode

        // 如果文件夹树已打开，则更新当前激活项
        if (folderTreeData) {
          const loadedPath = result.root || folderPath;
          treeActivePath = loadedPath;
          checkedFolderPaths.clear();
          checkedFolderPaths.add(loadedPath);
          renderFolderTree();
        }
      } catch (e) {
        const errorMsg = (e.message || String(e)).replace(/^Error: /, '');
        // 如果文件夹树已可见，用户可能是有意点击了父文件夹
        // （其中并没有 .kestrel）。此时给出柔和状态提示，不弹警告框。
        if (folderTreeData) {
          setStatus(t('folder.no_database_in_tree'));
        } else {
          alert(t('folder.database_missing_alert', { error: errorMsg }));
          setStatus(t('folder.load_failed'));
        }
      }
    }

    // 事件绑定
    el('#pickFolder').addEventListener('click', async () => {
      console.log('[DEBUG] Folder picker clicked');
      console.log('[DEBUG] hasPywebviewApi:', hasPywebviewApi);
      console.log('[DEBUG] window.pywebview:', window.pywebview);
      console.log('[DEBUG] window.pywebview?.api:', window.pywebview?.api);

      // 若 pywebview API 尚未就绪，则先等待
      if (!hasPywebviewApi) {
        console.log('[DEBUG] Waiting for pywebview API...');
        const ready = await waitForPywebview();
        console.log('[DEBUG] Pywebview API ready:', ready);
      }
      // 当用户打开一个文件夹时，重置主树中所有已勾选项
      // （等同于点击“取消全选”），避免误载入上一次根目录选择时留下的文件夹。
      try {
        checkedFolderPaths.clear();
        renderFolderTree();
        debouncedAutoLoad(); // Unload current folder (same as Check None)
      } catch (e) { /* ignore */ }

      try {
        // 优先级 1：Python API（桌面应用，全平台）
        // 只要可用，就始终优先使用它以保持行为一致
        if (hasPywebviewApi && window.pywebview?.api?.choose_directory) {
          console.log('[DEBUG] Using Python API for folder picker');
          try {
            setStatus(t('folder.opening_picker'));
            const folderPath = await window.pywebview.api.choose_directory();
            if (folderPath) {
              // 将选中的文件夹作为树根来扫描
              // （用户可能选的是包含多个已分析子目录的父目录，也可能直接选叶子目录）。
              treeExpandedPaths.clear();
              const treeScanned = await scanFolderTree(folderPath);
              // 直接使用 scanFolderTree 返回的 root_has_kestrel 标记
              // （folderTreeRootHasKestrel 会在 scanFolderTree 内部同步设置）。
              // 只有根目录本身就是已分析文件夹时，才尝试加载 CSV。
              if (treeScanned && !folderTreeRootHasKestrel) {
                // 树扫描成功，但根目录没有 .kestrel，说明它是父目录。
                setStatus(t('queue.select_tree_folder'));
              } else {
                // 要么无法扫描树，要么根目录本身就有 .kestrel，此时直接加载。
                await loadFolderFromPath(folderPath);
              }
              return; // Success - Python API handled everything
            } else {
              setStatus(t('folder.selection_cancelled'));
              return; // User cancelled
            }
          } catch (e) {
            console.error('Python API folder picker failed:', e);
            alert(t('folder.picker_failed', { message: e.message || e }));
            setStatus(t('folder.picker_failed_status'));
            return; // Don't fall through - Python API should always work in desktop app
          }
        }

        // 优先级 2：File System Access API（仅浏览器模式）
        // 仅在不处于 pywebview 环境时执行
        if (supportsFS) {
          // 主路径：选择一个文件夹（根目录或 .kestrel）
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
            // 用户可能取消了选择，继续回退到文件选择器
          }

          // 次路径：直接打开 CSV
          try {
            const [fh] = await window.showOpenFilePicker({ types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }] });
            if (!fh) return;
            rootDirHandle = null;
            rootIsKestrel = false;
            rootPath = ''; // Clear rootPath
            await loadCsvFromHandle(fh);
            const mergeBtn = document.getElementById('openMerge');
            if (mergeBtn) mergeBtn.disabled = true;
            setStatus(t('folder.csv_loaded_limited'));
            return;
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.error('showOpenFilePicker failed:', e);
            }
            // 用户取消
          }
          return;
        }

        // 最后兜底：只用文件输入框选择 CSV
        setStatus(t('folder.file_picker_limited'));
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
            setStatus(t('folder.csv_loaded_limited'));
            alert(t('folder.csv_loaded_limited_alert'));
          } catch (e) {
            alert(`Failed to load CSV: ${e.message}`);
            setStatus(t('folder.csv_load_failed'));
          }
        };
        input.click();
      } catch (e) {
        console.error('Unexpected error in pickFolder:', e);
        setStatus(t('folder.unexpected_error'));
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

    // 根据 localStorage 中缓存的设置，应用初始自动保存可见性
    (function initAutoSaveVisibility() {
      _autoSaveEnabled = getSetting('auto_save_enabled', true) !== false;
      _updateSaveRevertVisibility();
    })();

    // “按文件夹分组”开关
    (function initGroupByFolder() {
      const t = document.getElementById('groupByFolder');
      if (!t) return;
      try { t.checked = getSetting('groupByFolder', true); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.groupByFolder = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // “按拍摄时间分组”开关
    (function initGroupByTime() {
      const t = document.getElementById('groupByTime');
      if (!t) return;
      try { t.checked = getSetting('groupByTime', true); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.groupByTime = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // 滚动位置指示器，滚动时显示当前文件夹/时间分组
    (function initScrollPositionIndicator() {
      const mainEl = document.querySelector('main');
      const indicator = document.getElementById('scrollPositionIndicator');
      if (!mainEl || !indicator) return;
      let hideTimer = null;
      mainEl.addEventListener('scroll', () => {
        // 同时跟踪文件夹标题和时间线日期横幅
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

    // 多选合并操作栏
    const selectMergeBtn = document.getElementById('selectMergeBtn');
    if (selectMergeBtn) selectMergeBtn.addEventListener('click', executeSelectionMerge);
    const selectClearBtn = document.getElementById('selectClearBtn');
    if (selectClearBtn) selectClearBtn.addEventListener('click', () => { selectedSceneIds.clear(); _lastSelectedIdx = -1; updateSelectionUI(); });
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !document.querySelector('dialog[open]')) { if (selectedSceneIds.size > 0) { selectedSceneIds.clear(); _lastSelectedIdx = -1; updateSelectionUI(); } _clearGridFocus(); } });
    // 还原按钮
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

    // 初始化工具栏里的“仅场景级手动评分”过滤开关
    (function initScenesManualFilter() {
      const t = document.getElementById('filterScenesManualRated');
      if (!t) return;
      try { t.checked = !!getSetting('onlyManualRatedScenes', false); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.onlyManualRatedScenes = !!t.checked; saveSettings(s);
        renderScenes();
      });
    })();

    // 初始化“包含次级物种/科”开关
    (function initIncludeSecondary() {
      const t = document.getElementById('includeSecondarySpecies');
      if (!t) return;
      try { t.checked = getSetting('includeSecondarySpecies', false); } catch { }
      t.addEventListener('change', () => {
        const s = loadSettings(); s.includeSecondarySpecies = !!t.checked; saveSettings(s); renderScenes();
      });
    })();

    // 合并场景功能
    function computeAllScenesForMerge() {
      // 按 scene_count 分组行数据，并保留基础统计与代表图
      const groups = new Map();
      for (const r of rows) {
        const id = r.scene_count;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(r);
      }
      const list = [];
      for (const [id, arr] of groups) {
        // 选择质量最高的图片作为代表
        let rep = arr[0];
        for (const r of arr) if (parseNumber(r.quality) > parseNumber(rep.quality)) rep = r;
        const maxQ = Math.max(...arr.map(a => parseNumber(a.quality)));
        const rowRp = arr[0]?.__rootPath || rootPath || '';
        const sdScene = rowRp ? _scenedata[rowRp]?.scenes?.[id] : null;
        const name = sdScene?.name || (arr.find(a => (a.scene_name || '').trim().length)?.scene_name || '').trim();
        list.push({ id, imageCount: arr.length, maxQuality: maxQ, sceneName: name, repPath: (rep.export_path || rep.crop_path || ''), repFilename: rep.filename || '' });
      }
      // 尽量按数字 ID 排序
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
        summary.textContent = n < 2 ? '至少选择两个场景后才能合并。' : t('merge.summary', { count: n, target: targetId, images: totalImgs });
        applyBtn.disabled = n < 2 || !targetId;
      }

      // 构建行：[缩略图] [复选框 + 标题] [数量]
      for (const s of sceneList) {
        const row = document.createElement('div');
        row.style.display = 'contents';

        // 缩略图单元格
        const cThumb = document.createElement('div');
        const thumb = document.createElement('div'); thumb.className = 'thumb'; thumb.style.aspectRatio = '16/10';
        const img = document.createElement('img'); img.alt = s.repFilename || '无预览'; img.loading = 'lazy';
        (async () => { const url = await getBlobUrlForPath(s.repPath); if (url) img.src = url; })();
        thumb.appendChild(img); cThumb.appendChild(thumb);

        // 标题 + 复选框单元格
        const cTitle = document.createElement('div');
        const cb = document.createElement('input'); cb.type = 'checkbox'; cb.dataset.id = String(s.id); cb.style.marginRight = '8px';
        cb.addEventListener('change', () => { if (cb.checked) sel.add(cb.dataset.id); else sel.delete(cb.dataset.id); updateSummary(); });
        const title = document.createElement('span'); title.textContent = `${t('merge.scene_label', { id: s.id })}${s.sceneName ? ` — ${s.sceneName}` : ''}`; title.title = title.textContent;
        cTitle.appendChild(cb); cTitle.appendChild(title);

        // 数量单元格
        const cCount = document.createElement('div'); cCount.className = 'muted'; cCount.style.textAlign = 'right'; cCount.textContent = t('merge.images_count', { count: s.imageCount });

        row.appendChild(cThumb); row.appendChild(cTitle); row.appendChild(cCount);
        listEl.appendChild(row);
      }

      // 绑定单选按钮
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
        // 更新 scenedata：将非目标场景中的文件名移动到目标场景
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
        if (changed) { dirty = true; _notifyDirty(true); document.getElementById('saveCsv').disabled = false; setStatus(t('merge.merged_status', { target: targetId, changed })); }
        renderScenes();
        dlg.close();
      };

      updateSummary();
      dlg.showModal();
    }

    // 初始化
    loadVersionBadge();
    setStatus('Open your photo folder (the one that contains .kestrel) or select kestrel_database.csv');
    hydrateSettingsFromServer();

    // 如果页面加载前队列就在运行（例如页面刷新），则重新接上轮询逻辑
    (async () => {
      try {
        const status = await apiGetQueueStatus();
        if (status && (status.items || []).length > 0) {
          renderQueuePanel(status);
          if (status.running) startPollingQueue();
        }
      } catch (_) { }
    })();

    // 绑定树面板中的“更换根目录…”按钮
    const treeChangeRootBtn = document.getElementById('treeChangeRoot');
    if (treeChangeRootBtn) {
      treeChangeRootBtn.addEventListener('click', async () => {
        if (!hasPywebviewApi) { const ready = await waitForPywebview(); if (!ready) return; }
        if (!window.pywebview?.api?.choose_directory) return;
        setStatus(t('folder.opening_picker'));
        const folderPath = await window.pywebview.api.choose_directory();
        if (folderPath) {
          treeExpandedPaths.clear();
          checkedFolderPaths.clear();
          const treeScanned = await scanFolderTree(folderPath);
          if (treeScanned && !folderTreeRootHasKestrel) {
            setStatus(t('queue.select_tree_folder'));
          } else {
            await loadFolderFromPath(folderPath);
          }
        } else {
          setStatus(t('folder.selection_cancelled'));
        }
      });
    }

    // 绑定“全选 / 取消全选”按钮
    const treeCheckAllBtn = document.getElementById('treeCheckAll');
    if (treeCheckAllBtn) treeCheckAllBtn.addEventListener('click', checkAllTreeFolders);
    const treeCheckNoneBtn = document.getElementById('treeCheckNone');
    if (treeCheckNoneBtn) treeCheckNoneBtn.addEventListener('click', checkNoneTreeFolders);

    // 绑定“加载已勾选”按钮（HTML 中已移除，这里保留为空操作保护）
    const treeLoadSelectedBtn = document.getElementById('treeLoadSelected');
    if (treeLoadSelectedBtn) {
      treeLoadSelectedBtn.addEventListener('click', async () => {
        if (checkedFolderPaths.size === 0) return;
        await loadMultipleFolders(Array.from(checkedFolderPaths));
      });
    }

    // ── 分析队列事件绑定 ───────────────────────────────────────────────

    // “分析文件夹…”按钮打开对话框
    const analyzeQueueBtn = document.getElementById('analyzeQueueBtn');
    if (analyzeQueueBtn) {
      analyzeQueueBtn.addEventListener('click', openAnalyzeDialog);
    }

    // 分析对话框：取消
    const analyzeDlgCancel = document.getElementById('analyzeDlgCancel');
    if (analyzeDlgCancel) {
      analyzeDlgCancel.addEventListener('click', () => {
        // 保存当前选择，便于用户下次打开对话框时恢复
        if (_dlgSelected && _dlgSelected.size > 0) {
          const s = loadSettings();
          s.lastQueueState = Array.from(_dlgSelected);
          saveSettings(s);
        }
        document.getElementById('analyzeQueueDlg').close();
      });
    }

    // 分析对话框：加入队列
    const analyzeDlgAdd = document.getElementById('analyzeDlgAdd');
    if (analyzeDlgAdd) {
      analyzeDlgAdd.addEventListener('click', async () => {
        const paths = Array.from(_dlgSelected);
        if (paths.length === 0) return;
        const useGpu = document.getElementById('analyzeUseGpu')?.checked ?? true;
        const wildlifeEnabled = document.getElementById('analyzeWildlife')?.checked ?? false;

        // 检查是否有旧版本文件夹尚未确认允许重新分析
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
          const confirmed = confirm(t('analysis.outdated_confirm', { names, version: _appVersion }));
          if (!confirmed) return;
          // 重新分析前，先清理旧版本文件夹中的 .kestrel
          for (const o of outdatedPaths) {
            try {
              await window.pywebview.api.clear_kestrel_data(o.path);
              // 更新内存中的节点状态
              const node = findNode(folderTreeRootNode, o.path);
              if (node) { node.has_kestrel = false; node.kestrel_version = ''; }
            } catch (e) {
              console.warn('Failed to clear kestrel data for', o.path, e);
            }
          }
        }

        // 对已完整分析且确认重新入队的文件夹，清理其 .kestrel
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
          // 在分析器导入模型（懒加载）期间显示加载遮罩
          showLoadingAnalyzer();
          const result = await apiStartQueue(paths, useGpu, wildlifeEnabled);
          if (result && result.success) {
            queuedFolderPaths.clear();
            _dlgSelected.clear();
            _isFirstQueueStart = true; // reset for Case 1 logic on next queue start
            // 因为即将启动新队列，所以清空已保存的队列状态
            const s = loadSettings();
            delete s.lastQueueState;
            saveSettings(s);
            // 为新队列清空会话状态，让 ETA 使用最新的文件夹检查结果
            _queueSessionStartState.clear();
            _queueFolderInspections.clear();
            startPollingQueue();
            const status = await apiGetQueueStatus();
            renderQueuePanel(status);
            setStatus(t('analysis.queue_started', { count: result.added || paths.length }));
            // 启动轮询；开始处理后 renderQueuePanel 会隐藏加载遮罩。
            // 作为保险，如果 30 秒内仍未开始，也主动隐藏遮罩。
            setTimeout(() => { try { hideLoadingAnalyzer(); } catch (e) { } }, 30000);
          } else {
            hideLoadingAnalyzer();
            alert(t('analysis.queue_start_failed', { error: result?.error || 'Unknown error' }));
          }
        } catch (e) {
          hideLoadingAnalyzer();
          alert(t('analysis.queue_start_failed', { error: e.message || e }));
        } finally {
          analyzeDlgAdd.disabled = false;
        }
      });
    }

    // 分析对话框：“更换文件夹”按钮
    document.getElementById('analyzeDlgChangeRoot')?.addEventListener('click', async () => {
      if (!hasPywebviewApi) { alert(t('analysis.desktop_browse_only')); return; }
      const fp = await window.pywebview.api.choose_directory();
      if (!fp) return;
      await scanFolderTree(fp);
      if (!folderTreeRootNode) return;
      _dlgExpandedPaths = new Set([folderTreeRootNode.path]);
      _dlgSelected.clear();
      function refreshDlg2() {
        const countEl = document.getElementById('analyzeDlgCount');
        const addBtn = document.getElementById('analyzeDlgAdd');
        if (countEl) countEl.textContent = t('queue.restore_count', { count: _dlgSelected.size });
        if (addBtn) addBtn.disabled = _dlgSelected.size === 0;
        _refreshAnalyzeDlgQueuePreview();
      }
      const treeEl = document.getElementById('analyzeDlgTree');
      treeEl.innerHTML = '';
      treeEl.appendChild(buildAnalyzeDlgNode(folderTreeRootNode, _dlgSelected, refreshDlg2));
      populateAnalyzeFolderCounts();
      refreshDlg2();
    });

    // ── 欢迎面板事件绑定 ──────────────────────────────────────────────

    // ── 法律协议逻辑 ──────────────────────────────────────────────
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
            showToast(t('analysis.legal_accepted'), 4000);
          }
        } catch (e) {
          console.error('Failed to agree to legal terms', e);
        }
      });
    }

    // 初始检查
    if (hasPywebviewApi) {
      checkLegalAgreement();
    }

    // 队列面板头部：切换展开 / 折叠
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

    // 暂停 / 继续按钮
    const queuePauseBtn = document.getElementById('queuePauseBtn');
    if (queuePauseBtn) {
      queuePauseBtn.addEventListener('click', async () => {
        try {
          const status = await apiGetQueueStatus();
          if (status.paused) {
            // 恢复时重新检查文件夹，以获得准确基线
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
                      _queueSessionStartState.set(normalizePath(path), {
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

    // 取消按钮
    const queueCancelBtn = document.getElementById('queueCancelBtn');
    if (queueCancelBtn) {
      queueCancelBtn.addEventListener('click', async () => {
        if (!confirm(t('analysis.cancel_queue_confirm'))) return;
        try { await apiQueueControl('cancel'); } catch (_) { }
      });
    }

    // 清除已完成按钮
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

    // ---- 筛片助手启动器 ----
    async function openCullingAssistant(rootPath) {
      if (!window.pywebview?.api) {
        showToast('Culling Assistant requires desktop mode', 4000);
        return;
      }
      // 打开前先提示保存未保存改动（使用自定义对话框）
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
    
    // 用于筛片助手保存决策的自定义对话框
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
        'height:auto',
        'overflow-y:auto',
        'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
      ].join(';');

      dlg.innerHTML = `
        <div style="padding:20px 22px 14px;border-bottom:1px solid #222e45;">
          <div style="font-size:17px;font-weight:700;margin-bottom:4px;">Folder Options</div>
          <div style="color:#7a90b8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(folderPath)}">${escapeHtml(folderName)}</div>
        </div>

        <div style="padding:14px 22px;">
          <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:#5a7099;margin-bottom:10px;">Reset Culling Decisions</div>

          <div class="folder-opt-card" id="folderOptCardVerified" style="
            display:flex;align-items:flex-start;gap:12px;padding:12px 14px;
            border:1px solid #263045;border-radius:8px;background:#1a2235;
            cursor:pointer;margin-bottom:8px;transition:border-color 0.15s,background 0.15s;">
            <div style="margin-top:2px;font-size:16px;line-height:1;">↺</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;">Reset Confirmed Decisions</div>
              <div style="font-size:12px;color:#7a90b8;line-height:1.45;">Clears only Accept/Reject decisions that were <em>Confirmed</em> via the Culling Assistant's finalize step. Manual (user-assigned) decisions are kept.</div>
            </div>
          </div>

          <div class="folder-opt-card" id="folderOptCardAll" style="
            display:flex;align-items:flex-start;gap:12px;padding:12px 14px;
            border:1px solid #3f2020;border-radius:8px;background:#2a1a1a;
            cursor:pointer;margin-bottom:0;transition:border-color 0.15s,background 0.15s;">
            <div style="margin-top:2px;font-size:16px;line-height:1;color:#ff8888;">⊘</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:3px;color:#ffc8c8;">Reset All Decisions</div>
              <div style="font-size:12px;color:#b07878;line-height:1.45;">Clears <strong style="color:#ffaaaa">all</strong> manual and confirmed Accept/Reject decisions for this folder, returning every image to Undecided. Auto-categorized decisions are unaffected.</div>
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
        showToast(changed > 0 ? `Reset ${changed} confirmed decision${changed === 1 ? '' : 's'}` : 'No confirmed decisions to reset', 3000);
        closeAndRemove();
      });

      const cardAll = dlg.querySelector('#folderOptCardAll');
      cardAll.addEventListener('mouseenter', () => { cardAll.style.borderColor = '#7f3f3f'; cardAll.style.background = '#361818'; });
      cardAll.addEventListener('mouseleave', () => { cardAll.style.borderColor = '#3f2020'; cardAll.style.background = '#2a1a1a'; });
      cardAll.addEventListener('click', () => {
        const ok = confirm(`Reset ALL manual and confirmed culling decisions for "${folderName}"?\n\nThis cannot be undone.`);
        if (!ok) return;
        const changed = resetFolderCullState(folderPath, 'all');
        showToast(changed > 0 ? `Reset ${changed} manual/confirmed decision${changed === 1 ? '' : 's'}` : 'No manual or confirmed decisions to reset', 3000);
        closeAndRemove();
      });

      dlg.addEventListener('close', () => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); });
      dlg.showModal();
    }

    // ---- 写入元数据启动器 ----
    async function writeMetadataForFolder(rootPath) {
      if (!window.pywebview?.api) {
        showToast('Write Metadata requires desktop mode', 4000);
        return;
      }
      const folderRows = rows.filter(r => r.__rootPath === rootPath);
      if (!folderRows.length) {
        showToast('此文件夹中未找到图片', 3000);
        return;
      }

      const folderName = folderBaseName(rootPath) || rootPath;
      const imageCount = folderRows.length;

      const dlg = document.createElement('dialog');
      dlg.style.cssText = [
        'border:1px solid #303a52', 'border-radius:12px', 'background:#141a24',
        'color:#e8f0f8', 'padding:0', 'min-width:440px', 'max-width:560px',
        'width:90vw', 'height:auto', 'overflow-y:auto',
        'box-shadow:0 8px 40px rgba(0,0,0,0.6)',
      ].join(';');

      dlg.innerHTML = `
        <div style="padding:20px 22px 14px;border-bottom:1px solid #222e45;">
          <div style="font-size:17px;font-weight:700;margin-bottom:4px;">Write Photo Metadata</div>
          <div style="color:#7a90b8;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(rootPath)}">${escapeHtml(folderName)} &middot; ${imageCount} image${imageCount === 1 ? '' : 's'}</div>
        </div>

        <div id="wmOptView" style="padding:16px 22px;">
          <div style="background:#1a2235;border:1px solid #263045;border-radius:8px;padding:12px 14px;margin-bottom:12px;display:flex;gap:12px;align-items:flex-start;">
            <div style="font-size:18px;margin-top:2px;">📝</div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:13px;font-weight:600;margin-bottom:4px;">XMP Sidecar Files</div>
              <div style="font-size:12px;color:#7a90b8;line-height:1.5;">Writes a <code style="background:#1c2438;padding:1px 4px;border-radius:3px;">.xmp</code> sidecar file next to each original. Embeds star ratings, Accept/Reject decisions, and species tags in a format readable by Lightroom, Capture One, darktable, and other editors.</div>
            </div>
          </div>
          <div style="background:#1a1f10;border:1px solid #3a4020;border-radius:6px;padding:10px 14px;margin-bottom:16px;font-size:12px;color:#b0c070;line-height:1.5;">
            &#9888; <b>Write metadata before importing into your photo editor.</b> Most catalogues ignore new sidecar files once a photo is already imported. Write first, then import, for best results.<br>Kestrel will not overwrite XMP files generated by other software without your permission.
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="wmCancel" style="padding:8px 16px;border:1px solid #3a465f;background:#1c2433;color:#e8f0f8;border-radius:6px;cursor:pointer;font-size:13px;">Cancel</button>
            <button id="wmOk" style="padding:8px 16px;border:1px solid #2a5fa8;background:#1a3a6a;color:#7eb8e0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Write Metadata &#10003;</button>
          </div>
        </div>

        <div id="wmProgressView" style="display:none;padding:16px 22px;">
          <ul id="wmStepsList" style="list-style:none;margin:0 0 16px;padding:0;display:flex;flex-direction:column;gap:6px;"></ul>
          <div id="wmProgressActions" style="display:none;justify-content:flex-end;">
            <button id="wmDone" style="padding:8px 16px;border:1px solid #2a5fa8;background:#1a3a6a;color:#7eb8e0;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600;">Done</button>
          </div>
        </div>

        <div id="wmConflictView" style="display:none;padding:16px 22px;">
          <p id="wmConflictDesc" style="font-size:13px;line-height:1.5;margin:0 0 10px;color:#9fb0cc;"></p>
          <ul id="wmConflictList" style="max-height:160px;overflow-y:auto;list-style:none;padding:0;margin:0 0 16px;font-size:12px;color:#7a90b8;border:1px solid #222e45;border-radius:6px;"></ul>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button id="wmSkip" style="padding:8px 16px;border:1px solid #3a465f;background:#1c2433;color:#e8f0f8;border-radius:6px;cursor:pointer;font-size:13px;">Skip these files</button>
            <button id="wmOverwrite" style="padding:8px 12px;border:1px solid #7f3f3f;background:#5c2a2a;color:#ffdede;border-radius:6px;cursor:pointer;font-size:13px;">Overwrite Anyway</button>
          </div>
        </div>
      `;
      document.body.appendChild(dlg);

      const closeAndRemove = () => {
        try { dlg.close(); } catch (_) {}
        if (dlg.parentNode) dlg.parentNode.removeChild(dlg);
      };

      const showView = (id) => {
        ['wmOptView', 'wmProgressView', 'wmConflictView'].forEach(v => {
          const el = dlg.querySelector('#' + v);
          if (el) el.style.display = (v === id) ? 'block' : 'none';
        });
      };

      const addStep = (id, label, state) => {
        const icons  = { pending:'○', running:'⟳', done:'✓', failed:'✗', skipped:'–' };
        const colors = { pending:'#7a90b8', running:'#6aa0ff', done:'#50c878', failed:'#ff6b6b', skipped:'#555' };
        const li = document.createElement('li');
        li.id = 'wm-step-' + id;
        li.style.cssText = 'display:flex;align-items:center;gap:10px;font-size:13px;padding:6px 0;border-bottom:1px solid #1a2235;';
        li.innerHTML =
          `<span id="wm-step-icon-${id}" style="font-size:15px;width:18px;text-align:center;flex-shrink:0;color:${colors[state]}">${icons[state]}</span>` +
          `<span style="flex:1;color:#e8f0f8;">${label}</span>` +
          `<span id="wm-step-detail-${id}" style="font-size:11px;color:#7a90b8;"></span>`;
        dlg.querySelector('#wmStepsList').appendChild(li);
      };

      const setStep = (id, state, detail = '') => {
        const icons  = { pending:'○', running:'⟳', done:'✓', failed:'✗', skipped:'–' };
        const colors = { pending:'#7a90b8', running:'#6aa0ff', done:'#50c878', failed:'#ff6b6b', skipped:'#555' };
        const iconEl   = dlg.querySelector('#wm-step-icon-' + id);
        const detailEl = dlg.querySelector('#wm-step-detail-' + id);
        if (iconEl)   { iconEl.textContent = icons[state]; iconEl.style.color = colors[state]; }
        if (detailEl && detail) detailEl.textContent = detail;
      };

      const payload = folderRows.map(r => ({
        filename: r.filename,
        rating: getRating(r),
        culled: getRawCullStatus(r),
        culled_origin: normalizeCullOrigin(r),
        species: getSpeciesDisplayName(r.species || ''),
        family: getFamilyDisplayName(r.family || ''),
        quality: r.quality != null ? r.quality : null,
      }));

      dlg.querySelector('#wmCancel').addEventListener('click', closeAndRemove);

      dlg.querySelector('#wmOk').addEventListener('click', async () => {
        showView('wmProgressView');
        addStep('write', 'Writing XMP sidecar files', 'running');
        try {
          const res = await window.pywebview.api.write_xmp_metadata(rootPath, payload, false, false);
          if (!res.success) {
            setStep('write', 'failed', res.error || 'Unknown error');
            dlg.querySelector('#wmProgressActions').style.display = 'flex';
            return;
          }
          if (res.skipped_conflicts && res.skipped_conflicts.length > 0) {
            const n = res.skipped_conflicts.length;
            setStep('write', 'done', `${res.written} written, ${n} conflict${n === 1 ? '' : 's'}`);
            dlg.querySelector('#wmConflictDesc').textContent =
              `${n} existing XMP file${n === 1 ? '' : 's'} appear to have been created by another application (such as Lightroom or darktable). Overwriting them may interfere with metadata managed by that software.`;
            const conflictList = dlg.querySelector('#wmConflictList');
            res.skipped_conflicts.slice(0, 10).forEach(f => {
              const li = document.createElement('li');
              li.style.cssText = 'padding:5px 8px;border-bottom:1px solid #1a2235;';
              li.textContent = f;
              conflictList.appendChild(li);
            });
            if (res.skipped_conflicts.length > 10) {
              const li = document.createElement('li');
              li.style.cssText = 'padding:5px 8px;color:#7a90b8;';
              li.textContent = `\u2026and ${res.skipped_conflicts.length - 10} more`;
              conflictList.appendChild(li);
            }
            showView('wmConflictView');

            dlg.querySelector('#wmSkip').addEventListener('click', () => {
              showToast(`Metadata written: ${res.written} written, ${n} skipped`, 4000);
              closeAndRemove();
            });
            dlg.querySelector('#wmOverwrite').addEventListener('click', async () => {
              showView('wmProgressView');
              addStep('overwrite', 'Overwriting conflicting XMP files', 'running');
              try {
                const res2 = await window.pywebview.api.write_xmp_metadata(rootPath, payload, true, false);
                if (!res2.success) {
                  setStep('overwrite', 'failed', res2.error || 'Unknown error');
                } else {
                  setStep('overwrite', 'done', `${res2.written} file${res2.written === 1 ? '' : 's'} written`);
                  showToast(`Metadata written: ${res2.written} file${res2.written === 1 ? '' : 's'}`, 4000);
                }
              } catch (e) {
                setStep('overwrite', 'failed', 'Error overwriting');
              }
              dlg.querySelector('#wmProgressActions').style.display = 'flex';
            });
          } else {
            setStep('write', 'done', `${res.written} file${res.written === 1 ? '' : 's'} written`);
            showToast(`Metadata written: ${res.written} file${res.written === 1 ? '' : 's'}`, 4000);
            dlg.querySelector('#wmProgressActions').style.display = 'flex';
          }
        } catch (e) {
          console.error('writeMetadataForFolder error', e);
          setStep('write', 'failed', 'Unexpected error');
          dlg.querySelector('#wmProgressActions').style.display = 'flex';
        }
      });

      dlg.querySelector('#wmDone').addEventListener('click', closeAndRemove);
      dlg.addEventListener('close', () => { if (dlg.parentNode) dlg.parentNode.removeChild(dlg); });
      dlg.showModal();
    }

    // 重新加载当前文件夹（筛片完成后由 Python 通过 evaluate_js 调用）
    async function reloadCurrentFolders() {
      const loadedPaths = [...new Set(rows.map(r => r.__rootPath).filter(Boolean))];
      if (loadedPaths.length === 0) return;
      if (loadedPaths.length === 1) {
        await loadFolderFromPath(loadedPaths[0]);
      } else {
        await loadMultipleFolders(loadedPaths);
      }
    }
    // 暴露到全局，供 Python 通过 evaluate_js 调用
    window.reloadCurrentFolders = reloadCurrentFolders;

    // 定期把队列运行状态广播到 window（用于 beforeunload 防护）
    setInterval(async () => {
      try {
        if (hasPywebviewApi && window.pywebview?.api?.is_analysis_running) {
          const r = await window.pywebview.api.is_analysis_running();
          window.__queueRunning = !!(r && r.running);
        }
      } catch (_) { }
    }, 3000);

    // 👁 实时分析按钮
    const queueLiveBtn = document.getElementById('queueLiveBtn');
    if (queueLiveBtn) {
      queueLiveBtn.addEventListener('click', openLiveAnalysisDlg);
    }

    // 实时对话框关闭按钮与 Escape 处理
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
    // 教程系统（第 1 部分 = 分析介绍，第 2 部分 = 浏览功能）
    // 交互式：部分步骤需要用户操作后才能继续。
    // 参考网站 try-it-out 演示中的 waitFor/trigger 模式。
    // ====================================================================

    const TUTORIAL_PART1 = [
      {
        title: '欢迎使用 Project Kestrel！',
        body: 'Project Kestrel 使用机器学习来整理你的照片，帮助你更高效地复查作品、搜索图库，并快速决定哪些照片值得编辑和分享。<br><br>这份引导教程会带你了解 Kestrel 的核心功能。',
        target: null,
      },
      {
        title: '首先，分析你的照片',
        body: '点击 <b>分析文件夹\u2026</b>，选择包含鸟类照片的文件夹。Kestrel 会按场景分组，使用 AI 检测鸟类、识别物种和科名，并自动评估图片质量。',
        target: '#analyzeQueueBtn',
        position: 'bottom',
      },
      {
        title: '打开一个已分析的文件夹',
        body: '当你用 Kestrel 分析完一个文件夹后，点击 <b>打开文件夹\u2026</b> 即可浏览其中内容。Kestrel 会加载这些场景。<br><br>接下来我们会自动载入一组 <b>示例鸟类照片</b>，让你直观看到效果。',
        target: '#pickFolder',
        position: 'bottom',
      },
    ];

    const TUTORIAL_PART2 = [
      {
        title: '你的照片会按场景整理',
        body: 'Kestrel 会把你的照片整理成一个个 <b>场景</b>，也就是同一组连拍中相似的图片。场景网格会按照拍摄顺序显示这些场景。',
        nudge: '点击一个场景来打开它！',
        target: '#sceneGrid .card',
        position: 'right',
        waitFor: 'clickScene',
      },
      {
        title: '浏览场景内容',
        body: '在每个场景中，你的照片都会按照 <b>质量</b> 自动排序，从最锐利到最模糊。这样你可以立刻把注意力放到最好的作品上。<br><br>点击下方胶片条中的任意照片来查看详情。',
        nudge: '点击下方胶片条中的一张照片！',
        target: '#imageGrid',
        position: 'top',
        inDialog: true,
        waitFor: 'clickFilmstrip',
      },
      {
        title: '评分与筛片决定',
        body: 'Kestrel 会根据每张图片的质量分数计算 <b>星级评分</b>。你也可以点击星星手动修改。<span style="color:#6aa0ff">蓝色星星</span> 表示 AI 评分，<span style="color:#f5c542">金色星星</span> 表示你的手动覆盖。<br><br>使用 <b>接受 · 未决定 · 拒绝</b> 按钮为每张照片做出筛片决定。后面使用筛片助手时，这些信息会非常有用。',
        nudge: '把一张照片标记为“接受”或“拒绝”后继续！',
        target: '#sceneInfoBar',
        position: 'top-left',
        inDialog: true,
        waitFor: 'clickCullToggle',
      },
      {
        title: '键盘快捷键',
        body: 'Kestrel 提供了一组键盘快捷键，让复查照片更高效。快捷键就在上方，继续之前不妨试一试。',
        target: '#sceneShortcutLegend',
        position: 'bottom',
        inDialog: true,
        setupAction: 'expandShortcuts',
      },
      {
        title: '其他场景功能',
        body: '当你浏览自己的 <b>真实照片</b> 时，还可以做这些事（示例图片上不会全部生效）：<br><br>\u2022 在完整图上 <b>点击并拖动</b>，加载 RAW 并放大查看<br>\u2022 编辑顶部的 <b>场景名称</b> 和 <b>标签</b><br>\u2022 按 <kbd>Space</kbd> 在你偏好的照片编辑器中打开图片<br>\u2022 如果 Kestrel 误把两个不同场景合并了，可以使用 <b>\u2702 拆分场景</b><br><br>点击 <b>关闭</b> 继续！',
        nudge: '关闭场景对话框后继续。',
        target: '#closeDlg',
        position: 'bottom',
        inDialog: true,
        waitFor: 'closeDialog',
      },
      {
        title: '筛选选项',
        body: '\u2022 可以直接 <b>搜索</b> 任意鸟类物种或科名，网格会随输入即时筛选。<br>\u2022 搜索后没有看到场景？可以降低 <b>置信度阈值</b> 以查看更多结果。<br>\u2022 如果场景中包含多种鸟类，请启用 <b>多主体模式</b>。<br>\u2022 也可以按质量、图片数量或拍摄时间进行 <b>排序</b>。',
        target: '.filter-panel',
        position: 'right',
      },
      {
        title: '合并场景',
        body: '上方高亮的两个场景其实原本属于同一组连拍，只是被 Kestrel 拆成了两个。按住 <kbd>Ctrl</kbd> 并点击这两张卡片选中它们，然后点击 <b>合并所选场景</b>，就能把它们重新合并。<br><br>你也可以通过 <kbd>Shift+Click</kbd> 一次性范围选择多组场景。',
        target: '#sceneGrid .card:nth-child(2)',
        highlightFirst: '#sceneGrid .card:nth-child(1)',
        position: 'bottom',
      },
      {
        title: '写入照片元数据',
        body: '点击 <b>写入照片元数据</b>，即可把 Kestrel 的星级评分和接受/拒绝决定导出到照片旁的 XMP 旁车文件中。这些 <code>.xmp</code> 文件能被 <b>Adobe Lightroom</b>、<b>darktable</b>、<b>Capture One</b> 以及其他编辑器原生读取。<br><br>\u26a0\ufe0f <b>请在把照片导入编辑器 <em>之前</em> 写入元数据</b>，因为大多数目录式软件在照片导入后会忽略新生成的旁车文件。如果旁车文件原本由其他应用创建，Kestrel 会在覆盖前先询问你。',
        target: '.write-metadata-btn',
        position: 'bottom',
      },
      {
        title: '筛片助手',
        body: '<b>筛片助手</b> 可以根据星级评分帮你自动把照片标记为接受或拒绝，甚至能把拒绝项移动到单独的文件夹。<br><br>点击 <b>打开筛片助手</b>，即可为该文件夹打开专门的接受/拒绝工作区。',
        target: '.culling-assistant-btn',
        position: 'bottom',
      },
      {
        title: '设置选项',
        body: '点击 <b>设置</b> 可选择你偏好的 <b>照片编辑器</b>（如 Lightroom、Darktable 或系统默认）。按下 <kbd>Space</kbd> 打开照片时，就会在这里启动。你也可以在设置里调整其他多个选项。',
        target: '#openSettings',
        position: 'bottom',
      },
      {
        title: '你已经准备好了！',
        body: '教程到这里就结束了。快速回顾一下：<br><br>\u2022 用 <b>分析文件夹</b> 处理新照片<br>\u2022 用 <b>打开文件夹</b> 浏览已分析的照片<br>\u2022 <b>点击场景</b> 来查看并评分照片<br>\u2022 用 <b>筛片助手</b> 进行批量接受/拒绝操作<br>\u2022 用 <b>写入照片元数据</b> 导出到 Lightroom、darktable 等软件<br><br>\u26a0\ufe0f <b>记住：</b> 为了获得最佳效果，请先写入照片元数据，再导入 Lightroom 或 Capture One。<br><br>你随时都可以点击 <b>\uD83D\uDCD6 教程</b> 按钮重新播放本教程。祝你观鸟愉快！',
        target: null,
      },
      {
        title: '欢迎发送反馈！',
        body: '我，也就是 Project Kestrel 的开发者，非常希望听到你的真实感受。无论你觉得这个应用是否有帮助，或发现了 bug，又或者有改进建议，都欢迎告诉我。<br><br>感谢你试用 Kestrel！',
        target: '#openFeedback',
        position: 'top',
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
      // 移除所有 highlight-target 类
      document.querySelectorAll('.highlight-target').forEach(function(el) {
        el.classList.remove('highlight-target');
      });
      // 执行 waitFor 监听器的清理逻辑
      if (_tutCleanupFn) { _tutCleanupFn(); _tutCleanupFn = null; }
      // 如果教程卡片被移动进场景对话框（顶层），就把它移回去
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

      // 步骤前置动作（在定位目标前执行）
      if (step.setupAction === 'expandShortcuts') {
        var legend = document.getElementById('sceneShortcutLegend');
        if (legend && legend.classList.contains('hidden')) {
          var shortcutToggleBtn = document.getElementById('sceneShortcutBtn');
          if (shortcutToggleBtn) shortcutToggleBtn.click();
        }
      }

      // 文案
      _tutEl('#tutorialCounter').textContent = 'Step ' + (idx + 1) + ' of ' + _tutSteps.length;
      _tutEl('#tutorialTitle').innerHTML = step.title;
      _tutEl('#tutorialBody').innerHTML  = step.body;

      // 提示语（点击后继续）
      if (step.nudge) {
        nudge.textContent = step.nudge;
        nudge.style.display = '';
      } else {
        nudge.style.display = 'none';
      }

      // 圆点进度
      var dotsCont = _tutEl('#tutorialProgress');
      dotsCont.innerHTML = '';
      _tutSteps.forEach(function(_, i) {
        var d = document.createElement('div');
        d.className = 'tutorial-dot' + (i === idx ? ' active' : '');
        dotsCont.appendChild(d);
      });

      // 上一步 / 下一步按钮文案
      _tutEl('#tutorialBack').disabled = (idx === 0);
      var isLast = (idx === _tutSteps.length - 1);
      nextBtn.textContent = isLast ? 'Finish \u2713' : 'Next \u2192';

      // 如果当前步骤使用 waitFor，则在动作完成前隐藏“下一步”按钮
      var hasWaitFor = !!step.waitFor;
      nextBtn.style.display = hasWaitFor ? 'none' : '';

      // 找到目标元素
      var target = step.target ? document.querySelector(step.target) : null;

      // 对于 inDialog 步骤，先检查场景对话框是否已打开
      var _inDialogActive = false;
      if (step.inDialog) {
        var dlg = document.getElementById('sceneDlg');
        if (!dlg || !dlg.open) {
          // 对话框未打开，则显示提示，并允许通过“下一步”跳过
          _tutEl('#tutorialBody').innerHTML = step.body + '<br><br><span style="color:var(--brand);font-weight:600">Open a scene first, then this step will highlight the right element.</span>';
          nudge.style.display = 'none';
          nextBtn.style.display = '';  // show Next even if waitFor was set
          target = null;  // treat as center
          hasWaitFor = false;
        } else {
          // 对话框已打开，则把教程卡片实际移动到对话框中，
          // 让它处于浏览器顶层（高于模态内容）
          _inDialogActive = true;
          _tutInDialog = true;
          if (card.parentElement !== dlg) { dlg.appendChild(card); }
          overlay.style.display = 'none'; // hide the main-page dim; dialog has its own backdrop
        }
      }
      // 对于带有独立首个高亮目标的步骤
      if (step.highlightFirst && !_inDialogActive) {
        var _hfEl = document.querySelector(step.highlightFirst);
        if (_hfEl) _hfEl.classList.add('highlight-target');
      }

      if (!target || (target.offsetWidth === 0 && target.offsetHeight === 0)) {
        // 卡片居中显示，并带完整背景遮罩
        hl.style.display = 'none';
        overlay.classList.add('has-backdrop');
        card.style.transform = 'translate(-50%, -50%)';
        card.style.top  = '50%';
        card.style.left = '50%';
      } else {
        // 对于 inDialog 激活步骤，卡片在对话框内部（顶层），因此不显示页面级高亮框
        hl.style.display = _inDialogActive ? 'none' : '';
        overlay.classList.remove('has-backdrop');
        card.style.transform = '';

        // 为目标添加 highlight-target 类，触发脉冲效果
        target.classList.add('highlight-target');

        var pad = 8;
        var r = target.getBoundingClientRect();
        if (!_inDialogActive) {
          hl.style.top    = (r.top  - pad) + 'px';
          hl.style.left   = (r.left - pad) + 'px';
          hl.style.width  = (r.width  + pad * 2) + 'px';
          hl.style.height = (r.height + pad * 2) + 'px';
        }

        // 将卡片定位到目标附近
        var pos    = step.position || 'right';
        var margin = 18;
        var vw     = window.innerWidth;
        var vh     = window.innerHeight;
        var cw     = 380 + margin;
        var ch     = card.offsetHeight || 220;
        var top, left;
        if (pos === 'right')       { left = r.right + margin;                 top = r.top + r.height / 2 - ch / 2; }
        else if (pos === 'left')     { left = r.left - cw - margin;             top = r.top + r.height / 2 - ch / 2; }
        else if (pos === 'bottom')   { left = r.left + r.width / 2 - cw / 2;   top = r.bottom + margin; }
        else if (pos === 'top-left') { left = r.left;                           top = r.top - ch - margin; }
        else                         { left = r.left + r.width / 2 - cw / 2;   top = r.top - ch - margin; } // 'top'
        left = Math.max(margin, Math.min(left, vw - cw - margin));
        top  = Math.max(margin, Math.min(top,  vh - ch - margin));
        card.style.left = left + 'px';
        card.style.top  = top  + 'px';
      }

      // ---- 设置交互式 waitFor 监听器 ----
      if (hasWaitFor && step.waitFor === 'clickScene') {
        // 用户必须点击网格中的任一场景卡片，因此监听 sceneGrid 的点击事件。
        var sceneGridEl = document.getElementById('sceneGrid');
        if (sceneGridEl) {
          var handler = function(ev) {
            var cardEl = ev.target.closest('.card');
            if (cardEl) {
              // 场景卡片已被点击，它会通过自己的点击处理器打开对话框。
              // 稍等片刻让对话框出现，再推进教程。
              setTimeout(function() { _tutAdvance(); }, 400);
            }
          };
          sceneGridEl.addEventListener('click', handler, true);
          _tutCleanupFn = function() { sceneGridEl.removeEventListener('click', handler, true); };
        }
      }
      else if (hasWaitFor && step.waitFor === 'clickStar') {
        // 用户必须在场景对话框中点击一颗星
        var onStarClick = function(ev) {
          var starEl = ev.target.closest('.star, .stars span');
          if (starEl) {
            setTimeout(function() { _tutAdvance(); }, 300);
          }
        };
        document.addEventListener('click', onStarClick, true);
        _tutCleanupFn = function() { document.removeEventListener('click', onStarClick, true); };
      }
      else if (hasWaitFor && step.waitFor === 'clickFilmstrip') {
        // 用户必须在底片栏中点击一张照片
        var filmstripEl = document.getElementById('imageGrid');
        if (filmstripEl) {
          var onFilmstripClick = function(ev) {
            var cardEl = ev.target.closest('.filmstrip-card, .card');
            if (cardEl) {
              setTimeout(function() { _tutAdvance(); }, 350);
            }
          };
          filmstripEl.addEventListener('click', onFilmstripClick, true);
          _tutCleanupFn = function() { filmstripEl.removeEventListener('click', onFilmstripClick, true); };
        }
      }
      else if (hasWaitFor && step.waitFor === 'clickCullToggle') {
        // 用户必须点击“接受”或“拒绝”按钮（不能是“未决定”）
        var onCullClick = function(ev) {
          var cullBtn = ev.target.closest('.cull-btn[data-cull="accept"], .cull-btn[data-cull="reject"]');
          if (cullBtn) {
            setTimeout(function() { _tutAdvance(); }, 400);
          }
        };
        document.addEventListener('click', onCullClick, true);
        _tutCleanupFn = function() { document.removeEventListener('click', onCullClick, true); };
      }
      else if (hasWaitFor && step.waitFor === 'closeDialog') {
        // 用户必须关闭场景对话框
        var sceneDlgEl = document.getElementById('sceneDlg');
        if (sceneDlgEl) {
          var onDlgClose = function() {
            sceneDlgEl.removeEventListener('close', onDlgClose);
            _tutCleanupFn = null;
            setTimeout(function() { _tutAdvance(); }, 250);
          };
          sceneDlgEl.addEventListener('close', onDlgClose);
          _tutCleanupFn = function() { sceneDlgEl.removeEventListener('close', onDlgClose); };
        }
      }
    }

    function _tutAdvance() {
      _tutStep++;
      if (_tutStep >= _tutSteps.length) {
        // 当前部分结束
        if (_tutPart === 1) {
          _closeMainTutorial();
          // 切换到第 2 部分：自动加载示例集后开始
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
          // 扫描示例父目录，让侧边栏文件夹树显示 backyard_birds 与 forest_trail
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
          // 略微延迟等待渲染完成，再开始第 2 部分
          console.log('[tutorial] Starting Part 2 of tutorial');
          setTimeout(function() { startMainTutorial(2, 0); }, 600);
        } else {
          // 没找到示例集，也直接开始第 2 部分
          console.warn('[tutorial] No sample sets found. res.success=', res?.success, 'res.paths=', res?.paths);
          startMainTutorial(2, 0);
        }
      } catch (e) {
        console.warn('[tutorial] _autoLoadSamplesAndStartPart2 error:', e);
        console.error(e);
        startMainTutorial(2, 0);
      }
    }

    // 绑定教程按钮
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
        // 即使跳过第 1 部分，也要先加载示例后进入第 2 部分
        _closeMainTutorial();
        _autoLoadSamplesAndStartPart2();
      } else {
        _closeMainTutorial();
      }
    });

    // 键盘：仅允许用 Escape 关闭教程（方向键被有意移除，
    // 用户改用“上一步/下一步”按钮或完成 waitFor 动作来推进）
    document.addEventListener('keydown', function(ev) {
      if (!_tutEl('#tutorialOverlay').classList.contains('active')) return;
      if (_tutPart === 0) return;
      if (ev.key === 'Escape') { _closeMainTutorial(); }
    });

    // 同时为欢迎面板中的教程链接绑定内嵌教程启动逻辑
    var welcomeTutLink = document.getElementById('welcomeTutorialLink');
    if (welcomeTutLink) {
      welcomeTutLink.addEventListener('click', function(e) {
        e.preventDefault();
        startMainTutorial(1, 0);
      });
    }

    document.querySelectorAll('.welcome-settings-link').forEach(function(linkEl) {
      linkEl.addEventListener('click', function(e) {
        e.preventDefault();
        showSettings();
      });
    });

    // 首次启动时自动开始教程（仅 pywebview 模式）
    (async function() {
      if (!hasPywebviewApi) return;
      // 稍等片刻，让 UI 先稳定
      await new Promise(function(r) { setTimeout(r, 800); });
      var seen = await checkMainTutorialSeen();
      if (!seen) {
        startMainTutorial(1, 0);
      }
    })();


    // 绑定捐助对话框按钮，此脚本在对话框 HTML 已进入 DOM 后执行
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
