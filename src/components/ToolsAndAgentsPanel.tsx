import { useEffect, useState } from 'react';
import { Bot, Play, Terminal } from 'lucide-react';
import type { A2AAgentInfo, McpToolInfo } from '../types/nexora';

interface ToolsAndAgentsPanelProps {
  guestId: string;
  getAuthToken: () => Promise<string | null>;
}

const DEFAULT_TOOL_ARGS: Record<string, string> = {
  calculator: '{"expression": "(1280 * 1.15) + sqrt(256)"}',
  datetime_now: '{"timezone": "Asia/Karachi"}',
  web_search: '{"query": "Google Cloud Run WebSocket timeout limits"}',
  knowledge_retrieve: '{"query": "architecture", "topK": 3}',
  document_summarize: '{"documentQuery": "architecture"}',
  data_analyze: '{"data": "quarter,revenue,cost\\nQ1,120000,74000\\nQ2,148000,82000\\nQ3,172000,89000"}',
  url_context_read: '{"url": "https://ai.google.dev", "question": "What does Gemini API support?"}',
};

export function ToolsAndAgentsPanel({ guestId, getAuthToken }: ToolsAndAgentsPanelProps) {
  const [tools, setTools] = useState<McpToolInfo[]>([]);
  const [agents, setAgents] = useState<A2AAgentInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const [selectedTool, setSelectedTool] = useState('calculator');
  const [toolArgsJson, setToolArgsJson] = useState(DEFAULT_TOOL_ARGS.calculator!);
  const [toolResult, setToolResult] = useState<string>('');
  const [runningTool, setRunningTool] = useState(false);

  const [selectedAgent, setSelectedAgent] = useState('research-agent');
  const [a2aInput, setA2aInput] = useState('Summarize best practices for low-latency WebSocket audio streaming.');
  const [a2aOutput, setA2aOutput] = useState<string>('');
  const [runningA2a, setRunningA2a] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [tRes, aRes] = await Promise.all([fetch('/api/mcp/tools'), fetch('/api/a2a/agents')]);
        const tData = (await tRes.json()) as { tools?: McpToolInfo[] };
        const aData = (await aRes.json()) as { agents?: A2AAgentInfo[] };
        if (mounted) {
          setTools(tData.tools ?? []);
          setAgents(aData.agents ?? []);
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleRunTool = async () => {
    setRunningTool(true);
    setToolResult('');
    try {
      const parsedArgs = JSON.parse(toolArgsJson) as Record<string, unknown>;
      const token = await getAuthToken();
      const res = await fetch('/api/mcp/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ toolName: selectedTool, args: parsedArgs }),
      });
      const data = await res.json();
      setToolResult(JSON.stringify(data, null, 2));
    } catch (err) {
      setToolResult(err instanceof Error ? err.message : 'Invalid JSON arguments or tool failure');
    } finally {
      setRunningTool(false);
    }
  };

  const handleDispatchA2A = async () => {
    if (!a2aInput.trim()) return;
    setRunningA2a(true);
    setA2aOutput('');
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/a2a', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tasks/send',
          params: {
            agentId: selectedAgent,
            input: a2aInput.trim(),
          },
        }),
      });
      const data = await res.json();
      setA2aOutput(JSON.stringify(data, null, 2));
    } catch (err) {
      setA2aOutput(err instanceof Error ? err.message : 'A2A dispatch failed');
    } finally {
      setRunningA2a(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-5xl mx-auto space-y-10">
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold text-slate-100">MCP Tools & A2A Multi-Agent Registry</h1>
          <p className="text-sm text-slate-400">
            Live discovery of Model Context Protocol tools and specialized Agent2Agent endpoints exposed by Nexora AI.
          </p>
        </header>

        {/* MCP Tools Grid + Runner */}
        <section className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-slate-200">Connected MCP Tools</h2>
            <span className="text-xs font-mono tabular-nums text-slate-400">{tools.length} discovered</span>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {[1, 2, 3, 4].map((n) => (
                <div key={n} className="h-24 bg-[#11141B] border border-white/8 rounded-xl animate-pulse" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {tools.map((tool) => (
                <div
                  key={tool.name}
                  className="p-4 bg-[#11141B] border border-white/8 rounded-xl flex flex-col justify-between gap-2"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold text-blue-300">{tool.name}</span>
                      <span className="text-xs font-mono text-slate-500">scope: {tool.permissionLevel}</span>
                    </div>
                    <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">{tool.description}</p>
                  </div>
                  <div className="pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedTool(tool.name);
                        setToolArgsJson(DEFAULT_TOOL_ARGS[tool.name] ?? '{}');
                      }}
                      className="text-xs font-medium text-blue-400 hover:text-blue-300"
                    >
                      Load into tester
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Interactive MCP Tool Tester */}
          <div className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Terminal className="w-4 h-4 text-blue-400" />
              <span>Execute MCP Tool Directly</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select
                aria-label="Select MCP tool"
                value={selectedTool}
                onChange={(e) => {
                  const name = e.target.value;
                  setSelectedTool(name);
                  setToolArgsJson(DEFAULT_TOOL_ARGS[name] ?? '{}');
                }}
                className="min-h-[40px] px-3 py-2 text-sm font-mono bg-[#090B10] text-slate-100 border border-white/10 rounded-lg"
              >
                {tools.map((t) => (
                  <option key={t.name} value={t.name}>
                    {t.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={toolArgsJson}
                onChange={(e) => setToolArgsJson(e.target.value)}
                aria-label="MCP JSON arguments"
                className="md:col-span-2 min-h-[40px] px-3 py-2 text-xs font-mono bg-[#090B10] text-slate-200 border border-white/10 rounded-lg"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleRunTool()}
                disabled={runningTool}
                className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {runningTool ? 'Executing...' : 'Run MCP Call'}
              </button>
            </div>
            {toolResult && (
              <pre className="p-3.5 bg-[#090B10] border border-white/8 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto max-h-60">
                {toolResult}
              </pre>
            )}
          </div>
        </section>

        {/* A2A Specialized Agents */}
        <section className="space-y-5">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-slate-200">Specialized A2A Agents</h2>
            <a
              href="/.well-known/agent.json"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-blue-400 hover:underline"
            >
              /.well-known/agent.json
            </a>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => (
              <div key={agent.id} className="p-4 bg-[#11141B] border border-white/8 rounded-xl space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-100">{agent.name}</span>
                  <span className="text-xs font-mono text-violet-300">{agent.id}</span>
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">{agent.description}</p>
                <p className="text-[11px] font-mono text-slate-500">
                  Tools: {agent.capabilities.mcpTools.join(', ')}
                </p>
              </div>
            ))}
          </div>

          {/* A2A JSON-RPC Dispatch Tester */}
          <div className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-4">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-200">
              <Bot className="w-4 h-4 text-violet-400" />
              <span>Dispatch A2A JSON-RPC Task (tasks/send)</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select
                aria-label="Select A2A agent"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                className="min-h-[40px] px-3 py-2 text-sm font-mono bg-[#090B10] text-slate-100 border border-white/10 rounded-lg"
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={a2aInput}
                onChange={(e) => setA2aInput(e.target.value)}
                aria-label="A2A task prompt"
                className="md:col-span-2 min-h-[40px] px-3 py-2 text-sm bg-[#090B10] text-slate-200 border border-white/10 rounded-lg"
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleDispatchA2A()}
                disabled={runningA2a}
                className="min-h-[40px] inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#8B5CF6] hover:bg-[#7C3AED] disabled:opacity-40 text-white rounded-lg transition-colors"
              >
                <Play className="w-3.5 h-3.5" />
                {runningA2a ? 'Dispatching...' : 'Send A2A Task'}
              </button>
            </div>
            {a2aOutput && (
              <pre className="p-3.5 bg-[#090B10] border border-white/8 rounded-lg text-xs font-mono text-slate-300 overflow-x-auto max-h-64">
                {a2aOutput}
              </pre>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
