/* Lumen over local HTTPS — no tunnel, no third party, nothing leaves your LAN.
 *
 *   node serve-https.js [port]
 *
 * The certificate is self-signed, so the phone must trust it once:
 * open http://<ip>:<port+1>/lumen-ca.cer to install, then
 * Settings > General > About > Certificate Trust Settings > enable it.
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const CERTDIR = path.join(os.homedir(), '.scout', 'lumen-cert');
const PORT = Number(process.argv[2]) || 8443;
const CERTPORT = PORT + 1;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.cer': 'application/x-x509-ca-cert'
};

function lanIPs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces()))
    for (const n of list || [])
      if (n.family === 'IPv4' && !n.internal && !n.address.startsWith('169.'))
        out.push(n.address);
  return out;
}

function serve(req, res, root) {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'lumen.html';
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}

const pfx = path.join(CERTDIR, 'lumen.pfx');
if (!fs.existsSync(pfx)) {
  console.error(`No certificate at ${pfx}. Generate one first (see README-ios.md).`);
  process.exit(1);
}

https.createServer({ pfx: fs.readFileSync(pfx), passphrase: 'lumen' },
  (q, r) => serve(q, r, ROOT)).listen(PORT, '0.0.0.0', () => {
    const ips = lanIPs();
    console.log('Lumen over HTTPS — camera will work, nothing leaves your network.\n');
    for (const ip of ips) console.log(`   https://${ip}:${PORT}/lumen.html`);
    console.log(`\nFirst time on this phone, install the certificate:`);
    for (const ip of ips) console.log(`   http://${ip}:${CERTPORT}/lumen-ca.cer`);
    console.log(`\nthen Settings > General > About > Certificate Trust Settings > turn it on.`);
  });

// Plain http purely to hand over the certificate — it carries no app data.
http.createServer((q, r) => serve(q, r, CERTDIR)).listen(CERTPORT, '0.0.0.0');
