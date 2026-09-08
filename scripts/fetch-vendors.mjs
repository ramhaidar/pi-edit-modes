#!/usr/bin/env node
// Fetches upstream repos as GitHub branch archive zips (no git clone), extracts
// them into vendor/, deletes the zips, and records the downloaded commit SHA in
// vendor/.state.json so repeated runs skip repos whose upstream SHA is unchanged.
//
// Usage:
//   node scripts/fetch-vendors.mjs          # download/update as needed
//   node scripts/fetch-vendors.mjs --force  # re-download even if SHA matches

import { createWriteStream, readFileSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const STATE_FILE = path.join(VENDOR_DIR, '.state.json');

const REPOS = [
  { owner: 'openai', repo: 'codex', branch: 'main', dir: 'codex' },
  { owner: 'google-gemini', repo: 'gemini-cli', branch: 'main', dir: 'gemini-cli' },
  { owner: 'deepseek-ai', repo: 'deepseek-harness', branch: 'master', dir: 'deepseek-harness' },
];

const FORCE = process.argv.includes('--force');
const USER_AGENT = 'pi-edit-modes-vendor-fetch';

const log = (msg) => console.log(`[fetch-vendors] ${msg}`);

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
    redirect: 'follow',
  });
  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(`GET ${url} -> 403 (GitHub API rate limit? Try again later)`);
    }
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function latestBranchSha({ owner, repo, branch }) {
  const commit = await fetchJson(
    `https://api.github.com/repos/${owner}/${repo}/commits/${branch}`,
  );
  return commit.sha;
}

async function downloadZip({ owner, repo, branch }, dest) {
  const url = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// --- Minimal zip reader (methods: 0 store, 8 deflate), zip-slip safe. ---

async function unzip(zipPath, outDir) {
  const buf = readFileSync(zipPath);

  // Locate the End Of Central Directory record (scan back over any comment).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${zipPath}: not a valid zip file (no EOCD)`);

  const entryCount = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`${zipPath}: corrupt central directory`);
    }
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    // The local header's own name/extra lengths decide where data starts
    // (the central-directory extra field may differ in size).
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`${zipPath}: bad local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    const isDir = name.endsWith('/');
    const abs = path.resolve(outDir, name);
    if (abs !== outDir && !abs.startsWith(outDir + path.sep)) {
      throw new Error(`${zipPath}: refusing unsafe zip entry ${name}`);
    }

    if (isDir) {
      await mkdir(abs, { recursive: true });
      continue;
    }

    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    if (method === 0) {
      data = raw;
    } else if (method === 8) {
      data = inflateRawSync(raw);
    } else {
      throw new Error(`${zipPath}: unsupported compression method ${method} for ${name}`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
  }
}

async function dirExistsAndNonEmpty(dir) {
  try {
    return (await readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { repos: {} };
  }
}

async function writeState(state) {
  await mkdir(VENDOR_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(state, null, 2) + '\n');
  await rename(tmp, STATE_FILE);
}

async function fetchRepo(repo, state) {
  const label = `${repo.owner}/${repo.repo}`;
  const target = path.join(VENDOR_DIR, repo.dir);
  const known = state.repos[repo.dir];

  const sha = await latestBranchSha(repo);

  if (
    !FORCE &&
    known?.sha === sha &&
    (await dirExistsAndNonEmpty(target))
  ) {
    log(`${label}: up to date at ${sha.slice(0, 12)} — skipping`);
    return;
  }

  const action = known?.sha
    ? `updating ${known.sha.slice(0, 12)} -> ${sha.slice(0, 12)}`
    : `downloading ${sha.slice(0, 12)}`;
  log(`${label}: ${action}`);

  await mkdir(VENDOR_DIR, { recursive: true });
  const zipPath = path.join(VENDOR_DIR, `${repo.dir}.zip`);
  await downloadZip(repo, zipPath);

  // Extract into a staging dir so the swap into place is a single rename.
  const staging = await mkdtemp(path.join(VENDOR_DIR, `.${repo.dir}.staging-`));
  try {
    await unzip(zipPath, staging);
    const entries = await readdir(staging);
    if (entries.length !== 1) {
      throw new Error(`${label}: expected one top-level dir in zip, got ${entries.join(', ')}`);
    }
    await rm(target, { recursive: true, force: true });
    await rename(path.join(staging, entries[0]), target);
  } finally {
    await rm(staging, { recursive: true, force: true });
    await rm(zipPath, { force: true });
  }

  state.repos[repo.dir] = {
    sha,
    branch: repo.branch,
    updatedAt: new Date().toISOString(),
  };
  await writeState(state);
  log(`${label}: extracted to vendor/${repo.dir}, zip deleted, state saved`);
}

async function main() {
  const state = await readState();
  state.repos ??= {};
  let failures = 0;

  for (const repo of REPOS) {
    try {
      await fetchRepo(repo, state);
    } catch (err) {
      failures++;
      log(`ERROR ${repo.owner}/${repo.repo}: ${err.message}`);
    }
  }

  if (failures > 0) {
    process.exitCode = 1;
  }
}

await main();
