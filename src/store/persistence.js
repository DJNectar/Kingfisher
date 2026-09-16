/**
 * Saving and reopening the library file, and picking audio to inspect.
 *
 * THE CHROME / SAFARI SPLIT, and why the UI must say which one you are in:
 *
 * Chrome (and any Chromium on macOS) has the File System Access API. The app
 * can hold a handle to the file the user chose, write straight back to it, and
 * — because handles are structured-cloneable — remember it in IndexedDB so the
 * next launch offers "Reopen". Saving is a real save: same file, same place,
 * no Downloads folder, no duplicates. This works on a file in Dropbox or iCloud
 * Drive exactly as it works anywhere else, which is what makes cross-machine
 * use possible without a server.
 *
 * Safari has none of that. There is no handle, so there is no "save back to the
 * file I opened" — the only ways out are a download, and the only way in is an
 * upload. Two consequences the user MUST be told about rather than discovering:
 *   1. Saving produces a NEW file in Downloads. It does not update the file
 *      they opened. Keeping one library therefore means moving that file back
 *      over the old one themselves.
 *   2. Nothing is remembered between launches, so every session starts by
 *      opening the file again.
 * The app states this in the status bar and in Help, and never presents a
 * Safari download as though it had saved in place.
 *
 * WHY NOTHING IS AUTOSAVED. In Chrome the app could save on every change. It
 * deliberately does not: a library on a synced drive being rewritten constantly
 * is how sync services generate conflicted copies. Saving is an explicit act,
 * with unsaved changes shown plainly.
 */

export const FSA_AVAILABLE = typeof window !== 'undefined'
  && typeof window.showOpenFilePicker === 'function';

export const DIRECTORY_PICKER_AVAILABLE = typeof window !== 'undefined'
  && typeof window.showDirectoryPicker === 'function';

const HANDLE_KEY = 'library-handle';

import { idbGet, idbSet, idbDelete } from './idb.js';
import { listParsers } from '../core/registry.js';
import { serializeLibrary, parseLibrary, LIBRARY_FILE_EXTENSION } from './schema.js';

/** What this browser can actually do, for the UI to display honestly. */
export function capabilities() {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  const isSafari = /^((?!chrome|android|crios|fxios).)*safari/i.test(ua);
  return {
    fileSystemAccess: FSA_AVAILABLE,
    directoryPicker: DIRECTORY_PICKER_AVAILABLE,
    browser: FSA_AVAILABLE ? 'chromium' : isSafari ? 'safari' : 'other',
    /** True when a save writes back to the file the user opened. */
    savesInPlace: FSA_AVAILABLE,
  };
}

const LIBRARY_PICKER_TYPES = [
  {
    description: 'Kingfisher library',
    accept: { 'application/json': ['.json'] },
  },
];

// ------------------------------------------------------------- open library

/**
 * @returns {Promise<{library, handle, fileName, source}|null>} null if cancelled
 */
export async function openLibrary() {
  if (FSA_AVAILABLE) {
    let handle;
    try {
      [handle] = await window.showOpenFilePicker({
        types: LIBRARY_PICKER_TYPES,
        multiple: false,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
    const file = await handle.getFile();
    const library = parseLibrary(await file.text());
    await rememberHandle(handle);
    return { library, handle, fileName: file.name, source: 'file-system-access' };
  }

  // Safari path: a plain file input. No handle exists, so saving later cannot
  // write back here — the caller surfaces that.
  const file = await pickFileWithInput('.json,application/json');
  if (!file) return null;
  const library = parseLibrary(await file.text());
  return { library, handle: null, fileName: file.name, source: 'upload' };
}

/** Reopen the remembered file, if the browser still grants access. */
export async function reopenRememberedLibrary({ prompt = false } = {}) {
  if (!FSA_AVAILABLE) return null;
  const handle = await idbGet(HANDLE_KEY);
  if (!handle) return null;

  const mode = { mode: 'readwrite' };
  let permission = await handle.queryPermission?.(mode);
  if (permission !== 'granted') {
    if (!prompt) return { needsPermission: true, handle, fileName: handle.name };
    // requestPermission must be called from a user gesture, hence the flag.
    permission = await handle.requestPermission?.(mode);
    if (permission !== 'granted') return { needsPermission: true, handle, fileName: handle.name };
  }

  try {
    const file = await handle.getFile();
    const library = parseLibrary(await file.text());
    return { library, handle, fileName: file.name, source: 'file-system-access' };
  } catch (err) {
    // The file may have been moved, renamed or deleted since last time.
    await forgetHandle();
    throw new Error(
      `The library that was open last time (${handle.name}) could not be reopened: ${err.message}. Use "Open library…" to find it.`,
    );
  }
}

export async function rememberedLibraryName() {
  const handle = await idbGet(HANDLE_KEY);
  return handle?.name ?? null;
}

async function rememberHandle(handle) {
  await idbSet(HANDLE_KEY, handle);
}

export async function forgetHandle() {
  await idbDelete(HANDLE_KEY);
}

// ------------------------------------------------------------- save library

/**
 * Save to the handle we already hold. Chrome only.
 * @returns {Promise<{saved:true, fileName:string}>}
 */
export async function saveLibraryToHandle(library, handle) {
  if (!handle) throw new Error('No file is open to save to.');
  const permission = await handle.requestPermission?.({ mode: 'readwrite' });
  if (permission && permission !== 'granted') {
    throw new Error('Permission to write to that file was declined, so nothing was saved.');
  }
  // createWritable() writes to a swap file and only replaces the original on
  // close(), so an interrupted save cannot leave a half-written library.
  const writable = await handle.createWritable();
  try {
    await writable.write(serializeLibrary(library));
  } finally {
    await writable.close();
  }
  return { saved: true, fileName: handle.name };
}

/** "Save as…" — Chrome gets a real picker, Safari gets a download. */
export async function saveLibraryAs(library, suggestedName = `library${LIBRARY_FILE_EXTENSION}`) {
  if (FSA_AVAILABLE) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: LIBRARY_PICKER_TYPES,
      });
    } catch (err) {
      if (err?.name === 'AbortError') return null;
      throw err;
    }
    await saveLibraryToHandle(library, handle);
    await rememberHandle(handle);
    return { handle, fileName: handle.name, source: 'file-system-access' };
  }

  downloadText(serializeLibrary(library), suggestedName, 'application/json');
  return { handle: null, fileName: suggestedName, source: 'download' };
}

