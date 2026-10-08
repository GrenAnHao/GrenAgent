/**
 * 后台 bash 卡片场景的假数据：按真实会话里 `bash` + `run_in_background` 的结果形状造
 * （details 里 background / jobId / jobStartedAt / logPath，正文是「started background job …」）。
 * - 实时：tool_execution_start / tool_execution_end
 * - 历史：get_messages 还原的 assistant toolCall + toolResult（details 在 toolResult 消息上）
 * 不用随机数，不用当前时间。
 */
import { escalationHintMarker, sandboxDenialMarker } from '@extensions/_shared/sandbox/facts'
import type { AgentEvent, AgentMessage } from '../src/lib/pi'

export interface JobKey {
  jobId: string
  jobStartedAt: number
}

/** 注册表里还在跑的 job */
export const LIVE_JOB: JobKey = { jobId: 'bash-904', jobStartedAt: 1791258099963 }
/** 注册表里已结束的 job（历史回放用） */
export const DONE_JOB: JobKey = { jobId: 'bash-905', jobStartedAt: 1791258199963 }
/** 注册表里已经没有的 job（应用重启或已清理） */
export const GONE_JOB: JobKey = { jobId: 'bash-906', jobStartedAt: 1791258299963 }
/** 运行中的前台命令的匠名 job（模型没拿到它的 id） */
export const FOREGROUND_JOB: JobKey = { jobId: 'bash-907', jobStartedAt: 1791258399963 }
/** 匠名 job 在注册表里找不到（界面重载后任务已结束、记录已离开） */
export const FOREGROUND_GONE: JobKey = { jobId: 'bash-908', jobStartedAt: 1791258499963 }
/** 后台任务被沙箱拒绝：结算 detail 由 processOutcome 写（带给模型的标记和升权提示） */
export const SANDBOX_JOB: JobKey = { jobId: 'bash-909', jobStartedAt: 1791258599963 }
export const SANDBOX_JOB_DETAIL = `exit code: 1; ${sandboxDenialMarker('read-only')} ${escalationHintMarker()}`
export const SANDBOX_JOB_OUTPUT = "Set-Content: Access to the path 'D:\\outside.txt' is denied.\n"

export const FOREGROUND_COMMAND = 'npm test'
export const FOREGROUND_DESCRIPTION = 'Run unit tests'

export const COMMAND = 'cd electron-agent; npx vitest run src/stores > ../.tmp-regress.log 2>&1; exit $LASTEXITCODE'
export const DESCRIPTION = 'Run regression suite in background to a log file'
const LOG = 'C:\\Users\\rxstudio\\AppData\\Local\\Temp\\pi-bash-2e821abd82b1de92.log'

export const LIVE_OUTPUT = ' RUN  v4.1.11 D:/OneDrive/Project Files/Pi/electron-agent\n'
export const DONE_OUTPUT = ' Test Files  60 passed (60)\n      Tests  524 passed (524)\n'

function startText(job: JobKey): string {
  return `started background job ${job.jobId}\nfull log: ${LOG}\nYou will be notified when it finishes; read newer output with job_output, stop it with job_kill.`
}

function startDetails(job: JobKey): Record<string, unknown> {
  return { background: true, jobId: job.jobId, jobStartedAt: job.jobStartedAt, logPath: LOG }
}

const ARGS = { command: COMMAND, description: DESCRIPTION, run_in_background: true }

export function liveEvents(callId: string, job: JobKey): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: ARGS },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: startText(job) }], details: startDetails(job) },
      isError: false
    }
  ] as unknown as AgentEvent[]
}

/**
 * 运行中的前台 bash：只有 tool_execution_start + 一条 partial 更新。
 * 匠名 job 的引用只在 partial 结果的 details.foregroundJob 里（工具侧没有把它给模型）。
 */
export function foregroundRunningEvents(callId: string, job: JobKey, partialText: string): AgentEvent[] {
  return [
    {
      type: 'tool_execution_start',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: FOREGROUND_COMMAND, description: FOREGROUND_DESCRIPTION }
    },
    {
      type: 'tool_execution_update',
      toolCallId: callId,
      toolName: 'bash',
      args: { command: FOREGROUND_COMMAND, description: FOREGROUND_DESCRIPTION },
      partialResult: {
        content: [{ type: 'text', text: partialText }],
        details: { foregroundJob: { jobId: job.jobId, jobStartedAt: job.jobStartedAt } }
      }
    }
  ] as unknown as AgentEvent[]
}

/** 前台命令结束：最终结果里没有任何 job 引用（匠名）。 */
export function foregroundEndEvent(callId: string, finalText: string): AgentEvent {
  return {
    type: 'tool_execution_end',
    toolCallId: callId,
    toolName: 'bash',
    result: { content: [{ type: 'text', text: finalText }] },
    isError: false
  } as unknown as AgentEvent
}

export function historyMessages(callId: string, job: JobKey): AgentMessage[] {
  return [
    { role: 'user', content: [{ type: 'text', text: '跑一下回归' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: callId, name: 'bash', arguments: ARGS }],
      timestamp: 2
    },
    {
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'bash',
      content: [{ type: 'text', text: startText(job) }],
      details: startDetails(job),
      isError: false,
      timestamp: 3
    }
  ] as unknown as AgentMessage[]
}

const DENIED_ARGS = { command: 'Set-Content -Path ..\\outside.txt -Value x', description: 'Write a file outside the workspace' }
const DENIED_TEXT =
  "Set-Content: Access to the path 'D:\\outside.txt' is denied.\n\n\n" +
  `${sandboxDenialMarker('read-only')}\n${escalationHintMarker()}\n\nCommand exited with code 1`

/** 前台命令被沙箱拒绝：最终结果 isError，details.sandbox 带事实（extensions/sandbox/bashTool.ts）。 */
export function deniedEvents(callId: string): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: DENIED_ARGS },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: { content: [{ type: 'text', text: DENIED_TEXT }], details: { sandbox: { mode: 'read-only', denied: true } } },
      isError: true
    }
  ] as unknown as AgentEvent[]
}

const ESCALATED_ARGS = {
  command: 'npm run build',
  description: 'Build into the workspace',
  sandbox_permissions: 'workspace-write',
  justification: '需要把构建产物写进工作区'
}

/** 同一次调用经用户批准升权后跑完：details.sandbox 带 escalatedFrom。 */
export function escalatedEvents(callId: string): AgentEvent[] {
  return [
    { type: 'tool_execution_start', toolCallId: callId, toolName: 'bash', args: ESCALATED_ARGS },
    {
      type: 'tool_execution_end',
      toolCallId: callId,
      toolName: 'bash',
      result: {
        content: [{ type: 'text', text: 'built in 3.2s\n' }],
        details: { sandbox: { mode: 'workspace-write', denied: false, escalatedFrom: 'read-only' } }
      },
      isError: false
    }
  ] as unknown as AgentEvent[]
}
