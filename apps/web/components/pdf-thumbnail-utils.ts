import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models"

// services/mcp-server serves the pdfium WASM binary from its own node_modules copy at this
// route (static.ts's resolveEmbedPdfiumDir) — never jsdelivr's CDN, which would silently phone
// home on every PDF view despite this being a "no document content leaves the device" app (see
// docs/superpowers/specs/2026-07-15-document-intelligence-app-design.md §9). Relative to the
// page's own origin, same reasoning as wasm-pipeline's API_BASE: the Node service always serves
// the UI and its vendored assets from the same origin the page was loaded from.
const PDFIUM_WASM_URL =
  (typeof window !== "undefined" ? window.location.origin : "") + "/vendor/embedpdf/pdfium.wasm"

let sharedEnginePromise: Promise<PdfEngine> | null = null
const pdfDocumentCache = new Map<string, Promise<PdfDocumentObject>>()
const thumbnailUrlCache = new Map<string, Promise<string | null>>()

export function loadSharedPdfEngine() {
  sharedEnginePromise ??= import("@embedpdf/engines/pdfium-worker-engine").then(
    ({ createPdfiumEngine }) =>
      createPdfiumEngine(PDFIUM_WASM_URL, {
        // Left unset, PDFium requests missing CJK/Arabic/Hebrew glyphs from jsdelivr's CDN —
        // the same egress this app can't allow (see PDFIUM_WASM_URL above). Disabling means a
        // PDF using an unembedded non-Latin font may render that text with tofu/boxes instead
        // of silently phoning home; embedded fonts (the common case) are unaffected.
        fontFallback: null,
      })
  )

  return sharedEnginePromise
}

export async function loadPdfDocument(url: string) {
  let documentPromise = pdfDocumentCache.get(url)

  if (!documentPromise) {
    documentPromise = loadSharedPdfEngine().then((engine) =>
      engine
        .openDocumentUrl(
          { id: url, url },
          { mode: url.startsWith("blob:") ? "full-fetch" : "auto" }
        )
        .toPromise()
    )
    pdfDocumentCache.set(url, documentPromise)
  }

  return documentPromise
}

export async function getPdfPageCount(url: string) {
  return (await loadPdfDocument(url)).pageCount
}

export function renderPdfThumbnailUrl({
  dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  pageIndex,
  url,
  width,
}: {
  dpr?: number
  pageIndex: number
  url: string
  width: number
}) {
  const cacheKey = `${url}#${pageIndex}@${width}x${dpr}`
  let thumbnailPromise = thumbnailUrlCache.get(cacheKey)

  if (!thumbnailPromise) {
    thumbnailPromise = (async () => {
      const [engine, document] = await Promise.all([
        loadSharedPdfEngine(),
        loadPdfDocument(url),
      ])
      const page = document.pages[pageIndex]

      if (!page) return null

      const blob = await engine
        .renderThumbnail(document, page, {
          dpr,
          imageType: "image/png",
          scaleFactor: width / page.size.width,
          withAnnotations: true,
        })
        .toPromise()

      return URL.createObjectURL(blob)
    })()
    thumbnailUrlCache.set(cacheKey, thumbnailPromise)
  }

  return thumbnailPromise
}
