/**
 * Project Kestrel — Cloudflare Worker API
 *
 * Endpoints:
 *   POST /api/feedback   — Bug reports, suggestions, positive feedback
 *   POST /api/crash      — Crash reports (emailed)
 *   POST /api/analytics  — Anonymous per-folder usage analytics (stored in KV)
 *   GET  /api/analytics  — Query stored analytics (admin-only, requires ADMIN_KEY)
 *
 * Secrets (set via `npx wrangler secret put <NAME>`):
 *   KESTREL_SHARED_SECRET  — shared key embedded in the desktop app
 *   RESEND_API_KEY          — Resend.com API key for sending email
 *   NOTIFY_EMAIL            — destination email for feedback / crash alerts
 *   ADMIN_KEY               — key for querying analytics (GET /api/analytics)
 *
 * KV Namespaces:
 *   ANALYTICS   — stores per-machine analytics sessions
 *   RATE_LIMIT  — simple per-IP rate-limit counters
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Return a JSON Response. */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** Basic CORS headers for pre-flight and responses. */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Kestrel-Key',
    'Access-Control-Max-Age': '86400',
  };
}

/** Rate-limit by IP: allow `max` requests per `windowSec` seconds. */
async function checkRateLimit(ip, RATE_LIMIT, max = 30, windowSec = 60) {
  const key = `rl:${ip}`;
  const raw = await RATE_LIMIT.get(key);
  const now = Math.floor(Date.now() / 1000);

  if (raw) {
    const data = JSON.parse(raw);
    if (now - data.start < windowSec) {
      if (data.count >= max) return false; // rate-limited
      data.count++;
      await RATE_LIMIT.put(key, JSON.stringify(data), { expirationTtl: windowSec });
      return true;
    }
  }
  // New window
  await RATE_LIMIT.put(key, JSON.stringify({ start: now, count: 1 }), { expirationTtl: windowSec });
  return true;
}

/** Send an email via Resend API. */
async function sendEmail(resendKey, to, subject, htmlBody) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Project Kestrel <noreply@projectkestrel.org>',
      to: [to],
      subject,
      html: htmlBody,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('Resend error:', res.status, text);
  }
  return res.ok;
}

/** Escape HTML to prevent injection in email bodies. */
function escapeHtml(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Route Handlers
// ---------------------------------------------------------------------------

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const type = body.type || 'general';               // bug, suggestion, liked, general
  const description = body.description || '';
  const contact = body.contact || '';
  const version = body.version || 'unknown';
  const os = body.os || 'unknown';
  const machineId = body.machine_id || 'unknown';
  const screenshotB64 = body.screenshot_b64 || '';    // base64 PNG (optional)
  const logTail = body.log_tail || '';                // recent log entries (optional)

  if (!description.trim()) {
    return json({ ok: false, error: 'Description is required' }, 400);
  }

  // Build email
  const typeLabel = {
    bug: '🐛 Bug Report',
    suggestion: '💡 Suggestion',
    liked: '❤️ Something They Liked',
    general: '📝 General Feedback',
  }[type] || `📝 ${type}`;

  let html = `
    <h2>${typeLabel}</h2>
    <p><strong>Version:</strong> ${escapeHtml(version)}<br>
    <strong>OS:</strong> ${escapeHtml(os)}<br>
    <strong>Machine ID:</strong> <code>${escapeHtml(machineId)}</code></p>
    <h3>Description</h3>
    <pre style="white-space:pre-wrap;max-width:700px;">${escapeHtml(description)}</pre>
  `;

  if (contact) {
    html += `<p><strong>Contact:</strong> ${escapeHtml(contact)}</p>`;
  }
  if (logTail) {
    html += `<h3>Recent Logs</h3><pre style="font-size:11px;max-height:400px;overflow:auto;">${escapeHtml(logTail)}</pre>`;
  }
  if (screenshotB64) {
    html += `<h3>Screenshot</h3><img src="data:image/png;base64,${screenshotB64}" style="max-width:800px;border:1px solid #ccc;" alt="screenshot">`;
  }

  const emailOk = await sendEmail(
    env.RESEND_API_KEY,
    env.NOTIFY_EMAIL,
    `[Kestrel ${typeLabel}] ${description.slice(0, 80)}`,
    html
  );

  return json({ ok: true, emailed: emailOk });
}

