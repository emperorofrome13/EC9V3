const { spawnSync } = require('child_process');

const isWindows = process.platform === 'win32';
const npmCommand = isWindows ? 'npm.cmd' : 'npm';

function run(command, args) {
  return spawnSync(command, args, {
    stdio: 'inherit',
    shell: isWindows,
  });
}

console.log('\nRestoring native modules for the local Node runtime...');
const rebuild = run(npmCommand, ['rebuild', 'better-sqlite3']);

if (rebuild.status === 0) {
  process.exit(0);
}

const validate = spawnSync(process.execPath, ['-e', "require('better-sqlite3')"], {
  stdio: 'ignore',
});

if (validate.status === 0) {
  console.warn('better-sqlite3 rebuild reported an error, but the module loads under the local Node runtime.');
  console.warn('This can happen on Windows when a running dev server has the native module file locked.');
  process.exit(0);
}

console.error('better-sqlite3 does not load under the local Node runtime. Stop running EC9V3/Next processes and run: npm rebuild better-sqlite3');
process.exit(rebuild.status || 1);

