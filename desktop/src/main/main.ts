import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell } from "electron";
import { writeFile, readFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { createXhsAuthority } from './xiaohongshu-authority.ts';
import { createXhsWorker } from './xiaohongshu-worker.ts';
import { XhsDesktopService } from './xiaohongshu-service.ts';
import { registerXhsIpc } from './xiaohongshu-ipc.ts';
import { registerCouncilReportIpc } from './council-report-ipc.ts';
import path from "node:path";
import { createMainWindow } from "./create-window.ts";
import { accountKey, registerDesktopIpc } from "./desktop-ipc.ts";
import { startRendererServer } from "./renderer-server.ts";
import {
  SidecarProcessManager,
  type SidecarProcessManagerOptions,
} from "./sidecar-process-manager.ts";
import { createAppPaths, type AppPaths } from "./app-paths.ts";
import { createDesktopLogger } from "./logger.ts";
import { desktopExecutionPaths, rendererLocation } from "./runtime-location.ts";
import { installControlledQuitSignalHandlers, stopDesktopServices } from "./controlled-shutdown.ts";
import { resolveDesktopRuntime, type RemoteDesktopRuntime } from "./runtime-config.ts";
import { prepareLocalApplication } from './prepare-local-application.ts';
import { readEmbeddedReferencePack } from './embedded-reference-pack.js';
import type { LocalApplicationRuntime } from './local-application-runtime.ts';
import { requestLocalInitialAccount } from './local-setup-window.ts';
import { launchSingleInstanceApplication, keepApplicationAliveBetweenWindows } from "./main-bootstrap.ts";
import { readDesktopBuildIdentity, readDevelopmentDesktopBuildIdentity } from "./desktop-build-identity.ts";
import { createAppUpdateService, installedRelease } from "./app-update-service.ts";
import { registerAppUpdateIpc } from "./app-update-ipc.ts";
import { UPDATE_CHANNELS } from "../shared/app-update.ts";
import { DesktopCentralApiClient } from "./desktop-central-api-client.ts";
import { createDeviceInstallationStore } from "./device-installation.ts";
import { createDeviceCredentialStore } from "./device-credential-store.ts";
import { createOutreachActionJournalStore } from "./outreach-action-journal.ts";
import { DesktopOutreachActionCoordinator } from "./outreach-action-coordinator.ts";
import { attachOutreachSidecarLifecycle, sidecarActionPort } from "./outreach-action-lifecycle.ts";
import { DesktopEnrollmentService } from "./desktop-enrollment-service.ts";
import { CfoVoiceService } from './cfo-voice.ts';
import { CFO_GREETING_ASSET_FILENAME, createMacGreetingOutput, registerCfoVoiceIpc } from './cfo-voice-ipc.ts';
import { createCfoRealtimeSettingsStore } from './cfo-realtime-settings.ts';
import { CfoRealtimeService } from './cfo-realtime-service.ts';
import { openQwenRealtime } from './cfo-realtime-provider.ts';
import { createCfoVoiceAuthority } from './cfo-realtime-authority.ts';
import { registerCfoRealtimeIpc } from './cfo-realtime-ipc.ts';
import { CFO_REALTIME_EVENT } from '../shared/cfo-realtime.ts';
import { registerEnterpriseBrowserIpc } from './enterprise-browser-ipc.ts';
import { createEnterpriseLocalBrowser } from './enterprise-local-browser.ts';

async function main(runtime: RemoteDesktopRuntime, paths: AppPaths,
  localApplication?: LocalApplicationRuntime, handoffStartup: () => void = () => {}): Promise<void> {
  const environment: "production" | "development" = app.isPackaged
    ? "production"
    : "development";
  const logger = createDesktopLogger(path.join(paths.logs, "desktop.jsonl"));
  const executionPaths = desktopExecutionPaths({
    production: environment === "production",
    mainModuleDirectory: import.meta.dirname,
    appPath: app.getAppPath(),
  });

  const location = rendererLocation({
    production: environment === "production",
    resourcesPath: process.resourcesPath,
    repositoryRoot: executionPaths.repositoryRoot,
  });
  const remoteOrigin = runtime.remoteOrigin;
  // Resolve once in Main. Neither Renderer nor a later environment change can
  // override the identity/origin used by enrollment and action requests.
  const buildManifestSha256 = environment === "production"
    ? await readDesktopBuildIdentity(process.resourcesPath)
    : await readDevelopmentDesktopBuildIdentity(executionPaths.repositoryRoot!,
      process.env.SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH ?? "");
  const central = new DesktopCentralApiClient({ origin: remoteOrigin, buildManifestSha256 });
  const renderer = await startRendererServer({ distDir: location.distDir, remoteOrigin, buildManifestSha256 });

  const managerOptions: SidecarProcessManagerOptions = {
    environment,
    repositoryRoot: executionPaths.repositoryRoot,
    resourcesPath: process.resourcesPath,
    userDataDirectory: paths.userData,
    logsDirectory: paths.logs,
    temporaryDirectory: paths.temp,
    logger: (message: string) => logger.info("sidecar.status", { message }),
    outputLogger: (stream, line) => logger.warn("sidecar.output", {
      stream,
      line: line.slice(0, 500),
    }),
  };
  const manager = new SidecarProcessManager(managerOptions);
  const installationStore = createDeviceInstallationStore(paths.installation);
  const credentialStore = createDeviceCredentialStore({ directory: paths.deviceCredentials, safeStorage });
  const coordinator = new DesktopOutreachActionCoordinator({
    central,
    sidecar: sidecarActionPort(manager),
    installationStore,
    credentialStore,
    journalStore: createOutreachActionJournalStore(paths.outreachJournal),
    enabled: !localApplication,
    onDiagnostic: (diagnostic) => logger.warn("desktop.outreach_operation_failed", diagnostic),
    // The current login/collection IPC's historical accountId is a workspace
    // ID. Reuse that exact Profile key; the central lane still uses accountId.
    accountKeyFor: (_accountId, workspaceId) => accountKey(workspaceId),
  });
  const outreach = new DesktopEnrollmentService({ central, installationStore, credentialStore, coordinator,
    onBindingDiagnostic: diagnostic => logger.warn("desktop.binding_failed", diagnostic) });
  const disposeOutreachLifecycle = attachOutreachSidecarLifecycle({
    manager,
    coordinator,
    onFailure: () => logger.error("desktop.outreach_lifecycle_failed"),
  });
  let window: BrowserWindow | null = null;
  const xhsEnabled = !localApplication && process.env.XHS_DESKTOP_SENDING_ENABLED === 'true';
  const xhsUpstream = process.env.SHENSI_XHS_UPSTREAM_PATH;
  const xhsService = new XhsDesktopService(createXhsAuthority({ localOrigin: renderer.origin,
    session: () => window?.webContents.session, installationStore, credentialStore }), scope => {
    if (!executionPaths.repositoryRoot || !xhsUpstream || !path.isAbsolute(xhsUpstream))
      throw new Error('xhs_runtime_not_configured');
    const directory = path.join(executionPaths.repositoryRoot, 'services', 'xiaohongshu');
    const storage = path.join(paths.userData, 'xiaohongshu');
    mkdirSync(storage, { recursive: true, mode: 0o700 });
    return createXhsWorker({ executable: path.join(directory, '.venv', 'bin', 'python'), cwd: directory,
      args: ['-u', path.join(directory, 'worker_process.py'), '--workspace', scope.workspaceId,
        '--actor', scope.actorId, '--device', scope.deviceId, '--storage', storage, '--upstream', xhsUpstream,
        ...(xhsEnabled ? ['--enable-sending'] : [])] });
  }, xhsEnabled);
  const xhsIpc = registerXhsIpc({localOrigin: renderer.origin, authorizedSender: () => window?.webContents, ipcMain, service: xhsService});
  let xhsChecking = false;
  const xhsMonitor = setInterval(() => {
    if (xhsChecking) return;
    xhsChecking = true;
    void xhsService.checkSession().finally(() => { xhsChecking = false; });
  }, 15_000);
  xhsMonitor.unref();
  const enterpriseLocal = createEnterpriseLocalBrowser({
    createWindow: options => new BrowserWindow(options),
    captureScript: await readFile(path.join(import.meta.dirname, 'enterprise-capture.js'), 'utf8'),
    authorize: async () => {
      if (!window) throw new Error('auth_required');
      const response = await window.webContents.session.fetch(`${renderer.origin}/api/auth/me`,
        { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('auth_required');
      const data = await response.json();
      if (typeof data?.user?.id !== 'string' || !data.user.id) throw new Error('auth_required');
      return `${remoteOrigin}:${data.user.id}`;
    }
  });
  const enterpriseBrowserIpc = registerEnterpriseBrowserIpc({ ipcMain, localOrigin: renderer.origin, sender: () => window?.webContents, local: enterpriseLocal });
  const councilReportIpc = registerCouncilReportIpc({ localOrigin: renderer.origin, ipcMain,
    authorizedSender: () => window?.webContents,
    createWindow: options => new BrowserWindow(options),
    showSaveDialog: options => window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options),
    writeFile });
  const voiceAuthority = createCfoVoiceAuthority({ localOrigin: renderer.origin, session: () => window?.webContents.session });
  const realtimeSettings = createCfoRealtimeSettingsStore({ directory: path.join(paths.userData, 'realtime-voice'), safeStorage });
  const realtime = new CfoRealtimeService({ store: realtimeSettings,
    diagnostic: value => logger.info('cfo.realtime_turn', value),
    connect: (settings, history, receive, signal) => openQwenRealtime(settings, history, receive, signal,
      { endpoint: 'dashscope', onDiagnostic: diagnostic => logger.warn('cfo.realtime_connection_failed', { endpoint: 'dashscope', ...diagnostic }) }),
    ask: voiceAuthority.ask, emit: event => { if (window && !window.isDestroyed()) window.webContents.send(CFO_REALTIME_EVENT, event); } });
  const realtimeIpc = registerCfoRealtimeIpc({ localOrigin: renderer.origin, service: realtime, ipcMain,
    authorizedSender: () => window?.webContents, authorize: voiceAuthority.authorize,
    openHelp: kind => shell.openExternal(kind === 'key' ? 'https://help.aliyun.com/zh/model-studio/get-api-key'
      : 'https://help.aliyun.com/zh/model-studio/obtain-the-app-id-and-workspace-id') });
  const bundledGreetingAsset = path.join(environment === 'production'
    ? process.resourcesPath : path.join(executionPaths.repositoryRoot!, 'desktop', 'resources'),
  'audio', CFO_GREETING_ASSET_FILENAME);
  const voice = new CfoVoiceService(createMacGreetingOutput({ directory: path.join(paths.userData, 'voice-preferences'),
    bundledAssetPath: bundledGreetingAsset,
    store: realtimeSettings,
    diagnostic: value => logger.info('cfo.startup_greeting', value) }));
  const voiceIpc = registerCfoVoiceIpc({ localOrigin: renderer.origin, ipcMain, voice,
    authorizedSender: () => window?.webContents, authorize: voiceAuthority.authorize });
  const updates = createAppUpdateService({
    installed: installedRelease({
      platform: process.platform,
      arch: process.arch === "arm64" ? "arm64" : "x64",
      buildManifestSha256
    }),
    directory: path.join(paths.userData, "updates"),
    reveal: async (filePath) => { await shell.showItemInFolder(filePath); },
    onState: (state) => {
      const sender = window?.webContents;
      if (!sender || sender.isDestroyed()) return;
      try { if (new URL(sender.getURL()).origin !== new URL(renderer.origin).origin) return; }
      catch { return; }
      sender.send(UPDATE_CHANNELS.changed, state);
    }
  });
  const updateIpc = registerAppUpdateIpc({
    localOrigin: renderer.origin,
    ipcMain,
    authorizedSender: () => window?.webContents,
    service: updates
  });
  const ipc = registerDesktopIpc({
    onCollectionDiagnostic: value => logger.info("desktop.collection_start", value),
    localOrigin: renderer.origin,
    ipcMain,
    authorizedSender: () => window?.webContents,
    manager,
    outreach,
    appVersion: () => app.getVersion(),
    openLogsDirectory: () => shell.openPath(paths.logs).then(() => undefined),
    runtimeInfo: () => ({
      platform: "darwin",
      architecture: process.arch === "arm64" ? "arm64" : "x64",
      appVersion: app.getVersion(),
      environment,
      connectorStatus: manager.getStatus(),
    }),
  });

  let cleaning = false;
  let allowQuit = false;
  const disposeSignals = installControlledQuitSignalHandlers(process, () => app.quit());
  const unsubscribeStatus = manager.onStatus((status) => {
    if (window && !window.isDestroyed()) {
      window.webContents.send("shensi:desktop:connector-status-changed", status);
    }
  });
  const open = () => {
    const createdWindow = createMainWindow({
      localOrigin: renderer.origin,
      preloadPath: executionPaths.preloadPath,
      BrowserWindow,
      openExternal: url => shell.openExternal(url),
    });
    window = createdWindow;
    createdWindow.on("closed", () => { realtime.stop(); window = null; void voice.stop().catch(() => undefined); void xhsService.dispose().catch(() => undefined); });
    createdWindow.webContents.on('did-start-navigation', (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame) realtime.stop(); });
    createdWindow.webContents.on('render-process-gone', () => realtime.stop());
    const localMedia = (contents: unknown, url?: string) => {
      try { return !!realtime.activeScope && contents === createdWindow.webContents && new URL(url ?? '').origin === renderer.origin; }
      catch { return false; }
    };
    createdWindow.webContents.session.setPermissionCheckHandler((contents: unknown, permission: string, origin: string, details: { mediaType?: string; isMainFrame?: boolean }) =>
      permission === 'media' && details.mediaType === 'audio' && details.isMainFrame && localMedia(contents, origin));
    createdWindow.webContents.session.setPermissionRequestHandler((contents: unknown, permission: string, callback: (allow: boolean) => void, details: unknown) => {
      const media = details as { mediaTypes?: string[]; securityOrigin?: string; isMainFrame?: boolean };
      callback(permission === 'media' && media.mediaTypes?.length === 1 && media.mediaTypes[0] === 'audio'
        && media.isMainFrame === true && localMedia(contents, media.securityOrigin));
    });
    createdWindow.webContents.on("render-process-gone", () => logger.warn("renderer.crashed"));
  };

  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    } else {
      open();
    }
  });
  app.on("activate", () => { if (!window) open(); });
  handoffStartup();
  app.on("before-quit", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (cleaning) return;
    cleaning = true;
    clearInterval(xhsMonitor);
    councilReportIpc.dispose();
    enterpriseBrowserIpc.dispose();
    voiceIpc.dispose();
    realtimeIpc.dispose();
    outreach.dispose();
    disposeOutreachLifecycle();
    void (async () => {
      try { try { await xhsIpc.dispose(); } finally { await stopDesktopServices({ coordinator, sidecar: manager, renderer }); } }
      finally { await localApplication?.stop(); }
    })()
      .catch(() => logger.error("desktop.shutdown_failed")).then(() => {
      disposeSignals();
      unsubscribeStatus();
      ipc.dispose();
      updateIpc.dispose();
      allowQuit = true;
      app.quit();
    });
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
  ]));
  open();
  void manager.start().catch(() => logger.error("sidecar.start_failed"));
}

