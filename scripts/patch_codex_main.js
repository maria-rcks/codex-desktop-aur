#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function usage() {
  console.error('Usage: patch_codex_main.js <asar-extract-dir | path-to-main.js>');
  process.exit(2);
}

function countMatches(source, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  let count = 0;
  while (re.exec(source) !== null) {
    count += 1;
  }
  return count;
}

function patchSingle({ source, label, oldRegex, newRegex, replacer }) {
  const oldCount = countMatches(source, oldRegex);
  const newCount = countMatches(source, newRegex);

  if (oldCount === 1) {
    const patched = source.replace(oldRegex, replacer);
    return { source: patched, status: 'patched', label };
  }

  if (oldCount === 0 && newCount >= 1) {
    return { source, status: 'already', label };
  }

  if (oldCount > 1) {
    throw new Error(
      `${label}: expected exactly one old match, found ${oldCount} (refusing ambiguous patch)`
    );
  }

  throw new Error(`${label}: did not find patchable pattern`);
}

function listDirectoryJsFiles(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    return [];
  }

  return fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.js'))
    .map(entry => path.join(dirPath, entry.name));
}

function walkJsFiles(rootDir) {
  const files = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'webview') {
          continue;
        }
        stack.push(entryPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.js')) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function formatMatchLocations(matches, baseDir) {
  return matches
    .map(({ filePath, count }) => {
      const displayPath = baseDir ? path.relative(baseDir, filePath) : filePath;
      return `${displayPath} (${count})`;
    })
    .join(', ');
}

function createFileRegistry({ searchRootDir, entryJsPath }) {
  const sources = new Map();
  const originalSources = new Map();
  let expanded = false;

  function loadFile(filePath) {
    const resolvedFilePath = path.resolve(filePath);
    if (sources.has(resolvedFilePath)) {
      return;
    }

    const source = fs.readFileSync(resolvedFilePath, 'utf8');
    sources.set(resolvedFilePath, source);
    originalSources.set(resolvedFilePath, source);
  }

  function loadFiles(filePaths) {
    for (const filePath of filePaths) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile() && filePath.endsWith('.js')) {
        loadFile(filePath);
      }
    }
  }

  function expandSearch() {
    if (expanded || !searchRootDir) {
      return;
    }

    expanded = true;
    loadFiles(walkJsFiles(searchRootDir));
  }

  const initialCandidates = new Set();
  initialCandidates.add(entryJsPath);

  const entryDir = path.dirname(entryJsPath);
  for (const filePath of listDirectoryJsFiles(entryDir)) {
    initialCandidates.add(filePath);
  }

  if (searchRootDir && entryDir !== searchRootDir) {
    for (const filePath of listDirectoryJsFiles(searchRootDir)) {
      initialCandidates.add(filePath);
    }
  }

  loadFiles([...initialCandidates]);

  return {
    expandSearch,
    getSource(filePath) {
      return sources.get(filePath);
    },
    setSource(filePath, source) {
      sources.set(filePath, source);
    },
    listMatches(regex) {
      const matches = [];

      for (const [filePath, source] of sources) {
        const count = countMatches(source, regex);
        if (count > 0) {
          matches.push({ filePath, count });
        }
      }

      return matches;
    },
    writeChangedFiles() {
      for (const [filePath, source] of sources) {
        if (source !== originalSources.get(filePath)) {
          fs.writeFileSync(filePath, source, 'utf8');
        }
      }
    }
  };
}

function runBestEffortPatch(runPatch, label) {
  try {
    return runPatch();
  } catch (error) {
    return {
      status: 'warning',
      label,
      warning: error instanceof Error ? error.message : String(error),
      filePath: null
    };
  }
}

function patchSingleInRegistry({ registry, searchRootDir, label, oldRegex, newRegex, replacer }) {
  let oldMatches = registry.listMatches(oldRegex);
  let newMatches = registry.listMatches(newRegex);

  if (oldMatches.length === 0 && newMatches.length === 0) {
    registry.expandSearch();
    oldMatches = registry.listMatches(oldRegex);
    newMatches = registry.listMatches(newRegex);
  }

  const oldMatchCount = oldMatches.reduce((sum, match) => sum + match.count, 0);
  const newMatchCount = newMatches.reduce((sum, match) => sum + match.count, 0);

  if (oldMatchCount > 1) {
    throw new Error(
      `${label}: expected exactly one old match, found ${oldMatchCount} across ${formatMatchLocations(oldMatches, searchRootDir)}`
    );
  }

  if (oldMatchCount === 0) {
    if (newMatchCount >= 1) {
      return { status: 'already', label, filePath: newMatches[0]?.filePath ?? null };
    }

    throw new Error(`${label}: did not find patchable pattern`);
  }

  const targetFilePath = oldMatches[0].filePath;
  const result = patchSingle({
    source: registry.getSource(targetFilePath),
    label,
    oldRegex,
    newRegex,
    replacer
  });

  registry.setSource(targetFilePath, result.source);
  return { status: result.status, label, filePath: targetFilePath };
}

function findMatchingBrace(source, openIndex) {
  if (source[openIndex] !== '{') {
    throw new Error(`Expected '{' at index ${openIndex}`);
  }

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];

    if (quote !== null) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === quote) {
        quote = null;
      }

      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch;
      continue;
    }

    if (ch === '{') {
      depth += 1;
      continue;
    }

    if (ch === '}') {
      depth -= 1;

      if (depth === 0) {
        return i;
      }
    }
  }

  throw new Error(`Unterminated brace block starting at index ${openIndex}`);
}

