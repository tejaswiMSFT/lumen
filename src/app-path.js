/* Locate the app file whether it is named lumen.html (working copy)
   or index.html (as published). */
const fs = require('fs');
const path = require('path');

function appPath() {
  const here = __dirname;
  const candidates = [
    path.join(here, 'lumen.html'),
    path.join(here, '..', 'index.html'),
    path.join(here, '..', 'lumen.html'),
    path.join(here, 'index.html')
  ];
  for (const c of candidates) if (fs.existsSync(c)) return path.resolve(c);
  throw new Error('Cannot find lumen.html or index.html near ' + here +
                  ' — run `npm run build` first.');
}

module.exports = {
  appPath,
  appUrl: () => 'file:///' + appPath().replace(/\\/g, '/')
};
