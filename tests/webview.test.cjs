const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { JSDOM } = require('jsdom');
const original = Module._load;
Module._load = function(name, ...args) {
  if (name === 'vscode') return {
    env: { language: 'en' },
    Uri: { joinPath: (...parts) => parts.join('/') },
    workspace: { workspaceFolders: [] },
  };
  return original.call(this, name, ...args);
};
const { KanbanPanel } = require('../out/KanbanPanel');
const { KanbanSidebarProvider } = require('../out/KanbanSidebarProvider');
Module._load = original;
const { getColumnSorts } = require('../out/boardSorting');

const task = (name, status = 'proposed') => ({ title: name, date: '2026-01-01', status,
  filePath: `/project/docs/${status}/${name}.md`, relPath: `docs/${status}/${name}.md`, fileName: `${name}.md` });
function state() {
  return { tasks: { proposed: [task('A'), task('B')], active: [task('C', 'active')], closed: [], rejected: [], architecture: [], other: [] },
    order: ['rejected', 'proposed', 'active', 'closed'], docsExists: true, hasWorkspace: true,
    goals: {exists: true, sections: [], filePath: '/project/docs/goals.md'},
    showCopyPathIcon: true, uiScale: 100, columnSorts: getColumnSorts({}, undefined) };
}
function view(initial) {
  const panel = Object.create(KanbanPanel.prototype);
  panel._context = { extensionUri: '/extension' };
  panel._panel = { webview: { cspSource: 'https://local', asWebviewUri: uri => uri } };
  const messages = [];
  const dom = new JSDOM(panel._buildHtml(initial), { runScripts: 'dangerously',
    beforeParse(window) { window.acquireVsCodeApi = () => ({ postMessage: msg => messages.push(msg) }); } });
  dom.window.eval(fs.readFileSync(path.join(__dirname, '../media/main.js'), 'utf8'));
  const send = next => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: {command: 'renderTasks', state: next} }));
  return { dom, document: dom.window.document, messages, send };
}

test('identical refresh produces no DOM mutations', () => {
  const initial = state();
  const { dom, document, send } = view(initial);
  try {
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    send(structuredClone(initial));
    assert.equal(observer.takeRecords().length, 0);
    observer.disconnect();
  } finally { dom.window.close(); }
});

test('changed card is patched, other cards and open form retain identity, focus and scroll', () => {
  const initial = state();
  const { dom, document, send } = view(initial);
  try {
    const zone = document.querySelector('.column-cards[data-status="proposed"]');
    const [a, b] = zone.querySelectorAll('.kanban-card');
    const otherColumn = document.querySelector('.kanban-column[data-status="active"]');
    const header = document.querySelector('.board-header');
    const form = document.createElement('div');
    form.className = 'new-task-form';
    form.innerHTML = '<input value="Draft task">';
    zone.appendChild(form);
    form.firstElementChild.focus();
    zone.scrollTop = 50;
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(otherColumn, { subtree: true, childList: true, attributes: true, characterData: true });
    const headerObserver = new dom.window.MutationObserver(() => {});
    headerObserver.observe(header, {subtree:true, childList:true, attributes:true, characterData:true});
    const next = structuredClone(initial);
    next.tasks.proposed[0].title = 'A revised';
    send(next);
    assert.equal(zone.querySelectorAll('.kanban-card')[0], a);
    assert.equal(zone.querySelectorAll('.kanban-card')[1], b);
    assert.equal(a.querySelector('.card-title').textContent, 'A revised');
    assert.equal(document.activeElement, form.firstElementChild);
    assert.equal(form.firstElementChild.value, 'Draft task');
    assert.equal(zone.scrollTop, 50);
    assert.equal(observer.takeRecords().length, 0);
    assert.equal(headerObserver.takeRecords().length, 0);
    const reordered = structuredClone(next);
    reordered.tasks.proposed.reverse();
    reordered.tasks.proposed[0].pinned = true;
    send(reordered);
    assert.equal(zone.querySelectorAll('.kanban-card')[0], b);
    assert.equal(b.querySelector('.card-pin-btn').getAttribute('aria-pressed'), 'true');
    assert.equal(document.activeElement, form.firstElementChild);
    assert.equal(zone.querySelector('.new-task-form'), form);
    assert.equal(zone.scrollTop, 50);
    const removed = structuredClone(reordered);
    removed.tasks.proposed = [removed.tasks.proposed[0]];
    send(removed);
    assert.equal(a.isConnected, false);
    assert.equal(zone.querySelector('.kanban-card'), b);
    assert.equal(zone.querySelector('.new-task-form'), form);
  } finally { dom.window.close(); }
});

