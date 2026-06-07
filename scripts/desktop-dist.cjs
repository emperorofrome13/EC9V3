const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';
const npxCommand = isWindows ? 'npx.cmd' : 'npx';
const restoreScript = require('path').join(__dirname, 'restore-node-native.cjs');

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: isWindows,
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

let exitCode = 0;

try {
  exitCode = run(npmCommand, ['run', 'build']);
  if (exitCode === 0) {
    exitCode = run(npxCommand, ['electron-builder', '--win', 'portable']);
  }
} finally {
  const rebuildCode = run(process.execPath, [restoreScript]);
  if (exitCode === 0 && rebuildCode !== 0) {
    exitCode = rebuildCode;
  }
}

process.exit(exitCode);
