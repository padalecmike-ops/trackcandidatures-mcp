/* Test de fumée en lecture seule contre le vrai backend.
 * Usage (PowerShell) :
 *   $env:TC_EMAIL = "vous@exemple.fr"
 *   $env:TC_PASSWORD = "votre-mot-de-passe"
 *   node smoke.js
 * Ne modifie rien : initialize + list (3) + stats uniquement. */
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const srv = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: Object.assign({}, process.env)
});
let buf = '', queue = [];
srv.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (line) queue.push(JSON.parse(line));
  }
});
let id = 0;
function call(method, params) {
  return new Promise((resolve, reject) => {
    const myId = ++id;
    srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n');
    const t0 = Date.now();
    (function wait() {
      const ix = queue.findIndex((m) => m.id === myId);
      if (ix >= 0) return resolve(queue.splice(ix, 1)[0]);
      if (Date.now() - t0 > 45000) return reject(new Error('timeout ' + method));
      setTimeout(wait, 50);
    })();
  });
}
async function main() {
  const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  if (!init.result || init.result.serverInfo.name !== 'trackcandidatures') throw new Error('handshake KO');
  console.log('ok: handshake (' + init.result.protocolVersion + ')');
  const tools = await call('tools/list', {});
  console.log('ok: ' + tools.result.tools.length + ' outils');
  const list = await call('tools/call', { name: 'list_candidatures', arguments: { limit: 3 } });
  if (list.result.isError) throw new Error('list: ' + list.result.content[0].text);
  const data = JSON.parse(list.result.content[0].text);
  console.log('ok: list_candidatures -> ' + data.total + ' fiche(s)');
  const stats = await call('tools/call', { name: 'dashboard_stats', arguments: {} });
  if (stats.result.isError) throw new Error('stats: ' + stats.result.content[0].text);
  const s = JSON.parse(stats.result.content[0].text);
  console.log('ok: dashboard_stats -> total=' + s.total + ' en_cours=' + s.en_cours);
  srv.kill();
  console.log('SMOKE OK (lecture seule, rien modifié)');
}
main().catch((e) => { console.error('SMOKE KO: ' + e.message); srv.kill(); process.exit(1); });
