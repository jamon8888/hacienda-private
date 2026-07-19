// Shared contracts for the Xberg document-intelligence app.
// Authoritative source: docs/superpowers/specs/2026-07-15-document-intelligence-app-design.md
// The Node service and (later) the browser share these types. No engine logic here.

export type AuthScopes = "read" | "ingest" | "redact" | "admin";
export type AuthScope = AuthScopes;

export interface Matter {
  id: string;
  name: string;
  created_at: string;
}

export type FolderStatus = "pending" | "processing" | "done" | "error";

export interface Folder {
  id: string;
  matter_id: string;
  name: string;
  path?: string;
  status: FolderStatus;
  last_ingested_at?: string;
  document_count: number;
  pii_count: number;
}

export type IngestSource = "mcp" | "browser";

export interface Document {
  id: string;
  folder_id: string;
  matter_id: string;
  path: string;
  content_hash: string;
  status: FolderStatus;
  pages: number;
  chunk_count: number;
  pii_count: number;
  ingested_via: IngestSource;
  error_message?: string;
  created_at: string;
}

export interface PiiEntity {
  kind: string;
  start: number;
  end: number;
  text: string;
  ciphertext?: Uint8Array;
}

export type PiiReport = PiiEntity[];

export interface DocumentPiiEntity {
  id: string;
  document_id: string;
  kind: string;
  start: number;
  end: number;
  text: string;
  reviewed: boolean;
}

export interface BoundingBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RetrievedChunk {
  doc_id: string;
  chunk_index: number;
  text: string;
  page?: number;
  bbox?: BoundingBox;
  score: number;
  citation: string;
}

// --- Light metadata: consent ---

export interface ConsentRecord {
  id: string;
  subject: string;
  matter_id: string;
  scope: AuthScopes;
  granted_at: string;
  expires_at?: string;
}

export interface ConsentGrant {
  subject: string;
  matter_id: string;
  scope: AuthScopes;
  expires_at?: string;
}

export interface ConsentCheck {
  subject: string;
  matter_id: string;
  scope: AuthScopes;
  active: boolean;
}

// --- API request/response shapes (browser <-> Node) ---

export interface EmbedRequest {
  text: string;
}

export interface EmbedResponse {
  embedding: number[];
  model: string;
}

export interface NerRequest {
  text: string;
  labels?: string[];
}

export interface NerResponse {
  entities: PiiEntity[];
}

export interface RagMirrorRequest {
  matter_id: string;
  // Serialized EdgeVec index (redacted/tokenized chunk text + e5 vectors +
  // citations + encrypted curtain vault) uploaded by the browser.
  index_file_name: string;
}

export interface RagQueryRequest {
  matter_id: string;
  query: string;
  top_k?: number;
  user_id?: string;
}

export interface RagQueryResponse {
  chunks: RetrievedChunk[];
}

export interface AuthIssueRequest {
  user_id: string;
  scopes: AuthScopes[];
  matter_id?: string;
}

export interface AuthIssueResponse {
  token: string;
  scopes: AuthScopes[];
}

// --- Pinned model manifest (served by the Node model cache) ---

export interface ModelManifestEntry {
  name: string;
  url: string;
  file: string;
  sha256: string;
}

export interface ModelManifest {
  models: ModelManifestEntry[];
}
