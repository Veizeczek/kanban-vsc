const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-security-'));
const trash = [];
const errors = [];
const workspace = { isTrusted: true, workspaceFolders: [{uri: {scheme: 'file', fsPath: root}}], textDocuments: [],
  fs: { delete: async (uri, options) => trash.push({uri, options}) } };
const vscode = { workspace, env: {language: 'en'},
  Uri: {file: fsPath => ({fsPath}), joinPath: (...parts) => parts.join('/')},
  window: {showErrorMessage: error => errors.push(error)}, commands: {executeCommand: async () => {}} };
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
};
const files = require('../out/fileManager');
const { KanbanPanel } = require('../out/KanbanPanel');
const preferences = require('../out/preferences');
Module._load = originalLoad;
after(() => fs.rmSync(root, {recursive: true, force: true}));
function reset() {
  workspace.isTrusted = true;
  workspace.textDocuments = [];
  preferences.setProjectEnabled(true);
  fs.rmSync(path.join(root, 'docs'), {recursive: true, force: true});
  for (const folder of ['proposed', 'active', 'closed', 'rejected', 'architecture']) {
    fs.mkdirSync(path.join(root, 'docs', folder), {recursive: true});
  }
}
function put(relative, content = '---\ntitle: Changed title\nstatus: active\n---\n\nBody\n') {
  const file = path.join(root, relative);
  fs.writeFileSync(file, content);
  return file;
}
function panel(saved = new Map()) {
  let receive;
  const messages = [];
  const webview = {cspSource: 'https://local', asWebviewUri: uri => uri,
    postMessage: msg => messages.push(msg), onDidReceiveMessage: handler => {receive = handler;} };
  const context = {extensionUri: '/extension', workspaceState: {get: key => saved.get(key), update: async (key, value) => saved.set(key, value)}, globalState: {get: () => undefined}};
  new KanbanPanel({webview, onDidDispose: () => {}}, context);
  return {receive, messages};
}

test('opening and repeatedly refreshing never modifies files, names, directories or mtimes', async () => {
  reset();
  put('docs/proposed/original-name.md');
  put('docs/goals.md', '# Notes\r\n\r\n## Demo\r\n- [x] Done\r\n\r\nKeep spacing\r\n- [ ] Pending\r\n');
  function snapshot() {
    return fs.readdirSync(path.join(root, 'docs'), {recursive: true}).sort().map(relative => {
      const file = path.join(root, 'docs', relative);
      const stat = fs.statSync(file);
      return [relative, stat.mtimeMs, stat.isFile() ? fs.readFileSync(file).toString('hex') : null];
    });
  }
  const before = snapshot();
  const {receive, messages} = panel();
  for (let i = 0; i < 3; i++) await receive({command: 'refresh'});
  assert.deepEqual(snapshot(), before);
  assert.equal(messages.filter(msg => msg.command === 'refreshDone' && msg.success).length, 3);
});

test('messages cannot delete or move arbitrary files; invalid messages are harmless', async () => {
  reset();
  const outside = put('private.md', 'Do not change');
  const {receive} = panel();
  for (const msg of [null, {}, {command: 'deleteFile', filePath: outside},
    {command: 'moveTask', filePath: outside, newStatus: 'active'},
    {command: 'createTask', title: 'Test', status: '../../outside'},
    {command: 'reorderColumns', order: ['active', 'active']}]) await receive(msg);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'Do not change');
  assert.equal(trash.length, 0);
  assert.equal(files.deleteGoalEntry(NaN, null), false);
  assert.equal(files.insertGoalItem(NaN, -1, 'Test'), false);
});

test('directory and file symlinks, dangling links and hard links are protected', async () => {
  reset();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-external-'));
  try {
    const victim = path.join(external, 'victim.md');
    fs.writeFileSync(victim, 'Original');
    fs.rmSync(path.join(root, 'docs/active'), {recursive: true});
    fs.symlinkSync(external, path.join(root, 'docs/active'), 'dir');
    assert.deepEqual(files.readTasks().active, []);
    assert.equal(await files.createTask('Victim', 'active'), null);
    const source = put('docs/proposed/source.md');
    assert.equal(await files.moveTask(source, 'active'), null);
    fs.symlinkSync(victim, path.join(root, 'docs/goals.md'));
    assert.equal(files.toggleGoalItem(0, 0), false);
    assert.equal(files.ensureGoalsFile(), null);
    fs.symlinkSync(path.join(external, 'missing.md'), path.join(root, 'docs/proposed/dangling.md'));
    await assert.rejects(files.createTask('Dangling', 'proposed'));
    const hard = path.join(root, 'docs/proposed/hard.md');
    fs.linkSync(victim, hard);
    assert.throws(() => files.setTaskPinned(hard, true));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'Original');
    assert.equal(fs.existsSync(path.join(external, 'missing.md')), false);
    fs.rmSync(path.join(root, 'docs'), {recursive: true});
    fs.symlinkSync(external, path.join(root, 'docs'), 'dir');
    assert.equal(files.getDocsPath(), null);
  } finally { fs.rmSync(external, {recursive: true, force: true}); }
});

