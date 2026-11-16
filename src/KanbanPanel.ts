import {
  VISIBILITY_KEY, VISIBILITY_ITEMS, Visibility, getVisibility, isVisibilityItem,
  PROJECT_ENABLED_KEY, UI_SCALE_KEY, UI_SCALES, isProjectEnabled, setProjectEnabled, getUiScale, setUiScale,
} from './preferences';
import { BOARD_SORT_KEY, COLUMN_SORT_KEY, getColumnSorts, BOARD_SORT_MODES, BoardSort, isBoardSort, sortBoardTasks } from './boardSorting';
import { esc, getNonce } from './html';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import {
  setTaskPinned, readTasks, createTask, moveTask, createDocsStructure, getDocsPath,
  isManagedDocument, deleteDocument, getWorkspaceRoot, saveDocsChanges, isValidTaskTitle,
  readGoals, insertGoalItem, insertGoalSection, toggleGoalItem,
  reorderGoalSection, updateGoalEntry, deleteGoalEntry, ensureGoalsFile,
} from './fileManager';
import { Task, TaskStatus, DEFAULT_COLUMN_ORDER, STATUS_COLORS, READONLY_STATUSES, GoalsState } from './types';
import { getLocale, getLangCode, setConfiguredLanguage } from './i18n';

const ORDER_KEY = 'kanban.columnOrder';
const SHOW_COPY_ICON_KEY = 'kanban.showCopyPathIcon';
const LANGUAGE_KEY = 'kanban.language';

interface BoardState {
  visibility: Visibility;
  columnSorts: Partial<Record<TaskStatus, BoardSort>>;
  tasks: Record<TaskStatus, Task[]>;
  docsExists: boolean;
  order: TaskStatus[];
  goals: GoalsState;
  showCopyPathIcon: boolean;
  uiScale: number;
  hasWorkspace: boolean;
}

export class KanbanPanel {
  public static currentPanel: KanbanPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _htmlLoaded = false;
  private _lastStateSignature = '';

