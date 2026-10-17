/* ============================================================================
 * mcp/remote.js — Serveur MCP distant (HTTP) pour TrackCandidatures.
 *
 * Même logique que server.js (stdio) mais exposée via HTTP Streamable MCP
 * pour être utilisable depuis n'importe quel appareil / client OpenCode.
 *
 * Déploiement : voir mcp/README.md § "Serveur distant (multi-appareils)".
 * Variables d'environnement : TC_EMAIL, TC_PASSWORD, TC_SUPABASE_URL,
 * TC_SUPABASE_ANON_KEY (mêmes que server.js), PORT (défaut 3000).
 * ==========================================================================*/
'use strict';

const http = require('http');
const { URL } = require('url');

// Réutilise la logique métier de server.js en l'important via module.exports
// server.js utilise process.stdout.write et readline, donc on duplique
// la logique métier ici pour rester indépendant.

const DEFAULT_URL = 'https://epspmcwknvmsndksuutc.supabase.co';
const DEFAULT_ANON_KEY = 'sb_publishable_GuWaiuvXEBBd7tXCSFFQQQ_7_dXWtgi';

const SUPABASE_URL = (process.env.TC_SUPABASE_URL || DEFAULT_URL).replace(/\/+$/, '');
const ANON_KEY = process.env.TC_SUPABASE_ANON_KEY || DEFAULT_ANON_KEY;
const EMAIL = process.env.TC_EMAIL || '';
const PASSWORD = process.env.TC_PASSWORD || '';
const PORT = parseInt(process.env.PORT || '3000', 10);

const STATUSES = ['idea', 'todo', 'sent', 'relance', 'interview', 'test', 'offer', 'refused', 'withdrawn', 'archived'];
const COMPARTMENTS = ['etudiant', 'stage', 'emploi', 'interim', 'spontanee'];
const SENT = ['sent', 'relance', 'interview', 'test', 'offer', 'refused', 'withdrawn'];

let cached = null;

