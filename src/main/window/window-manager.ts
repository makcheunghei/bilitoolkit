import { BrowserWindow, globalShortcut, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron'
import { IPC_CHANNELS } from '@/shared/types/electron-ipc.js'
import { execBiz, formatUnitSize, isCanceledError } from '@ybgnb/utils'
import type { PluginApiInvokeOptions } from '@/shared/types/api-invoke.js'
import { ToolkitApiDispatcher } from '@/main/api/handler/toolkit-api-dispatcher.js'
import { BaseWindowManager } from '@/main/window/base-window-manager.js'
import { showDevTools } from '@/main/utils/dev-tools.js'
import { mainLogger, mainConsoleLogger, mainFileLogger } from '@/main/common/main-logger.js'
import { appPath } from '@/main/common/app-path.js'
import { BiliApiBusinessError } from '@ybgnb/bili-api'
import { initDatabase } from '@/main/db/init.js'
import { taskRuntime } from '@/main/plugin/task/runtime.js'
import { LOG_IGNORED_API_SET, LOG_IGNORED_API_REGEXP } from '@/main/common/main-constants.js'
import util from 'node:util'
import { fileHandleManager } from '@/main/modules/file-handle/file-handle-manager.js'
import { AppError } from 'bilitoolkit-types'
import { appUpdateManager } from '@/main/modules/update/update-manager.js'
import { downloadManager } from '@/main/modules/download/download-manager.js'
import { userManager } from '@/main/modules/user-manager.js'

type IpcMainInvokeEvent = Electron.IpcMainInvokeEvent

/**
 * 窗口管理
 *
 * 项目主要环境划分：
 *    不同窗口对应的宿主环境（应用自己的基础web内容） <=> 主进程 <=> 不同窗口对应的不同插件环境
 *
 *  一个窗口的环境：
 *    一个主窗口：BrowserWindow
 *    一个宿主环境：WebContents
 *    多个插件环境：WebContentsView
 */
export class WindowManager extends BaseWindowManager {
  // API处理器
  readonly apiDispatcher: ToolkitApiDispatcher
  /** 进程级全局资源是否已初始化完成 */
  private globalInitialized = false
  /** 全局初始化的进行中 Promise（并发重入保护） */
  private globalInitPromise: Promise<void> | null = null

  constructor() {
    super()
    this.apiDispatcher = new ToolkitApiDispatcher(this)
  }

  /**
   * 初始化主进程相关的设置
   *
   * 注意：本方法在 macOS 上**会被多次调用**——关闭主窗口后进程按 darwin 分支存活，
   * 点 Dock 图标经 `activate` 重建主窗口时会再次走到这里。因此方法体内必须区分：
   *   - 每窗口初始化（本方法直接执行）
   *   - 进程级全局初始化（交 ensureGlobalInitialized，只执行一次）
   *
   * @param mainWindow 主窗口
   */
  public async initMainWindow(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow
    this.configureChildWindowBehavior(mainWindow)
    // 监听主窗口的 close 事件
    mainWindow.on('close', async () => {
      // 取消所有任务
      await taskRuntime.cancelAll()
    })
    // 进程级全局资源只初始化一次
    await this.ensureGlobalInitialized()
    // 主窗口重建后，把已存在的对话框视图重新绑到新窗口上（否则 resize 监听仍挂在已销毁的旧窗口）
    await this.bindAppDialogViewToWindow(mainWindow)
    // 每次重建主窗口都必须重新加载内容：旧窗口已销毁，不加载则新窗口永远停留在 show:false
    if (appPath.devUrl) {
      // 开发
      await mainWindow.loadURL(appPath.devUrl)
    } else {
      // 生产
      await mainWindow.loadFile(appPath.appURL)
    }
  }

  /**
   * 进程级全局初始化，保证整个进程只执行一次。
   *
   * 这些资源都是进程级的：`ipcMain.handle` 重复注册会抛
   * "Attempted to register a second handler for 'PLUGIN_APIS'"，
   * `appUpdateManager.init()` 重复调用会叠加 autoUpdater 监听导致弹多个安装框；
   * 一旦抛错，同一函数内后续的数据库/调度/下载初始化与窗口内容加载就全部被跳过，
   * 新窗口既不显示也不可用（表现为点 Dock 图标毫无反应）。
   */
  private async ensureGlobalInitialized() {
    if (this.globalInitialized) return
    if (this.globalInitPromise) return await this.globalInitPromise

    this.globalInitPromise = (async () => {
      // 初始化插件API监听（先移除同名 handler，保证热重载/异常路径下的幂等）
      ipcMain.removeHandler(IPC_CHANNELS.PLUGIN_APIS)
      ipcMain.handle(IPC_CHANNELS.PLUGIN_APIS, async (event: IpcMainInvokeEvent, options: PluginApiInvokeOptions) => {
        return await this.handlePluginApiInvoke(options, event)
      })
      // 设置菜单
      this.configureApplicationMenu()
      // 应用更新检测
      appUpdateManager.init()
      // 在开发环境和生产环境均可通过快捷键打开devTools
      globalShortcut.register('CommandOrControl+Shift+i', function () {
        showDevTools()
      })
      // 初始化数据库
      await initDatabase()
      await userManager.init()
      // 初始化对话框视图
      await this.initAppDialogView()
      // 初始化任务调度
      void taskRuntime.bootstrap()
      // 初始化下载管理
      void downloadManager.bootstrap()
      // 初始化文件句柄API
      fileHandleManager.init()
      this.globalInitialized = true
    })()

    try {
      await this.globalInitPromise
    } catch (e) {
      // 初始化失败则清空缓存，允许下次重建窗口时重试
      this.globalInitPromise = null
      throw e
    }
  }

  /**
   * 配置 macOS 标准应用菜单，保留 Cmd+Q、复制、粘贴等系统快捷键。
   */
  private configureApplicationMenu() {
    if (process.platform !== 'darwin') {
      Menu.setApplicationMenu(null)
      return
    }

    const template: MenuItemConstructorOptions[] = [
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  /**
   * 处理插件 API 调用
   */
  private async handlePluginApiInvoke(options: PluginApiInvokeOptions, event: Electron.IpcMainInvokeEvent) {
    return await execBiz(async () => {
      let logPrefix = `[${options.module}.${options.name}]`
      try {
        const apiCallerContext = this.getApiCallerContext(event)
        logPrefix = `[${apiCallerContext.envType}] ${apiCallerContext.envType === 'plugin' ? `${apiCallerContext.plugin.id} ` : ''}${logPrefix}`
        const isDialog = apiCallerContext.envType === 'host' && apiCallerContext.isDialogWebContents
        if (!isDialog) {
          handleLogger(options, logPrefix, '执行中', 'arg', options?.args)
        }
        const result = await this.apiDispatcher.handle(event, options, apiCallerContext)
        if (!isDialog) {
          handleLogger(options, logPrefix, '执行成功', 'rep', result)
        }
        return result
      } catch (e) {
        if (isCanceledError(e)) {
          throw e
        }
        if (e instanceof BiliApiBusinessError) {
          mainLogger.error(`${logPrefix} 执行错误`, e.message, e.responseCode)
        } else if (e instanceof AppError) {
          mainLogger.error(`${logPrefix} 执行错误`, e.message)
        } else {
          mainLogger.error(`${logPrefix} 执行错误`, e)
        }
        throw e
      }
    })
  }
}

// 处理日志打印
function handleLogger(
  options: Omit<PluginApiInvokeOptions, 'args'>,
  logPrefix: string,
  status: string,
  dataName: 'arg' | 'rep',
  data: unknown,
) {
  const apiPath = `${options.module}.${options.name}`
  if (LOG_IGNORED_API_SET.has(apiPath)) return
  for (const regExp of LOG_IGNORED_API_REGEXP) {
    if (apiPath.match(regExp)) {
      return
    }
  }
  if (data == null || data === '') {
    mainLogger.info(`${logPrefix} ${status}`)
    return
  }
  const jsonData = util.inspect(data, { depth: null, colors: false })
  const argSize = jsonData.length ?? 0
  if (argSize > 300) {
    // 参数过长时，不在控制台打印具体参数
    mainConsoleLogger.info(
      `${logPrefix} ${status} ${dataName} size: ${formatUnitSize(argSize, 1024, ['B', 'KB', 'MB', 'GB', 'TB'], '').text}`,
    )
    mainFileLogger.info(`${logPrefix} ${status}`, jsonData)
  } else {
    mainLogger.info(`${logPrefix} ${status}`, jsonData)
  }
}

/**
 * 窗口管理单例
 */
export const windowManager = new WindowManager()