// ------------------------------------------------------------- audio input

/**
 * Pick a single audio file. Returns [{file, path}] for symmetry with folders.
 */
export async function pickAudioFiles() {
  if (FSA_AVAILABLE) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [
          {
            description: 'Audio files',
            accept: { 'audio/*': AUDIO_EXTENSIONS },
          },
        ],
      });
    } catch (err) {
      if (err?.name === 'AbortError') return [];
      throw err;
    }
    return Promise.all(
      handles.map(async (h) => ({ file: await h.getFile(), path: h.name })),
    );
  }

  const files = await pickFilesWithInput(`${AUDIO_EXTENSIONS.join(',')},audio/*`);
  return files.map((f) => ({ file: f, path: f.name }));
}

/**
 * Pick a folder and walk it.
 *
 * Chrome: showDirectoryPicker, recursing through subfolders.
 * Safari: <input webkitdirectory>, which yields the same files with relative
 * paths but requires the user to confirm an upload-style prompt.
 */
export async function pickAudioFolder({ recursive = true, onProgress } = {}) {
  if (DIRECTORY_PICKER_AVAILABLE) {
    let dir;
    try {
      dir = await window.showDirectoryPicker();
    } catch (err) {
      if (err?.name === 'AbortError') return { folderName: null, files: [] };
      throw err;
    }
    const files = [];
    await walkDirectory(dir, dir.name, files, recursive, onProgress);
    return { folderName: dir.name, files };
  }

  const files = await pickFilesWithInput(null, { directory: true });
  return {
    folderName: files[0]?.webkitRelativePath?.split('/')[0] ?? null,
    files: files.map((f) => ({ file: f, path: f.webkitRelativePath || f.name })),
  };
}

async function walkDirectory(dir, prefix, out, recursive, onProgress) {
  for await (const entry of dir.values()) {
    const path = `${prefix}/${entry.name}`;
    if (entry.kind === 'file') {
      out.push({ file: await entry.getFile(), path });
      onProgress?.(out.length, path);
    } else if (entry.kind === 'directory' && recursive) {
      await walkDirectory(entry, path, out, recursive, onProgress);
    }
  }
}

/**
 * Extensions offered in file pickers and accepted during a folder scan.
 *
 * Derived from the registered parsers rather than written out again here, so
 * adding a format cannot leave folder scanning silently skipping it.
 *
 * Note this is only a filter for bulk input — identification is still by magic
 * number, so a mislabelled file is read correctly once it gets through.
 */
export const AUDIO_EXTENSIONS = [...new Set(listParsers().flatMap((p) => p.extensions))];

export function looksLikeAudio(name) {
  const lower = String(name).toLowerCase();
  return AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// ---------------------------------------------------------------- fallbacks

function pickFileWithInput(accept) {
  return pickFilesWithInput(accept).then((files) => files[0] ?? null);
}

/**
 * The Safari path. An <input> only fires 'change' when something is chosen, and
 * fires nothing at all on cancel, so the promise would hang forever; 'cancel'
 * (supported in Safari 16.4+) and a focus fallback resolve it either way.
 */
function pickFilesWithInput(accept, { directory = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    if (directory) {
      input.webkitdirectory = true;
      input.multiple = true;
    } else {
      input.multiple = true;
    }
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    document.body.appendChild(input);

    let settled = false;
    const done = (files) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };

    input.addEventListener('change', () => done([...input.files]));
    input.addEventListener('cancel', () => done([]));
    // Older Safari has no 'cancel' event: if the window regains focus and
    // nothing was chosen, treat it as a cancellation.
    window.addEventListener(
      'focus',
      () => setTimeout(() => done([...(input.files ?? [])]), 500),
      { once: true },
    );

    input.click();
  });
}

/** Trigger a download. The only way to write a file in Safari. */
export function downloadText(content, fileName, mime = 'text/plain') {
  downloadBlob(new Blob([content], { type: `${mime};charset=utf-8` }), fileName);
}

export function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke late: Safari has been known to cancel an in-flight download if the
  // object URL disappears too soon.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and a user gesture; fall back to the
    // old execCommand path so file:// and odd cases still work.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
