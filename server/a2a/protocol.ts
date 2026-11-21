import crypto from 'node:crypto';
import { createGenAIClient, MODELS } from '../config/env.ts';
import { mcpToolManager } from '../mcp/client.ts';
import { telemetry } from '../observability/telemetry.ts';

export type SpecializedAgentId =
  | 'research-agent'
  | 'data-analyst-agent'
  | 'document-agent'
  | 'coding-agent'
  | 'knowledge-agent';

export interface AgentCard {
  id: SpecializedAgentId | 'nexora-orchestrator';
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    multimodalAudio: boolean;
    mcpTools: string[];
  };
  skills: Array<{
    id: string;
    name: string;
    description: string;
    examples: string[];
  }>;
}

export interface A2ATask {
  id: string;
  agentId: SpecializedAgentId;
  status: 'submitted' | 'working' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  input: string;
  output?: string;
  toolsInvoked: string[];
  sources: Array<{ title: string; url?: string; score?: number }>;
  error?: string;
}

const SPECIALIZED_AGENTS: Record<SpecializedAgentId, {
  name: string;
  description: string;
  systemPrompt: string;
  allowedTools: string[];
  skills: AgentCard['skills'];
}> = {
  'research-agent': {
    name: 'Nexora Research Agent',
    description: 'Searches live web sources, synthesizes multi-source findings, and inspects public URLs with attribution.',
    systemPrompt:
      'You are the Nexora Research Agent operating over A2A. Synthesize verified findings clearly, distinguish verified web sources from general knowledge, and cite source URLs when provided.',
    allowedTools: ['web_search', 'url_context_read', 'datetime_now'],
    skills: [
      {
        id: 'web-research',
        name: 'Grounded Web Research',
        description: 'Live web search and multi-source synthesis.',
        examples: ['Compare recent Gemini Live API latency benchmarks', 'Summarize latest AI regulations in 2026'],
      },
    ],
  },
  'data-analyst-agent': {
    name: 'Nexora Data Analyst Agent',
    description: 'Profiles CSV/JSON datasets, computes statistical summaries, detects anomalies, and verifies math.',
    systemPrompt:
      'You are the Nexora Data Analyst Agent operating over A2A. Use statistical outputs accurately, report exact numbers with units, and highlight anomalies or data quality gaps.',
    allowedTools: ['data_analyze', 'calculator'],
    skills: [
      {
        id: 'dataset-profiling',
        name: 'Structured Data Profiling',
        description: 'Computes descriptive statistics, distributions, and calculations.',
        examples: ['Analyze quarterly revenue CSV', 'Calculate compound annual growth rate'],
      },
    ],
  },
  'document-agent': {
    name: 'Nexora Document Agent',
    description: 'Reads, summarizes, and extracts structured insights from uploaded PDF, DOCX, and TXT files.',
    systemPrompt:
      'You are the Nexora Document Agent operating over A2A. Ground every claim in the retrieved document contents and explicitly state if a detail is absent from the document.',
    allowedTools: ['document_summarize', 'knowledge_retrieve'],
    skills: [
      {
        id: 'doc-synthesis',
        name: 'Document Summarization & Extraction',
        description: 'Processes uploaded PDF/DOCX/TXT documents.',
        examples: ['Summarize the uploaded architecture specification', 'Extract SLA obligations from contract.pdf'],
      },
    ],
  },
  'coding-agent': {
    name: 'Nexora Coding Agent',
    description: 'Assists with software architecture, TypeScript/Python debugging, algorithm design, and security reviews.',
    systemPrompt:
      'You are the Nexora Coding Agent operating over A2A. Provide production-grade, type-safe, secure code and clear root-cause explanations.',
    allowedTools: ['calculator', 'knowledge_retrieve'],
    skills: [
      {
        id: 'code-engineering',
        name: 'Engineering & Debugging',
        description: 'Production code generation, refactoring, and root-cause debugging.',
        examples: ['Debug an async WebSocket race condition', 'Write a Python FastAPI streaming endpoint'],
      },
    ],
  },
  'knowledge-agent': {
    name: 'Nexora Knowledge Agent',
    description: 'Performs vector semantic retrieval over the user knowledge base and distinguishes document facts from general knowledge.',
    systemPrompt:
      'You are the Nexora Knowledge Agent operating over A2A. Retrieve relevant vector chunks, attribute each fact to its document name and chunk index, and separate retrieved knowledge from general knowledge.',
    allowedTools: ['knowledge_retrieve', 'document_summarize'],
    skills: [
      {
        id: 'semantic-rag',
        name: 'Semantic Vector Retrieval',
        description: 'Cosine similarity search over embedded document chunks.',
        examples: ['What does our security policy say about key rotation?'],
      },
    ],
  },
};

const taskStore = new Map<string, A2ATask>();

export function getOrchestratorAgentCard(baseUrl: string): AgentCard {
  return {
    id: 'nexora-orchestrator',
    name: "Mona's AI Orchestrator",
    description:
      'Autonomous multimodal voice and text agent coordinating specialized A2A sub-agents, MCP tools, RAG retrieval, and user-controlled memory.',
    url: `${baseUrl}/api/a2a`,
    version: '1.0.0',
    capabilities: {
      streaming: true,
      multimodalAudio: true,
      mcpTools: [
        'web_search',
        'calculator',
        'datetime_now',
        'knowledge_retrieve',
        'document_summarize',
        'data_analyze',
        'url_context_read',
      ],
    },
    skills: [
      {
        id: 'multimodal-voice',
        name: 'Real-Time Multilingual Voice',
        description: 'Low-latency Gemini Live speech-to-speech in English, Urdu, and Roman Urdu.',
        examples: ['Mera aaj ka schedule aur uploaded notes summarize karo'],
      },
      {
        id: 'a2a-routing',
        name: 'Multi-Agent A2A Routing',
        description: 'Dispatches complex domain tasks to specialized Research, Data, Document, Coding, and Knowledge agents.',
        examples: ['Analyze this CSV dataset and cross-check with our Q4 PDF'],
      },
    ],
  };
}