test('sort control targets one column and saved choices migrate independently', () => {
  const initial = state();
  const { dom, document, messages } = view(initial);
  try {
    const select = document.querySelector('.column-sort-select[data-status="proposed"]');
    select.value = 'name-asc';
    select.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(JSON.parse(JSON.stringify(messages[0])), { command: 'setColumnSort', status: 'proposed', sort: 'name-asc' });
    assert.equal(document.querySelector('.column-sort-select[data-status="active"]').value, 'date-desc');
    const saved = getColumnSorts({proposed: 'name-asc', active: 'date-asc'}, 'name-desc');
    assert.equal(saved.proposed, 'name-asc');
    assert.equal(saved.active, 'date-asc');
    assert.equal(saved.closed, 'name-desc');
    assert.equal(getColumnSorts({proposed: 'invalid'}, null).proposed, 'date-desc');
    assert.equal(document.querySelector('#board-sort-select'), null);
  } finally { dom.window.close(); }
});

test('backend suppresses duplicate renders and keeps the webview document on updates', () => {
  const panel = Object.create(KanbanPanel.prototype);
  let current = state();
  const messages = [];
  let fullRenders = 0;
  panel._getBoardState = () => current;
  panel._buildHtml = () => { fullRenders++; return 'initial'; };
  panel._panel = {webview: {postMessage: msg => messages.push(msg)}};
  panel._update();
  panel._update();
  assert.equal(fullRenders, 1);
  assert.equal(messages.length, 0);
  current = structuredClone(current);
  current.tasks.proposed[0].title = 'Changed';
  panel._update();
  assert.equal(fullRenders, 1);
  assert.equal(messages.length, 1);
});


test('sidebar refresh without changes neither rebuilds HTML nor sends replacement content', () => {
  const provider = new KanbanSidebarProvider('/extension');
  const messages = [];
  let fullRenders = 0;
  provider._view = { webview: {postMessage: msg => messages.push(msg)} };
  provider._buildHtml = () => { fullRenders++; return 'initial'; };
  provider._getCurrentContentHtml = () => '<div>unchanged</div>';
  provider.refresh();
  provider.refresh();
  assert.equal(fullRenders, 1);
  assert.equal(messages.length, 0);
});

test('search replaces the heading, filters only its column and survives refresh', () => {
  const initial = state();
  const { dom, document, send } = view(initial);
  try {
    const column = document.querySelector('.kanban-column[data-status="proposed"]');
    const input = column.querySelector('.column-search');
    const title = column.querySelector('.column-title');
    assert.equal(input.hidden, true);
    column.querySelector('.column-search-toggle').click();
    assert.equal(title.hidden, true);
    assert.equal(input.hidden, false);
    assert.equal(document.activeElement, input);
    input.value = 'a.md';
    input.dispatchEvent(new dom.window.Event('input'));
    assert.deepEqual([...column.querySelectorAll('.kanban-card')].map(card => card.hidden), [false, true]);
    assert.equal(document.querySelector('.kanban-column[data-status="active"] .kanban-card').hidden, false);
    const next = structuredClone(initial);
    next.tasks.proposed.push(task('Z'));
    send(next);
    assert.equal(input.value, 'a.md');
    assert.equal(column.querySelector('.task-count').textContent, '1');
    assert.ok(column.querySelector('.col-header-left .task-count'));
    assert.ok(column.querySelector('.col-header-right .column-search-toggle'));
    assert.ok(column.querySelector('.col-header-right .column-sort-select'));
    input.value = 'no matching document';
    input.dispatchEvent(new dom.window.Event('input'));
    assert.equal(column.querySelector('.task-count').textContent, '0');
    assert.equal(column.querySelector('.task-count').classList.contains('empty'), true);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {key: 'Escape'}));
    assert.equal(input.hidden, true);
    assert.equal(title.hidden, false);
    assert.equal(column.querySelector('.task-count').textContent, '3');
    assert.equal(column.querySelectorAll('.kanban-card[hidden]').length, 0);
  } finally { dom.window.close(); }
});

