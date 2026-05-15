import { loadPuter, formatPuterError } from './puterService';

const APP_ROOT = '/GoDam';

async function ensureAppRoot() {
  const puter = await loadPuter();
  try {
    await puter.fs.stat(APP_ROOT);
  } catch {
    await puter.fs.mkdir(APP_ROOT);
  }
}

function appPath(relativePath) {
  const clean = String(relativePath || '').replace(/^\/+/, '');
  return `${APP_ROOT}/${clean}`;
}

export async function writeFile(relativePath, content) {
  const puter = await loadPuter();
  await ensureAppRoot();
  try {
    return await puter.fs.write(appPath(relativePath), content);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function readFile(relativePath) {
  const puter = await loadPuter();
  try {
    const blob = await puter.fs.read(appPath(relativePath));
    return blob;
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function readFileAsText(relativePath) {
  const blob = await readFile(relativePath);
  if (blob instanceof Blob) return blob.text();
  return String(blob || '');
}

export async function readJSON(relativePath) {
  const text = await readFileAsText(relativePath);
  return JSON.parse(text);
}

export async function writeJSON(relativePath, data) {
  return writeFile(relativePath, JSON.stringify(data, null, 2));
}

export async function listFiles(relativePath = '') {
  const puter = await loadPuter();
  await ensureAppRoot();
  try {
    return await puter.fs.readdir(appPath(relativePath || ''));
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function deleteFile(relativePath) {
  const puter = await loadPuter();
  try {
    return await puter.fs.delete(appPath(relativePath));
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function createFolder(relativePath) {
  const puter = await loadPuter();
  await ensureAppRoot();
  try {
    return await puter.fs.mkdir(appPath(relativePath));
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function uploadFile(file, folderPath = 'uploads') {
  await ensureAppRoot();
  const targetDir = appPath(folderPath);
  const puter = await loadPuter();
  try {
    await puter.fs.mkdir(targetDir).catch(() => {});
    const filePath = `${targetDir}/${file.name}`;
    return await puter.fs.write(filePath, file);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function kvSet(key, value) {
  const puter = await loadPuter();
  try {
    return await puter.kv.set(key, value);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function kvGet(key) {
  const puter = await loadPuter();
  try {
    return await puter.kv.get(key);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function kvDel(key) {
  const puter = await loadPuter();
  try {
    return await puter.kv.del(key);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}

export async function kvList(pattern) {
  const puter = await loadPuter();
  try {
    return await puter.kv.list(pattern || true);
  } catch (e) {
    throw new Error(formatPuterError(e));
  }
}
