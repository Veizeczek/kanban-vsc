import { isProjectEnabled } from './preferences';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { Task, TaskStatus, STATUS_FOLDERS, GoalItem, GoalSection, GoalsState } from './types';

const GOALS_FILE_NAME = 'goals.md';
const DEFAULT_GOALS_SECTIONS = ['Long term goals', 'Bugs'] as const;
const CHECKBOX_LINE_REGEX = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const SECTION_HEADING_REGEX = /^##\s+(.+?)\s*$/;

const GOALS_TEMPLATE = `${DEFAULT_GOALS_SECTIONS.map(title => `## ${title}`).join('\n\n')}\n`;

const SAFE_TITLE_REGEX = /^[a-zA-Z0-9 _-]+$/;
const HAS_ALNUM_REGEX  = /[a-zA-Z0-9]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 60);
}

export function isValidTaskTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) { return false; }
  if (!SAFE_TITLE_REGEX.test(trimmed) || !HAS_ALNUM_REGEX.test(trimmed)) {
    return false;
  }
  const slug = slugify(trimmed);
  return Boolean(slug && !WINDOWS_RESERVED.test(slug));
}

function parseFrontmatter(content: string): { title: string; date: string; status: string; pinned: boolean } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) { return null; }

  const fm: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { continue; }
    const key   = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key) { fm[key] = value; }
  }

  return {
    title:  fm['title']  ?? '',
    date:   fm['date']   ?? '',
    status: fm['status'] ?? '',
    pinned: fm['pinned'] === 'true',
  };
}

function getFileDate(filePath: string, frontmatterDate?: string): string {
  if (frontmatterDate) { return frontmatterDate; }
  try {
    return fs.statSync(filePath).mtime.toISOString().split('T')[0];
  } catch {
    return '';
  }
}

const VALID_STATUSES = new Set<string>(Object.keys(STATUS_FOLDERS));

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value);
}

/** Reject traversal, symlinks (including dangling links), and non-local workspaces. */
function isSafeWorkspacePath(filePath: string): boolean {
  const root = getWorkspaceRoot();
  if (!root || typeof filePath !== 'string' || !path.isAbsolute(filePath)) { return false; }
  const relative = path.relative(root, filePath);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { return false; }
  let current = root;
  try {
    for (const part of relative.split(path.sep)) {
      current = path.join(current, part);
      try {
        if (fs.lstatSync(current).isSymbolicLink()) { return false; }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { return false; }
      }
    }
    return true;
  } catch { return false; }
}

function assertWritable(filePath: string, initializing = false): void {
  if ((!initializing && !isProjectEnabled()) || vscode.workspace.isTrusted === false || !isSafeWorkspacePath(filePath)) {
    throw new Error('Unsafe document path or untrusted workspace.');
  }
  if (vscode.workspace.textDocuments?.some(doc => doc.isDirty && path.resolve(doc.uri.fsPath) === path.resolve(filePath))) {
    throw new Error('Save or revert unsaved editor changes before modifying this document.');
  }
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.nlink > 1) { throw new Error('Linked or non-regular documents cannot be modified.'); }
  }
}

