import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createGenAIClient, MODELS } from '../config/env.ts';
import { ragStore } from '../rag/pipeline.ts';
import { evaluateMathExpression, validateExternalUrl } from '../security/guard.ts';
import { getMcpExecutionContext } from './context.ts';

export function createNexoraMcpServer(): McpServer {
  const server = new McpServer({
    name: 'nexora-mcp-tools',
    version: '1.0.0',
  });

  // 1. Web Search & Grounded Retrieval
  server.registerTool(
    'web_search',
    {
      title: 'Web Search',
      description: 'Searches live web information via Google Search grounding for recent facts, news, documentation, or general verification.',
      inputSchema: z.object({
        query: z.string().min(2).max(400).describe('The search query to execute.'),
      }),
    },
    async ({ query }) => {
      const ai = createGenAIClient();
      const response = await ai.models.generateContent({
        model: MODELS.ORCHESTRATOR,
        contents: `Answer the following search query concisely with verified facts and dates:\n${query}`,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });
      const chunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      const sources = chunks
        .map((c) => (c.web ? { title: c.web.title || c.web.uri || 'Web Source', url: c.web.uri || '' } : null))
        .filter((s): s is { title: string; url: string } => Boolean(s && s.url));

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              summary: (response.text ?? '').trim(),
              sources,
            }),
          },
        ],
      };
    },
  );

  // 2. Safe Mathematical Calculator
  server.registerTool(
    'calculator',
    {
      title: 'Calculator',
      description: 'Evaluates mathematical expressions accurately using a safe parser (+, -, *, /, %, ^, sqrt, sin, cos, tan, log, ln, abs, round, floor, ceil, pi, e).',
      inputSchema: z.object({
        expression: z.string().min(1).max(256).describe('Mathematical expression such as "(1250 * 0.18) + sqrt(144)".'),
      }),
    },
    async ({ expression }) => {
      const result = evaluateMathExpression(expression);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              expression,
              result,
            }),
          },
        ],
      };
    },
  );

  // 3. Date & Time Intelligence
  server.registerTool(
    'datetime_now',
    {
      title: 'Date & Time',
      description: 'Returns the current date and time in UTC and an optional IANA timezone (e.g. Asia/Karachi, America/Los_Angeles, Europe/London).',
      inputSchema: z.object({
        timezone: z.string().max(64).optional().describe('Optional IANA timezone name.'),
      }),
    },
    async ({ timezone }) => {
      const now = new Date();
      let formattedLocal = now.toISOString();
      let tzUsed = 'UTC';
      if (timezone) {
        try {
          formattedLocal = new Intl.DateTimeFormat('en-US', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          }).format(now);
          tzUsed = timezone;
        } catch {
          throw new Error(`Invalid IANA timezone: ${timezone}`);
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              isoUtc: now.toISOString(),
              unixMs: now.getTime(),
              timezone: tzUsed,
              formatted: formattedLocal,
            }),
          },
        ],
      };
    },
  );

  // 4. RAG Vector Knowledge Retrieval
  server.registerTool(
    'knowledge_retrieve',
    {
      title: 'Knowledge Base Search',
      description: 'Performs semantic vector search across the user’s uploaded PDF, DOCX, and TXT knowledge documents.',
      inputSchema: z.object({
        query: z.string().min(2).max(500).describe('Natural language search query for uploaded documents.'),
        topK: z.number().int().min(1).max(10).optional().describe('Number of chunks to return (default 5).'),
      }),
    },
    async ({ query, topK }) => {
      const { userId } = getMcpExecutionContext();
      const chunks = await ragStore.retrieve(userId, query, topK ?? 5);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              matchesFound: chunks.length,
              chunks,
            }),
          },
        ],
      };
    },
  );

  // 5. Document Reading & Summarization
  server.registerTool(
    'document_summarize',
    {
      title: 'Document Reader & Summarizer',
      description: 'Reads an uploaded document from the knowledge library by filename or ID and returns a focused summary or answers a specific question about it.',
      inputSchema: z.object({
        documentQuery: z.string().min(1).max(200).describe('Document filename or ID.'),
        focusQuestion: z.string().max(400).optional().describe('Optional question to answer from the document.'),
      }),
    },
    async ({ documentQuery, focusQuestion }) => {
      const { userId } = getMcpExecutionContext();
      const doc = ragStore.getDocumentText(userId, documentQuery);
      if (!doc) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                found: false,
                message: `No uploaded document matched "${documentQuery}".`,
              }),
            },
          ],
        };
      }
      const ai = createGenAIClient();
      const prompt = focusQuestion
        ? `Based strictly on the document "${doc.meta.filename}", answer: ${focusQuestion}\n\nDocument text:\n${doc.fullText.slice(0, 18000)}`
        : `Summarize the key points, figures, and conclusions of "${doc.meta.filename}":\n\n${doc.fullText.slice(0, 18000)}`;

      const res = await ai.models.generateContent({
        model: MODELS.ORCHESTRATOR,
        contents: prompt,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              found: true,
              filename: doc.meta.filename,
              chunkCount: doc.meta.chunkCount,
              analysis: (res.text ?? '').trim(),
            }),
          },
        ],
      };
    },
  );

  // 6. Structured Data Analysis (JSON / CSV)
  server.registerTool(
    'data_analyze',
    {
      title: 'Structured Data Analyzer',
      description: 'Computes summary statistics (count, min, max, mean, median, standard deviation, top categories) on CSV or JSON array datasets.',
      inputSchema: z.object({
        data: z.string().min(2).max(40000).describe('Raw JSON array or CSV text to analyze.'),
      }),
    },
    async ({ data }) => {
      const rows = parseStructuredInput(data);
      if (rows.length === 0) {
        throw new Error('No structured rows detected in input.');
      }
      const columns = Array.from(new Set(rows.flatMap((r) => Object.keys(r))));
      const profile: Record<string, unknown> = {};

      for (const col of columns.slice(0, 20)) {
        const values = rows.map((r) => r[col]).filter((v) => v !== undefined && v !== null && v !== '');
        const numeric = values.map((v) => Number(v)).filter((n) => Number.isFinite(n));
        if (numeric.length > 0 && numeric.length >= values.length * 0.6) {
          const sorted = [...numeric].sort((a, b) => a - b);
          const mean = numeric.reduce((a, b) => a + b, 0) / numeric.length;
          const variance = numeric.reduce((a, b) => a + (b - mean) ** 2, 0) / numeric.length;
          const mid = Math.floor(sorted.length / 2);
          const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
          profile[col] = {
            type: 'numeric',
            count: numeric.length,
            min: sorted[0],
            max: sorted[sorted.length - 1],
            mean: Number(mean.toFixed(4)),
            median: Number(median.toFixed(4)),
            stdDev: Number(Math.sqrt(variance).toFixed(4)),
          };
        } else {
          const counts = new Map<string, number>();
          for (const v of values) {
            const key = String(v);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
          const topValues = Array.from(counts.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([value, count]) => ({ value, count }));
          profile[col] = {
            type: 'categorical',
            nonNullCount: values.length,
            uniqueCount: counts.size,
            topValues,
          };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              rowCount: rows.length,
              columnCount: columns.length,
              columns,
              profile,
            }),
          },
        ],
      };
    },
  );

  // 7. Safe URL Context Reader
  server.registerTool(
    'url_context_read',
    {
      title: 'URL Context Inspector',
      description: 'Validates a public HTTP/HTTPS URL and extracts/summarizes its webpage content.',
      inputSchema: z.object({
        url: z.string().url().max(500).describe('Public http/https URL to inspect.'),
        question: z.string().max(300).optional().describe('Optional question to answer from the URL.'),
      }),
    },
    async ({ url, question }) => {
      const safeUrl = validateExternalUrl(url);
      const ai = createGenAIClient();
      const prompt = question
        ? `Using ${safeUrl.toString()}, answer concisely: ${question}`
        : `Summarize the key information at ${safeUrl.toString()}.`;

      const res = await ai.models.generateContent({
        model: MODELS.ORCHESTRATOR,
        contents: prompt,
        config: {
          tools: [{ urlContext: {} }],
        },
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              url: safeUrl.toString(),
              summary: (res.text ?? '').trim(),
            }),
          },
        ],
      };
    },
  );

  return server;
}

function parseStructuredInput(raw: string): Record<string, unknown>[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed.filter((r) => r && typeof r === 'object') as Record<string, unknown>[];
    if (parsed && typeof parsed === 'object') return [parsed as Record<string, unknown>];
  }

  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const vals = splitCsvLine(line);
    const row: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      row[h] = vals[i] ?? '';
    });
    return row;
  });
}

function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}
