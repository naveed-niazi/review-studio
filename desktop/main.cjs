const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  utilityProcess,
  ipcMain,
  dialog,
  shell,
  safeStorage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

if (process.env.REVIEW_STUDIO_DATA)
  app.setPath('userData', path.join(process.env.REVIEW_STUDIO_DATA, 'desktop'));
let window,
  service,
  tray,
  address,
  quitting = false,
  serviceStopped = false,
  serviceLog = '',
  prefs = { keepRunning: true };
const keyPath = () => path.join(app.getPath('userData'), 'api-key.encrypted');
const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');
const safeExternal = (url) => {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') void shell.openExternal(url);
  } catch {}
};
function cliPath() {
  const home = os.homedir();
  const paths = [
    path.join(home, '.local/bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.volta/bin'),
    path.join(home, '.asdf/shims'),
    path.join(home, '.local/share/mise/shims'),
  ];
  const nvm = path.join(home, '.nvm/versions/node');
  try {
    for (const version of fs
      .readdirSync(nvm)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })))
      paths.push(path.join(nvm, version, 'bin'));
  } catch {}
  return [
    ...new Set(
      [
        ...(process.env.PATH || '').split(path.delimiter),
        ...paths,
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin',
      ].filter(Boolean),
    ),
  ].join(path.delimiter);
}
function preferences() {
  const login = app.getLoginItemSettings({ args: ['--background'] });
  return {
    apiKeySaved: fs.existsSync(keyPath()),
    keepRunning: prefs.keepRunning,
    openAtLogin: login.openAtLogin,
    loginStatus: login.status || null,
  };
}
function verifySender(event) {
  if (!address || new URL(event.senderFrame.url).origin !== address)
    throw new Error('Untrusted window.');
}
function createWindow(show = true) {
  if (window && !window.isDestroyed()) {
    if (show) {
      window.show();
      window.focus();
    }
    return;
  }
  window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 780,
    minHeight: 600,
    title: 'Review Studio',
    backgroundColor: '#f7f8fa',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    safeExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== address) {
      event.preventDefault();
      safeExternal(url);
    }
  });
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false),
  );
  window.on('close', (event) => {
    if (!quitting && prefs.keepRunning) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    window = null;
    if (!prefs.keepRunning) app.quit();
  });
  window.once('ready-to-show', () => {
    if (show) window.show();
  });
  void window.loadURL(address);
}
function showWindow() {
  createWindow(true);
}
function setupTray() {
  let icon = nativeImage.createFromPath(path.join(__dirname, '../build/trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Review Studio · local code reviews');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Review Studio', click: showWindow },
      { type: 'separator' },
      { label: 'Quit Review Studio', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => address && showWindow());
  app.on('activate', () => address && showWindow());
  app.whenReady().then(() => {
    try {
      prefs = {
        ...prefs,
        ...JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')),
      };
    } catch {}
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'Review Studio',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            {
              label: 'Settings',
              accelerator: 'CmdOrCtrl+,',
              click: () => {
                showWindow();
                window.webContents.send('navigate', 'settings');
              },
            },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        {
          label: 'View',
          submenu: [
            { role: 'reload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' },
            { role: 'togglefullscreen' },
          ],
        },
        { role: 'windowMenu' },
      ]),
    );
    ipcMain.handle('preferences:get', (event) => {
      verifySender(event);
      return preferences();
    });
    ipcMain.handle('preferences:set', (event, values) => {
      verifySender(event);
      if (typeof values.openAtLogin === 'boolean') {
        if (!app.isPackaged) throw new Error('Start at login is available in the packaged app.');
        if (values.openAtLogin && process.platform === 'darwin' && !app.isInApplicationsFolder())
          throw new Error('Move Review Studio into Applications before enabling start at login.');
        app.setLoginItemSettings({
          openAtLogin: values.openAtLogin,
          args: ['--background'],
        });
        const login = app.getLoginItemSettings({ args: ['--background'] });
        if (values.openAtLogin && !login.openAtLogin && login.status !== 'requires-approval')
          throw new Error(
            'macOS did not register this login item. A signed, notarized build installed in Applications is required for reliable login startup.',
          );
      }
      if (typeof values.keepRunning === 'boolean') prefs.keepRunning = values.keepRunning;
      fs.mkdirSync(path.dirname(preferencesPath()), { recursive: true });
      fs.writeFileSync(preferencesPath(), JSON.stringify(prefs), {
        mode: 0o600,
      });
      return preferences();
    });
    ipcMain.handle('directory:select', async (event) => {
      verifySender(event);
      const result = await dialog.showOpenDialog(window, {
        properties: ['openDirectory'],
        title: 'Choose a local repository',
      });
      return result.canceled ? null : result.filePaths[0];
    });
    ipcMain.handle('credentials:set', (event, key) => {
      verifySender(event);
      if (typeof key !== 'string' || key.length > 500) throw new Error('Invalid API key.');
      if (key) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error('Secure credential storage is unavailable. Use CLI sign-in instead.');
        fs.mkdirSync(path.dirname(keyPath()), { recursive: true });
        fs.writeFileSync(keyPath(), safeStorage.encryptString(key), {
          mode: 0o600,
        });
      } else {
        try {
          fs.unlinkSync(keyPath());
        } catch (e) {
          if (e.code !== 'ENOENT') throw e;
        }
      }
      service.postMessage({ type: 'api-key', value: key });
      return preferences();
    });
    let savedKey = '';
    try {
      if (fs.existsSync(keyPath()))
        savedKey = safeStorage.decryptString(fs.readFileSync(keyPath()));
    } catch {
      dialog.showErrorBox(
        'Saved API key needs attention',
        'Your encrypted key could not be read. Reconnect from Settings. CLI sign-in is still available.',
      );
    }
    setupTray();
    service = utilityProcess.fork(path.join(__dirname, '../server/index.js'), [], {
      serviceName: 'Review Studio Engine',
      env: {
        ...process.env,
        PATH: cliPath(),
        REVIEW_STUDIO_API_KEY: savedKey,
        REVIEW_STUDIO_PORT: '0',
        REVIEW_STUDIO_DATA:
          process.env.REVIEW_STUDIO_DATA || path.join(os.homedir(), '.review-studio'),
      },
      stdio: 'pipe',
    });
    const collect = (chunk) => {
      serviceLog = (serviceLog + chunk.toString()).slice(-6000);
    };
    service.stdout?.on('data', collect);
    service.stderr?.on('data', collect);
    service.on('message', (message) => {
      if (message.type === 'ready') {
        address = message.url;
        createWindow(
          !process.argv.includes('--background') && !app.getLoginItemSettings().wasOpenedAtLogin,
        );
      }
    });
    service.on('exit', (code) => {
      serviceStopped = true;
      if (quitting) {
        app.quit();
        return;
      }
      dialog.showErrorBox(
        'Review Studio could not keep running',
        `The local engine exited (${code}). Your saved queue is preserved.\n\n${serviceLog}`,
      );
      quitting = true;
      app.quit();
    });
    setTimeout(() => {
      if (!address && !quitting)
        dialog.showErrorBox(
          'Review Studio is taking longer to start',
          serviceLog || 'The local engine has not responded. Quit and reopen the app.',
        );
    }, 20000).unref();
  });
}
app.on('before-quit', (event) => {
  quitting = true;
  if (service && !serviceStopped) {
    event.preventDefault();
    service.postMessage({ type: 'shutdown' });
    setTimeout(() => {
      if (!serviceStopped) {
        service.kill();
      }
    }, 8000).unref();
  }
});
app.on('window-all-closed', () => {
  if (!prefs.keepRunning) app.quit();
});
