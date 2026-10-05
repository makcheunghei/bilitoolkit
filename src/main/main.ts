// https://www.electronjs.org/zh/docs/latest/tutorial/quick-start
// app 控制应用程序的事件生命周期（相当于应用程序）
// BrowserWindow 创建并控制浏览器窗口（相当于打开桌面弹框）
import { app, BrowserWindow, globalShortcut, ipcMain, session } from 'electron'
import * as os from 'node:os'
import { windowManager } from '@/main/window/window-manager.js'
import { appPath } from '@/main/common/app-path.js'
import { mainEnv } from '@/main/common/main-env.js'
import { mainLogger } from '@/main/common/main-logger.js'
import { initFFmpeg } from '@/main/modules/ffmpeg/init.js'
import { killAllFfmpeg } from '@/main/modules/ffmpeg/merge.js'
import '@/shared/utils/polyfills'
import windowStateKeeper from 'electron-window-state'

initFFmpeg()

if (mainEnv.DEV) {
  // Source Map 支持库 => 开发环境打印日志时输出源码路径和行号
  ;(await import('source-map-support')).install()
}

process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
app.commandLine.appendSwitch('disable-web-security')
//if (mainEnv.DEV) app.commandLine.appendSwitch('disable-http-cache')

process.on('uncaughtException', (err) => {
  mainLogger.error('uncaughtException:', err)
  app.quit()
})

process.on('unhandledRejection', (reason) => {
  // 插件或背景任務的 rejected promise 不應令整個應用程式退出。
  mainLogger.error('unhandledRejection:', reason)
})

// 设置全局最大监听器数
ipcMain.setMaxListeners(0)

// 主窗口
let mainWindow: BrowserWindow | null = null

// 禁用 Windows 7 的 GPU 加速
if (os.release().startsWith('6.1')) {
  app.disableHardwareAcceleration()
}

// 设置 Windows 10+ 通知的应用程序名称
if (process.platform === 'win32') app.setAppUserModelId(app.getName())

// 创建窗口 https://www.electronjs.org/zh/docs/latest/api/browser-window
const createWindow = async () => {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1000,
    defaultHeight: 720,
  })

  mainWindow = windowManager.createWindow(
    {
      minWidth: 1000,
      minHeight: 720,
      x: mainWindowState.x,
      y: mainWindowState.y,
      width: mainWindowState.width,
      height: mainWindowState.height,
      webPreferences: {
        preload: appPath.preloadJS,
      },
    },
    { show: true },
  )

  mainWindowState.manage(mainWindow)

  // 初始化主窗口相关的 IPC 事件监听和处理
  await windowManager.initMainWindow(mainWindow)
}

// 这段程序将会在 Electron 结束初始化和创建浏览器窗口的时候调用
// 部分 API 在 ready 事件触发后才能使用。
app.whenReady().then(() => {
  if (mainEnv.DEV) {
    session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const url = details.url
      const isImage = /\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)(\?|$)/i.test(url)

      if (!isImage) {
        // 非图片请求：强制禁用缓存
        details.requestHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate'
        details.requestHeaders['Pragma'] = 'no-cache'
        callback({ cancel: false, requestHeaders: details.requestHeaders })
        return
      }
      // 图片请求：不修改头，保持默认缓存策略
      callback({
        cancel: false,
        requestHeaders: details.requestHeaders,
      })
    })
  }
  createWindow().catch((e) => {
    mainLogger.error('创建主窗口失败:', e)
  })
})

// 除了 macOS 外，当所有窗口都被关闭的时候退出程序。 因此, 通常对应用程序和它们的菜单栏来说应该时刻保持激活状态,
// 直到用户使用 Cmd + Q 明确退出
app.on('window-all-closed', () => {
  mainWindow = null
  if (process.platform !== 'darwin') app.quit()
})

// 退出前统一清理进程级资源。
// ffmpeg 子进程与全局快捷键都不会随主进程退出自动回收：不清理会留下仍在写文件的
// ffmpeg 进程，并在应用已退出后继续占用 CommandOrControl+Shift+i。
app.on('will-quit', () => {
  killAllFfmpeg()
  globalShortcut.unregisterAll()
})

app.on('activate', () => {
  // 在 macOS 系统内，如果没有已开启的应用窗口
  // 点击 Dock 图标时通常会重新创建一个新窗口
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length) {
    allWindows[0].focus()
  } else {
    // 必须捕获异常：重建失败时若不记录，窗口既不显示也没有任何提示
    // （表现为点 Dock 图标毫无反应，只能 Cmd+Q 后重启）
    createWindow().catch((e) => {
      mainLogger.error('重建主窗口失败:', e)
    })
  }
})
