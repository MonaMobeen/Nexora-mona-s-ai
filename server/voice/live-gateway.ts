import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import {
  Behavior,
  type FunctionDeclaration,
  FunctionResponseScheduling,
  InteractionStatus,
  type LiveServerMessage,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';
import { buildEngineeredContext, type ApprovedMemoryItem } from '../agent/context.ts';
import { createGenAIClient, hasGeminiApiKey, MODELS } from '../config/env.ts';
import { mcpToolManager } from '../mcp/client.ts';
import { telemetry } from '../observability/telemetry.ts';
import { resolveRequestActor, sanitizeUserInput } from '../security/guard.ts';

export type LiveVoiceName = 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';

export interface LiveStartPayload {
  token?: string;
  guestId?: string;
  sessionId?: string;
  voiceName?: LiveVoiceName;
  speakingStyle?: 'concise' | 'natural' | 'technical' | 'warm';
  languagePreference?: 'auto' | 'en' | 'ur' | 'ur-Latn';
  extendedThinking?: boolean;
  memories?: ApprovedMemoryItem[];
}

function buildLiveTools(nonBlocking: boolean): FunctionDeclaration[] {
  const base: FunctionDeclaration[] = [
    {
      name: 'web_search',
      description: 'Search the live web for current facts, news, weather, or technical references.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'Search query' },
        },
        required: ['query'],
      },
    },
    {
      name: 'calculator',
      description: 'Evaluate exact arithmetic or scientific math expressions.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          expression: { type: Type.STRING, description: 'Math expression' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'datetime_now',
      description: 'Get the current date and time in UTC or a requested IANA timezone.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          timezone: { type: Type.STRING, description: 'Optional IANA timezone' },
        },
      },
    },
    {
      name: 'knowledge_retrieve',
      description: 'Search uploaded PDF, DOCX, and TXT knowledge documents for grounded facts.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: { type: Type.STRING, description: 'Search query for uploaded documents' },
        },
        required: ['query'],
      },
    },
    {
      name: 'propose_memory_save',
      description:
        'Ask the user to approve saving a preference, project detail, or instruction into long-term memory.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          fact: { type: Type.STRING, description: 'Fact or preference to save' },
          category: { type: Type.STRING, description: 'preference | project | fact | instruction' },
        },
        required: ['fact', 'category'],
      },
    },
  ];

  if (nonBlocking) {
    return base.map((fn) => ({ ...fn, behavior: Behavior.NON_BLOCKING }));
  }
  return base;
}

export interface LiveVoiceSessionHandle {
  userId: string;
  sessionId: string;
  model: string;
  voiceName: LiveVoiceName;
  sendAudio: (base64Pcm: string) => void;
  sendText: (text: string) => void;
  close: () => void;
}

