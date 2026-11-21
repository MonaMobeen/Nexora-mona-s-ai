import crypto from 'node:crypto';

export type LogSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface StructuredLogEntry {
  severity: LogSeverity;
  timestamp: string;
  component: string;
  event: string;
  traceId?: string;
  latencyMs?: number;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentTraceEvent {
  id: string;
  timestamp: string;
  sessionId: string;
  kind: 'orchestrator' | 'voice' | 'mcp_tool' | 'a2a_agent' | 'rag_retrieval' | 'context_opt' | 'security';
  name: string;
  status: 'ok' | 'error' | 'blocked';
  latencyMs: number;
  detail: string;
}

export interface ToolMetricSummary {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  avgLatencyMs: number;
}

class ObservabilityRegistry {
  private traces: AgentTraceEvent[] = [];
  private activeVoiceConnections = 0;
  private totalSessions = 0;
  private totalTurns = 0;
  private modelErrors = 0;
  private securityBlocks = 0;
  private ragRetrievals = 0;
  private totalInputTokensEst = 0;
  private totalOutputTokensEst = 0;
  private latencies: number[] = [];
  private toolStats = new Map<string, { calls: number; successes: number; failures: number; totalLatency: number }>();

  log(entry: Omit<StructuredLogEntry, 'timestamp'>): void {
    const payload: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      ...entry,
    };
    if (entry.severity === 'ERROR') {
      console.error(JSON.stringify(payload));
    } else {
      console.log(JSON.stringify(payload));
    }
  }

  recordTrace(event: Omit<AgentTraceEvent, 'id' | 'timestamp'>): AgentTraceEvent {
    const full: AgentTraceEvent = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...event,
    };
    this.traces.unshift(full);
    if (this.traces.length > 150) {
      this.traces.length = 150;
    }
    return full;
  }

  incrementVoiceConnections(delta: number): void {
    this.activeVoiceConnections = Math.max(0, this.activeVoiceConnections + delta);
    if (delta > 0) this.totalSessions += 1;
  }

  recordTurn(latencyMs: number, inputTokensEst: number, outputTokensEst: number): void {
    this.totalTurns += 1;
    this.totalInputTokensEst += inputTokensEst;
    this.totalOutputTokensEst += outputTokensEst;
    this.latencies.push(latencyMs);
    if (this.latencies.length > 200) {
      this.latencies.shift();
    }
  }

  recordToolCall(name: string, success: boolean, latencyMs: number): void {
    const cur = this.toolStats.get(name) ?? { calls: 0, successes: 0, failures: 0, totalLatency: 0 };
    cur.calls += 1;
    if (success) cur.successes += 1;
    else cur.failures += 1;
    cur.totalLatency += latencyMs;
    this.toolStats.set(name, cur);
  }

  recordModelError(): void {
    this.modelErrors += 1;
  }

  recordSecurityBlock(): void {
    this.securityBlocks += 1;
  }

  recordRagRetrieval(): void {
    this.ragRetrievals += 1;
  }

  getMetricsSnapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const avgLatencyMs = sorted.length
      ? Math.round(sorted.reduce((acc, v) => acc + v, 0) / sorted.length)
      : 0;
    const p95LatencyMs = sorted.length
      ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
      : 0;

    const tools: ToolMetricSummary[] = Array.from(this.toolStats.entries()).map(([name, s]) => ({
      name,
      calls: s.calls,
      successes: s.successes,
      failures: s.failures,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatency / s.calls) : 0,
    }));

    const totalToolCalls = tools.reduce((sum, t) => sum + t.calls, 0);
    const totalToolSuccess = tools.reduce((sum, t) => sum + t.successes, 0);

    return {
      activeVoiceConnections: this.activeVoiceConnections,
      totalSessions: this.totalSessions,
      totalTurns: this.totalTurns,
      avgLatencyMs,
      p95LatencyMs,
      modelErrors: this.modelErrors,
      securityBlocks: this.securityBlocks,
      ragRetrievals: this.ragRetrievals,
      estimatedTokens: {
        input: this.totalInputTokensEst,
        output: this.totalOutputTokensEst,
        total: this.totalInputTokensEst + this.totalOutputTokensEst,
      },
      toolSuccessRate: totalToolCalls > 0 ? Math.round((totalToolSuccess / totalToolCalls) * 100) : 100,
      tools,
      recentLatencies: this.latencies.slice(-24),
    };
  }

  getRedactedTraces(limit = 50): AgentTraceEvent[] {
    return this.traces.slice(0, limit);
  }
}

export const telemetry = new ObservabilityRegistry();
