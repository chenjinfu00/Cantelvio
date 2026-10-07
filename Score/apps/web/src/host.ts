/**
 * Where the editor runs. Locally (npm run dev / preview) everything is available. GitHub Pages
 * serves the editor without an AI backend. In a claude.ai artifact the page runs in a
 * locked-down frame: downloads go through the viewer's
 * `downloads` capability, printing is unavailable and calls to a server on this computer
 * (the Cantelvio adapter) are blocked. Feature code asks this module instead of guessing.
 */

interface ClaudeHost {
  use(name: string): Promise<unknown>;
}

declare global {
  interface Window {
    claude?: ClaudeHost;
  }
}

/** The viewer's `downloads` namespace (runtime contract 0.2.x). */
export interface DownloadsCapability {
  save(request: {
    filename: string;
    data: string | Blob;
  }): Promise<{ status: 'saved' | 'delivered' }>;
}

/** True inside a claude.ai artifact viewer (or the platform's top-level artifact host). */
export const IN_ARTIFACT =
  typeof window !== 'undefined' && typeof window.claude?.use === 'function';

/** Pages builds also set this flag so a custom domain keeps the same static-only behavior. */
export const IN_STATIC_PREVIEW =
  import.meta.env.VITE_STATIC_PREVIEW === 'true' ||
  (typeof window !== 'undefined' && /(^|\.)github\.io$/i.test(window.location.hostname));

/** A published static editor never probes or uploads files to a visitor's local machine. */
export const LOCAL_SERVICE_UNAVAILABLE = IN_ARTIFACT || IN_STATIC_PREVIEW;

let downloads: Promise<DownloadsCapability | null> | null = null;

/** The viewer's downloads capability, or null (local run, or not granted in this view). */
export function artifactDownloads(): Promise<DownloadsCapability | null> {
  if (!IN_ARTIFACT) return Promise.resolve(null);
  downloads ??= window
    .claude!.use('downloads')
    .then((d) => (d as DownloadsCapability | null) ?? null)
    .catch(() => null);
  return downloads;
}
