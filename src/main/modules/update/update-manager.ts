import { appEnv } from '@ybgnb/vite-env/common'
import electronUpdater, { type UpdateDownloadedEvent } from 'electron-updater'
import { dialog } from 'electron'
import { getAppSettings } from '@/main/utils/host-app.js'
import { mainLogger } from '@/main/common/main-logger.js'

class AppUpdateManager {
  updateTask: null | Promise<void> = null
  ignoreResult = false
  // 是否显示上次检查更新为最新版本的提示
  showLastCheckUpToDateTip: boolean = false
  /** autoUpdater 监听是否已注册 */
  private initialized = false

  /**
   * 当前平台是否支持应用内自动更新。
   *
   * macOS 版本目前是 ad-hoc 签名（`identity: '-'`，本机无 Developer ID 证书）。
   * electron-updater 在 darwin 上走 Electron 原生 Squirrel.Mac，它要求新 bundle 通过
   * **当前运行应用**的 designated requirement 校验；ad-hoc 的 DR 会退化成该二进制的
   * cdhash，任何新构建都不匹配，因此下载完成后 quitAndInstall() 必然失败、
   * 界面还不会有任何提示。在拿到 Developer ID 证书并启用公证之前，macOS 上直接关闭
   * 更新能力，避免"转圈后毫无反应"的静默失败。
   */
  get supported(): boolean {
    return process.platform !== 'darwin'
  }

  init() {
    // 幂等：主窗口在 macOS 上会被反复重建，重复注册会叠加监听，一次更新弹出多个安装框
    if (this.initialized) return
    this.initialized = true

    const autoUpdater = electronUpdater.autoUpdater
    autoUpdater.on('update-not-available', () => {
      if (this.showLastCheckUpToDateTip) {
        dialog.showMessageBox({
          type: 'info',
          buttons: ['确定'],
          title: '提示',
          message: `当前已经是最新版本`,
        })
        this.showLastCheckUpToDateTip = false
      }
    })
    autoUpdater.on('update-downloaded', async (event: UpdateDownloadedEvent) => {
      if (this.ignoreResult) return
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['立即安装', '暂不安装'],
        title: '检测到新版本',
        message: `新版本 ${event.version} 已下载完成`,
      })

      if (response === 0) {
        autoUpdater.quitAndInstall()
      }
    })
    // 必须显式记录错误：electron-updater 只把错误写进它自己的 logger，
    // 不监听 error 会让"检查更新"失败表现为转圈后毫无反应。
    autoUpdater.on('error', (e: unknown) => {
      mainLogger.error('检查更新失败:', e)
    })
    if (appEnv.PROD && this.supported && getAppSettings().autoUpdateOnStartup) {
      void this.checkUpdate()
    }
  }

  async checkUpdate() {
    if (!this.supported) {
      mainLogger.info('当前平台不支持应用内自动更新（macOS 未签名），已跳过检查更新')
      return
    }
    this.ignoreResult = false
    if (this.updateTask) {
      return this.updateTask
    }

    this.updateTask = (async () => {
      try {
        await electronUpdater.autoUpdater.checkForUpdatesAndNotify()
      } finally {
        this.updateTask = null
      }
    })()

    return this.updateTask
  }

  async cancelCheck() {
    this.ignoreResult = true
  }
}

export const appUpdateManager = new AppUpdateManager()
