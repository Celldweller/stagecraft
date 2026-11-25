/**
 * Recursive folder scan on top of an injected `browse` function (FilePicker.browse at runtime).
 *
 * No Foundry globals in here, so the traversal is testable with a fake file system.
 */
import { isImagePath } from "./filenames.mjs";

/** Defaults that bound a scan, so a misconfigured root cannot run away. */
export const SCAN_LIMITS = Object.freeze({
  maxDepth: 12,
  maxFiles: 20000,
  maxDirs: 5000,
  concurrency: 4
});

/**
 * @callback BrowseFunction
 * @param {string} source   Storage source, e.g. "data" or "forgevtt".
 * @param {string} target   Folder within the source.
 * @param {{extensions?: string[]}} [options]
 * @returns {Promise<{dirs: string[], files: string[]}>}
 */

/**
 * @typedef {object} ScanResult
 * @property {string[]} files       Image paths as delivered by `browse`, sorted, without duplicates.
 * @property {number} dirsVisited   Number of folders browsed successfully.
 * @property {{dir: string, message: string}[]} errors  Folders that could not be browsed; the scan continues.
 * @property {boolean} truncated    True if a limit stopped the scan early.
 */

/**
 * Scan `root` and all its subfolders for images. Folders are browsed with bounded concurrency;
 * every folder is visited at most once, which also guards against symlink loops.
 * @param {object} options
 * @param {BrowseFunction} options.browse
 * @param {string} options.source
 * @param {string} options.root
 * @param {Iterable<string>} options.extensions  Image extensions without dot.
 * @param {Partial<typeof SCAN_LIMITS>} [options.limits]
 * @param {(progress: {dirsVisited: number, files: number}) => void} [options.onProgress]
 * @returns {Promise<ScanResult>}
 */
export async function scanFolder({browse, source, root, extensions, limits = {}, onProgress}) {
  const {maxDepth, maxFiles, maxDirs, concurrency} = {...SCAN_LIMITS, ...limits};
  const allowed = [...extensions];
  const dotted = allowed.map(e => `.${String(e).toLowerCase()}`);

  const files = new Set();
  const errors = [];
  const visited = new Set();
  /** @type {{dir: string, depth: number}[]} */
  const queue = [{dir: stripSlash(root), depth: 0}];
  let dirsVisited = 0;
  let truncated = false;

  const visit = async ({dir, depth}) => {
    let result;
    try {
      result = await browse(source, dir, {extensions: dotted});
    } catch ( err ) {
      errors.push({dir, message: String(err?.message ?? err)});
      return;
    }
    dirsVisited++;
    for ( const file of result?.files ?? [] ) {
      if ( !isImagePath(file, allowed) ) continue;
      if ( files.size >= maxFiles ) {
        truncated = true;
        break;
      }
      files.add(file);
    }
    for ( const sub of result?.dirs ?? [] ) {
      const key = stripSlash(sub);
      if ( visited.has(key) ) continue;
      if ( depth + 1 > maxDepth || visited.size >= maxDirs ) {
        truncated = true;
        continue;
      }
      visited.add(key);
      queue.push({dir: key, depth: depth + 1});
    }
    onProgress?.({dirsVisited, files: files.size});
  };

  visited.add(queue[0].dir);
  while ( queue.length ) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(visit));
  }

  return {files: [...files].sort(), dirsVisited, errors, truncated};
}

/**
 * @param {string} path
 * @returns {string}
 */
function stripSlash(path) {
  return String(path).replace(/\/+$/, "");
}