function writeDocument(filePath: string, content: string, exclusive = false, initializing = false): void {
  assertWritable(filePath, initializing);
  if (exclusive) {
    fs.writeFileSync(filePath, content, { encoding: 'utf-8', flag: 'wx' });
    return;
  }
  const original = fs.statSync(filePath);
  const temporary = path.join(path.dirname(filePath), `.kanban-${randomBytes(16).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporary, content, { encoding: 'utf-8', flag: 'wx', mode: 0o600 });
    fs.chmodSync(temporary, original.mode);
    assertWritable(filePath, initializing);
    const current = fs.statSync(filePath);
    if (current.ino !== original.ino || current.mtimeMs !== original.mtimeMs || current.ctimeMs !== original.ctimeMs) {
      throw new Error('Document changed during the operation; retry after reviewing it.');
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) { fs.unlinkSync(temporary); }
  }
}

export function isManagedDocument(filePath: unknown): filePath is string {
  if (typeof filePath !== 'string' || !isSafeWorkspacePath(filePath)) { return false; }
  return Object.values(readTasks()).some(tasks => tasks.some(task => task.filePath === filePath));
}

export async function deleteDocument(filePath: unknown): Promise<boolean> {
  if (!isManagedDocument(filePath)) { return false; }
  assertWritable(filePath);
  await vscode.workspace.fs.delete(vscode.Uri.file(filePath), { useTrash: true });
  return true;
}

function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  if (!isSafeWorkspacePath(dir) || !fs.existsSync(dir)) { return results; }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) { continue; }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(fullPath);
      }
    }
  } catch { /* skip unreadable directory */ }

  return results;
}

function collectOtherFiles(docsPath: string): Task[] {
  const results: Task[] = [];
  if (!fs.existsSync(docsPath)) { return results; }

  try {
    const entries = fs.readdirSync(docsPath, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.')) { continue; }
      if (!entry.isFile()) { continue; }
      const fullPath = path.join(docsPath, entry.name);
      if (isGoalsFile(docsPath, fullPath)) { continue; }

      let title = path.basename(entry.name, path.extname(entry.name)) || entry.name;
      let date = '';

      if (entry.name.toLowerCase().endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const fm = parseFrontmatter(content);
          if (fm?.title) {
            title = fm.title;
          }
          date = getFileDate(fullPath, fm?.date);
        } catch {
          date = getFileDate(fullPath);
        }
      } else {
        date = getFileDate(fullPath);
      }

      results.push({
        title,
        date,
        status: 'other',
        filePath: fullPath,
        fileName: entry.name,
        relPath: `docs/${entry.name}`,
      });
    }
  } catch { /* skip unreadable directory */ }

  return results;
}

function isGoalsFile(docsPath: string, filePath: string): boolean {
  const rel = path.relative(docsPath, filePath).split(path.sep).join('/').toLowerCase();
  return rel === GOALS_FILE_NAME;
}

interface InternalGoalSection {
  title: string;
  notes: string[];
  items: GoalItem[];
}

interface ParsedGoalsDoc {
  preamble: string[];
  sections: InternalGoalSection[];
}

function sortGoalItems(items: GoalItem[]): GoalItem[] {
  const active    = items.filter(item => !item.completed);
  const completed = items.filter(item => item.completed);
  return [...active, ...completed];
}

function parseGoalsDocument(content: string): ParsedGoalsDoc {
  const preamble: string[] = [];
  const sections: InternalGoalSection[] = [];
  let current: InternalGoalSection | null = null;

  for (const line of content.split(/\r?\n/)) {
    const headingMatch = line.match(SECTION_HEADING_REGEX);
    if (headingMatch) {
      current = { title: headingMatch[1].trim(), notes: [], items: [] };
      sections.push(current);
      continue;
    }

    const checkboxMatch = line.match(CHECKBOX_LINE_REGEX);
    if (checkboxMatch) {
      const text = checkboxMatch[2].trim();
      if (text) {
        if (!current) {
          current = { title: DEFAULT_GOALS_SECTIONS[0], notes: [], items: [] };
          sections.push(current);
        }
        current.items.push({
          completed: checkboxMatch[1].toLowerCase() === 'x',
          text,
        });
      }
      continue;
    }

    if (current) {
      current.notes.push(line);
    } else {
      preamble.push(line);
    }
  }

  for (const section of sections) {
    section.items = sortGoalItems(section.items);
  }

  return { preamble, sections };
}

function serializeGoalsDocument(doc: ParsedGoalsDoc): string {
  const blocks: string[] = [];
  const preambleText = doc.preamble.join('\n').trim();
  if (preambleText) {
    blocks.push(preambleText);
  }

  const sections = doc.sections.length > 0
    ? doc.sections
    : DEFAULT_GOALS_SECTIONS.map(title => ({ title, notes: [], items: [] }));

  for (const section of sections) {
    const lines: string[] = [`## ${section.title}`];
    const notesText = section.notes.join('\n').trim();
    if (notesText) {
      lines.push('', notesText);
    }
    const sorted = sortGoalItems(section.items);
    if (sorted.length > 0) {
      lines.push('');
      for (const item of sorted) {
        lines.push(`- [${item.completed ? 'x' : ' '}] ${item.text}`);
      }
    }
    blocks.push(lines.join('\n'));
  }

  return `${blocks.join('\n\n')}\n`;
}