async function openGeminiLiveSession(params: {
  userId: string;
  config: LiveStartPayload;
  emit: (payload: Record<string, unknown>) => void;
}): Promise<LiveVoiceSessionHandle> {
  if (!hasGeminiApiKey()) {
    throw new Error('GEMINI_API_KEY is not configured in server secrets.');
  }

  const { userId, config, emit } = params;
  const sessionId = String(config.sessionId || `voice_${Date.now()}`).slice(0, 64);
  const validVoices: LiveVoiceName[] = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
  const voiceName: LiveVoiceName = validVoices.includes(config.voiceName as LiveVoiceName)
    ? (config.voiceName as LiveVoiceName)
    : 'Zephyr';

  const useExtended = Boolean(config.extendedThinking);
  const model = useExtended ? MODELS.LIVE_THINKING : MODELS.LIVE_FAST;

  const ctx = await buildEngineeredContext({
    userId,
    query: 'Voice session initialization',
    history: [],
    memories: Array.isArray(config.memories) ? config.memories : [],
    languagePreference: config.languagePreference ?? 'auto',
    speakingStyle: config.speakingStyle ?? 'natural',
    includeRag: false,
  });

  const ai = createGenAIClient();
  const tools = buildLiveTools(useExtended);

  const liveConfig: Record<string, unknown> = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName } },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    tools: [{ functionDeclarations: tools }],
    systemInstruction:
      ctx.systemInstruction +
      "\nYou are speaking aloud in real-time as Mona's AI. Keep spoken answers crisp, natural, and well-paced. Support natural switching between English, Urdu, and Roman Urdu.",
  };

  if (useExtended) {
    liveConfig.thinkingConfig = {
      thinkingLevel: ThinkingLevel.MEDIUM,
    };
  }

  let closed = false;
  let errorEmitted = false;
  let liveSession: Awaited<ReturnType<ReturnType<typeof createGenAIClient>['live']['connect']>> | null = null;

  telemetry.incrementVoiceConnections(1);

  const closeHandle = () => {
    if (closed) return;
    closed = true;
    telemetry.incrementVoiceConnections(-1);
    if (liveSession) {
      try {
        liveSession.close();
      } catch {
        // ignore close errors
      }
      liveSession = null;
    }
  };

  try {
    liveSession = await ai.live.connect({
      model,
      config: liveConfig,
      callbacks: {
        onopen: () => {
          telemetry.recordTrace({
            sessionId,
            kind: 'voice',
            name: model,
            status: 'ok',
            latencyMs: 0,
            detail: `Live session opened (${voiceName})`,
          });
        },
        onmessage: async (message: LiveServerMessage) => {
          if (closed) return;
          const content = message.serverContent;

          if (content?.interrupted) {
            emit({ type: 'interrupted' });
          }

          if (content?.inputTranscription?.text) {
            emit({
              type: 'input_transcript',
              text: content.inputTranscription.text,
            });
          }

          if (content?.outputTranscription?.text) {
            emit({
              type: 'output_transcript',
              text: content.outputTranscription.text,
            });
          }

          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data) {
              emit({
                type: 'audio',
                data: part.inlineData.data,
              });
            }
          }

          if (content?.turnComplete) {
            emit({ type: 'turn_complete' });
          }

          const interactionStatus = content?.interactionStatus;
          if (interactionStatus === InteractionStatus.IN_PROGRESS) {
            emit({ type: 'state', state: 'processing' });
          } else if (interactionStatus === InteractionStatus.IDLE) {
            emit({ type: 'state', state: 'idle' });
          }

          const calls = message.toolCall?.functionCalls ?? [];
          for (const call of calls) {
            const callName = call.name ?? 'unknown';
            const callArgs = (call.args ?? {}) as Record<string, unknown>;

            if (callName === 'propose_memory_save') {
              const fact = String(callArgs.fact ?? '').slice(0, 500);
              const category = ['preference', 'project', 'fact', 'instruction'].includes(String(callArgs.category))
                ? String(callArgs.category)
                : 'fact';

              emit({
                type: 'approval_request',
                actionId: `vmem_${Date.now()}`,
                actionType: 'save_memory',
                title: 'Approve Long-Term Memory',
                description: `Save to your personal memory (${category})?`,
                payload: { fact, category, source: 'voice' },
              });

              liveSession?.sendToolResponse({
                functionResponses: [
                  {
                    id: call.id,
                    name: callName,
                    response: {
                      status: 'awaiting_user_confirmation',
                      instruction: 'Tell the user you placed an approval card on screen to save this memory.',
                    },
                    ...(useExtended ? { scheduling: FunctionResponseScheduling.WHEN_IDLE } : {}),
                  },
                ],
              });
              continue;
            }

            emit({ type: 'tool_start', toolName: callName, args: callArgs });
            const toolRes = await mcpToolManager.executeTool(callName, callArgs, { userId });
            emit({
              type: 'tool_result',
              toolName: callName,
              success: toolRes.success,
              latencyMs: toolRes.latencyMs,
            });

            liveSession?.sendToolResponse({
              functionResponses: [
                {
                  id: call.id,
                  name: callName,
                  response: toolRes.success ? { result: toolRes.data } : { error: toolRes.error },
                  ...(useExtended ? { scheduling: FunctionResponseScheduling.WHEN_IDLE } : {}),
                },
              ],
            });
          }
        },
        onerror: (err: unknown) => {
          telemetry.recordModelError();
          const errMsg = err instanceof Error ? err.message : 'Gemini Live API connection error.';
          telemetry.recordTrace({
            sessionId,
            kind: 'voice',
            name: model,
            status: 'error',
            latencyMs: 0,
            detail: errMsg.slice(0, 140),
          });
          if (!errorEmitted && !closed) {
            errorEmitted = true;
            emit({ type: 'error', message: errMsg });
          }
        },
        onclose: () => {
          if (!errorEmitted && !closed) {
            emit({ type: 'closed' });
          }
          closeHandle();
        },
      },
    });
  } catch (err) {
    closeHandle();
    throw err;
  }

  return {
    userId,
    sessionId,
    model,
    voiceName,
    sendAudio: (base64Pcm: string) => {
      if (!closed && liveSession) {
        liveSession.sendRealtimeInput({
          audio: {
            data: base64Pcm,
            mimeType: 'audio/pcm;rate=16000',
          },
        });
      }
    },
    sendText: (text: string) => {
      if (!closed && liveSession) {
        const check = sanitizeUserInput(text, 2000);
        if (check.sanitized) {
          liveSession.sendRealtimeInput({
            text: check.sanitized,
          });
        }
      }
    },
    close: closeHandle,
  };
}

// --- HTTPS SSE + POST Live Bridge Registry (Fallback when proxy/browser blocks WebSocket upgrade) ---
interface HttpLiveBridge {
  id: string;
  userId: string;
  handle: LiveVoiceSessionHandle;
  queue: Array<Record<string, unknown>>;
  listener: ((payload: Record<string, unknown>) => void) | null;
  createdAt: number;
  lastActivityAt: number;
}