test('untrusted document titles and goals are rendered as text, never executable markup', () => {
  const initial = state();
  const payload = '</script><script>window.compromised = true</script><img src=x onerror="window.compromised=true">';
  initial.tasks.proposed[0].title = payload;
  initial.goals.sections = [{title: payload, items: [{text: payload, completed: false}]}];
  const { dom, document, send } = view(initial);
  try {
    assert.equal(dom.window.compromised, undefined);
    assert.equal(document.querySelector('.kanban-card .card-title').textContent, payload);
    assert.equal(document.querySelector('img'), null);
    const next = structuredClone(initial);
    next.tasks.proposed[0].title = payload + ' updated';
    send(next);
    assert.equal(dom.window.compromised, undefined);
    assert.equal(document.querySelector('img'), null);
  } finally { dom.window.close(); }
});

test('visibility settings restore saved choices and stay hidden after document refresh', () => {
  const initial = state();
  initial.visibility = {goals: false, architecture: false, other: false, agents: false, save: false, refresh: false};
  initial.tasks.other = [task('Notes', 'other')];
  const {dom, document, send, messages} = view(initial);
  try {
    for (const selector of ['[data-tab="goals"]', '[data-tab="architecture"]', '[data-tab="other"]', '#agent-btn', '#save-changes-btn', '#refresh-btn']) {
      assert.equal(document.querySelector(selector).hidden, true, selector);
    }
    assert.equal(document.querySelector('[data-tab="board"]').hidden, false);
    assert.equal(document.querySelector('#settings-tab-btn').hidden, false);
    const toggle = document.querySelector('[data-visibility="goals"]');
    assert.equal(toggle.checked, false);
    toggle.checked = true;
    toggle.dispatchEvent(new dom.window.Event('change'));
    assert.deepEqual(JSON.parse(JSON.stringify(messages.at(-1))), {command:'setVisibility', item:'goals', enabled:true});
    const next = structuredClone(initial);
    next.visibility.goals = true;
    next.tasks.other.push(task('Another', 'other'));
    send(next);
    assert.equal(document.querySelector('[data-tab="goals"]').hidden, false);
    assert.equal(document.querySelector('[data-tab="other"]').hidden, true);
    document.querySelector('[data-tab="goals"]').click();
    assert.equal(document.querySelector('#goals-view').hidden, false);
    const hiddenAgain = structuredClone(next);
    hiddenAgain.visibility.goals = false;
    send(hiddenAgain);
    assert.equal(document.querySelector('#goals-view').hidden, true);
    assert.equal(document.querySelector('#board-view').hidden, false);
    assert.equal(toggle.checked, false);
    assert.equal(document.querySelector('[data-visibility-state="goals"]').textContent, 'Disabled');
    const restored = structuredClone(hiddenAgain);
    restored.visibility.other = true;
    send(restored);
    assert.equal(document.querySelector('[data-tab="other"]').hidden, false);
  } finally { dom.window.close(); }
});

test('status and count visibility restore independently and retain filtered counts', () => {
  const initial = state();
  initial.visibility = {status: false, count: false};
  const {dom, document, send} = view(initial);
  try {
    assert.equal(document.body.classList.contains('hide-status-indicators'), true);
    assert.equal(document.body.classList.contains('hide-document-counts'), true);
    assert.equal(document.querySelector('[data-visibility="status"]').checked, false);
    const column = document.querySelector('[data-status="proposed"].kanban-column');
    const input = column.querySelector('.column-search');
    input.value = 'a.md';
    input.dispatchEvent(new dom.window.Event('input'));
    const next = structuredClone(initial);
    next.visibility.count = true;
    send(next);
    assert.equal(document.body.classList.contains('hide-status-indicators'), true);
    assert.equal(document.body.classList.contains('hide-document-counts'), false);
    assert.equal(column.querySelector('.task-count').textContent, '1');
  } finally { dom.window.close(); }
});