function updateFrontmatterStatus(content: string, newStatus: TaskStatus, filePath: string): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    const title = path.basename(filePath, path.extname(filePath));
    const date  = getFileDate(filePath);
    return `---\ntitle: ${title}\ndate: ${date}\nstatus: ${newStatus}\n---\n\n${content}`;
  }

  const fullFm    = fmMatch[0];
  const inner     = fmMatch[1];
  const updatedFm = /^status:\s*[^\n\r]*/m.test(inner)
    ? fullFm.replace(/^status:\s*[^\n\r]*/m, `status: ${newStatus}`)
    : `---\n${inner}\nstatus: ${newStatus}\n---`;

  return updatedFm + content.slice(fullFm.length);
}

export function getDocsPath(): string | null {
  if (!isProjectEnabled() || vscode.workspace.isTrusted === false) { return null; }
  const root = getWorkspaceRoot();
  if (!root) { return null; }
  const docsPath = path.join(root, 'docs');
  return isSafeWorkspacePath(docsPath) && fs.existsSync(docsPath) && fs.statSync(docsPath).isDirectory() ? docsPath : null;
}

export function getWorkspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  const uri = folders?.[0]?.uri;
  return uri && (!uri.scheme || uri.scheme === 'file') ? uri.fsPath : null;
}

export function readTasks(): Record<TaskStatus, Task[]> {
  const result: Record<TaskStatus, Task[]> = {
    proposed: [], active: [], closed: [], architecture: [], rejected: [], other: [],
  };

  const docsPath = getDocsPath();
  if (!docsPath) { return result; }

  const statusList: TaskStatus[] = ['proposed', 'active', 'closed', 'architecture', 'rejected'];
  for (const status of statusList) {
    const folder = STATUS_FOLDERS[status];
    if (!folder) { continue; }
    const folderPath = path.join(docsPath, folder);
    for (const filePath of collectMarkdownFiles(folderPath)) {
      try {
        const content       = fs.readFileSync(filePath, 'utf-8');
        const fm            = parseFrontmatter(content);
        const fallbackTitle = path.basename(filePath, path.extname(filePath));
        const title         = fm?.title || fallbackTitle;
        const date          = getFileDate(filePath, fm?.date);

        result[status].push({
          title,
          pinned: fm?.pinned ?? false,
          date,
          status,
          filePath,
          fileName: path.basename(filePath),
          relPath: `docs/${path.relative(docsPath, filePath).split(path.sep).join('/')}`,
        });
      } catch { /* skip unreadable file */ }
    }
  }

  result.other = collectOtherFiles(docsPath);

  return result;
}

/** Keep the pin with the document when its title, filename or column changes. */
export function setTaskPinned(filePath: string, pinned: boolean): boolean {
  const tasks = readTasks();
  const task = ['proposed', 'active', 'closed', 'rejected']
    .flatMap(status => tasks[status as TaskStatus])
    .find(candidate => candidate.filePath === filePath);
  if (!task) { return false; }
  const content = fs.readFileSync(filePath, 'utf-8');
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  let updated: string;
  if (match) {
    const lines = match[1].split(/\r?\n/).filter(line => !/^pinned\s*:/.test(line));
    if (pinned) { lines.push('pinned: true'); }
    updated = `---${newline}${lines.join(newline)}${newline}---${content.slice(match[0].length)}`;
  } else {
    if (!pinned) { return true; }
    // Preserve the fallback date even though writing changes the file's mtime.
    updated = `---${newline}date: ${task.date}${newline}pinned: true${newline}---${newline}${content}`;
  }
  if (updated !== content) { writeDocument(filePath, updated); }
  return true;
}

