import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { createGenAIClient, MODELS } from '../config/env.ts';
import { telemetry } from '../observability/telemetry.ts';

export interface DocumentChunk {
  id: string;
  documentId: string;
  userId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface IndexedDocumentMeta {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  chunkCount: number;
  status: 'indexed' | 'error';
  summary: string;
  createdAt: string;
}

export interface RetrievedChunk {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

interface PersistedRagData {
  documents: IndexedDocumentMeta[];
  chunks: DocumentChunk[];
}

const DATA_DIR = path.resolve(process.cwd(), '.nexora-data');
const STORE_PATH = path.resolve(DATA_DIR, 'rag-store.json');

export function cleanExtractedText(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function chunkText(text: string, chunkSize = 750, overlap = 120): string[] {
  const cleaned = cleanExtractedText(text);
  if (!cleaned) return [];
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);
    if (end < cleaned.length) {
      const sentenceBreak = cleaned.lastIndexOf('. ', end);
      const newlineBreak = cleaned.lastIndexOf('\n', end);
      const bestBreak = Math.max(sentenceBreak, newlineBreak);
      if (bestBreak > start + Math.floor(chunkSize * 0.45)) {
        end = bestBreak + 1;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece.length > 0) chunks.push(piece);
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const va = a[i]!;
    const vb = b[i]!;
    dot += va * vb;
    normA += va * va;
    normB += vb * vb;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function extractTextFromUpload(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const lowerName = filename.toLowerCase();

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      const textRes = await parser.getText();
      return cleanExtractedText(textRes.text || '');
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    lowerName.endsWith('.docx')
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return cleanExtractedText(result.value || '');
  }

  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/csv' ||
    /\.(txt|md|csv|json|ts|py|log)$/i.test(lowerName)
  ) {
    return cleanExtractedText(buffer.toString('utf-8'));
  }

  throw new Error(`Unsupported document format (${mimeType}). Supported formats: PDF, DOCX, TXT, MD, CSV, JSON.`);
}

async function generateEmbedding(text: string): Promise<number[]> {
  const ai = createGenAIClient();
  const res = await ai.models.embedContent({
    model: MODELS.EMBEDDING,
    contents: text,
  });
  const values = res.embeddings?.[0]?.values;
  if (!values || values.length === 0) {
    throw new Error('Embedding service returned empty vector.');
  }
  return values;
}

async function summarizeText(filename: string, text: string): Promise<string> {
  const ai = createGenAIClient();
  const excerpt = text.slice(0, 8000);
  const res = await ai.models.generateContent({
    model: MODELS.ORCHESTRATOR,
    contents: `Provide a concise 2-3 sentence summary of the uploaded document "${filename}" based strictly on the following excerpt:\n\n${excerpt}`,
  });
  return (res.text ?? 'Document indexed and ready for semantic retrieval.').trim().slice(0, 1500);
}

class RagVectorStore {
  private documents: IndexedDocumentMeta[] = [];
  private chunks: DocumentChunk[] = [];
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(STORE_PATH)) {
        const parsed = JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as PersistedRagData;
        if (Array.isArray(parsed.documents)) this.documents = parsed.documents;
        if (Array.isArray(parsed.chunks)) this.chunks = parsed.chunks;
      }
    } catch {
      this.documents = [];
      this.chunks = [];
    }
  }

  private persist(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const data: PersistedRagData = {
        documents: this.documents,
        chunks: this.chunks,
      };
      fs.writeFileSync(STORE_PATH, JSON.stringify(data), 'utf-8');
    } catch (err) {
      telemetry.log({
        severity: 'WARNING',
        component: 'rag-store',
        event: 'persist_failed',
        metadata: { message: err instanceof Error ? err.message : 'unknown' },
      });
    }
  }

  listDocuments(userId: string): IndexedDocumentMeta[] {
    this.ensureLoaded();
    return this.documents.filter((d) => d.userId === userId);
  }

  getDocumentText(userId: string, filenameOrId: string): { meta: IndexedDocumentMeta; fullText: string } | null {
    this.ensureLoaded();
    const q = filenameOrId.toLowerCase();
    const doc = this.documents.find(
      (d) => d.userId === userId && (d.id === filenameOrId || d.filename.toLowerCase().includes(q)),
    );
    if (!doc) return null;
    const docChunks = this.chunks
      .filter((c) => c.userId === userId && c.documentId === doc.id)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
    return {
      meta: doc,
      fullText: docChunks.map((c) => c.text).join('\n\n'),
    };
  }

  async ingestDocument(params: {
    userId: string;
    documentId?: string;
    filename: string;
    mimeType: string;
    buffer: Buffer;
  }): Promise<IndexedDocumentMeta> {
    this.ensureLoaded();
    const start = Date.now();
    const docId = params.documentId || crypto.randomUUID();

    const extracted = await extractTextFromUpload(params.buffer, params.mimeType, params.filename);
    if (!extracted || extracted.length < 10) {
      throw new Error('Could not extract meaningful text from the uploaded document.');
    }

    const rawChunks = chunkText(extracted, 750, 120).slice(0, 60);
    const embeddedChunks: DocumentChunk[] = [];

    for (let idx = 0; idx < rawChunks.length; idx++) {
      const piece = rawChunks[idx]!;
      const embedding = await generateEmbedding(piece);
      embeddedChunks.push({
        id: `${docId}_c${idx}`,
        documentId: docId,
        userId: params.userId,
        filename: params.filename,
        chunkIndex: idx,
        text: piece,
        embedding,
      });
    }

    const summary = await summarizeText(params.filename, extracted);

    const meta: IndexedDocumentMeta = {
      id: docId,
      userId: params.userId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.buffer.length,
      chunkCount: embeddedChunks.length,
      status: 'indexed',
      summary,
      createdAt: new Date().toISOString(),
    };

    // Replace existing if same ID
    this.documents = this.documents.filter((d) => !(d.userId === params.userId && d.id === docId));
    this.chunks = this.chunks.filter((c) => !(c.userId === params.userId && c.documentId === docId));

    this.documents.unshift(meta);
    this.chunks.push(...embeddedChunks);
    this.persist();

    telemetry.recordTrace({
      sessionId: params.userId,
      kind: 'rag_retrieval',
      name: 'ingest_document',
      status: 'ok',
      latencyMs: Date.now() - start,
      detail: `Indexed ${embeddedChunks.length} chunks`,
    });

    return meta;
  }

  deleteDocument(userId: string, documentId: string): boolean {
    this.ensureLoaded();
    const before = this.documents.length;
    this.documents = this.documents.filter((d) => !(d.userId === userId && d.id === documentId));
    this.chunks = this.chunks.filter((c) => !(c.userId === userId && c.documentId === documentId));
    const removed = this.documents.length < before;
    if (removed) this.persist();
    return removed;
  }

  async retrieve(userId: string, query: string, topK = 5): Promise<RetrievedChunk[]> {
    this.ensureLoaded();
    const start = Date.now();
    const userChunks = this.chunks.filter((c) => c.userId === userId);
    if (userChunks.length === 0) return [];

    const queryVec = await generateEmbedding(query);
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);

    const scored: RetrievedChunk[] = userChunks.map((chunk) => {
      const semantic = cosineSimilarity(queryVec, chunk.embedding);
      const lowerText = chunk.text.toLowerCase();
      const lexicalHits = terms.reduce((acc, term) => (lowerText.includes(term) ? acc + 1 : acc), 0);
      const lexicalBoost = terms.length > 0 ? (lexicalHits / terms.length) * 0.15 : 0;
      return {
        documentId: chunk.documentId,
        filename: chunk.filename,
        chunkIndex: chunk.chunkIndex,
        text: chunk.text,
        score: Number((semantic + lexicalBoost).toFixed(4)),
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.filter((c) => c.score > 0.25).slice(0, topK);

    telemetry.recordRagRetrieval();
    telemetry.recordTrace({
      sessionId: userId,
      kind: 'rag_retrieval',
      name: 'vector_search',
      status: 'ok',
      latencyMs: Date.now() - start,
      detail: `Retrieved ${top.length} chunks`,
    });

    return top;
  }
}

export const ragStore = new RagVectorStore();