function reportBootstrapFailure(paths: AppPaths): void {
  try {
    createDesktopLogger(path.join(paths.logs, "desktop.jsonl"))
      .error("desktop.bootstrap_failed", { code: "initialization_failed" });
  } catch {
    // The application still terminates if even its fallback log path is unavailable.
  }
}

async function bootstrap(): Promise<void> {
  keepApplicationAliveBetweenWindows(app);
  const runtime = await resolveDesktopRuntime({ production: app.isPackaged,
    resourcesPath: process.resourcesPath, environment: process.env });
  const paths = createAppPaths({ baseUserData: app.getPath("appData"),
    environment: runtime.dataEnvironment, testId: runtime.mode === 'standalone' ? undefined : runtime.testId,
    standalone: runtime.mode === 'standalone' });
  // Before the single-instance lock and Chromium session initialization.
  if (runtime.mode === 'standalone') mkdirSync(paths.userData, { recursive: true, mode: 0o700 });
  if (runtime.dataEnvironment === "test" || runtime.mode === 'standalone') app.setPath("userData", path.join(paths.userData, "browser-session"));
  launchSingleInstanceApplication({
    requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
    whenReady: () => app.whenReady(),
    start: async () => {
      if (runtime.mode !== 'standalone') return main(runtime, paths);
      const execution = desktopExecutionPaths({ production: app.isPackaged,
        mainModuleDirectory: import.meta.dirname, appPath: app.getAppPath() });
      const digest = app.isPackaged ? await readDesktopBuildIdentity(process.resourcesPath)
        : await readDevelopmentDesktopBuildIdentity(execution.repositoryRoot!, process.env.SHENSI_DESKTOP_DEV_BUILD_MANIFEST_PATH ?? '');
      const embeddedReference = app.isPackaged ? await readEmbeddedReferencePack(process.resourcesPath) : undefined;
      const local = await prepareLocalApplication({ userData: paths.userData, safeStorage,
        ...(embeddedReference ? { embeddedReference } : {}),
        requestInitialAccount: () => requestLocalInitialAccount({ ipcMain, createWindow: options => new BrowserWindow(options),
          preloadPath: path.join(path.dirname(execution.preloadPath), 'local-setup.cjs') }),
        buildDigest: digest,
        mysqlRuntimeDirectory: app.isPackaged ? path.join(process.resourcesPath, 'mysql') : process.env.SHENSI_STANDALONE_MYSQL_ROOT ?? '',
        nodeExecutable: app.isPackaged ? path.join(process.resourcesPath, 'backend-runtime', 'node') : process.env.SHENSI_STANDALONE_NODE ?? '',
        backendEntrypoint: app.isPackaged ? path.join(process.resourcesPath, 'backend', 'dist', 'server.js')
          : path.join(execution.repositoryRoot!, 'backend', 'dist', 'server.js') });
      let quitting = false;
      const startupQuit = (event: Electron.Event) => {
        event.preventDefault();
        if (quitting) return;
        quitting = true;
        void local.stop().catch(() => reportBootstrapFailure(paths)).finally(() => {
          app.removeListener('before-quit', startupQuit); app.quit();
        });
      };
      app.on('before-quit', startupQuit);
      try {
        await local.start();
        if (quitting) return;
        await main({ remoteOrigin: local.origin, dataEnvironment: runtime.dataEnvironment }, paths, local, () => {
          if (quitting) throw new Error('desktop_start_cancelled');
          app.removeListener('before-quit', startupQuit);
        });
      } catch (error) {
        await local.stop(); app.removeListener('before-quit', startupQuit); throw error;
      }
    },
    quit: () => app.quit(),
    onFailure: () => reportBootstrapFailure(paths),
  });
}
await bootstrap().catch(() => { console.error("desktop.bootstrap_failed"); app.quit(); });