export async function createTask(title: string, status: TaskStatus): Promise<string | null> {
  const root = getWorkspaceRoot();
  if (!root || !getDocsPath() || !isTaskStatus(status)) { return null; }

  const trimmedTitle = title.trim();
  if (!isValidTaskTitle(trimmedTitle)) { return null; }

  const taskDate   = new Date().toISOString().split('T')[0];
  const baseName   = slugify(trimmedTitle);
  if (!baseName) { return null; }
  const folderPath = status === 'other'
    ? path.join(root, 'docs')
    : path.join(root, 'docs', STATUS_FOLDERS[status]);

  if (!isSafeWorkspacePath(folderPath)) { return null; }
  fs.mkdirSync(folderPath, { recursive: true });

  // Find unique filename (add -2, -3, … on collision)
  let fileName = `${baseName}.md`;
  let counter  = 2;
  while (fs.existsSync(path.join(folderPath, fileName)) || (status === 'other' && fileName.toLowerCase() === GOALS_FILE_NAME)) {
    fileName = `${baseName}-${counter}.md`;
    counter++;
  }

  const filePath = path.join(folderPath, fileName);

  const content = `---
title: ${trimmedTitle}
date: ${taskDate}
status: ${status}
---

## brief

## progress

## description
`;

  writeDocument(filePath, content, true);
  return filePath;
}

export async function moveTask(filePath: string, newStatus: TaskStatus): Promise<string | null> {
  if (!isTaskStatus(newStatus) || !isManagedDocument(filePath) || path.extname(filePath).toLowerCase() !== '.md') { return null; }
  assertWritable(filePath);
  const currentTask = Object.values(readTasks()).flat().find(task => task.filePath === filePath);
  if (currentTask?.status === newStatus) { return filePath; }

  const docsPath = getDocsPath();
  if (!docsPath) { return null; }

  const content        = fs.readFileSync(filePath, 'utf-8');
  const updatedContent = updateFrontmatterStatus(content, newStatus, filePath);

  const ext       = path.extname(filePath);
  const baseName  = path.basename(filePath, ext);
  const newFolder = newStatus === 'other'
    ? docsPath
    : path.join(docsPath, STATUS_FOLDERS[newStatus]);
  if (!isSafeWorkspacePath(newFolder)) { return null; }
  fs.mkdirSync(newFolder, { recursive: true });

  let targetName = `${baseName}${ext}`;
  let counter    = 2;
  while ((fs.existsSync(path.join(newFolder, targetName)) &&
         path.join(newFolder, targetName) !== filePath) || (newStatus === 'other' && targetName.toLowerCase() === GOALS_FILE_NAME)) {
    targetName = `${baseName}-${counter}${ext}`;
    counter++;
  }

  const newFilePath = path.join(newFolder, targetName);
  writeDocument(newFilePath, updatedContent, true);
  if (newFilePath !== filePath) {
    assertWritable(filePath);
    if (fs.readFileSync(filePath, 'utf-8') !== content) {
      throw new Error('Source changed during the move; both copies have been preserved.');
    }
    fs.unlinkSync(filePath);
  }

  return newFilePath;
}

export type DocsCreateResult = 'created' | 'already-exists' | 'no-workspace';
export type SaveDocsChangesResult =
  | { status: 'committed'; hash: string }
  | { status: 'no-workspace' | 'no-docs' | 'not-git-repo' | 'no-changes' }
  | { status: 'git-error'; message: string };

function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      const code = typeof (error as { code?: unknown } | null)?.code === 'number'
        ? (error as { code: number }).code
        : error ? 1 : 0;
      resolve({ stdout, stderr, code });
    });
  });
}

const AGENTS_TEMPLATE = `# Agent Notes

Instructions for AI agents working on this project.

## Project overview

<!-- Describe what this project does and its main goals -->

## Architecture

<!-- Key architectural decisions, patterns used, tech stack -->

## File structure

<!-- Important files and folders -->

## Rules

<!-- What agents should and should not do in this codebase -->

## Current focus

<!-- What is currently being worked on -->
`;

