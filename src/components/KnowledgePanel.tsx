import { useRef, useState } from 'react';
import { FileText, Search, Trash2, UploadCloud } from 'lucide-react';
import type { RagDocument } from '../types/nexora';

interface KnowledgePanelProps {
  documents: RagDocument[];
  guestId: string;
  getAuthToken: () => Promise<string | null>;
  onUploadComplete: (doc: RagDocument) => Promise<void>;
  onDeleteDocument: (docId: string) => Promise<void>;
}

interface SearchHit {
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  score: number;
}

export function KnowledgePanel({
  documents,
  guestId,
  getAuthToken,
  onUploadComplete,
  onDeleteDocument,
}: KnowledgePanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<SearchHit[]>([]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const token = await getAuthToken();
      const res = await fetch('/api/rag/upload', {
        method: 'POST',
        headers: {
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: formData,
      });
      const data = (await res.json()) as { document?: RagDocument; error?: string };
      if (!res.ok || !data.document) {
        throw new Error(data.error || 'Document ingestion failed.');
      }
      await onUploadComplete(data.document);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleVectorSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchQuery.trim() || searching) return;
    setSearching(true);
    try {
      const token = await getAuthToken();
      const res = await fetch('/api/rag/query', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-nexora-guest-id': guestId,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query: searchQuery.trim(), topK: 5 }),
      });
      const data = (await res.json()) as { chunks?: SearchHit[] };
      setHits(data.chunks ?? []);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-6 py-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <header className="space-y-2">
          <h1 className="font-display text-2xl font-semibold text-slate-100">RAG Knowledge Intelligence</h1>
          <p className="text-sm text-slate-400">
            Upload PDF, DOCX, TXT, Markdown, CSV, or JSON files. Nexora extracts text, generates overlapping chunks, embeds them with Gemini Embedding 2, and attributes every retrieved passage.
          </p>
        </header>

        {/* Upload Drop Zone */}
        <div className="bg-[#11141B] border border-dashed border-white/20 rounded-xl p-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-lg bg-blue-500/12 border border-blue-500/25 flex items-center justify-center shrink-0">
              <UploadCloud className="w-5 h-5 text-blue-400" />
            </div>
            <div>
              <p className="text-sm font-medium text-slate-100">Ingest a Document (Max 10 MB)</p>
              <p className="text-xs text-slate-400 mt-0.5">
                Supported formats: .pdf, .docx, .txt, .md, .csv, .json
              </p>
            </div>
          </div>
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.txt,.md,.csv,.json"
              onChange={(e) => void handleFileChange(e)}
              className="hidden"
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="min-h-[42px] px-4 py-2 text-sm font-medium bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-50 text-white rounded-lg transition-colors whitespace-nowrap"
            >
              {uploading ? 'Indexing & Embedding...' : 'Upload Document'}
            </button>
          </div>
        </div>

        {uploadError && (
          <div className="px-4 py-3 bg-rose-950/40 border border-rose-500/30 rounded-lg text-sm text-rose-200">
            {uploadError}
          </div>
        )}

        {/* Indexed Document Library */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-display text-base font-semibold text-slate-200">Document Library</h2>
            <span className="text-xs font-mono tabular-nums text-slate-400">{documents.length} indexed</span>
          </div>

          {documents.length === 0 ? (
            <div className="bg-[#11141B] border border-white/8 rounded-xl p-8 text-center space-y-2">
              <p className="text-sm font-medium text-slate-300">No documents indexed yet</p>
              <p className="text-xs text-slate-500">
                Upload a PDF, DOCX, or TXT file to enable grounded semantic retrieval during voice and text conversations.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/8 bg-[#11141B] border border-white/8 rounded-xl overflow-hidden">
              {documents.map((d) => (
                <div key={d.id} className="p-4 sm:p-5 flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <FileText className="w-4 h-4 text-blue-400 mt-1 shrink-0" />
                    <div className="space-y-1 min-w-0">
                      <p className="text-sm font-medium text-slate-100 truncate">{d.filename}</p>
                      <p className="text-xs text-slate-400 leading-relaxed">{d.summary}</p>
                      <p className="text-xs font-mono tabular-nums text-slate-500">
                        {d.chunkCount} chunks · {(d.sizeBytes / 1024).toFixed(1)} KB · status {d.status}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onDeleteDocument(d.id)}
                    aria-label={`Delete ${d.filename}`}
                    className="p-2 text-slate-400 hover:text-rose-400 hover:bg-white/5 rounded-lg transition-colors shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Semantic Vector Retrieval Tester */}
        <section className="bg-[#11141B] border border-white/8 rounded-xl p-5 space-y-4">
          <h2 className="font-display text-base font-semibold text-slate-200">Test Semantic Vector Search</h2>
          <form onSubmit={(e) => void handleVectorSearch(e)} className="flex gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Query your uploaded documents semantically..."
              className="flex-1 min-h-[42px] px-3.5 py-2 text-sm bg-[#090B10] text-slate-100 placeholder:text-slate-500 border border-white/10 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#3B82F6]"
            />
            <button
              type="submit"
              disabled={!searchQuery.trim() || searching}
              className="min-h-[42px] inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-white/10 hover:bg-white/15 disabled:opacity-40 text-slate-100 rounded-lg transition-colors whitespace-nowrap"
            >
              <Search className="w-4 h-4" />
              {searching ? 'Searching...' : 'Retrieve'}
            </button>
          </form>

          {hits.length > 0 && (
            <div className="space-y-2.5 pt-2">
              {hits.map((h) => (
                <div
                  key={`${h.documentId}_${h.chunkIndex}`}
                  className="p-3.5 bg-[#090B10] border border-white/8 rounded-lg space-y-1.5"
                >
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums text-blue-300">
                    <span>
                      {h.filename} · chunk #{h.chunkIndex}
                    </span>
                    <span>similarity {h.score.toFixed(3)}</span>
                  </div>
                  <p className="text-xs text-slate-300 leading-relaxed">{h.text}</p>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
