import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts-v2";

import { getConfig } from "../_shared/runtime-config.js";

export interface MemoryConnectionConfig {
  endpoint: string;
  apiKey: string;
  serviceId: string;
  teamId: string;
  agentId: string;
  userId: string;
  userKey: string;
  taskId?: string;
}

function required(name: string): string {
  const value = getConfig(name)?.trim();
  if (!value) throw new Error(`TencentDB memory is not configured: ${name} is missing`);
  return value;
}

export function readMemoryConnectionConfig(): MemoryConnectionConfig {
  return {
    endpoint: required("TDAI_MEMORY_ENDPOINT").replace(/\/+$/, ""),
    apiKey: required("TDAI_MEMORY_API_KEY"),
    serviceId: getConfig("TDAI_MEMORY_SERVICE_ID")?.trim() || "personal-memory",
    teamId: required("TDAI_MEMORY_TEAM_ID"),
    agentId: required("TDAI_MEMORY_AGENT_ID"),
    userId: required("TDAI_MEMORY_USER_ID"),
    userKey: required("TDAI_MEMORY_USER_KEY"),
    taskId: getConfig("TDAI_MEMORY_TASK_ID")?.trim() || undefined,
  };
}

export function createMemoryClient(config = readMemoryConnectionConfig()): MemoryClient {
  return new MemoryClient(config);
}
