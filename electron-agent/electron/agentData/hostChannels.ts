/**
 * 宿主与主进程之间的通道名常量。
 *
 * 原 `agentDataProcess/contract.ts` 随 agentdata-host 一起下线；运行时的知识模型调用
 * 仍需要这两个通道名（模型用量与诊断），因此保留为独立常量，避免测试与适配层依赖已删模块。
 */
export const AGENTDATA_DIAG_CHANNEL = 'agentdata.diag';
export const AGENTDATA_MODEL_USAGE_CHANNEL = 'agentdata.model.usage';