class HttpLiveBridgeRegistry {
  private bridges = new Map<string, HttpLiveBridge>();

  constructor() {
    const gc = setInterval(() => {
      const now = Date.now();
      for (const [id, b] of this.bridges.entries()) {
        if (now - b.lastActivityAt > 120_000 && !b.listener) {
          b.handle.close();
          this.bridges.delete(id);
        }
      }
    }, 30_000);
    gc.unref?.();
  }

  async createBridge(userId: string, config: LiveStartPayload): Promise<{ bridgeId: string; model: string; voiceName: LiveVoiceName }> {
    const bridgeId = crypto.randomUUID();
    const queue: Array<Record<string, unknown>> = [];

    const bridge: HttpLiveBridge = {
      id: bridgeId,
      userId,
      handle: null as unknown as LiveVoiceSessionHandle,
      queue,
      listener: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    const emit = (payload: Record<string, unknown>) => {
      bridge.lastActivityAt = Date.now();
      if (bridge.listener) {
        bridge.listener(payload);
      } else {
        queue.push(payload);
        if (queue.length > 100) queue.shift();
      }
    };

    const handle = await openGeminiLiveSession({ userId, config, emit });
    bridge.handle = handle;
    this.bridges.set(bridgeId, bridge);
    emit({ type: 'ready', model: handle.model, voiceName: handle.voiceName });

    return { bridgeId, model: handle.model, voiceName: handle.voiceName };
  }

  getBridge(bridgeId: string, userId: string): HttpLiveBridge | null {
    const b = this.bridges.get(bridgeId);
    if (!b || b.userId !== userId) return null;
    b.lastActivityAt = Date.now();
    return b;
  }

  attachStream(
    bridgeId: string,
    userId: string,
    send: (payload: Record<string, unknown>) => void,
  ): (() => void) | null {
    const b = this.getBridge(bridgeId, userId);
    if (!b) return null;

    while (b.queue.length > 0) {
      const next = b.queue.shift();
      if (next) send(next);
    }
    b.listener = send;

    return () => {
      b.listener = null;
      b.handle.close();
      this.bridges.delete(bridgeId);
    };
  }

  closeBridge(bridgeId: string, userId: string): void {
    const b = this.getBridge(bridgeId, userId);
    if (!b) return;
    b.handle.close();
    this.bridges.delete(bridgeId);
  }
}

export const httpLiveBridge = new HttpLiveBridgeRegistry();

export function attachLiveVoiceGateway(httpServer: HttpServer): void {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname === '/ws/live') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  // Heartbeat keeps proxy/Cloud Run WebSocket connections alive during silence
  const heartbeatInterval = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
        client.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      }
    }
  }, 15_000);
  heartbeatInterval.unref?.();

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (clientWs: WebSocket) => {
    let sessionHandle: LiveVoiceSessionHandle | null = null;
    let closed = false;
    let errorEmitted = false;

    const safeSend = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (sessionHandle) {
        sessionHandle.close();
        sessionHandle = null;
      }
    };

    clientWs.on('close', cleanup);
    clientWs.on('error', cleanup);

    clientWs.on('message', async (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as Record<string, unknown>;

        if (msg.type === 'ping') {
          safeSend({ type: 'pong', ts: Date.now() });
          return;
        }

        if (msg.type === 'start') {
          if (sessionHandle) {
            sessionHandle.close();
            sessionHandle = null;
          }

          const startCfg = msg as unknown as LiveStartPayload;
          const actor = await resolveRequestActor(
            startCfg.token ? `Bearer ${startCfg.token}` : undefined,
            startCfg.guestId,
          );

          errorEmitted = false;
          sessionHandle = await openGeminiLiveSession({
            userId: actor.userId,
            config: startCfg,
            emit: safeSend,
          });

          safeSend({
            type: 'ready',
            model: sessionHandle.model,
            voiceName: sessionHandle.voiceName,
          });
          return;
        }

        if (msg.type === 'audio' && typeof msg.data === 'string' && sessionHandle) {
          sessionHandle.sendAudio(msg.data);
          return;
        }

        if (msg.type === 'text' && typeof msg.text === 'string' && sessionHandle) {
          sessionHandle.sendText(msg.text);
          return;
        }

        if (msg.type === 'stop') {
          if (sessionHandle) {
            sessionHandle.close();
            sessionHandle = null;
          }
          safeSend({ type: 'closed' });
        }
      } catch (err) {
        telemetry.recordModelError();
        const message = err instanceof Error ? err.message : 'Failed to process live voice frame.';
        if (!errorEmitted) {
          errorEmitted = true;
          safeSend({ type: 'error', message });
        }
      }
    });
  });
}
