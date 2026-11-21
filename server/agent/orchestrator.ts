import { type FunctionDeclaration, Type } from '@google/genai';
import { dispatchA2ATask, type SpecializedAgentId } from '../a2a/protocol.ts';
import { createGenAIClient, MODELS } from '../config/env.ts';
import { mcpToolManager } from '../mcp/client.ts';
import { telemetry } from '../observability/telemetry.ts';
import { sanitizeUserInput } from '../security/guard.ts';
import { buildEngineeredContext, type ApprovedMemoryItem, type ConversationTurn } from './context.ts';

export type OrchestratorStreamEvent =
  | { type: 'trace'; step: string; detail: string }
  | { type: 'context'; tokenEstimate: Record<string, number>; memoriesUsed: number; ragChunksUsed: number }
  | { type: 'tool_start'; toolName: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; success: boolean; latencyMs: number; summary: string }
  | { type: 'a2a_event'; agentId: string; status: string; toolsInvoked: string[] }
  | {
      type: 'approval_request';
      actionId: string;
      actionType: 'save_memory' | 'delete_document' | 'delete_memory';
      title: string;
      description: string;
      payload: Record<string, unknown>;
    }
  | { type: 'sources'; sources: Array<{ title: string; url?: string; score?: number; kind: 'document' | 'web' }> }
  | { type: 'delta'; text: string }
  | { type: 'done'; latencyMs: number; agentRoute: string; compressedSummary?: string }
  | { type: 'error'; message: string };

const ORCHESTRATOR_TOOLS: FunctionDeclaration[] = [
  {
    name: 'web_search',
    description: 'Search the live web for recent events, facts, documentation, or external verification.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Search query string' },
      },
      required: ['query'],
    },
  },
  {
    name: 'calculator',
    description: 'Evaluate exact arithmetic, percentages, or scientific math expressions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        expression: { type: Type.STRING, description: 'Math expression to evaluate' },
      },
      required: ['expression'],
    },
  },
  {
    name: 'datetime_now',
    description: 'Get the current date and time in UTC or a specified IANA timezone.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        timezone: { type: Type.STRING, description: 'Optional IANA timezone (e.g. Asia/Karachi)' },
      },
    },
  },
  {
    name: 'knowledge_retrieve',
    description: 'Search uploaded PDF, DOCX, and TXT documents in the user knowledge base.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: { type: Type.STRING, description: 'Semantic search query' },
        topK: { type: Type.INTEGER, description: 'Number of chunks to fetch' },
      },
      required: ['query'],
    },
  },
  {
    name: 'document_summarize',
    description: 'Read and summarize a specific uploaded document by filename.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        documentQuery: { type: Type.STRING, description: 'Document filename or ID' },
        focusQuestion: { type: Type.STRING, description: 'Optional question about the document' },
      },
      required: ['documentQuery'],
    },
  },
  {
    name: 'data_analyze',
    description: 'Analyze structured CSV or JSON array data for statistics and distributions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        data: { type: Type.STRING, description: 'Raw CSV or JSON data' },
      },
      required: ['data'],
    },
  },
  {
    name: 'url_context_read',
    description: 'Inspect and summarize a public HTTP/HTTPS webpage URL.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING, description: 'Public http/https URL' },
        question: { type: Type.STRING, description: 'Optional question about the page' },
      },
      required: ['url'],
    },
  },
  {
    name: 'delegate_a2a_agent',
    description:
      'Delegate a specialized multi-step domain task to a specialized Agent2Agent sub-agent (research-agent, data-analyst-agent, document-agent, coding-agent, or knowledge-agent). Do not call for simple questions.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        agentId: {
          type: Type.STRING,
          description: 'One of: research-agent, data-analyst-agent, document-agent, coding-agent, knowledge-agent',
        },
        task: { type: Type.STRING, description: 'Clear task prompt for the specialized agent' },
      },
      required: ['agentId', 'task'],
    },
  },
  {
    name: 'request_memory_save',
    description:
      'Propose saving a user fact, preference, or recurring instruction to long-term memory. Always requires explicit user approval before persistence.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fact: { type: Type.STRING, description: 'Concise fact or preference to remember' },
        category: {
          type: Type.STRING,
          description: 'Category: preference, project, fact, or instruction',
        },
      },
      required: ['fact', 'category'],
    },
  },
];