export function createDocsStructure(): DocsCreateResult {
  const root = getWorkspaceRoot();
  if (!root || vscode.workspace.isTrusted === false) { return 'no-workspace'; }

  const docsPath = path.join(root, 'docs');
  if (!isSafeWorkspacePath(docsPath)) { throw new Error('Unsafe docs directory.'); }
  if (fs.existsSync(docsPath)) { return 'already-exists'; }

  for (const folder of Object.values(STATUS_FOLDERS)) {
    if (!folder) { continue; }
    fs.mkdirSync(path.join(docsPath, folder), { recursive: true });
  }

  const goalsPath = path.join(docsPath, GOALS_FILE_NAME);
  if (!fs.existsSync(goalsPath)) {
    writeDocument(goalsPath, GOALS_TEMPLATE, true, true);
  }

  const agentsPath = path.join(root, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    writeDocument(agentsPath, AGENTS_TEMPLATE, true, true);
  }

  return 'created';
}

async function resolveChangedDocTitles(root: string, relPaths: string[]): Promise<string[]> {
  const seen   = new Set<string>();
  const titles: string[] = [];

  for (const relPath of relPaths) {
    const normalizedRel = relPath.split(path.sep).join('/');
    const fullPath      = path.join(root, relPath);
    let title           = '';

    if (isSafeWorkspacePath(fullPath) && normalizedRel.toLowerCase().endsWith('.md')) {
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          title = parseFrontmatter(content)?.title ?? '';
        } else {
          const headFile = await runGit(['show', `HEAD:${normalizedRel}`], root);
          if (headFile.code === 0) {
            title = parseFrontmatter(headFile.stdout)?.title ?? '';
          }
        }
      } catch { /* fallback to filename */ }
    }

    const cleanTitle = (title || path.basename(relPath, path.extname(relPath)) || path.basename(relPath))
      .replace(/[\r\n]+/g, ' ')
      .trim();

    if (cleanTitle && !seen.has(cleanTitle)) {
      seen.add(cleanTitle);
      titles.push(cleanTitle);
    }
  }

  return titles;
}

export async function saveDocsChanges(): Promise<SaveDocsChangesResult> {
  const root = getWorkspaceRoot();
  if (!root) { return { status: 'no-workspace' }; }

  const docsPath = getDocsPath();
  if (!docsPath) { return { status: 'no-docs' }; }

  const insideRepo = await runGit(['rev-parse', '--is-inside-work-tree'], root);
  if (insideRepo.code !== 0 || insideRepo.stdout.trim() !== 'true') {
    return { status: 'not-git-repo' };
  }

  const docsPathspec = path.relative(root, docsPath).split(path.sep).join('/') || 'docs';
  const addResult = await runGit(['add', '--all', '--', docsPathspec], root);
  if (addResult.code !== 0) {
    return { status: 'git-error', message: addResult.stderr.trim() || addResult.stdout.trim() };
  }

  const diffResult = await runGit(['diff', '--cached', '--name-only', '-z', '--', docsPathspec], root);
  if (diffResult.code !== 0) {
    return { status: 'git-error', message: diffResult.stderr.trim() || diffResult.stdout.trim() };
  }

  const changedFiles = diffResult.stdout.split('\0').filter(Boolean);
  if (changedFiles.length === 0) {
    return { status: 'no-changes' };
  }

  const titles        = await resolveChangedDocTitles(root, changedFiles);
  const commitMessage = titles.length > 0 ? `docs: ${titles.join(', ')}` : 'docs: update';

  const commitResult = await runGit(['commit', '-m', commitMessage, '--', docsPathspec], root);
  if (commitResult.code !== 0) {
    return { status: 'git-error', message: commitResult.stderr.trim() || commitResult.stdout.trim() };
  }

  const hashResult = await runGit(['rev-parse', '--short', 'HEAD'], root);
  return { status: 'committed', hash: hashResult.stdout.trim() };
}

