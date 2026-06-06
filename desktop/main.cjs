const { app, BrowserWindow, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');

let mainWindow = null;
let serverProcess = null;

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findPort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free desktop server port found near ${start}`);
}

function waitForServer(url, timeoutMs = 45000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        if (Date.now() - start >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(check, 500);
      });

      req.setTimeout(2500, () => {
        req.destroy();
      });
    };

    check();
  });
}

function getServerCommand(port) {
  const repoRoot = path.resolve(__dirname, '..');
  const production = app.isPackaged || process.argv.includes('--production');
  const baseEnv = {
    ...process.env,
    PORT: String(port),
    HOSTNAME: '127.0.0.1',
    EC9V3_DESKTOP: '1',
  };

  if (!production) {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    return {
      command: npmCommand,
      args: ['run', 'dev', '--', '-H', '127.0.0.1', '-p', String(port)],
      cwd: repoRoot,
      env: baseEnv,
    };
  }

  const serverPath = app.isPackaged
    ? path.join(process.resourcesPath, 'next', 'server.js')
    : path.join(repoRoot, '.next', 'standalone', 'server.js');

  return {
    command: process.execPath,
    args: [serverPath],
    cwd: path.dirname(serverPath),
    env: {
      ...baseEnv,
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}

async function startServer() {
  const port = await findPort(Number(process.env.EC9V3_DESKTOP_PORT || 33119));
  const url = `http://127.0.0.1:${port}`;
  const server = getServerCommand(port);

  serverProcess = spawn(server.command, server.args, {
    cwd: server.cwd,
    env: server.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    console.log(`[ec9v3-server] ${chunk.toString().trimEnd()}`);
  });

  serverProcess.stderr.on('data', (chunk) => {
    console.error(`[ec9v3-server] ${chunk.toString().trimEnd()}`);
  });

  serverProcess.on('exit', (code, signal) => {
    if (mainWindow) {
      mainWindow.webContents.send('server-exit', { code, signal });
    }
  });

  await waitForServer(`${url}/settings`);
  return url;
}

async function createWindow() {
  const url = await startServer();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 720,
    title: 'EC9V3',
    backgroundColor: '#050814',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(url);
}

function stopServer() {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
  }
  serverProcess = null;
}

app.whenReady().then(() => {
  createWindow().catch((error) => {
    console.error(error);
    app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        console.error(error);
        app.quit();
      });
    }
  });
});

app.on('before-quit', stopServer);

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});