export function listSpecializedAgentCards(baseUrl: string): AgentCard[] {
  return (Object.keys(SPECIALIZED_AGENTS) as SpecializedAgentId[]).map((id) => {
    const spec = SPECIALIZED_AGENTS[id];
    return {
      id,
      name: spec.name,
      description: spec.description,
      url: `${baseUrl}/api/a2a`,
      version: '1.0.0',
      capabilities: {
        streaming: false,
        multimodalAudio: false,
        mcpTools: spec.allowedTools,
      },
      skills: spec.skills,
    };
  });
}

export function getA2ATask(taskId: string): A2ATask | undefined {
  return taskStore.get(taskId);
}

export async function dispatchA2ATask(params: {
  agentId: SpecializedAgentId;
  input: string;
  userId: string;
  contextHint?: string;
}): Promise<A2ATask> {
  const spec = SPECIALIZED_AGENTS[params.agentId];
  if (!spec) {
    throw new Error(`Unknown A2A agent: ${params.agentId}`);
  }

  const taskId = crypto.randomUUID();
  const task: A2ATask = {
    id: taskId,
    agentId: params.agentId,
    status: 'working',
    createdAt: new Date().toISOString(),
    input: params.input,
    toolsInvoked: [],
    sources: [],
  };
  taskStore.set(taskId, task);

  const start = Date.now();
  try {
    const toolFindings: string[] = [];

    // Execute domain-appropriate MCP tools before synthesis
    if (params.agentId === 'research-agent') {
      const urlMatch = params.input.match(/https?:\/\/[^\s)]+/i);
      if (urlMatch) {
        const res = await mcpToolManager.executeTool(
          'url_context_read',
          { url: urlMatch[0], question: params.input },
          { userId: params.userId },
        );
        task.toolsInvoked.push('url_context_read');
        if (res.success) toolFindings.push(JSON.stringify(res.data));
      } else {
        const res = await mcpToolManager.executeTool(
          'web_search',
          { query: params.input },
          { userId: params.userId },
        );
        task.toolsInvoked.push('web_search');
        if (res.success && res.data && typeof res.data === 'object') {
          const d = res.data as { summary?: string; sources?: Array<{ title: string; url: string }> };
          toolFindings.push(d.summary ?? '');
          for (const s of d.sources ?? []) {
            task.sources.push({ title: s.title, url: s.url });
          }
        }
      }
    } else if (params.agentId === 'knowledge-agent' || params.agentId === 'document-agent') {
      const res = await mcpToolManager.executeTool(
        'knowledge_retrieve',
        { query: params.input, topK: 5 },
        { userId: params.userId },
      );
      task.toolsInvoked.push('knowledge_retrieve');
      if (res.success && res.data && typeof res.data === 'object') {
        const d = res.data as { chunks?: Array<{ filename: string; chunkIndex: number; text: string; score: number }> };
        for (const ch of d.chunks ?? []) {
          toolFindings.push(`[${ch.filename} · chunk ${ch.chunkIndex} · score ${ch.score}]: ${ch.text}`);
          task.sources.push({ title: `${ch.filename} (chunk #${ch.chunkIndex})`, score: ch.score });
        }
      }
    } else if (params.agentId === 'data-analyst-agent') {
      const hasRawData = /[\[{].*[\]}]/.test(params.input) || (params.input.includes(',') && params.input.includes('\n'));
      if (hasRawData) {
        const res = await mcpToolManager.executeTool(
          'data_analyze',
          { data: params.input },
          { userId: params.userId },
        );
        task.toolsInvoked.push('data_analyze');
        if (res.success) toolFindings.push(JSON.stringify(res.data));
      }
    }

    const ai = createGenAIClient();
    const promptParts = [
      `Task: ${params.input}`,
      params.contextHint ? `Context Hint:\n${params.contextHint}` : '',
      toolFindings.length > 0 ? `Verified Tool Output:\n${toolFindings.join('\n\n')}` : '',
    ].filter(Boolean);

    const response = await ai.models.generateContent({
      model: MODELS.ORCHESTRATOR,
      contents: promptParts.join('\n\n'),
      config: {
        systemInstruction: spec.systemPrompt,
      },
    });

    task.output = (response.text ?? '').trim();
    task.status = 'completed';
    task.completedAt = new Date().toISOString();

    telemetry.recordTrace({
      sessionId: params.userId,
      kind: 'a2a_agent',
      name: params.agentId,
      status: 'ok',
      latencyMs: Date.now() - start,
      detail: `A2A task completed (${task.toolsInvoked.length} tools)`,
    });

    return task;
  } catch (err) {
    task.status = 'failed';
    task.error = err instanceof Error ? err.message : String(err);
    task.completedAt = new Date().toISOString();

    telemetry.recordTrace({
      sessionId: params.userId,
      kind: 'a2a_agent',
      name: params.agentId,
      status: 'error',
      latencyMs: Date.now() - start,
      detail: task.error.slice(0, 120),
    });

    return task;
  }
}
