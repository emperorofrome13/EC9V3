const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const outputDir = path.join(repoRoot, '.next');
const nextBin = path.join(repoRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

if (outputDir.startsWith(repoRoot)) {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

const result = spawnSync(process.execPath, [nextBin, 'build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    EC9V3_NEXT_DIST_DIR: '.next',
  },
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);