function patchZedLinuxPlatform(source) {
  const label = 'Linux open-target platform support';
  const matches = Array.from(source.matchAll(/id:(["'`])zed\1,platforms:\{/g));

  if (matches.length > 1) {
    throw new Error(
      `${label}: expected exactly one zed target definition, found ${matches.length}`
    );
  }

  if (matches.length === 0) {
    throw new Error(`${label}: did not find zed target definition`);
  }

  const match = matches[0];
  const platformsOpenIndex = match.index + match[0].length - 1;
  const platformsCloseIndex = findMatchingBrace(source, platformsOpenIndex);
  const platformsBody = source.slice(platformsOpenIndex + 1, platformsCloseIndex);

  if (/\blinux\s*:/.test(platformsBody)) {
    return { source, status: 'already', label };
  }

  if (!/\bdarwin\s*:\s*\{/.test(platformsBody)) {
    throw new Error(`${label}: did not find patchable darwin platform entry`);
  }

  const patchedPlatformsBody = platformsBody.replace(/\bdarwin\s*:\s*\{/, 'linux:{');
  const patchedSource =
    source.slice(0, platformsOpenIndex + 1) +
    patchedPlatformsBody +
    source.slice(platformsCloseIndex);

  return { source: patchedSource, status: 'patched', label };
}

function patchZedLinuxPlatformInRegistry({ registry, searchRootDir }) {
  const label = 'Linux open-target platform support';
  let matches = registry.listMatches(/id:(["'`])zed\1,platforms:\{/g);

  if (matches.length === 0) {
    registry.expandSearch();
    matches = registry.listMatches(/id:(["'`])zed\1,platforms:\{/g);
  }

  const matchCount = matches.reduce((sum, match) => sum + match.count, 0);
  if (matchCount > 1) {
    throw new Error(
      `${label}: expected exactly one zed target definition, found ${matchCount} across ${formatMatchLocations(matches, searchRootDir)}`
    );
  }

  if (matchCount === 0) {
    throw new Error(`${label}: did not find zed target definition`);
  }

  const targetFilePath = matches[0].filePath;
  const result = patchZedLinuxPlatform(registry.getSource(targetFilePath));
  registry.setSource(targetFilePath, result.source);
  return { status: result.status, label: result.label, filePath: targetFilePath };
}

const inputPath = process.argv[2];
if (!inputPath) {
  usage();
}

const resolvedInputPath = path.resolve(inputPath);
let searchRootDir = path.dirname(resolvedInputPath);
let resolvedEntryJsPath = resolvedInputPath;

if (fs.existsSync(resolvedInputPath) && fs.statSync(resolvedInputPath).isDirectory()) {
  const packageJsonPath = path.join(resolvedInputPath, 'package.json');
  if (!fs.existsSync(packageJsonPath)) {
    throw new Error(`package.json not found in extracted asar root: ${resolvedInputPath}`);
  }

  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  if (typeof pkg.main !== 'string' || pkg.main.trim() === '') {
    throw new Error(`package.json at ${packageJsonPath} does not define a valid "main" field`);
  }

  searchRootDir = resolvedInputPath;
  resolvedEntryJsPath = path.join(resolvedInputPath, pkg.main);
}

if (!fs.existsSync(resolvedEntryJsPath)) {
  throw new Error(`entry JavaScript file not found at ${resolvedEntryJsPath}`);
}

const registry = createFileRegistry({ searchRootDir, entryJsPath: resolvedEntryJsPath });
const outcomes = [];

outcomes.push(
  runBestEffortPatch(
    () =>
      patchSingleInRegistry({
        registry,
        searchRootDir,
        label: 'autoHideMenuBar enabled',
        oldRegex:
          /([A-Za-z_$][A-Za-z0-9_$]*)\.isDestroyed\(\)\|\|\1\.setTitle\(\1\.getTitle\(\)\)/,
        newRegex:
          /([A-Za-z_$][A-Za-z0-9_$]*)\.isDestroyed\(\)\|\|\1\.setAutoHideMenuBar\(!0\)/,
        replacer: (_, id) => `${id}.isDestroyed()||${id}.setAutoHideMenuBar(!0)`
      }),
    'autoHideMenuBar enabled'
  )
);

outcomes.push(
  runBestEffortPatch(
    () => patchZedLinuxPlatformInRegistry({ registry, searchRootDir }),
    'Linux open-target platform support'
  )
);

outcomes.push(
  runBestEffortPatch(
    () =>
      patchSingleInRegistry({
        registry,
        searchRootDir,
        label: 'Linux editor-link compatibility',
        oldRegex:
          /return ([A-Za-z_$][A-Za-z0-9_$]*)&&([A-Za-z_$][A-Za-z0-9_$]*)\.has\(\1\)\?\1:\2\.values\(\)\.next\(\)\.value\?\?null/,
        newRegex:
          /return ([A-Za-z_$][A-Za-z0-9_$]*)\.has\("zed"\)\?"zed":\1\.has\(([A-Za-z_$][A-Za-z0-9_$]*)\)\?\2:\[\.\.\.\1\]\[0\]\?\?0 ?/,
        replacer: (_, preferredKey, targetsSet) =>
          `return ${targetsSet}.has("zed")?"zed":${targetsSet}.has(${preferredKey})?${preferredKey}:[...${targetsSet}][0]??0 `
      }),
    'Linux editor-link compatibility'
  )
);

registry.writeChangedFiles();

for (const item of outcomes) {
  const displayPath = item.filePath
    ? searchRootDir
      ? path.relative(searchRootDir, item.filePath)
      : item.filePath
    : 'bundle';

  if (item.status === 'patched') {
    console.log(`Patched ${displayPath}: ${item.label}`);
  } else if (item.status === 'already') {
    console.log(`${displayPath} already patched: ${item.label}`);
  } else {
    console.warn(`WARNING: ${item.warning}`);
  }
}
