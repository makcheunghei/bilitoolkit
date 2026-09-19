import { readFileSync } from 'node:fs'
import type { Configuration } from 'electron-builder'

const winIcon = 'public/favicon.ico'
const installerIcon = 'public/favicon.ico'
const uninstallerIcon = 'public/favicon.ico'
const macIcon = 'doc/logo/icon.icns'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

export default (): Configuration => {
  console.log('============正在打包electron============')
  return {
    // 应用程序 ID
    appId: packageJson.appId,
    // 应用程序名称
    productName: packageJson.productName,
    // 是否将应用程序的源代码打包成 asar 归档
    asar: true,
    // 原生執行檔必須解包，否則 asar 內無法直接執行。
    asarUnpack: ['node_modules/ffmpeg-static/**/*'],
    // 版权声明
    copyright: `Copyright © 2026 ${packageJson.author}`,
    // 构建的目录配置
    directories: {
      // 输出目录（按版本号分级）
      output: `release/${packageJson.version}`,
    },
    // 需要包含在打包中的文件/目录
    files: [
      'dist', // 主进程和渲染进程构建文件
      'dist-electron', // Electron 相关构建文件
      'package.json',
      'LICENSE',
      'node_modules/**/*',
    ],
    // Windows 平台特定配置
    win: {
      icon: winIcon, // 应用程序图标
      target: [
        // 打包目标格式
        {
          // target: "nsis",                      // 使用 NSIS 安装程序
          // target: "portable",                  // 免安装程序
          target: process.env.NODE_ENV === 'development' ? 'dir' : 'nsis',
          arch: [
            // 目标架构
            'x64', // 仅打包 64 位版本
          ],
        },
      ],
      artifactName: `${packageJson.productName}_${packageJson.version}.exe`, // 生成的文件名格式
      // requestedExecutionLevel: "requireAdministrator"                         // 需要管理员权限
    },
    // macOS 平台特定配置
    mac: {
      icon: macIcon,
      category: 'public.app-category.utilities',
      target: ['dmg', 'zip'],
      artifactName: `${packageJson.productName}_${packageJson.version}_\${arch}.\${ext}`,
      identity: '-',
      hardenedRuntime: false,
      gatekeeperAssess: false,
    },
    // macOS DMG 配置
    dmg: {
      title: `${packageJson.productName} ${packageJson.version}`,
      icon: macIcon,
      iconSize: 96,
      contents: [
        { x: 130, y: 220 },
        { x: 410, y: 220, type: 'link', path: '/Applications' },
      ],
    },
    // NSIS 安装程序配置
    nsis: {
      oneClick: false, // 禁用一键安装
      perMachine: false, // 当前用户安装而非所有用户
      allowToChangeInstallationDirectory: true, // 允许修改安装目录
      deleteAppDataOnUninstall: true, // 卸载时保留用户数据
      license: 'LICENSE', // 许可证文件路径
      createDesktopShortcut: true, // 创建桌面快捷方式
      createStartMenuShortcut: true, // 创建开始菜单快捷方式
      installerIcon: installerIcon, // 安装程序图标
      uninstallerIcon: uninstallerIcon, // 卸载程序图标
      include: 'scripts/installer.nsh',
    },
    // 继承的基础配置（设为 null 禁用继承）
    //  extends: null,
  }
}