export function getGoalsFilePath(): string | null {
  const docsPath = getDocsPath();
  const goalsPath = docsPath ? path.join(docsPath, GOALS_FILE_NAME) : null;
  return goalsPath && isSafeWorkspacePath(goalsPath) ? goalsPath : null;
}

export function ensureGoalsFile(): string | null {
  const goalsPath = getGoalsFilePath();
  if (!goalsPath) { return null; }
  if (!fs.existsSync(goalsPath)) {
    writeDocument(goalsPath, GOALS_TEMPLATE, true);
  }
  return goalsPath;
}

export function readGoals(): GoalsState {
  const goalsPath = getGoalsFilePath();
  if (!goalsPath) {
    return { exists: false, filePath: null, sections: [] };
  }

  if (!fs.existsSync(goalsPath)) {
    return {
      exists: false,
      filePath: goalsPath,
      sections: DEFAULT_GOALS_SECTIONS.map(title => ({ title, items: [] })),
    };
  }

  try {
    const content = fs.readFileSync(goalsPath, 'utf-8');
    const parsed  = parseGoalsDocument(content);
    const sections: GoalSection[] = parsed.sections.length > 0
      ? parsed.sections.map(s => ({ title: s.title, items: s.items }))
      : DEFAULT_GOALS_SECTIONS.map(title => ({ title, items: [] }));

    return { exists: true, filePath: goalsPath, sections };
  } catch {
    return { exists: false, filePath: goalsPath, sections: [] };
  }
}

export function insertGoalItem(sectionIndex: number, afterItemIndex: number, text: string): boolean {
  if (!Number.isInteger(sectionIndex) || !Number.isInteger(afterItemIndex)) { return false; }
  const cleanText = text.replace(/[\r\n]+/g, ' ').trim();
  if (!cleanText) { return false; }

  const goalsPath = ensureGoalsFile();
  if (!goalsPath) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  if (doc.sections.length === 0) {
    doc.sections = DEFAULT_GOALS_SECTIONS.map(title => ({ title, notes: [], items: [] }));
  }

  const resolvedIdx = sectionIndex < 0
    ? 0
    : (sectionIndex >= doc.sections.length ? doc.sections.length - 1 : sectionIndex);
  const targetSection = doc.sections[resolvedIdx];

  const active    = targetSection.items.filter(item => !item.completed);
  const completed = targetSection.items.filter(item => item.completed);
  const newItem: GoalItem = { text: cleanText, completed: false };

  if (afterItemIndex < 0) {
    active.unshift(newItem);
  } else if (afterItemIndex < active.length) {
    active.splice(afterItemIndex + 1, 0, newItem);
  } else {
    active.push(newItem);
  }

  targetSection.items = [...active, ...completed];

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}

