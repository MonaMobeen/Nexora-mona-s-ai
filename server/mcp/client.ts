import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { telemetry } from '../observability/telemetry.ts';
import { mcpContextStorage, type McpExecutionContext } from './context.ts';
import { createNexoraMcpServer } from './nexora-mcp-server.ts';

export interface DiscoveredMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  permissionLevel: 'read' | 'compute' | 'external';
}

export interface McpToolCallResult {
  toolName: string;
  success: boolean;
  latencyMs: number;
  data?: unknown;
  error?: string;
}

const TOOL_PERMISSIONS: Record<string, 'read' | 'compute' | 'external'> = {
  web_search: 'external',
  url_context_read: 'external',
  calculator: 'compute',
  datetime_now: 'read',
  knowledge_retrieve: 'read',
  document_summarize: 'read',
  data_analyze: 'compute',
};

export class McpToolManager {
  private client: Client | null = null;
  private initPromise: Promise<void> | null = null;

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const mcpServer = createNexoraMcpServer();
        const client = new Client(
          { name: 'nexora-orchestrator-client', version: '1.0.0' },
          { capabilities: {} },
        );
        await Promise.all([mcpServer.connect(serverTransport), client.connect(clientTransport)]);
        this.client = client;
      })();
    }
    await this.initPromise;
    return this.client!;
  }

  async discoverTools(): Promise<DiscoveredMcpTool[]> {
    const client = await this.ensureConnected();
    const res = await client.listTools();
    return res.tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      permissionLevel: TOOL_PERMISSIONS[t.name] ?? 'read',
    }));
  }

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    ctx: McpExecutionContext,
    options: { timeoutMs?: number; retries?: number } = {},
  ): Promise<McpToolCallResult> {
    const client = await this.ensureConnected();
    const timeoutMs = options.timeoutMs ?? 20_000;
    const maxAttempts = (options.retries ?? 1) + 1;
    const start = Date.now();
    let lastError = 'Unknown tool error';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const callPromise = mcpContextStorage.run(ctx, () =>
          client.callTool({
            name: toolName,
            arguments: args,
          }),
        );

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`MCP tool "${toolName}" timed out after ${timeoutMs}ms`)), timeoutMs);
        });

        const result = await Promise.race([callPromise, timeoutPromise]);
        const latencyMs = Date.now() - start;

        if (result.isError) {
          const textErr = Array.isArray(result.content)
            ? result.content.map((c) => ('text' in c ? c.text : '')).join(' ')
            : 'Tool returned error';
          throw new Error(textErr || 'Tool returned error');
        }

        const firstContent = Array.isArray(result.content) ? result.content[0] : undefined;
        const rawText = firstContent && 'text' in firstContent ? String(firstContent.text) : '{}';
        let parsed: unknown = rawText;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          // keep text
        }

        telemetry.recordToolCall(toolName, true, latencyMs);
        telemetry.recordTrace({
          sessionId: ctx.userId,
          kind: 'mcp_tool',
          name: toolName,
          status: 'ok',
          latencyMs,
          detail: `MCP execution succeeded (attempt ${attempt})`,
        });

        return {
          toolName,
          success: true,
          latencyMs,
          data: parsed,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 250 * attempt));
        }
      }
    }

    const latencyMs = Date.now() - start;
    telemetry.recordToolCall(toolName, false, latencyMs);
    telemetry.recordTrace({
      sessionId: ctx.userId,
      kind: 'mcp_tool',
      name: toolName,
      status: 'error',
      latencyMs,
      detail: lastError.slice(0, 140),
    });

    return {
      toolName,
      success: false,
      latencyMs,
      error: lastError,
    };
  }
}

export const mcpToolManager = new McpToolManager();
