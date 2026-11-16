// electron-builder afterPack step: leave out Electron's WebGPU shader compiler (dxcompiler.dll, dxil.dll).
// The island never uses WebGPU, and these files aren't signed, so Windows Smart App Control blocks them and shows
// "Part of this app has been blocked" every time the graphics process starts (including after sleep).
const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  for (const name of ['dxcompiler.dll', 'dxil.dll']) {
    const file = path.join(context.appOutDir, name);
    if (fs.existsSync(file)) { fs.rmSync(file); console.log(`  • removed ${name} (WebGPU, not used)`); }
  }
};
