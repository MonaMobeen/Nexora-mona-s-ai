export type OrbState = 'idle' | 'listening' | 'processing' | 'speaking' | 'interrupted' | 'error';

export type VoiceName = 'Zephyr' | 'Puck' | 'Charon' | 'Kore' | 'Fenrir';
export type SpeakingStyle = 'concise' | 'natural' | 'technical' | 'warm';
export type LanguagePreference = 'auto' | 'en' | 'ur' | 'ur-Latn';

export type WorkspaceTab = 'conversation' | 'memory' | 'tools' | 'knowledge' | 'observability' | 'settings';

export interface ToolActivityDetail {
  toolName: string;
  success: boolean;
  latencyMs: number;
  summary: string;
}

export interface SourceReference {
  title: string;
  url?: string;
  score?: number;
  kind: 'document' | 'web';
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  modality: 'voice' | 'text';
  createdAt: string;
  agentRoute?: string;
  latencyMs?: number;
  tools?: ToolActivityDetail[];
  sources?: SourceReference[];
  streaming?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  mode: 'voice' | 'text' | 'multimodal';
  language: LanguagePreference;
  summary: string;
  messageCount: number;
  updatedAt: string;
}

export interface MemoryEntry {
  id: string;
  fact: string;
  category: 'preference' | 'project' | 'fact' | 'instruction';
  source: 'voice' | 'text' | 'manual';
  approvedByUser: boolean;
  updatedAt: string;
}

export interface RagDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  status: 'processing' | 'indexed' | 'error';
  summary: string;
  createdAt: string;
}

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  permissionLevel: 'read' | 'compute' | 'external';
}

export interface A2AAgentInfo {
  id: string;
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

export interface ApprovalRequest {
  actionId: string;
  actionType: 'save_memory' | 'delete_document' | 'delete_memory';
  title: string;
  description: string;
  payload: Record<string, unknown>;
}

export interface ObservabilityMetrics {
  activeVoiceConnections: number;
  totalSessions: number;
  totalTurns: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  modelErrors: number;
  securityBlocks: number;
  ragRetrievals: number;
  estimatedTokens: {
    input: number;
    output: number;
    total: number;
  };
  toolSuccessRate: number;
  tools: Array<{
    name: string;
    calls: number;
    successes: number;
    failures: number;
    avgLatencyMs: number;
  }>;
  recentLatencies: number[];
}

export interface TraceEvent {
  id: string;
  timestamp: string;
  sessionId: string;
  kind: 'orchestrator' | 'voice' | 'mcp_tool' | 'a2a_agent' | 'rag_retrieval' | 'context_opt' | 'security';
  name: string;
  status: 'ok' | 'error' | 'blocked';
  latencyMs: number;
  detail: string;
}

export interface UserPreferences {
  preferredVoice: VoiceName;
  speakingStyle: SpeakingStyle;
  preferredLanguage: LanguagePreference;
  extendedThinking: boolean;
}
