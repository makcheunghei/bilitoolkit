import type { MenuItem } from '@/renderer/components/layout/AppMenus.vue'
import { toolkitApi } from '@/renderer/api/toolkit-api'
import { homeMenus } from '@/renderer/router/index'
import { showConfirm } from 'bilitoolkit-ui'

/**
 * 忽略当前菜单状态的路由路径前缀
 */
export const IGNORE_MENU_PATH_PREFIXES = ['/task-plugin', '/bili-space']

/**
 * 应用菜单
 */
export const buildAppMenus = () =>
  [
    ...homeMenus,
    {
      name: '退出',
      icon: 'shut-down',
      path: '/exit',
      beforeSwitch: async () => {
        try {
          await showConfirm('确认退出吗？')
        } catch {
          return false
        }
      },
      onclick: async () => {
        // 必须走核心 API 的 quitApp：直接 window.close() 在 macOS 上只关窗不退出进程，
        // 确认框写着「确认退出吗？」却仍留在 Dock 里、后台任务继续跑。
        await toolkitApi.core.quitApp()
      },
    },
  ] as MenuItem[]
