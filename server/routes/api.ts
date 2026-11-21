import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import {
  dispatchA2ATask,
  getA2ATask,
  listSpecializedAgentCards,
  type SpecializedAgentId,
} from '../a2a/protocol.ts';
import { runAgentOrchestration } from '../agent/orchestrator.ts';
import { hasGeminiApiKey } from '../config/env.ts';
import { mcpToolManager } from '../mcp/client.ts';
import { telemetry } from '../observability/telemetry.ts';
import { ragStore } from '../rag/pipeline.ts';
import { createRateLimiter, resolveRequestActor } from '../security/guard.ts';
import { httpLiveBridge, type LiveStartPayload } from '../voice/live-gateway.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB
  },
});

const chatRequestSchema = z.object({
  sessionId: z.string().min(1).max(128).default('default_session'),
  message: z.string().min(1).max(8000),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().max(12000),
      }),
    )
    .max(40)
    .default([]),
  memories: z
    .array(
      z.object({
        id: z.string(),
        fact: z.string().max(1000),
        category: z.enum(['preference', 'project', 'fact', 'instruction']),
      }),
    )
    .max(50)
    .default([]),
  languagePreference: z.enum(['auto', 'en', 'ur', 'ur-Latn']).default('auto'),
  speakingStyle: z.enum(['concise', 'natural', 'technical', 'warm']).default('natural'),
  existingSummary: z.string().max(2000).optional(),
});

const mcpExecuteSchema = z.object({
  toolName: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).default({}),
});

const a2aRpcSchema = z.object({
  jsonrpc: z.literal('2.0').default('2.0'),
  id: z.union([z.string(), z.number()]).default(1),
  method: z.enum(['tasks/send', 'tasks/get']),
  params: z.object({
    agentId: z
      .enum(['research-agent', 'data-analyst-agent', 'document-agent', 'coding-agent', 'knowledge-agent'])
      .optional(),
    taskId: z.string().optional(),
    input: z.string().max(8000).optional(),
  }),
});

async function getActor(req: Request) {
  const guestId = typeof req.headers['x-nexora-guest-id'] === 'string' ? req.headers['x-nexora-guest-id'] : undefined;
  return resolveRequestActor(req.headers.authorization, guestId);
}

const liveStartSchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  voiceName: z.enum(['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir']).optional(),
  speakingStyle: z.enum(['concise', 'natural', 'technical', 'warm']).optional(),
  languagePreference: z.enum(['auto', 'en', 'ur', 'ur-Latn']).optional(),
  extendedThinking: z.boolean().optional(),
  memories: z
    .array(
      z.object({
        id: z.string(),
        fact: z.string().max(1000),
        category: z.enum(['preference', 'project', 'fact', 'instruction']),
      }),
    )
    .max(50)
    .optional(),
});

const liveInputSchema = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(['audio', 'text', 'stop']),
        data: z.string().max(500_000).optional(),
        text: z.string().max(2000).optional(),
      }),
    )
    .min(1)
    .max(32),
});

