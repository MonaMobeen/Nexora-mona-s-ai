import { AsyncLocalStorage } from 'node:async_hooks';

export interface McpExecutionContext {
  userId: string;
}

export const mcpContextStorage = new AsyncLocalStorage<McpExecutionContext>();

export function getMcpExecutionContext(): McpExecutionContext {
  return mcpContextStorage.getStore() ?? { userId: 'guest_default' };
}
