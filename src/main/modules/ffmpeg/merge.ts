import ffmpeg from 'fluent-ffmpeg'
import fs from 'node:fs/promises'
import path from 'node:path'
import { mainLogger } from '@/main/common/main-logger.js'

type FfmpegCommand = ReturnType<typeof ffmpeg>

/**
 * 正在运行的 ffmpeg 合并进程。
 *
 * fluent-ffmpeg 派生的子进程不会随主进程退出而自动结束：应用退出后 ffmpeg 仍在往
 * 目标文件写，而合并成功后的 unlink/rename 收尾永远不会执行，留下半成品文件。
 * 因此必须在退出时显式终止。
 */
const runningCommands = new Set<FfmpegCommand>()

/**
 * 终止所有在途的 ffmpeg 合并进程（应用退出时调用）
 */
export function killAllFfmpeg() {
  if (runningCommands.size === 0) return
  mainLogger.info(`退出清理：终止 ${runningCommands.size} 个在途 ffmpeg 进程`)
  for (const command of runningCommands) {
    try {
      command.kill('SIGKILL')
    } catch (e) {
      mainLogger.error('终止 ffmpeg 进程失败:', e)
    }
  }
  runningCommands.clear()
}

export async function mergeAudioAndVideo(audioPath: string, videoPath: string, outputPath?: string): Promise<string> {
  const targetPath =
    outputPath ?? path.join(path.dirname(videoPath), `${path.parse(videoPath).name}.merge${path.parse(videoPath).ext}`)

  const command = ffmpeg()
    .input(videoPath)
    .input(audioPath)
    .outputOptions(['-c:v copy', '-c:a copy', '-map 0:v:0', '-map 1:a:0', '-shortest'])
    .save(targetPath)

  runningCommands.add(command)
  try {
    await new Promise<string | null>((resolve, reject) => {
      command.on('end', resolve).on('error', reject)
    })
  } finally {
    runningCommands.delete(command)
  }

  // 覆盖原视频
  if (!outputPath) {
    await fs.unlink(videoPath)
    await fs.rename(targetPath, videoPath)
    return videoPath
  }

  return targetPath
}
