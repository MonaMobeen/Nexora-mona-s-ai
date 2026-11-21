import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ObservabilityMetrics, TraceEvent } from '../types/nexora';

export function ObservabilityPanel() {
  const [metrics, setMetrics] = useState<ObservabilityMetrics | null>(null);
  const [traces, setTraces] = useState<TraceEvent[]>([]);
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  const loadTelemetry = useCallback(async () => {
    setLoading(true);
    try {
      const [mRes, tRes] = await Promise.all([
        fetch('/api/observability/metrics'),
        fetch('/api/observability/traces'),
      ]);
      const mData = (await mRes.json()) as ObservabilityMetrics;
      const tData = (await tRes.json()) as { traces?: TraceEvent[] };
      setMetrics(mData);
      setTraces(tData.traces ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTelemetry();
    const timer = setInterval(() => void loadTelemetry(), 10000);
    return () => clearInterval(timer);
  }, [loadTelemetry]);

  const filteredTraces =
    kindFilter === 'all' ? traces : traces.filter((t) => t.kind === kindFilter);

  const maxLatency = Math.max(100, ...(metrics?.recentLatencies ?? [100]));

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-8">
        <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="font-display text-2xl font-semibold text-slate-100">Observability & Execution Telemetry</h1>
            <p className="text-sm text-slate-400">
              Real-time operational metrics, latency distribution, tool reliability, and privacy-redacted agent traces.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadTelemetry()}
            className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-white/8 hover:bg-white/12 text-slate-200 border border-white/10 rounded-lg transition-colors self-start"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </header>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Active Voice Connections', value: metrics?.activeVoiceConnections ?? 0 },
            { label: 'Avg / P95 Latency', value: `${metrics?.avgLatencyMs ?? 0}ms / ${metrics?.p95LatencyMs ?? 0}ms` },
            { label: 'Tool Success Rate', value: `${metrics?.toolSuccessRate ?? 100}%` },
            { label: 'Estimated Tokens', value: (metrics?.estimatedTokens.total ?? 0).toLocaleString() },
            { label: 'Total Voice Sessions', value: metrics?.totalSessions ?? 0 },
            { label: 'Total Agent Turns', value: metrics?.totalTurns ?? 0 },
            { label: 'RAG Retrievals', value: metrics?.ragRetrievals ?? 0 },
            { label: 'Model Errors / Security Blocks', value: `${metrics?.modelErrors ?? 0} / ${metrics?.securityBlocks ?? 0}` },
          ].map((kpi) => (
            <div key={kpi.label} className="p-4 bg-[#11141B] border border-white/8 rounded-xl space-y-1.5">
              <p className="text-xs text-slate-400">{kpi.label}</p>
              <p className="text-lg font-mono tabular-nums font-semibold text-slate-100">{kpi.value}</p>
            </div>
          ))}
        </div>

        {/* Latency Distribution Chart */}
        <section className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-200">Recent Response Latencies (ms)</h2>
            <span className="text-xs font-mono tabular-nums text-slate-400">
              {metrics?.recentLatencies.length ?? 0} samples
            </span>
          </div>
          {!metrics || metrics.recentLatencies.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">
              Send a message or start a voice turn to record real response latency samples.
            </p>
          ) : (
            <div className="h-28 flex items-end gap-1.5 pt-2">
              {metrics.recentLatencies.map((val, idx) => {
                const heightPct = Math.max(8, Math.round((val / maxLatency) * 100));
                return (
                  <div key={idx} className="flex-1 flex flex-col items-center justify-end h-full gap-1 group">
                    <div
                      title={`${val}ms`}
                      style={{ height: `${heightPct}%` }}
                      className="w-full max-w-[26px] bg-blue-500/75 group-hover:bg-blue-400 rounded-t transition-colors"
                    />
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Tool Execution Table */}
        <section className="bg-[#11141B] border border-white/8 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-200">MCP Tool Execution Breakdown</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/3 text-slate-400">
                <tr>
                  <th className="px-5 py-3 font-medium">Tool Name</th>
                  <th className="px-5 py-3 font-medium text-right">Calls</th>
                  <th className="px-5 py-3 font-medium text-right">Succeeded</th>
                  <th className="px-5 py-3 font-medium text-right">Failed</th>
                  <th className="px-5 py-3 font-medium text-right">Avg Latency</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/6 font-mono tabular-nums">
                {!metrics || metrics.tools.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-5 py-6 text-center text-slate-500 font-sans">
                      No MCP tool invocations recorded yet.
                    </td>
                  </tr>
                ) : (
                  metrics.tools.map((t) => (
                    <tr key={t.name} className="hover:bg-white/3">
                      <td className="px-5 py-3 text-blue-300">{t.name}</td>
                      <td className="px-5 py-3 text-right text-slate-200">{t.calls}</td>
                      <td className="px-5 py-3 text-right text-emerald-400">{t.successes}</td>
                      <td className="px-5 py-3 text-right text-rose-400">{t.failures}</td>
                      <td className="px-5 py-3 text-right text-slate-300">{t.avgLatencyMs}ms</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Redacted Execution Traces */}
        <section className="bg-[#11141B] border border-white/8 rounded-xl overflow-hidden">
          <div className="px-5 py-4 border-b border-white/8 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <h2 className="font-display text-base font-semibold text-slate-200">Redacted Execution Traces</h2>
            <div className="flex flex-wrap gap-1">
              {['all', 'orchestrator', 'voice', 'mcp_tool', 'a2a_agent', 'rag_retrieval', 'security'].map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKindFilter(k)}
                  className={`px-2.5 py-1 text-xs font-mono rounded-md transition-colors ${
                    kindFilter === k ? 'bg-white/12 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          <div className="divide-y divide-white/6 max-h-80 overflow-y-auto font-mono text-xs tabular-nums">
            {filteredTraces.length === 0 ? (
              <p className="px-5 py-6 text-center text-slate-500 font-sans">No execution traces recorded yet.</p>
            ) : (
              filteredTraces.map((tr) => (
                <div key={tr.id} className="px-5 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={
                        tr.status === 'ok'
                          ? 'text-emerald-400'
                          : tr.status === 'blocked'
                            ? 'text-amber-400'
                            : 'text-rose-400'
                      }
                    >
                      {tr.status}
                    </span>
                    <span className="text-slate-400">{tr.kind}</span>
                    <span className="text-blue-300 truncate">{tr.name}</span>
                    <span className="text-slate-300 truncate">{tr.detail}</span>
                  </div>
                  <div className="text-slate-500 shrink-0">
                    {tr.latencyMs}ms · {new Date(tr.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