function detectExplicitMemoryIntent(message: string): { wantsSave: boolean; wantsDelete: boolean } {
  const lower = message.toLowerCase();
  const wantsSave =
    /\b(remember that|save this to memory|remember my|don't forget|yaad rakhna|yad rakhna|save memory)\b/i.test(lower);
  const wantsDelete =
    /\b(delete my memory|forget everything|delete document|remove all memories)\b/i.test(lower);
  return { wantsSave, wantsDelete };
}

export async function runAgentOrchestration(params: {
  userId: string;
  sessionId: string;
  message: string;
  history: ConversationTurn[];
  memories: ApprovedMemoryItem[];
  languagePreference: 'auto' | 'en' | 'ur' | 'ur-Latn';
  speakingStyle: 'concise' | 'natural' | 'technical' | 'warm';
  existingSummary?: string;
  emit: (event: OrchestratorStreamEvent) => void;
}): Promise<void> {
  const start = Date.now();
  const { emit } = params;

  const check = sanitizeUserInput(params.message, 8000);
  if (!check.sanitized) {
    emit({ type: 'error', message: 'Message cannot be empty.' });
    return;
  }

  if (check.flagged) {
    telemetry.recordSecurityBlock();
    telemetry.recordTrace({
      sessionId: params.sessionId,
      kind: 'security',
      name: 'prompt_injection_guard',
      status: 'blocked',
      latencyMs: Date.now() - start,
      detail: `Flagged patterns: ${check.reasons.join(', ')}`,
    });
    emit({
      type: 'trace',
      step: 'Security Guard',
      detail: 'Detected prompt-override syntax; enforcing strict system boundary.',
    });
  }

  emit({ type: 'trace', step: 'Context Engineering', detail: 'Assembling memory, RAG chunks, and token budget' });

  const ctx = await buildEngineeredContext({
    userId: params.userId,
    query: check.sanitized,
    history: params.history,
    memories: params.memories,
    languagePreference: params.languagePreference,
    speakingStyle: params.speakingStyle,
    existingSummary: params.existingSummary,
  });

  emit({
    type: 'context',
    tokenEstimate: ctx.tokenEstimate,
    memoriesUsed: ctx.selectedMemories.length,
    ragChunksUsed: ctx.retrievedChunks.length,
  });

  const allSources: Array<{ title: string; url?: string; score?: number; kind: 'document' | 'web' }> =
    ctx.retrievedChunks.map((c) => ({
      title: `${c.filename} (chunk #${c.chunkIndex})`,
      score: c.score,
      kind: 'document',
    }));

  const memorySignals = detectExplicitMemoryIntent(check.sanitized);
  if (memorySignals.wantsDelete) {
    emit({
      type: 'approval_request',
      actionId: `act_${Date.now()}`,
      actionType: 'delete_memory',
      title: 'Confirm Sensitive Data Deletion',
      description: 'You asked to delete stored memories or documents. Please confirm this action explicitly in the Memory or Knowledge panel.',
      payload: { reason: 'user_request' },
    });
  }

  const ai = createGenAIClient();
  let agentRoute = 'nexora-orchestrator';

  const contents: Array<{ role: 'user' | 'model'; parts: Array<Record<string, unknown>> }> = [
    ...ctx.optimizedHistory.map((h) => ({
      role: (h.role === 'assistant' ? 'model' : 'user') as 'user' | 'model',
      parts: [{ text: h.content }],
    })),
    {
      role: 'user',
      parts: [{ text: check.sanitized }],
    },
  ];

  const MAX_TOOL_STEPS = 4;
  let finalAnswerText = '';

  try {
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const response = await ai.models.generateContent({
        model: MODELS.ORCHESTRATOR,
        contents,
        config: {
          systemInstruction:
            ctx.systemInstruction +
            (memorySignals.wantsSave
              ? '\nThe user appears to ask you to remember something. Call `request_memory_save` so they can confirm storing it.'
              : ''),
          tools: [{ functionDeclarations: ORCHESTRATOR_TOOLS }],
        },
      });

      const functionCalls = response.functionCalls;
      const modelContent = response.candidates?.[0]?.content;

      if (!functionCalls || functionCalls.length === 0) {
        finalAnswerText = (response.text ?? '').trim();
        break;
      }

      if (modelContent) {
        contents.push({
          role: 'model',
          parts: (modelContent.parts ?? []) as Array<Record<string, unknown>>,
        });
      }

      const functionResponseParts: Array<Record<string, unknown>> = [];

      for (const call of functionCalls) {
        const callName = call.name ?? 'unknown';
        const callArgs = (call.args ?? {}) as Record<string, unknown>;

        if (callName === 'request_memory_save') {
          const fact = String(callArgs.fact ?? '').slice(0, 500);
          const category = ['preference', 'project', 'fact', 'instruction'].includes(String(callArgs.category))
            ? String(callArgs.category)
            : 'fact';
          emit({
            type: 'approval_request',
            actionId: `mem_${Date.now()}`,
            actionType: 'save_memory',
            title: 'Approve Long-Term Memory',
            description: `Save to your personal memory (${category})?`,
            payload: { fact, category, source: 'text' },
          });
          functionResponseParts.push({
            functionResponse: {
              id: call.id,
              name: callName,
              response: {
                status: 'awaiting_user_approval',
                message: 'A confirmation card has been presented to the user. Tell them to click Approve to save it.',
              },
            },
          });
          continue;
        }

        if (callName === 'delegate_a2a_agent') {
          const targetAgent = String(callArgs.agentId) as SpecializedAgentId;
          const taskPrompt = String(callArgs.task ?? check.sanitized);
          agentRoute = targetAgent;
          emit({ type: 'trace', step: 'A2A Dispatch', detail: `Delegating to ${targetAgent}` });
          const task = await dispatchA2ATask({
            agentId: targetAgent,
            input: taskPrompt,
            userId: params.userId,
            contextHint: ctx.selectedMemories.map((m) => m.fact).join('; '),
          });
          emit({
            type: 'a2a_event',
            agentId: targetAgent,
            status: task.status,
            toolsInvoked: task.toolsInvoked,
          });
          for (const s of task.sources) {
            allSources.push({
              title: s.title,
              url: s.url,
              score: s.score,
              kind: s.url ? 'web' : 'document',
            });
          }
          functionResponseParts.push({
            functionResponse: {
              id: call.id,
              name: callName,
              response: {
                agentId: targetAgent,
                status: task.status,
                output: task.output ?? task.error ?? 'No response from specialized agent.',
              },
            },
          });
          continue;
        }

        emit({ type: 'tool_start', toolName: callName, args: callArgs });
        const toolRes = await mcpToolManager.executeTool(callName, callArgs, { userId: params.userId });
        emit({
          type: 'tool_result',
          toolName: callName,
          success: toolRes.success,
          latencyMs: toolRes.latencyMs,
          summary: toolRes.success ? 'Completed' : toolRes.error ?? 'Failed',
        });

        if (toolRes.success && toolRes.data && typeof toolRes.data === 'object') {
          const dataObj = toolRes.data as Record<string, unknown>;
          if (Array.isArray(dataObj.sources)) {
            for (const s of dataObj.sources as Array<{ title?: string; url?: string }>) {
              if (s.url) allSources.push({ title: s.title || s.url, url: s.url, kind: 'web' });
            }
          }
          if (Array.isArray(dataObj.chunks)) {
            for (const c of dataObj.chunks as Array<{ filename?: string; chunkIndex?: number; score?: number }>) {
              if (c.filename) {
                allSources.push({
                  title: `${c.filename} (chunk #${c.chunkIndex ?? 0})`,
                  score: c.score,
                  kind: 'document',
                });
              }
            }
          }
        }

        functionResponseParts.push({
          functionResponse: {
            id: call.id,
            name: callName,
            response: toolRes.success ? { result: toolRes.data } : { error: toolRes.error },
          },
        });
      }

      contents.push({
        role: 'user',
        parts: functionResponseParts,
      });
    }

    if (!finalAnswerText) {
      const stream = await ai.models.generateContentStream({
        model: MODELS.ORCHESTRATOR,
        contents,
        config: {
          systemInstruction: ctx.systemInstruction,
        },
      });
      for await (const chunk of stream) {
        if (chunk.text) {
          finalAnswerText += chunk.text;
          emit({ type: 'delta', text: chunk.text });
        }
      }
    } else {
      // Stream final answer in natural word-boundary chunks for smooth UI rendering
      const words = finalAnswerText.split(/(\s+)/);
      for (let i = 0; i < words.length; i += 6) {
        emit({ type: 'delta', text: words.slice(i, i + 6).join('') });
      }
    }

    if (allSources.length > 0) {
      const dedupedSources = Array.from(
        new Map(allSources.map((s) => [`${s.kind}:${s.title}:${s.url ?? ''}`, s])).values(),
      );
      emit({ type: 'sources', sources: dedupedSources });
    }

    const totalLatency = Date.now() - start;
    telemetry.recordTurn(
      totalLatency,
      ctx.tokenEstimate.totalTokens + Math.ceil(check.sanitized.length / 4),
      Math.ceil(finalAnswerText.length / 4),
    );
    telemetry.recordTrace({
      sessionId: params.sessionId,
      kind: 'orchestrator',
      name: agentRoute,
      status: 'ok',
      latencyMs: totalLatency,
      detail: 'Orchestration turn completed',
    });

    emit({
      type: 'done',
      latencyMs: totalLatency,
      agentRoute,
      compressedSummary: ctx.compressedSummary || undefined,
    });
  } catch (err) {
    telemetry.recordModelError();
    const message = err instanceof Error ? err.message : 'Model orchestration error';
    telemetry.recordTrace({
      sessionId: params.sessionId,
      kind: 'orchestrator',
      name: agentRoute,
      status: 'error',
      latencyMs: Date.now() - start,
      detail: message.slice(0, 140),
    });
    emit({ type: 'error', message });
  }
}
