import type { TimerOptions } from 'bilitoolkit-types'
import type { ApiCallerContext } from '@/main/types/ipc-toolkit-api.js'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { IPC_CHANNELS } from '@/shared/types/electron-ipc.js'
import type { IpcTimerTrigger } from '@/main/types/ipc-timer.js'

type CancelTimer = () => Promise<void>

export class TimerService {
  // 已注册定时器的句柄映射（定时器 ID -> 取消方法）
  private readonly timerHandles = new Map<string, CancelTimer>()
  // 定时器 ID -> 所属 webContents ID（用于 webContents 销毁时批量回收）
  private readonly timerOwners = new Map<string, number>()
  // 已挂过 destroyed 监听的 webContents ID，避免重复挂载
  private readonly watchedWebContents = new Set<number>()

  public async register(context: ApiCallerContext, options: TimerOptions): Promise<void> {
    const { timerId, type, duration } = options
    if (this.timerHandles.has(timerId)) throw new Error(`定时器[${timerId}]已存在`)

    const currTrigger: IpcTimerTrigger = {
      timerId: timerId,
    }
    const onAck = async (event: IpcMainEvent, trigger: IpcTimerTrigger, ack: boolean) => {
      if (trigger.timerId === timerId && !ack) {
        await this.cancel(context, timerId)
      }
    }
    const onTrigger = async () => {
      if (context.webContents.isDestroyed()) return
      context.webContents.send(IPC_CHANNELS.TRIGGER_TIMER, currTrigger)
    }
    ipcMain.on(IPC_CHANNELS.TRIGGER_TIMER_ACK, onAck)
    const timeout = type === 'delay' ? setTimeout(onTrigger, duration) : setInterval(onTrigger, duration)
    const cancel = async () => {
      // 修正：注册用的是 TRIGGER_TIMER_ACK，这里原先误写成 TRIGGER_TIMER。
      // 两个通道不同 → 监听器永远移不掉；main.ts 又调用 ipcMain.setMaxListeners(0)
      // 关掉了超限告警，所以这个泄漏是完全静默的。
      ipcMain.removeListener(IPC_CHANNELS.TRIGGER_TIMER_ACK, onAck)
      if (type === 'delay') {
        clearTimeout(timeout)
      } else {
        clearInterval(timeout)
      }
    }
    this.timerHandles.set(timerId, cancel)
    this.timerOwners.set(timerId, context.webContents.id)
    this.watchWebContents(context.webContents)
  }

  public async cancel(context: ApiCallerContext, timerId: string): Promise<void> {
    if (!this.timerHandles.has(timerId)) return

    const cancelTimer = this.timerHandles.get(timerId)
    this.timerHandles.delete(timerId)
    this.timerOwners.delete(timerId)
    if (cancelTimer) {
      await cancelTimer()
    }
    const currTrigger: IpcTimerTrigger = {
      timerId: timerId,
    }
    if (!context.webContents.isDestroyed()) {
      context.webContents.send(IPC_CHANNELS.CANCEL_TIMER, currTrigger)
    }
  }

  /**
   * webContents 销毁后回收其名下所有定时器。
   *
   * 定时器闭包持有 context.webContents，且 ipcMain 上挂着一个监听器；不回收则
   * 监听器与闭包永久驻留，定时器还会继续按间隔触发。
   */
  private watchWebContents(webContents: WebContents) {
    const webContentsId = webContents.id
    if (this.watchedWebContents.has(webContentsId)) return
    this.watchedWebContents.add(webContentsId)
    webContents.once('destroyed', () => {
      this.watchedWebContents.delete(webContentsId)
      void this.disposeByWebContents(webContentsId)
    })
  }

  /** 静默回收某个 webContents 名下的全部定时器（不向其发送消息） */
  private async disposeByWebContents(webContentsId: number): Promise<void> {
    for (const [timerId, ownerId] of [...this.timerOwners]) {
      if (ownerId !== webContentsId) continue
      const cancelTimer = this.timerHandles.get(timerId)
      this.timerHandles.delete(timerId)
      this.timerOwners.delete(timerId)
      if (cancelTimer) await cancelTimer()
    }
  }
}

export const timerService = new TimerService()