export function createApiRouter(): Router {
  const router = Router();
  const standardLimiter = createRateLimiter();
  const streamInputLimiter = createRateLimiter(900);

  // Live audio frame ingestion uses a higher streaming RPM limit
  router.post('/live/input/:bridgeId', streamInputLimiter, async (req: Request, res: Response) => {
    const parsed = liveInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid live input payload.' });
      return;
    }
    const actor = await getActor(req);
    const bridgeId = String(req.params.bridgeId || '');
    const bridge = httpLiveBridge.getBridge(bridgeId, actor.userId);
    if (!bridge) {
      res.status(404).json({ error: 'Live bridge session not found or expired.' });
      return;
    }

    for (const item of parsed.data.items) {
      if (item.type === 'audio' && item.data) {
        bridge.handle.sendAudio(item.data);
      } else if (item.type === 'text' && item.text) {
        bridge.handle.sendText(item.text);
      } else if (item.type === 'stop') {
        httpLiveBridge.closeBridge(bridgeId, actor.userId);
        break;
      }
    }

    res.json({ ok: true });
  });

  router.use(standardLimiter);

  router.post('/live/start', async (req: Request, res: Response) => {
    const parsed = liveStartSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid live start config.' });
      return;
    }
    if (!hasGeminiApiKey()) {
      res.status(503).json({ error: 'GEMINI_API_KEY is not configured in server secrets.' });
      return;
    }
    try {
      const actor = await getActor(req);
      const result = await httpLiveBridge.createBridge(actor.userId, parsed.data as LiveStartPayload);
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error: err instanceof Error ? err.message : 'Failed to start Gemini Live session.',
      });
    }
  });

  router.get('/live/stream/:bridgeId', async (req: Request, res: Response) => {
    const actor = await getActor(req);
    const bridgeId = String(req.params.bridgeId || '');

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const detach = httpLiveBridge.attachStream(bridgeId, actor.userId, (payload) => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    });

    if (!detach) {
      res.write(`data: ${JSON.stringify({ type: 'error', message: 'Live stream session not found.' })}\n\n`);
      res.end();
      return;
    }

    const keepalive = setInterval(() => {
      res.write(`: keepalive ${Date.now()}\n\n`);
    }, 15_000);

    req.on('close', () => {
      clearInterval(keepalive);
      detach();
    });
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'monas-ai',
      geminiConfigured: hasGeminiApiKey(),
      timestamp: new Date().toISOString(),
    });
  });

  // Streaming SSE Chat & Orchestration Endpoint
  router.post('/agent/chat', async (req: Request, res: Response) => {
    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chat payload', issues: parsed.error.issues });
      return;
    }

    if (!hasGeminiApiKey()) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured in server secrets.',
      });
      return;
    }

    const actor = await getActor(req);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const sendEvent = (event: unknown) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runAgentOrchestration({
        userId: actor.userId,
        sessionId: parsed.data.sessionId,
        message: parsed.data.message,
        history: parsed.data.history,
        memories: parsed.data.memories,
        languagePreference: parsed.data.languagePreference,
        speakingStyle: parsed.data.speakingStyle,
        existingSummary: parsed.data.existingSummary,
        emit: sendEvent,
      });
    } catch (err) {
      sendEvent({
        type: 'error',
        message: err instanceof Error ? err.message : 'Orchestration failed unexpectedly.',
      });
    } finally {
      res.end();
    }
  });

  // MCP Discovery & Execution
  router.get('/mcp/tools', async (_req: Request, res: Response) => {
    try {
      const tools = await mcpToolManager.discoverTools();
      res.json({ tools });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'MCP discovery failed' });
    }
  });

  router.post('/mcp/execute', async (req: Request, res: Response) => {
    const parsed = mcpExecuteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid MCP tool payload', issues: parsed.error.issues });
      return;
    }
    const actor = await getActor(req);
    const result = await mcpToolManager.executeTool(parsed.data.toolName, parsed.data.args, {
      userId: actor.userId,
    });
    res.status(result.success ? 200 : 400).json(result);
  });

  // A2A Protocol Endpoints
  router.get('/a2a/agents', (req: Request, res: Response) => {
    const baseUrl = `${req.protocol}://${req.get('host') ?? 'localhost:3000'}`;
    res.json({ agents: listSpecializedAgentCards(baseUrl) });
  });

  router.post('/a2a', async (req: Request, res: Response) => {
    const parsed = a2aRpcSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32602, message: 'Invalid JSON-RPC A2A parameters' },
      });
      return;
    }

    const { id, method, params } = parsed.data;
    if (method === 'tasks/get') {
      const task = params.taskId ? getA2ATask(params.taskId) : undefined;
      if (!task) {
        res.status(404).json({
          jsonrpc: '2.0',
          id,
          error: { code: -32004, message: 'A2A task not found' },
        });
        return;
      }
      res.json({ jsonrpc: '2.0', id, result: task });
      return;
    }

    if (!params.agentId || !params.input) {
      res.status(400).json({
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'agentId and input are required for tasks/send' },
      });
      return;
    }

    const actor = await getActor(req);
    const task = await dispatchA2ATask({
      agentId: params.agentId as SpecializedAgentId,
      input: params.input,
      userId: actor.userId,
    });
    res.json({ jsonrpc: '2.0', id, result: task });
  });

  // RAG Document Library & Semantic Search
  router.get('/rag/documents', async (req: Request, res: Response) => {
    const actor = await getActor(req);
    res.json({ documents: ragStore.listDocuments(actor.userId) });
  });

  router.post('/rag/upload', upload.single('file'), async (req: Request, res: Response) => {
    if (!req.file) {
      res.status(400).json({ error: 'No document file uploaded.' });
      return;
    }
    if (!hasGeminiApiKey()) {
      res.status(503).json({ error: 'GEMINI_API_KEY is required for document embedding.' });
      return;
    }
    try {
      const actor = await getActor(req);
      const docId = typeof req.body?.documentId === 'string' ? req.body.documentId : undefined;
      const meta = await ragStore.ingestDocument({
        userId: actor.userId,
        documentId: docId,
        filename: req.file.originalname,
        mimeType: req.file.mimetype,
        buffer: req.file.buffer,
      });
      res.json({ document: meta });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Document ingestion failed.',
      });
    }
  });

  router.post('/rag/query', async (req: Request, res: Response) => {
    const schema = z.object({ query: z.string().min(2).max(500), topK: z.number().int().min(1).max(10).optional() });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid query payload.' });
      return;
    }
    try {
      const actor = await getActor(req);
      const chunks = await ragStore.retrieve(actor.userId, parsed.data.query, parsed.data.topK ?? 5);
      res.json({ chunks });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Vector search failed.' });
    }
  });

  router.delete('/rag/documents/:documentId', async (req: Request, res: Response) => {
    const actor = await getActor(req);
    const documentId = String(req.params.documentId || '');
    const removed = ragStore.deleteDocument(actor.userId, documentId);
    res.json({ removed });
  });

  // Observability & Analytics
  router.get('/observability/metrics', (_req: Request, res: Response) => {
    res.json(telemetry.getMetricsSnapshot());
  });

  router.get('/observability/traces', (_req: Request, res: Response) => {
    res.json({ traces: telemetry.getRedactedTraces(60) });
  });

  return router;
}
