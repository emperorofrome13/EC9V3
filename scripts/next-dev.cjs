const { spawnSync } = require('child_process');
const path = require('path');

const nextBin = path.join(__dirname, '..', 'node_modules', 'next', 'dist', 'bin', 'next');
const args = ['dev', ...process.argv.slice(2)];

const result = spawnSync(process.execPath, [nextBin, ...args], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EC9V3_NEXT_DIST_DIR: '.next-dev',
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