async function handleCrash(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const version = body.version || 'unknown';
  const os = body.os || 'unknown';
  const machineId = body.machine_id || 'unknown';
  const exceptionType = body.exception_type || '';
  const exceptionMsg = body.exception_message || '';
  const traceback = body.traceback || '';
  const logTail = body.log_tail || '';
  const sessionAnalytics = body.session_analytics || null;

  let html = `
    <h2>💥 Crash Report</h2>
    <p><strong>Version:</strong> ${escapeHtml(version)}<br>
    <strong>OS:</strong> ${escapeHtml(os)}<br>
    <strong>Machine ID:</strong> <code>${escapeHtml(machineId)}</code></p>
    <h3>Exception</h3>
    <p><strong>${escapeHtml(exceptionType)}:</strong> ${escapeHtml(exceptionMsg)}</p>
    <pre style="font-size:11px;max-height:500px;overflow:auto;">${escapeHtml(traceback)}</pre>
  `;

  if (logTail) {
    html += `<h3>Recent Logs</h3><pre style="font-size:11px;max-height:400px;overflow:auto;">${escapeHtml(logTail)}</pre>`;
  }
  if (sessionAnalytics) {
    html += `<h3>Session Analytics</h3><pre style="font-size:11px;">${escapeHtml(JSON.stringify(sessionAnalytics, null, 2))}</pre>`;
  }

  const emailOk = await sendEmail(
    env.RESEND_API_KEY,
    env.NOTIFY_EMAIL,
    `[Kestrel CRASH] ${exceptionType}: ${exceptionMsg.slice(0, 60)}`,
    html
  );

  return json({ ok: true, emailed: emailOk });
}

async function handleAnalyticsPost(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  const machineId = body.machine_id;
  if (!machineId) {
    return json({ ok: false, error: 'machine_id is required' }, 400);
  }

  // Each KV entry is a JSON array of session reports for that machine
  const key = `machine:${machineId}`;
  let existing = [];
  try {
    const raw = await env.ANALYTICS.get(key);
    if (raw) existing = JSON.parse(raw);
  } catch { /* start fresh */ }

  const entry = {
    timestamp: new Date().toISOString(),
    version: body.version || 'unknown',
    os: body.os || 'unknown',
    folder_name_hash: body.folder_name_hash || null,
    files_analyzed: body.files_analyzed || 0,
    avg_file_size_kb: body.avg_file_size_kb || 0,
    avg_analysis_speed_ms: body.avg_analysis_speed_ms || 0,
    file_formats: body.file_formats || {},
    active_compute_time_s: body.active_compute_time_s || 0,
    was_cancelled: body.was_cancelled || false,
  };

  existing.push(entry);

  // Cap at 500 entries per machine to avoid KV bloat
  if (existing.length > 500) {
    existing = existing.slice(-500);
  }

  await env.ANALYTICS.put(key, JSON.stringify(existing));

  return json({ ok: true, stored: existing.length });
}

async function handleAnalyticsGet(request, env) {
  // Admin-only endpoint: requires ADMIN_KEY header
  const adminKey = request.headers.get('X-Admin-Key') || '';
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) {
    return json({ ok: false, error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const machineId = url.searchParams.get('machine_id');

  if (machineId) {
    // Return data for a specific machine
    const raw = await env.ANALYTICS.get(`machine:${machineId}`);
    return json({ ok: true, machine_id: machineId, sessions: raw ? JSON.parse(raw) : [] });
  }

  // List all machine IDs (paginated via cursor)
  const cursor = url.searchParams.get('cursor') || undefined;
  const list = await env.ANALYTICS.list({ prefix: 'machine:', limit: 100, cursor });
  const machines = list.keys.map(k => ({
    machine_id: k.name.replace('machine:', ''),
  }));

  return json({
    ok: true,
    machines,
    cursor: list.list_complete ? null : list.cursor,
    total_listed: machines.length,
  });
}

// ---------------------------------------------------------------------------
// Main fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS pre-flight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health check
    if (path === '/api/health' && request.method === 'GET') {
      return json({ ok: true, service: 'kestrel-api' }, 200, corsHeaders());
    }

    // Authenticate with shared secret (except admin analytics GET)
    if (path !== '/api/analytics' || request.method !== 'GET') {
      const provided = request.headers.get('X-Kestrel-Key') || '';
      if (!env.KESTREL_SHARED_SECRET || provided !== env.KESTREL_SHARED_SECRET) {
        return json({ ok: false, error: 'Unauthorized' }, 401, corsHeaders());
      }
    }

    // Rate limiting
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const allowed = await checkRateLimit(ip, env.RATE_LIMIT, 30, 60);
    if (!allowed) {
      return json({ ok: false, error: 'Rate limit exceeded' }, 429, corsHeaders());
    }

    // Route
    try {
      if (path === '/api/feedback' && request.method === 'POST') {
        const res = await handleFeedback(request, env);
        return addCors(res);
      }
      if (path === '/api/crash' && request.method === 'POST') {
        const res = await handleCrash(request, env);
        return addCors(res);
      }
      if (path === '/api/analytics' && request.method === 'POST') {
        const res = await handleAnalyticsPost(request, env);
        return addCors(res);
      }
      if (path === '/api/analytics' && request.method === 'GET') {
        const res = await handleAnalyticsGet(request, env);
        return addCors(res);
      }
    } catch (err) {
      console.error('Handler error:', err);
      return json({ ok: false, error: 'Internal error' }, 500, corsHeaders());
    }

    return json({ ok: false, error: 'Not found' }, 404, corsHeaders());
  },
};

/** Add CORS headers to an existing Response. */
function addCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders())) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