async function sb(path, { method = 'GET', token = null, body = null, prefer = null } = {}) {
  const headers = { apikey: ANON_KEY, 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (prefer) headers.Prefer = prefer;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let res;
  try {
    res = await fetch(SUPABASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Supabase: délai dépassé (25 s).');
    throw new Error('Supabase: injoignable (' + (e && e.message ? e.message : e) + ').');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) {
    const msg = (data && (data.error_description || data.message || data.msg)) || text || ('HTTP ' + res.status);
    const err = new Error('Supabase: ' + msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function session() {
  if (!EMAIL || !PASSWORD) throw new Error('TC_EMAIL / TC_PASSWORD manquants.');
  if (cached) return cached;
  const data = await sb('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: EMAIL, password: PASSWORD } });
  if (!data || !data.access_token || !data.user || !data.user.id) throw new Error('Connexion impossible.');
  cached = { token: data.access_token, uid: data.user.id };
  return cached;
}

async function withSession(fn) {
  try { return await fn(await session()); }
  catch (e) {
    if (e && e.status === 401 && cached) { cached = null; return fn(await session()); }
    throw e;
  }
}

async function loadState() {
  return withSession(async ({ token, uid }) => {
    const rows = await sb('/rest/v1/user_data?user_id=eq.' + encodeURIComponent(uid) + '&select=state,updated_at', { token });
    if (Array.isArray(rows) && rows.length) return { uid, token, state: rows[0].state || {}, isNew: false };
    return { uid, token, state: { apps: [] }, isNew: true };
  });
}

async function saveState(ctx, state) {
  const payload = { state, updated_at: new Date().toISOString() };
  if (ctx.isNew) {
    await sb('/rest/v1/user_data', { method: 'POST', token: ctx.token, body: Object.assign({ user_id: ctx.uid }, payload), prefer: 'return=representation' });
  } else {
    await sb('/rest/v1/user_data?user_id=eq.' + encodeURIComponent(ctx.uid), { method: 'PATCH', token: ctx.token, body: payload, prefer: 'return=representation' });
  }
}

function todayISO(d) {
  const x = d || new Date();
  const m = x.getMonth() + 1, day = x.getDate();
  return x.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return todayISO(d);
}
function uid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function appsOf(state) { return Array.isArray(state.apps) ? state.apps : []; }
function slim(a) { return { id: a.id, title: a.title, company: a.company, compartment: a.compartment, status: a.status, location: a.location || '', source: a.source || '', dateApplied: a.dateApplied || '', next: a.next || null }; }
function goalsOf(state) { return Object.assign({ relanceDelay: 7, reminders: true }, state.goals || {}); }

// --- Métier (copié de server.js) ---
async function doList(args) {
  const { state } = await loadState();
  let list = appsOf(state);
  if (args.status) list = list.filter((a) => a.status === args.status);
  if (args.compartment) list = list.filter((a) => a.compartment === args.compartment);
  const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200));
  return { total: list.length, candidatures: list.slice(0, limit).map(slim) };
}
async function doGet(args) {
  if (!args.id) throw new Error('id obligatoire.');
  const { state } = await loadState();
  const a = appsOf(state).find((x) => x.id === args.id);
  if (!a) throw new Error('Candidature introuvable : ' + args.id);
  return a;
}
async function doAdd(args) {
  if (!args.company || !String(args.company).trim()) throw new Error('company obligatoire.');
  const compartment = args.compartment || 'emploi';
  if (!COMPARTMENTS.includes(compartment)) throw new Error('compartment invalide : ' + compartment);
  const status = args.status || 'todo';
  if (!STATUSES.includes(status)) throw new Error('status invalide : ' + status);
  const ctx = await loadState();
  const now = todayISO();
  const a = { id: uid(), title: args.title || '', company: String(args.company).trim(), compartment, status, location: args.location || '', url: args.url || '', source: args.source || '', contract: args.contract || '', salary: '', contact: args.contact || '', notes: args.notes || '', tags: Array.isArray(args.tags) ? args.tags : [], priority: [1, 2, 3].includes(args.priority) ? args.priority : 2, starred: false, dateApplied: args.dateApplied || '', dateClosed: '', createdAt: now, updatedAt: now, next: null, history: [{ date: now, label: 'Candidature créée', status }] };
  if (SENT.includes(status)) {
    if (!a.dateApplied) a.dateApplied = now;
    const g = goalsOf(ctx.state);
    if (g.reminders) a.next = { type: 'relance', date: addDaysISO(a.dateApplied, g.relanceDelay || 7), done: false };
  }
  ctx.state.apps = [a].concat(appsOf(ctx.state));
  await saveState(ctx, ctx.state);
  return a;
}
const UPDATABLE = ['title', 'company', 'compartment', 'location', 'url', 'source', 'contract', 'contact', 'notes', 'dateApplied', 'priority', 'tags', 'starred'];
async function doUpdate(args) {
  if (!args.id) throw new Error('id obligatoire.');
  const ctx = await loadState();
  const a = appsOf(ctx.state).find((x) => x.id === args.id);
  if (!a) throw new Error('Candidature introuvable : ' + args.id);
  UPDATABLE.forEach((k) => {
    if (args[k] === undefined) return;
    if (k === 'compartment' && !COMPARTMENTS.includes(args[k])) throw new Error('compartment invalide : ' + args[k]);
    a[k] = args[k];
  });
  if (args.status && args.status !== a.status) {
    if (!STATUSES.includes(args.status)) throw new Error('status invalide : ' + args.status);
    a.status = args.status;
    a.history = (a.history || []).concat([{ date: todayISO(), label: 'Statut : ' + args.status, status: args.status }]);
  }
  a.updatedAt = todayISO();
  await saveState(ctx, ctx.state);
  return a;
}
async function doSetStatus(args) {
  if (!args.id) throw new Error('id obligatoire.');
  if (!STATUSES.includes(args.status)) throw new Error('status invalide : ' + args.status);
  const ctx = await loadState();
  const a = appsOf(ctx.state).find((x) => x.id === args.id);
  if (!a) throw new Error('Candidature introuvable : ' + args.id);
  a.status = args.status;
  if (SENT.includes(args.status)) {
    if (!a.dateApplied) a.dateApplied = todayISO();
    const g = goalsOf(ctx.state);
    if (!a.next && g.reminders) a.next = { type: 'relance', date: addDaysISO(a.dateApplied, g.relanceDelay || 7), done: false };
  }
  a.history = (a.history || []).concat([{ date: todayISO(), label: 'Statut : ' + args.status, status: args.status }]);
  a.updatedAt = todayISO();
  await saveState(ctx, ctx.state);
  return slim(a);
}
async function doDue(args) {
  const within = Math.max(0, Number(args.within_days) || 7);
  const { state } = await loadState();
  const limit = addDaysISO(todayISO(), within);
  return appsOf(state).filter((a) => a.next && a.next.date && a.next.date <= limit).sort((x, y) => String(x.next.date).localeCompare(String(y.next.date))).map((a) => ({ id: a.id, company: a.company, title: a.title, action: a.next.type, date: a.next.date }));
}
async function doStats(args) {
  const days = Math.max(1, Number(args.days) || 30);
  const { state } = await loadState();
  const list = appsOf(state);
  const from = addDaysISO(todayISO(), -(days - 1));
  const sent = list.filter((a) => SENT.includes(a.status));
  const recent = sent.filter((a) => (a.dateApplied || '') >= from);
  const byStatus = {}, byComp = {};
  list.forEach((a) => { byStatus[a.status] = (byStatus[a.status] || 0) + 1; byComp[a.compartment] = (byComp[a.compartment] || 0) + 1; });
  const due = list.filter((a) => a.next && a.next.date && a.next.date <= addDaysISO(todayISO(), 7)).length;
  return { total: list.length, envoyees: sent.length, en_cours: list.filter((a) => a.status !== 'archived').length, envoyees_periode: recent.length, entretiens: list.filter((a) => a.status === 'interview').length, offres: list.filter((a) => a.status === 'offer').length, relances_dues_7j: due, par_statut: byStatus, par_compartiment: byComp };
}

const TOOLS = [
  { name: 'list_candidatures', description: 'Liste les candidatures (filtres optionnels statut / compartiment).', inputSchema: { type: 'object', properties: { status: { type: 'string' }, compartment: { type: 'string' }, limit: { type: 'number' } } }, run: doList },
  { name: 'get_candidature', description: 'Fiche complète d’une candidature par son id.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, run: doGet },
  { name: 'add_candidature', description: 'Crée une candidature (planifie la relance si envoyée).', inputSchema: { type: 'object', properties: { company: { type: 'string' }, title: { type: 'string' }, compartment: { type: 'string' }, status: { type: 'string' }, location: { type: 'string' }, contract: { type: 'string' }, source: { type: 'string' }, url: { type: 'string' }, contact: { type: 'string' }, notes: { type: 'string' }, dateApplied: { type: 'string' }, priority: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['company'] }, run: doAdd },
  { name: 'update_candidature', description: 'Modifie les champs d’une candidature (dont status avec historique).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, company: { type: 'string' }, compartment: { type: 'string' }, status: { type: 'string' }, location: { type: 'string' }, url: { type: 'string' }, source: { type: 'string' }, contract: { type: 'string' }, contact: { type: 'string' }, notes: { type: 'string' }, dateApplied: { type: 'string' }, priority: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } }, starred: { type: 'boolean' } }, required: ['id'] }, run: doUpdate },
  { name: 'set_status', description: 'Change le statut (gère date d’envoi, relance auto et historique).', inputSchema: { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] }, run: doSetStatus },
  { name: 'due_actions', description: 'Relances et actions dues (défaut : aujourd’hui + 7 jours).', inputSchema: { type: 'object', properties: { within_days: { type: 'number' } } }, run: doDue },
  { name: 'dashboard_stats', description: 'Chiffres clés : totaux, entretiens, offres, relances dues, répartitions.', inputSchema: { type: 'object', properties: { days: { type: 'number' } } }, run: doStats }
];

const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, mcp-session-id',
    'Access-Control-Expose-Headers': 'mcp-session-id',
  };
}

function sendJson(res, status, body, extra = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(), extra));
  res.end(data);
}

const sessions = new Map();

function handleMcpRequest(req, res, body) {
  const sessionId = req.headers['mcp-session-id'] || null;

  // Handle initialize
  if (body.method === 'initialize') {
    const newSessionId = 'sess_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    sessions.set(newSessionId, { created: Date.now() });
    const v = body.params?.protocolVersion;
    sendJson(res, 200, {
      jsonrpc: '2.0', id: body.id,
      result: {
        protocolVersion: SUPPORTED.includes(v) ? v : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'trackcandidatures', version: '1.0.0' },
        instructions: 'Outils de pilotage des candidatures TrackCandidatures (compte cloud).'
      }
    }, { 'mcp-session-id': newSessionId });
    return;
  }

  // Handle ping
  if (body.method === 'ping') {
    sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: {} });
    return;
  }

  // Handle tools/list
  if (body.method === 'tools/list') {
    sendJson(res, 200, {
      jsonrpc: '2.0', id: body.id,
      result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }
    });
    return;
  }

  // Handle tools/call
  if (body.method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === body.params?.name);
    if (!tool) {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Outil inconnu : ' + body.params?.name } });
      return;
    }
    tool.run(body.params?.arguments || {}).then((data) => {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] } });
    }).catch((e) => {
      sendJson(res, 200, { jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Erreur : ' + (e && e.message ? e.message : e) }], isError: true } });
    });
    return;
  }

  // Unknown method
  sendJson(res, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Méthode inconnue : ' + body.method } });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/' || url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('TrackCandidatures MCP OK');
    return;
  }

  // MCP endpoint
  if (url.pathname === '/mcp') {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); }
        catch (e) { sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
        handleMcpRequest(req, res, parsed);
      });
      return;
    }
    if (req.method === 'GET') {
      // SSE stream (not implemented for simplicity - return 405)
      res.writeHead(405, corsHeaders());
      res.end('SSE not supported. Use POST.');
      return;
    }
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'];
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(200, corsHeaders());
      res.end();
      return;
    }
  }

  res.writeHead(404, corsHeaders());
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`TrackCandidatures MCP (remote) listening on port ${PORT}`);
  console.log(`Endpoint: http://localhost:${PORT}/mcp`);
  if (!EMAIL || !PASSWORD) console.warn('WARNING: TC_EMAIL / TC_PASSWORD not set. Set them before use.');
});
