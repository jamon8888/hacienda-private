import type { PiiEntity, RetrievedChunk } from "@xberg-io/core";

// Persists ingested-document results in the browser (IndexedDB) so the folder's document list
// and each document's extracted text/PII survive navigation and page reloads. Extracted text and
// PII values are the raw, pre-redaction originals — per the app's local-first design, that content
// never leaves the browser, so this cannot be mirrored to the Node service; IndexedDB (not the
// 5-10MB localStorage quota already used for the RAG index in wasm-pipeline) is sized for it.

export interface StoredDocument {
  doc_id: string;
  folder_id: string;
  name: string;
  text: string;
  pages: number;
  pii: PiiEntity[];
  chunks: RetrievedChunk[];
  created_at: string;
  // The original file bytes, kept for format-preserving viewers (DOCX/PDF/XLSX render the
  // actual file, not just its extracted text). Optional so documents saved before this field
  // existed still load fine — they fall back to the plain-text view.
  blob?: Blob;
  mimeType?: string;
}

const DB_NAME = "xberg-documents";
const STORE_NAME = "documents";
const FOLDER_INDEX = "by_folder";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "doc_id" });
        store.createIndex(FOLDER_INDEX, "folder_id");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDocument(doc: StoredDocument): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(doc);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function listDocuments(folderId: string): Promise<StoredDocument[]> {
  const db = await openDb();
  const docs = await new Promise<StoredDocument[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).index(FOLDER_INDEX).getAll(folderId);
    req.onsuccess = () => resolve(req.result as StoredDocument[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return docs.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function getDocument(docId: string): Promise<StoredDocument | null> {
  const db = await openDb();
  const doc = await new Promise<StoredDocument | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(docId);
    req.onsuccess = () => resolve((req.result as StoredDocument | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return doc;
}
