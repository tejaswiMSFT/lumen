/* Read the app's real PRESETS out of the source, so tests can never drift
   from what actually ships. */
const fs = require('fs');
const path = require('path');

function readPresets(QR) {
  const tpl = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
  const m = tpl.match(/const PRESETS = (\[[\s\S]*?\]);/);
  if (!m) throw new Error('PRESETS not found in template.html');
  const presets = new Function('QR', 'return ' + m[1] + ';')(QR);
  if (!Array.isArray(presets) || !presets.length) throw new Error('PRESETS malformed');
  return presets;
}

module.exports = { readPresets };
