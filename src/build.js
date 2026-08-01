/* Inlines the tested modules into the template to produce one portable file. */
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const template = fs.readFileSync(path.join(dir, 'template.html'), 'utf8');
const qr = fs.readFileSync(path.join(dir, 'qr.js'), 'utf8');
const fountain = fs.readFileSync(path.join(dir, 'fountain.js'), 'utf8');
const qrdecode = fs.readFileSync(path.join(dir, 'qrdecode.js'), 'utf8');

// Strip the Node-only export tails; the browser build uses the globals directly.
const strip = s => s.replace(/\nif \(typeof module[\s\S]*?$/, '\n');

const out = template
  .replace('/*__QR_JS__*/', strip(qr))
  .replace('/*__FOUNTAIN_JS__*/', strip(fountain))
  .replace('/*__QRDECODE_JS__*/', strip(qrdecode));

for (const marker of ['__QR_JS__', '__FOUNTAIN_JS__', '__QRDECODE_JS__']) {
  if (out.includes(marker)) {
    console.error(`build: placeholder ${marker} was not replaced`);
    process.exit(1);
  }
}

const external = (out.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/g) || [])
  .concat(out.match(/import\(\s*['"]https?:\/\//g) || []);
if (external.length) {
  console.error('build: file is not self-contained —', external);
  process.exit(1);
}

const target = path.join(dir, '..', 'index.html');
fs.writeFileSync(target, out, 'utf8');
console.log(`built ${path.basename(target)} — ${(out.length / 1024).toFixed(1)} KB, no external dependencies`);
