const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createTempRoot(prefix = 'backend-new-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

module.exports = {
  createTempRoot,
  removeDir
};
