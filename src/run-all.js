/* Run every offline test in sequence and report a single verdict.
   The live-site test is excluded: it needs the network. */
const { spawnSync } = require('child_process');
const path = require('path');

const TESTS = [
  'test-qr.js',
  'test-fountain.js',
  'test-pipeline.js',
  'test-decode.js',
  'test-capture.js',
  'test-ios.js',
  'test-layout.js',
  'test-progress.js',
  'test-bootstrap.js',
  'test-offline.js',
  'test-subpath.js'
];

let failed = [];
for (const t of TESTS) {
  console.log(`\n=== ${t} ===`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(t);
}

console.log('\n' + '='.repeat(50));
if (failed.length) {
  console.log('FAILED: ' + failed.join(', '));
  process.exit(1);
}
console.log('ALL SUITES PASSED');