test('moves keep collisions intact, ignore binary files and reserve goals.md', async () => {
  reset();
  const source = put('docs/proposed/task.md');
  const existing = put('docs/active/task.md', 'Existing');
  const moved = await files.moveTask(source, 'active');
  assert.equal(path.basename(moved), 'task-2.md');
  assert.equal(fs.readFileSync(existing, 'utf8'), 'Existing');
  assert.equal(fs.existsSync(source), false);
  assert.match(fs.readFileSync(moved, 'utf8'), /status: active/);
  const binary = put('docs/image.png', '\x00\xffbinary');
  const before = fs.readFileSync(binary);
  assert.equal(await files.moveTask(binary, 'active'), null);
  assert.deepEqual(fs.readFileSync(binary), before);
  assert.equal(path.basename(await files.createTask('Goals', 'other')), 'goals-2.md');
});

test('exclusive destination creation fails safely if a collision appears after checking', async () => {
  reset();
  const source = put('docs/proposed/race.md');
  const target = path.join(root, 'docs/active/race.md');
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, data, options) {
    if (file === target) originalWrite(target, 'Concurrent document');
    return originalWrite(file, data, options);
  };
  try { await assert.rejects(files.moveTask(source, 'active'), {code: 'EEXIST'}); }
  finally { fs.writeFileSync = originalWrite; }
  assert.equal(fs.readFileSync(target, 'utf8'), 'Concurrent document');
  assert.equal(fs.existsSync(source), true);
});

test('dirty documents cannot be pinned, moved, deleted or rewritten as goals', async () => {
  reset();
  const source = put('docs/proposed/dirty.md');
  const goals = put('docs/goals.md', '## Demo\n- [ ] Keep\n');
  workspace.textDocuments = [source, goals].map(fsPath => ({isDirty: true, uri: {fsPath}}));
  assert.throws(() => files.setTaskPinned(source, true), /unsaved/);
  await assert.rejects(files.moveTask(source, 'active'), /unsaved/);
  await assert.rejects(files.deleteDocument(source), /unsaved/);
  assert.throws(() => files.toggleGoalItem(0, 0), /unsaved/);
  workspace.textDocuments = [];
  assert.equal(await files.deleteDocument(source), true);
  assert.deepEqual(trash.at(-1), {uri: {fsPath: source}, options: {useTrash: true}});
});

test('untrusted workspaces block writes; initialization works while project is disabled', async () => {
  reset();
  const source = put('docs/proposed/task.md');
  workspace.isTrusted = false;
  assert.equal(await files.moveTask(source, 'active'), null);
  assert.equal(await files.createTask('Blocked', 'active'), null);
  assert.equal(await files.deleteDocument(source), false);
  assert.equal(files.createDocsStructure(), 'no-workspace');
  workspace.isTrusted = true;
  fs.rmSync(path.join(root, 'docs'), {recursive: true});
  const ignore = put('.gitignore', 'private/\n');
  preferences.setProjectEnabled(false);
  assert.equal(files.createDocsStructure(), 'created');
  assert.equal(fs.readFileSync(ignore, 'utf8'), 'private/\n');
  assert.equal(fs.existsSync(path.join(root, 'docs/goals.md')), true);
  preferences.setProjectEnabled(true);
});

test('Save respects ignored documents and does not commit unrelated staged changes', async () => {
  reset();
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  git('init', '-q');
  git('config', 'user.name', 'Kanban Test');
  git('config', 'user.email', 'kanban@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  put('.gitignore', 'docs/secret.md\n');
  put('unrelated.txt', 'initial');
  git('add', '.gitignore', 'unrelated.txt');
  git('commit', '-qm', 'Initial');
  put('unrelated.txt', 'staged');
  git('add', 'unrelated.txt');
  put('docs/proposed/demo.md');
  put('docs/secret.md', 'Private');
  assert.equal((await files.saveDocsChanges()).status, 'committed');
  assert.equal(git('show', 'HEAD:unrelated.txt'), 'initial');
  assert.equal(git('diff', '--cached', '--name-only'), 'unrelated.txt');
  assert.equal(git('ls-files', 'docs/secret.md'), '');
});

test('a failed replacement write leaves the original document intact', () => {
  reset();
  const source = put('docs/proposed/intact.md');
  const before = fs.readFileSync(source);
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function(file, ...args) {
    if (path.basename(file).startsWith('.kanban-')) {
      originalWrite(file, 'Partial write');
      throw Object.assign(new Error('Disk full'), {code: 'ENOSPC'});
    }
    return originalWrite(file, ...args);
  };
  try { assert.throws(() => files.setTaskPinned(source, true), /Disk full/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.deepEqual(fs.readFileSync(source), before);
  assert.deepEqual(fs.readdirSync(path.dirname(source)), ['intact.md']);
});


test('visibility choices persist independently and invalid keys cannot hide essential controls', async () => {
  reset();
  const saved = new Map();
  const {receive} = panel(saved);
  await receive({command: 'setVisibility', item: 'goals', enabled: false});
  await receive({command: 'setVisibility', item: 'agents', enabled: false});
  await receive({command: 'setVisibility', item: 'settings', enabled: false});
  await receive({command: 'setVisibility', item: '__proto__', enabled: false});
  await receive({command: 'setVisibility', item: 'save', enabled: 'false'});
  assert.deepEqual(saved.get('kanban.visibility'), {goals:false, architecture:true, other:true, agents:false, save:true, refresh:true, status:true, count:true});
  const reloaded = panel(saved);
  await reloaded.receive({command: 'setVisibility', item: 'goals', enabled: true});
  assert.equal(saved.get('kanban.visibility').agents, false);
  assert.equal(saved.get('kanban.visibility').goals, true);
  assert.deepEqual(preferences.getVisibility(null), {goals:true, architecture:true, other:true, agents:true, save:true, refresh:true, status:true, count:true});
});