  public static createOrShow(context: vscode.ExtensionContext): void {
    const savedLang = context.globalState.get<string>(LANGUAGE_KEY);
    if (savedLang) {
      setConfiguredLanguage(savedLang);
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (KanbanPanel.currentPanel) {
      KanbanPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'kanbanBoard',
      'Kanban Board',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    KanbanPanel.currentPanel = new KanbanPanel(panel, context);
  }

  public static refresh(): void {
    KanbanPanel.currentPanel?._update();
  }

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel   = panel;
    this._context = context;

    this._update();
    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string' || vscode.workspace.isTrusted === false) { return; }
      try {
        if (!isProjectEnabled() && !['setVisibility', 'setColumnSort', 'toggleProject', 'setUiScale', 'setLanguage', 'toggleCopyPathIcon', 'openExternal', 'refresh'].includes(msg.command)) {
          return;
        }
        switch (msg.command) {
          case 'setVisibility': {
            const item: unknown = msg.item;
            if (!isVisibilityItem(item) || typeof msg.enabled !== 'boolean') { break; }
            const visibility = getVisibility(this._context.workspaceState.get(VISIBILITY_KEY));
            visibility[item] = msg.enabled;
            try {
              await this._context.workspaceState.update(VISIBILITY_KEY, visibility);
              this._update();
            } finally {
              this._panel.webview.postMessage({ command: 'visibilitySettings', visibility: getVisibility(this._context.workspaceState.get(VISIBILITY_KEY)) });
            }
            break;
          }
          case 'setColumnSort': {
            if (isBoardSort(msg.sort) && DEFAULT_COLUMN_ORDER.includes(msg.status)) {
              const columnSorts = getColumnSorts(this._context.workspaceState.get(COLUMN_SORT_KEY), this._context.workspaceState.get(BOARD_SORT_KEY));
              columnSorts[msg.status as TaskStatus] = msg.sort;
              await this._context.workspaceState.update(COLUMN_SORT_KEY, columnSorts);
              this._update();
            }
            break;
          }
          case 'setTaskPinned': {
            if (typeof msg.filePath !== 'string' || typeof msg.pinned !== 'boolean') { break; }
            try {
              setTaskPinned(msg.filePath, msg.pinned);
            } catch (error) {
              vscode.window.showErrorMessage(`${getLocale().pinFailed}: ${String(error)}`);
            } finally {
              this._update();
            }
            break;
          }
          case 'toggleProject': {
            try {
              if (msg.enabled === true) {
                const result = createDocsStructure();
                if (result === 'no-workspace') {
                  vscode.window.showErrorMessage(getLocale().saveChangesNoWorkspace);
                  break;
                }
              }
              const enabled = msg.enabled === true;
              await this._context.workspaceState.update(PROJECT_ENABLED_KEY, enabled);
              setProjectEnabled(enabled);
            } catch (error) {
              vscode.window.showErrorMessage(String(error));
            } finally {
              this._update();
              this._panel.webview.postMessage({ command: 'toggleProjectDone' });
              vscode.commands.executeCommand('kanban-vsc.refreshSidebar');
            }
            break;
          }
          case 'setUiScale': {
            if (typeof msg.scale === 'number' && UI_SCALES.includes(msg.scale)) {
              await this._context.workspaceState.update(UI_SCALE_KEY, msg.scale);
              setUiScale(msg.scale);
              this._update();
              vscode.commands.executeCommand('kanban-vsc.refreshSidebar');
            }
            break;
          }
          case 'moveTask': {
            const newPath = await moveTask(msg.filePath as string, msg.newStatus as TaskStatus);
            if (newPath) { this._update(); }
            break;
          }
          case 'createTask': {
            const rawTitle = String(msg.title ?? '');
            if (!isValidTaskTitle(rawTitle)) {
              vscode.window.showErrorMessage(getLocale().invalidTaskTitle);
              break;
            }
            const filePath = await createTask(rawTitle, msg.status as TaskStatus);
            if (filePath) {
              this._update();
              const doc = await vscode.workspace.openTextDocument(filePath);
              await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            break;
          }
          case 'openFile': {
            if (!isManagedDocument(msg.filePath)) { break; }
            const filePath = msg.filePath;
            try {
              if (filePath.toLowerCase().endsWith('.md')) {
                await vscode.commands.executeCommand(
                  'markdown.showPreviewToSide',
                  vscode.Uri.file(filePath)
                );
              } else {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
              }
            } catch {
              try {
                await vscode.commands.executeCommand(
                  'vscode.open',
                  vscode.Uri.file(filePath),
                  vscode.ViewColumn.Beside
                );
              } catch {
                vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
              }
            }
            break;
          }
          case 'openAgents': {
            const agentsPath = this._resolveAgentsPath();
            if (agentsPath) {
              const doc = await vscode.workspace.openTextDocument(agentsPath);
              await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            break;
          }
          case 'createDocs': {
            const t      = getLocale();
            const result = createDocsStructure();
            if (result === 'created') {
              this._update();
              vscode.window.showInformationMessage(t.docsCreated);
            } else if (result === 'already-exists') {
              vscode.window.showWarningMessage(t.docsAlreadyExists);
            } else {
              vscode.window.showErrorMessage(t.saveChangesNoWorkspace);
            }
            break;
          }
          case 'saveDocsChanges': {
            const t = getLocale();
            try {
              const result = await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: t.savingChanges,
                  cancellable: false,
                },
                () => saveDocsChanges()
              );

              switch (result.status) {
                case 'committed':
                  vscode.window.showInformationMessage(`${t.saveChangesCommitted} ${result.hash}`);
                  break;
                case 'no-changes':
                  vscode.window.showInformationMessage(t.saveChangesNoChanges);
                  break;
                case 'no-docs':
                  vscode.window.showWarningMessage(t.saveChangesNoDocs);
                  break;
                case 'not-git-repo':
                  vscode.window.showWarningMessage(t.saveChangesNotGitRepo);
                  break;
                case 'no-workspace':
                  vscode.window.showErrorMessage(t.saveChangesNoWorkspace);
                  break;
                case 'git-error':
                  vscode.window.showErrorMessage(`${t.saveChangesGitError}: ${result.message}`);
                  break;
              }
            } finally {
              this._panel.webview.postMessage({ command: 'saveDocsChangesDone' });
            }
            break;
          }
          case 'reorderColumns': {
            if (!Array.isArray(msg.order) || msg.order.length !== DEFAULT_COLUMN_ORDER.length ||
                new Set(msg.order).size !== DEFAULT_COLUMN_ORDER.length ||
                !msg.order.every((status: unknown) => DEFAULT_COLUMN_ORDER.includes(status as TaskStatus))) { break; }
            const order = msg.order as TaskStatus[];
            await this._context.workspaceState.update(ORDER_KEY, order);
            this._update();
            break;
          }
          case 'insertGoalItem': {
            if (insertGoalItem(Number(msg.sectionIndex), Number(msg.afterItemIndex), String(msg.text ?? ''))) {
              this._update();
            }
            break;
          }
          case 'insertGoalSection': {
            if (insertGoalSection(Number(msg.sectionIndex), Number(msg.afterItemIndex), String(msg.title ?? ''))) {
              this._update();
            }
            break;
          }
          case 'toggleGoalItem': {
            if (toggleGoalItem(Number(msg.sectionIndex), Number(msg.itemIndex))) {
              this._update();
            }
            break;
          }
          case 'reorderGoalSection': {
            if (reorderGoalSection(Number(msg.fromIndex), Number(msg.toIndex))) {
              this._update();
            }
            break;
          }
          case 'updateGoalEntry': {
            const itemIndex = msg.itemIndex === null || msg.itemIndex === undefined ? null : Number(msg.itemIndex);
            if (updateGoalEntry(Number(msg.sectionIndex), itemIndex, String(msg.text ?? ''))) {
              this._update();
            }
            break;
          }
          case 'deleteGoalEntry': {
            const itemIndex = msg.itemIndex === null || msg.itemIndex === undefined ? null : Number(msg.itemIndex);
            if (deleteGoalEntry(Number(msg.sectionIndex), itemIndex)) {
              this._update();
            }
            break;
          }
          case 'openGoalsFile': {
            const goalsPath = ensureGoalsFile();
            if (goalsPath) {
              const doc = await vscode.workspace.openTextDocument(goalsPath);
              await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            }
            break;
          }
          case 'copyPath': {
            const relPath = String(msg.relPath ?? '');
            if (relPath) {
              await vscode.env.clipboard.writeText(relPath);
              vscode.window.setStatusBarMessage(`${getLocale().copiedPath}: ${relPath}`, 2500);
            }
            break;
          }
          case 'toggleCopyPathIcon': {
            await this._context.workspaceState.update(SHOW_COPY_ICON_KEY, Boolean(msg.enabled));
            this._update();
            break;
          }
          case 'setLanguage': {
            const lang = String(msg.language ?? 'en');
            await this._context.globalState.update(LANGUAGE_KEY, lang);
            setConfiguredLanguage(lang);
            this._htmlLoaded = false;
            this._update();
            vscode.commands.executeCommand('kanban-vsc.refreshSidebar');
            break;
          }
          case 'openExternal': {
            const url = String(msg.url ?? '');
            if (url === 'https://github.com/veizeczek') {
              vscode.env.openExternal(vscode.Uri.parse(url));
            }
            break;
          }
          case 'deleteFile': {
            if (await deleteDocument(msg.filePath)) { this._update(); }
            break;
          }
          case 'refresh': {
            try {
              this._update();
              await vscode.commands.executeCommand('kanban-vsc.refreshSidebar', false);
              this._panel.webview.postMessage({ command: 'refreshDone', success: true });
            } catch (error) {
              vscode.window.showErrorMessage(`${getLocale().refreshFailed}: ${String(error)}`);
              this._panel.webview.postMessage({ command: 'refreshDone', success: false });
            }
            break;
          }
        }
      } catch (error) { vscode.window.showErrorMessage(String(error)); }
    }, null, this._disposables);
  }

  private _getColumnOrder(): TaskStatus[] {
    const saved = this._context.workspaceState.get<TaskStatus[]>(ORDER_KEY);
    if (!saved) { return [...DEFAULT_COLUMN_ORDER]; }
    const filtered = saved.filter((s): s is TaskStatus => DEFAULT_COLUMN_ORDER.includes(s));
    for (const col of DEFAULT_COLUMN_ORDER) {
      if (!filtered.includes(col)) { filtered.push(col); }
    }
    return filtered;
  }

  private _resolveAgentsPath(): string | null {
    // Workspace AGENTS.md first, then extension's own
    const root = getWorkspaceRoot();
    if (root) {
      const ws = path.join(root, 'AGENTS.md');
      if (fs.existsSync(ws)) { return ws; }
    }
    const ext = vscode.Uri.joinPath(this._context.extensionUri, 'AGENTS.md').fsPath;
    return fs.existsSync(ext) ? ext : null;
  }

  private _getBoardState(): BoardState {
    const columnSorts = getColumnSorts(this._context.workspaceState.get(COLUMN_SORT_KEY), this._context.workspaceState.get(BOARD_SORT_KEY));
    const tasks = readTasks();
    for (const status of DEFAULT_COLUMN_ORDER) {
      tasks[status] = sortBoardTasks(tasks[status], columnSorts[status]!, getLangCode());
    }
    return {
      visibility: getVisibility(this._context.workspaceState.get(VISIBILITY_KEY)),
      columnSorts,
      uiScale: getUiScale(),
      hasWorkspace: getWorkspaceRoot() !== null,
      tasks,
      docsExists: getDocsPath() !== null,
      order: this._getColumnOrder(),
      goals: readGoals(),
      showCopyPathIcon: this._context.workspaceState.get<boolean>(SHOW_COPY_ICON_KEY) ?? true,
    };
  }

  private _update(): void {
    const state = this._getBoardState();
    const signature = JSON.stringify(state);
    if (this._htmlLoaded && signature === this._lastStateSignature) { return; }
    this._lastStateSignature = signature;
    if (!this._htmlLoaded) {
      this._panel.webview.html = this._buildHtml(state);
      this._htmlLoaded = true;
      return;
    }

    this._panel.webview.postMessage({ command: 'renderTasks', state });
  }

  private _buildHtml(state: BoardState): string {
    const webview = this._panel.webview;
    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'icons.css'));
    const nonce   = getNonce();
    const t       = getLocale();
    const visibility = getVisibility(state.visibility);

    const picoUri   = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'pico.min.css'));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js'));

    const columnsHtml = state.order.map(status => {
      const isReadOnly  = READONLY_STATUSES.includes(status);
      const color       = STATUS_COLORS[status];
      const label       = t.columns[status];
      const columnTasks = state.tasks[status];
      const hasItems    = columnTasks.length > 0;

      const cardsHtml = columnTasks.map(task => `
        <div class="kanban-card${task.pinned ? ' is-pinned' : ''}"
             draggable="true"
             data-file-path="${esc(task.filePath)}"
             data-status="${task.status}">
          <div class="card-top">
            <div class="card-title" data-file-path="${esc(task.filePath)}">${esc(task.title)}</div>
            <button class="card-pin-btn" type="button" draggable="false"
                    data-file-path="${esc(task.filePath)}" aria-pressed="${Boolean(task.pinned)}"
                    title="${esc(task.pinned ? t.unpinTask : t.pinTask)}" aria-label="${esc(task.pinned ? t.unpinTask : t.pinTask)}">
              <span class="material-icon mi-push_pin" aria-hidden="true"></span>
            </button>
            <button class="card-copy-btn"
                    type="button"
                    draggable="false"
                    data-rel-path="${esc(task.relPath)}"
                    title="${esc(t.copyPath)}: ${esc(task.relPath)}"
                    aria-label="${esc(t.copyPath)}">
              <span class="material-icon mi-content_copy icon-copy" aria-hidden="true"></span>
              <span class="material-icon mi-check icon-check" aria-hidden="true"></span>
            </button>
          </div>
          <div class="card-date">${esc(task.date)}</div>
        </div>
      `).join('');

      return `
        <div class="kanban-column" data-status="${status}" style="--col-color: ${color}">
          <div class="column-header" draggable="true" data-status="${status}">
            <div class="col-header-left">
              ${hasItems ? `<span class="active-dot"></span>` : ''}
              <span class="column-title">${esc(label)}</span>
              <input class="column-search" type="search" hidden draggable="false"
                     placeholder="${esc(t.searchTasks)}" aria-label="${esc(t.searchTasks)}: ${esc(label)}">
              <span class="task-count${hasItems ? '' : ' empty'}">${columnTasks.length}</span>
            </div>
            <div class="col-header-right">
              <button class="column-search-toggle" type="button" draggable="false" aria-expanded="false"
                      aria-label="${esc(t.searchTasks)}: ${esc(label)}" title="${esc(t.searchTasks)}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="10" cy="10" r="6"></circle><path d="m15 15 6 6"></path></svg>
              </button>
              <label class="column-sort-control" draggable="false">
                <span class="material-icon mi-sort" aria-hidden="true"></span>
                <select class="column-sort-select" data-status="${status}" draggable="false"
                        aria-label="${esc(t.sortBoard)}: ${esc(label)}" title="${esc(t.boardSortOptions[state.columnSorts[status]!])}">
                  ${BOARD_SORT_MODES.map(mode => `<option value="${mode}"${state.columnSorts[status] === mode ? ' selected' : ''}>${esc(t.boardSortOptions[mode])}</option>`).join('')}
                </select>
              </label>
            </div>
          </div>
          <div class="column-cards${columnTasks.length > 0 ? ' has-items' : ''}" data-status="${status}" data-drop-ok="${isReadOnly ? 'false' : 'true'}">
            ${cardsHtml}
          </div>
          <p class="column-search-empty" hidden role="status">${esc(t.noSearchResults)}</p>
          <button class="add-task-btn" data-status="${status}" title="${t.add}" aria-label="${t.add}"><span class="material-icon mi-add" aria-hidden="true"></span></button>
        </div>
      `;
    }).join('');

    const saveBtn = `<button id="save-changes-btn" class="btn-save"${visibility.save ? '' : ' hidden'}${state.docsExists ? '' : ' disabled'} title="${esc(t.saveChanges)}" aria-label="${esc(t.saveChanges)}"><span class="material-icon mi-save" aria-hidden="true"></span></button>`;

    return `<!DOCTYPE html>
<html lang="${getLangCode()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${picoUri}">
  <link rel="stylesheet" href="${styleUri}">
  <link rel="stylesheet" href="${iconsUri}">
  <title>${t.boardTitle}</title>
</head>
<body style="zoom: ${state.uiScale / 100}; height: ${10000 / state.uiScale}%;" class="${state.showCopyPathIcon ? '' : 'hide-copy-icon'} ${visibility.status ? '' : 'hide-status-indicators'} ${visibility.count ? '' : 'hide-document-counts'}">
  <header class="board-header">
    <div class="header-navigation">
    <div class="header-tabs" role="tablist">
      <button class="tab-btn active" data-tab="board" role="tab" aria-selected="true">${esc(t.tabBoard)}</button>
      <button class="tab-btn" data-tab="goals"${visibility.goals ? '' : ' hidden'} role="tab" aria-selected="false">${esc(t.tabGoals)}</button>
      <button class="tab-btn" data-tab="architecture"${visibility.architecture ? '' : ' hidden'} role="tab" aria-selected="false">${esc(t.tabArchitecture)}</button>
      <button id="tab-btn-other" class="tab-btn" data-tab="other" role="tab" aria-selected="false"${visibility.other && (state.tasks.other?.length ?? 0) > 0 ? '' : ' hidden'}>${esc(t.tabOther ?? 'Other')}</button>
    </div>
      <button id="agent-btn" class="btn-icon"${visibility.agents ? '' : ' hidden'} title="${esc(t.agent)}" aria-label="${esc(t.agent)}"><span class="material-icon mi-smart_toy" aria-hidden="true"></span></button>
    </div>
    <div class="header-actions">
      ${saveBtn}
      <button id="refresh-btn" class="btn-icon"${visibility.refresh ? '' : ' hidden'} title="${esc(t.refresh)}" aria-label="${esc(t.refresh)}"><span class="material-icon mi-refresh" aria-hidden="true"></span></button>
      <button id="settings-tab-btn" class="btn-icon tab-btn" data-tab="settings" role="tab" aria-selected="false" title="${esc(t.tabSettings)}" aria-label="${esc(t.tabSettings)}"><span class="material-icon mi-settings" aria-hidden="true"></span></button>
    </div>
  </header>
  <span id="refresh-status" class="sr-only" role="status" aria-live="polite"></span>
  <div id="board-view" class="kanban-board">
    ${columnsHtml}
  </div>
  <div id="goals-view" class="goals-view" hidden></div>
  <div id="architecture-view" class="architecture-view" hidden></div>
  <div id="other-view" class="other-view" hidden></div>
  <div id="settings-view" class="settings-view" hidden>
    <div class="settings-section">
      <div class="settings-section-header"><span class="settings-section-title">${esc(t.settingsProjectHeading)}</span></div>
      <div class="settings-row">
        <label class="settings-checkbox-row" for="project-enabled-toggle">
          <input type="checkbox" role="switch" id="project-enabled-toggle" aria-describedby="project-setting-description"${state.docsExists ? ' checked' : ''}${state.hasWorkspace ? '' : ' disabled'}>
          <span>${esc(t.createDocs)}</span>
        </label>
        <span id="project-state" class="settings-state${state.docsExists ? ' is-on' : ''}" role="status">${esc(state.docsExists ? t.settingsEnabled : t.settingsDisabled)}</span>
      </div>
      <p id="project-setting-description" class="settings-desc">${esc(t.settingsProjectToggleDesc)}</p>
    </div>
    <div class="settings-section">
      <div class="settings-section-header"><span class="settings-section-title">${esc(t.settingsUiHeading)}</span></div>
      <div class="settings-row">
        <label for="settings-language-select" class="settings-label">${esc(t.settingsLanguageLabel)}</label>
        <select id="settings-language-select" class="settings-select">
          <option value="pl"${getLangCode() === 'pl' ? ' selected' : ''}>${esc(t.languagePl)}</option>
          <option value="en"${getLangCode() === 'en' ? ' selected' : ''}>${esc(t.languageEn)}</option>
        </select>
      </div>
      <div class="settings-row">
        <label for="settings-scale-select" class="settings-label">${esc(t.settingsScaleLabel)}</label>
        <select id="settings-scale-select" class="settings-select">
          ${UI_SCALES.map(scale => `<option value="${scale}"${state.uiScale === scale ? ' selected' : ''}>${scale}%${scale === 100 ? ` — ${esc(t.settingsScaleDefault)}` : ''}</option>`).join('')}
        </select>
      </div>

    </div>

    <section class="settings-section settings-visibility" aria-labelledby="visibility-heading">
      <div class="settings-section-header"><span id="visibility-heading" class="settings-section-title">${esc(t.settingsVisibilityHeading)}</span></div>
      <p class="settings-desc">${esc(t.settingsVisibilityDesc)}</p>
      ${[t.settingsVisibilityTabs, t.settingsVisibilityActions, t.settingsVisibilityColumns].map((heading, group) => `
        <h3 class="settings-subheading">${esc(heading)}</h3>
        ${VISIBILITY_ITEMS.slice(group * 3, (group + 1) * 3).map(key => {
          const labels = { goals: t.tabGoals, architecture: t.tabArchitecture, other: t.tabOther, agents: t.agent, save: t.saveChanges, refresh: t.refresh, status: t.settingsVisibilityStatus, count: t.settingsVisibilityCount };
          return `<div class="settings-row">
            <label class="settings-checkbox-row" for="visibility-${key}">
              <input id="visibility-${key}" type="checkbox" role="switch" data-visibility="${key}"${visibility[key] ? ' checked' : ''}>
              <span>${esc(labels[key])}</span>
            </label>
            <span class="settings-state${visibility[key] ? ' is-on' : ''}" data-visibility-state="${key}" role="status">${esc(visibility[key] ? t.settingsEnabled : t.settingsDisabled)}</span>
          </div>`;
        }).join('')}
      `).join('')}
      <div class="settings-row">
        <label class="settings-checkbox-row" for="toggle-copy-icon-checkbox">
          <input type="checkbox" role="switch" id="toggle-copy-icon-checkbox"${state.showCopyPathIcon ? ' checked' : ''}>
          <span>${esc(t.showCopyIconLabel)}</span>
        </label>
        <span id="copy-visibility-state" class="settings-state${state.showCopyPathIcon ? ' is-on' : ''}" role="status">${esc(state.showCopyPathIcon ? t.settingsEnabled : t.settingsDisabled)}</span>
      </div>
    </section>

    <div class="settings-footer">
      <span class="settings-footer-text">${esc(t.settingsAuthorsHeading)}:</span>
      <a href="https://github.com/veizeczek" id="author-link" class="settings-author-link" target="_blank" rel="noopener noreferrer">github.com/veizeczek</a>
    </div>
  </div>
  <script nonce="${nonce}">
    const I18N = ${JSON.stringify({
      settingsEnabled: t.settingsEnabled,
      settingsDisabled: t.settingsDisabled,
      refresh: t.refresh,
      refreshing: t.refreshing,
      refreshed: t.refreshed,
      refreshFailed: t.refreshFailed,
      pinTask: t.pinTask,
      unpinTask: t.unpinTask,
      placeholder: t.newTaskPlaceholder,
      invalidTitle: t.invalidTaskTitle,
      dateLabel: t.newTaskDateLabel,
      add: t.add,
      cancel: t.cancel,
      columns: t.columns,
      copyPath: t.copyPath,
      insertGoalTooltip: t.insertGoalTooltip,
      insertSectionTooltip: t.insertSectionTooltip,
      deleteEntryTooltip: t.deleteEntryTooltip,
      newSectionPlaceholder: t.newSectionPlaceholder,
      newGoalPlaceholder: t.newGoalPlaceholder,
      goalsNoDocs: t.goalsNoDocs,
      archEmpty: t.archEmpty,
      addArchDoc: t.addArchDoc,
      addDoc: t.addDoc,
      deleteDocTooltip: t.deleteDocTooltip,
      tabOther: t.tabOther ?? 'Other',
      otherEmpty: t.otherEmpty,
    }).replace(/</g, '\\u003c')};
    const INITIAL_BOARD_STATE = ${JSON.stringify(state).replace(/</g, '\\u003c')};
    const INITIAL_GOALS_STATE = ${JSON.stringify({
      goals: state.goals,
      architectureTasks: state.tasks.architecture,
      otherTasks: state.tasks.other ?? [],
      docsExists: state.docsExists,
    }).replace(/</g, '\\u003c')};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    KanbanPanel.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) { this._disposables.pop()?.dispose(); }
  }
}
