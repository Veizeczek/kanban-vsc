const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { sortBoardTasks, isBoardSort } = require('../out/boardSorting');

const task = (title, date, pinned = false, relPath = title) => ({
  title, date, pinned, relPath, filePath: relPath, fileName: relPath, status: 'proposed',
});

test('all sort modes keep pinned cards first and sort both groups', () => {
  const tasks = [task('Beta', '2026-02-01'), task('Alpha', '2026-01-01'),
    task('Pinned B', '2026-02-01', true), task('Pinned A', '2026-01-01', true)];
  for (const mode of ['date-asc', 'name-asc']) {
    assert.deepEqual(sortBoardTasks(tasks, mode, 'en').map(t => t.title), ['Pinned A', 'Pinned B', 'Alpha', 'Beta']);
  }
  for (const mode of ['date-desc', 'name-desc']) {
    assert.deepEqual(sortBoardTasks(tasks, mode, 'en').map(t => t.title), ['Pinned B', 'Pinned A', 'Beta', 'Alpha']);
  }
  assert.equal(tasks[0].title, 'Beta', 'sorting must not mutate input');
  assert.equal(isBoardSort('name-asc'), true);
  assert.equal(isBoardSort('random'), false);
});

test('dates without a valid value go last, ties are deterministic, names use natural order', () => {
  const tasks = [task('Task 10', ''), task('Task 2', 'bad'), task('Task 1', '2026-01-01')];
  for (const mode of ['date-asc', 'date-desc']) {
    assert.deepEqual(sortBoardTasks(tasks, mode, 'en').map(t => t.title), ['Task 1', 'Task 2', 'Task 10']);
  }
  assert.deepEqual(sortBoardTasks(tasks, 'name-asc', 'en').map(t => t.title), ['Task 1', 'Task 2', 'Task 10']);
  assert.deepEqual(sortBoardTasks([task('Same', '', false, 'b'), task('Same', '', false, 'a')], 'name-asc', 'en').map(t => t.relPath), ['a', 'b']);
  assert.deepEqual(sortBoardTasks([task('Żaba', ''), task('Łódź', ''), task('Adam', '')], 'name-asc', 'pl').map(t => t.title), ['Adam', 'Łódź', 'Żaba']);
});

test('pins persist across reload and move without losing document contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-pins-'));
  const original = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { workspace: { workspaceFolders: [{ uri: { fsPath: root } }] }, env: { language: 'en' } };
    return original.call(this, name, ...args);
  };
  const files = require('../out/fileManager');
  Module._load = original;
  try {
    const folder = path.join(root, 'docs/proposed');
    fs.mkdirSync(folder, { recursive: true });
    const file = path.join(folder, 'old.md');
    const content = '---\r\ntitle: Renamed\r\ndate: 2026-01-01\r\nstatus: proposed\r\ncustom: keep\r\n---\r\n\r\nBody\r\n';
    fs.writeFileSync(file, content);
    assert.equal(files.setTaskPinned(file, true), true);
    assert.equal(files.readTasks().proposed[0].pinned, true);
    assert.ok(fs.readFileSync(file, 'utf8').includes('custom: keep\r\npinned: true'));
    assert.ok(fs.readFileSync(file, 'utf8').endsWith('\r\n\r\nBody\r\n'));
    const moved = await files.moveTask(file, 'active');
    assert.ok(moved);
    const reloaded = files.readTasks().active[0];
    assert.equal(reloaded.pinned, true);
    assert.equal(reloaded.fileName, 'old.md');
    assert.equal(files.setTaskPinned(reloaded.filePath, false), true);
    assert.equal(files.readTasks().active[0].pinned, false);
    assert.ok(fs.readFileSync(reloaded.filePath, 'utf8').includes('custom: keep'));
    assert.ok(!fs.readFileSync(reloaded.filePath, 'utf8').includes('pinned:'));

    const plain = path.join(folder, 'plain.md');
    fs.writeFileSync(plain, '# Plain document\n');
    const originalDate = files.readTasks().proposed[0].date;
    assert.equal(files.setTaskPinned(plain, true), true);
    assert.equal(files.readTasks().proposed[0].date, originalDate);
    assert.ok(fs.readFileSync(plain, 'utf8').endsWith('# Plain document\n'));
    assert.equal(files.setTaskPinned(path.join(root, 'outside.md'), true), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