export function insertGoalSection(sectionIndex: number, afterItemIndex: number, title: string): boolean {
  if (!Number.isInteger(sectionIndex) || !Number.isInteger(afterItemIndex)) { return false; }
  const cleanTitle = title.replace(/[\r\n]+/g, ' ').replace(/^#+\s*/, '').trim();
  if (!cleanTitle) { return false; }

  const goalsPath = ensureGoalsFile();
  if (!goalsPath) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  if (doc.sections.length === 0) {
    doc.sections = DEFAULT_GOALS_SECTIONS.map(secTitle => ({ title: secTitle, notes: [], items: [] }));
  }

  if (sectionIndex < 0) {
    doc.sections.unshift({ title: cleanTitle, notes: [], items: [] });
  } else if (sectionIndex >= doc.sections.length) {
    doc.sections.push({ title: cleanTitle, notes: [], items: [] });
  } else {
    const current   = doc.sections[sectionIndex];
    const active    = current.items.filter(item => !item.completed);
    const completed = current.items.filter(item => item.completed);

    if (afterItemIndex < 0) {
      if (current.items.length === 0) {
        doc.sections.splice(sectionIndex + 1, 0, { title: cleanTitle, notes: [], items: [] });
      } else {
        const movedItems = sortGoalItems(current.items);
        current.items = [];
        doc.sections.splice(sectionIndex + 1, 0, { title: cleanTitle, notes: [], items: movedItems });
      }
    } else if (afterItemIndex < active.length) {
      const keptActive     = active.slice(0, afterItemIndex + 1);
      const trailingActive = active.slice(afterItemIndex + 1);
      current.items = [...keptActive, ...completed];
      doc.sections.splice(sectionIndex + 1, 0, {
        title: cleanTitle,
        notes: [],
        items: trailingActive,
      });
    } else {
      doc.sections.splice(sectionIndex + 1, 0, { title: cleanTitle, notes: [], items: [] });
    }
  }

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}

export function toggleGoalItem(sectionIndex: number, itemIndex: number): boolean {
  if (!Number.isInteger(sectionIndex) || !Number.isInteger(itemIndex)) { return false; }
  const goalsPath = getGoalsFilePath();
  if (!goalsPath || !fs.existsSync(goalsPath)) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  const section = doc.sections[sectionIndex];
  if (!section || !section.items[itemIndex]) { return false; }

  section.items[itemIndex].completed = !section.items[itemIndex].completed;
  section.items = sortGoalItems(section.items);

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}

export function reorderGoalSection(fromIndex: number, toIndex: number): boolean {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) { return false; }
  const goalsPath = getGoalsFilePath();
  if (!goalsPath || !fs.existsSync(goalsPath)) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  if (
    fromIndex < 0 || fromIndex >= doc.sections.length ||
    toIndex < 0 || toIndex >= doc.sections.length ||
    fromIndex === toIndex
  ) {
    return false;
  }

  const [moved] = doc.sections.splice(fromIndex, 1);
  doc.sections.splice(toIndex, 0, moved);

  for (const section of doc.sections) {
    section.items = sortGoalItems(section.items);
  }

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}

export function updateGoalEntry(sectionIndex: number, itemIndex: number | null, text: string): boolean {
  if (!Number.isInteger(sectionIndex) || (itemIndex !== null && !Number.isInteger(itemIndex))) { return false; }
  const clean = text.replace(/[\r\n]+/g, ' ').trim();
  const goalsPath = getGoalsFilePath();
  if (!goalsPath || !fs.existsSync(goalsPath)) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  const section = doc.sections[sectionIndex];
  if (!section) { return false; }

  if (itemIndex === null) {
    const cleanHeading = clean.replace(/^#+\s*/, '').trim();
    if (!cleanHeading) { return false; }
    section.title = cleanHeading;
  } else {
    if (!section.items[itemIndex]) { return false; }
    if (!clean) {
      section.items.splice(itemIndex, 1);
    } else {
      section.items[itemIndex].text = clean;
    }
    section.items = sortGoalItems(section.items);
  }

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}

export function deleteGoalEntry(sectionIndex: number, itemIndex: number | null): boolean {
  if (!Number.isInteger(sectionIndex) || (itemIndex !== null && !Number.isInteger(itemIndex))) { return false; }
  const goalsPath = getGoalsFilePath();
  if (!goalsPath || !fs.existsSync(goalsPath)) { return false; }

  const content = fs.readFileSync(goalsPath, 'utf-8');
  const doc     = parseGoalsDocument(content);
  const section = doc.sections[sectionIndex];
  if (!section) { return false; }

  if (itemIndex === null) {
    if (sectionIndex > 0) {
      const prev = doc.sections[sectionIndex - 1];
      prev.items = sortGoalItems([...prev.items, ...section.items]);
      doc.sections.splice(sectionIndex, 1);
    } else if (doc.sections.length > 1) {
      const next = doc.sections[1];
      next.items = sortGoalItems([...section.items, ...next.items]);
      doc.sections.splice(0, 1);
    } else {
      section.items = [];
    }
  } else {
    if (!section.items[itemIndex]) { return false; }
    section.items.splice(itemIndex, 1);
  }

  writeDocument(goalsPath, serializeGoalsDocument(doc));
  return true;
}
