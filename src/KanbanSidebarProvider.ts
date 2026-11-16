import { getUiScale, isProjectEnabled } from './preferences';
import * as vscode from 'vscode';
import * as path from 'path';
import { isManagedDocument, readTasks, getDocsPath, moveTask, readGoals, toggleGoalItem, deleteGoalEntry } from './fileManager';
import { SIDEBAR_STATUS_ORDER, STATUS_COLORS, Task, TaskStatus, GoalsState } from './types';
import { getLocale, getLangCode } from './i18n';
import { KanbanPanel } from './KanbanPanel';
import { esc, getNonce } from './html';

export class KanbanSidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'kanban-vsc.sidebar';

  private _view?: vscode.WebviewView;
  private readonly _extensionUri: vscode.Uri;
  private _htmlLoaded = false;
  private _lastContentSignature = '';

  private _activeView: 'board' | 'goals' = 'board';

  constructor(extensionUri: vscode.Uri) {
    this._extensionUri = extensionUri;
  }

  public refresh(forceRebuild = false): void {
    if (forceRebuild) {
      this._htmlLoaded = false;
    }
    if (this._view) { this._update(); }
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };
    this._update();

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg !== 'object' || typeof msg.command !== 'string' || vscode.workspace.isTrusted === false) { return; }
      try {
        if (!isProjectEnabled() && !['openBoard', 'toggleSidebarView'].includes(msg.command)) { return; }
        switch (msg.command) {
          case 'openFile': {
            if (!isManagedDocument(msg.filePath)) { break; }
            const filePath = msg.filePath;
            try {
              if (filePath.toLowerCase().endsWith('.md')) {
                await vscode.commands.executeCommand(
                  'markdown.showPreview',
                  vscode.Uri.file(filePath)
                );
              } else {
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
              }
            } catch {
              try {
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath));
              } catch { /* ignore */ }
            }
            break;
          }
          case 'moveTask':
            // file watcher will refresh sidebar + main panel automatically
            await moveTask(msg.filePath as string, msg.newStatus as TaskStatus);
            break;
          case 'openBoard':
            vscode.commands.executeCommand('kanban-vsc.open');
            break;
          case 'toggleSidebarView':
            this._activeView = this._activeView === 'board' ? 'goals' : 'board';
            this._update();
            break;
          case 'toggleGoalItem':
            toggleGoalItem(Number(msg.sectionIndex), Number(msg.itemIndex));
            this._update();
            KanbanPanel.refresh();
            break;
          case 'deleteGoalEntry': {
            const itemIndex = msg.itemIndex === null || msg.itemIndex === undefined ? null : Number(msg.itemIndex);
            if (deleteGoalEntry(Number(msg.sectionIndex), itemIndex)) {
              this._update();
              KanbanPanel.refresh();
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
        }
      } catch (error) { vscode.window.showErrorMessage(String(error)); }
    });
  }

  private _getToggleBtnText(t: ReturnType<typeof getLocale>): string {
    return this._activeView === 'board'
      ? t.sidebarSwitchToGoals
      : t.sidebarSwitchToBoard;
  }

  private _getCurrentContentHtml(
    tasks: Record<TaskStatus, Task[]>,
    docsExists: boolean,
    t: ReturnType<typeof getLocale>
  ): string {
    return this._activeView === 'board'
      ? this._buildSidebarRowsHtml(tasks, docsExists, t)
      : this._buildSidebarGoalsHtml(readGoals(), docsExists, t);
  }

  private _update(): void {
    if (!this._view) { return; }
    const t          = getLocale();
    const tasks      = readTasks();
    const docsExists = getDocsPath() !== null;

    const content = this._getCurrentContentHtml(tasks, docsExists, t);
    const signature = JSON.stringify([content, this._activeView]);
    if (this._htmlLoaded && signature === this._lastContentSignature) { return; }
    this._lastContentSignature = signature;
    if (!this._htmlLoaded) {
      this._view.webview.html = this._buildHtml(tasks, docsExists, t);
      this._htmlLoaded = true;
      return;
    }

    this._view.webview.postMessage({
      command: 'renderSidebar',
      html: content,
      toggleBtnText: this._getToggleBtnText(t),
      toggleIcon: this._activeView === 'board' ? 'flag' : 'view_kanban',
      openBoardText: t.openBoard ?? 'Open board',
    });
  }

  private _buildSidebarGoalsHtml(
    goals: GoalsState,
    docsExists: boolean,
    t: ReturnType<typeof getLocale>
  ): string {
    if (!docsExists) {
      return `<div class="empty-msg">${esc(t.noDocsEmpty)}</div>`;
    }

    if (goals.sections.length === 0 || goals.sections.every(s => s.items.length === 0)) {
      return `<div class="empty-msg">${esc(t.goalsNoDocs)}</div>`;
    }

    return goals.sections.map((section, sIdx) => {
      const itemsHtml = section.items.map((item, iIdx) => `
        <div class="sidebar-goal-row${item.completed ? ' completed' : ''}" data-section="${sIdx}" data-item="${iIdx}">
          <input type="checkbox"
                 class="sidebar-goal-checkbox"
                 data-section="${sIdx}"
                 data-item="${iIdx}"
                 ${item.completed ? 'checked' : ''}>
          <span class="sidebar-goal-text">${esc(item.text)}</span>
          <button type="button"
                  class="sidebar-goal-delete-btn"
                  data-section="${sIdx}"
                  data-item="${iIdx}"
                  title="${esc(t.deleteEntryTooltip)}" aria-label="${esc(t.deleteEntryTooltip)}"><span class="material-icon mi-delete" aria-hidden="true"></span></button>
        </div>
      `).join('');

      return `
        <div class="sidebar-goal-section" data-section="${sIdx}">
          <div class="sidebar-goal-section-header">
            <span class="sidebar-goal-section-title">${esc(section.title)}</span>
            <button type="button"
                    class="sidebar-goal-delete-btn"
                    data-section="${sIdx}"
                    data-item=""
                    title="${esc(t.deleteEntryTooltip)}" aria-label="${esc(t.deleteEntryTooltip)}"><span class="material-icon mi-delete" aria-hidden="true"></span></button>
          </div>
          ${itemsHtml}
        </div>
      `;
    }).join('');
  }

  private _buildSidebarRowsHtml(
    tasks: Record<TaskStatus, Task[]>,
    docsExists: boolean,
    t: ReturnType<typeof getLocale>
  ): string {
    const docsPath = getDocsPath();

    const rowsHtml = SIDEBAR_STATUS_ORDER.map(status => {
      const colTasks = tasks[status] ?? [];
      if (status === 'other' && colTasks.length === 0) {
        return '';
      }
      const label = t.columns[status];

      const taskRows = colTasks.map(task => {
        const relPath = docsPath
          ? `docs/${path.relative(docsPath, task.filePath).split(path.sep).join('/')}`
          : path.basename(task.filePath);

        return `
        <div class="task-row" data-fp="${esc(task.filePath)}" title="${esc(task.title)}">
          <span class="dot s-${status}"></span>
          <span class="task-name">${esc(task.title)}</span>
          <button class="copy-path-btn"
                  type="button"
                  draggable="false"
                  data-rel-path="${esc(relPath)}"
                  title="${esc(t.copyPath)}: ${esc(relPath)}"
                  aria-label="${esc(t.copyPath)}">
            <span class="material-icon mi-content_copy icon-copy" aria-hidden="true"></span>
            <span class="material-icon mi-check icon-check" aria-hidden="true"></span>
          </button>
        </div>
      `;
      }).join('');

      return `
        <div class="group${colTasks.length === 0 ? ' empty' : ''}" data-status="${status}">
          <div class="group-label s-${status}">${esc(label)}<span class="group-count">${colTasks.length}</span></div>
          ${taskRows}
        </div>
      `;
    }).join('');

    const contentBody = !docsExists
      ? `<div class="empty-msg">${esc(t.noDocsEmpty)}</div>`
      : rowsHtml;

    return contentBody;
  }

  private _buildContentHtml(
    tasks: Record<TaskStatus, Task[]>,
    docsExists: boolean,
    t: ReturnType<typeof getLocale>
  ): string {
    const openBoardBtn = `<button id="open-board" class="open-board-btn" title="${esc(t.openBoard ?? 'Open board')}" aria-label="${esc(t.openBoard ?? 'Open board')}"><span class="material-icon mi-open_in_new" aria-hidden="true"></span></button>`;
    const contentBody  = this._getCurrentContentHtml(tasks, docsExists, t);
    const bottomBar    = `
      <div class="sidebar-bottom-bar">
        <button id="sidebar-view-toggle" class="sidebar-green-btn" type="button" title="${esc(this._getToggleBtnText(t))}" aria-label="${esc(this._getToggleBtnText(t))}"><span class="material-icon mi-${this._activeView === 'board' ? 'flag' : 'view_kanban'}" aria-hidden="true"></span></button>
      </div>
    `;

    return `${openBoardBtn}<div id="sidebar-content">${contentBody}</div>${bottomBar}`;
  }

  private _buildHtml(
    tasks: Record<TaskStatus, Task[]>,
    docsExists: boolean,
    t: ReturnType<typeof getLocale>
  ): string {
    const webview    = this._view!.webview;
    const nonce      = getNonce();

    const iconsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'icons.css'));
    const sidebarUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'media', 'sidebar.css')
    );

    // Build CSS variables for each status color (avoids inline styles / CSP issues)
    const colorVars = (Object.entries(STATUS_COLORS) as [TaskStatus, string][])
      .map(([s, c]) => `.s-${s} { --c: ${c}; }`)
      .join('\n    ');

    const body = this._buildContentHtml(tasks, docsExists, t);

    return `<!DOCTYPE html>
<html lang="${getLangCode()}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${sidebarUri}">
  <link rel="stylesheet" href="${iconsUri}">
  <style>
    ${colorVars}
  </style>
</head>
<body style="zoom: ${getUiScale() / 100}; min-height: ${10000 / getUiScale()}vh;">
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let dragging = { fp: null, status: null };

    function bindSidebarContent(root) {
      root.querySelectorAll('.sidebar-goal-checkbox').forEach(cb => {
        if (cb.dataset.boundSidebarGoal === 'true') { return; }
        cb.dataset.boundSidebarGoal = 'true';

        cb.addEventListener('change', () => {
          vscode.postMessage({
            command: 'toggleGoalItem',
            sectionIndex: Number(cb.dataset.section),
            itemIndex: Number(cb.dataset.item)
          });
        });
      });

      root.querySelectorAll('.sidebar-goal-delete-btn').forEach(btn => {
        if (btn.dataset.boundSidebarDelete === 'true') { return; }
        btn.dataset.boundSidebarDelete = 'true';

        btn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          const rawItem = btn.dataset.item;
          vscode.postMessage({
            command: 'deleteGoalEntry',
            sectionIndex: Number(btn.dataset.section),
            itemIndex: rawItem === '' || rawItem === undefined ? null : Number(rawItem)
          });
        });
      });

      root.querySelectorAll('.copy-path-btn').forEach(btn => {
        if (btn.dataset.boundCopy === 'true') { return; }
        btn.dataset.boundCopy = 'true';

        btn.addEventListener('dragstart', e => {
          e.preventDefault();
          e.stopPropagation();
        });

        btn.addEventListener('click', e => {
          e.preventDefault();
          e.stopPropagation();
          const relPath = btn.dataset.relPath;
          if (!relPath) { return; }
          vscode.postMessage({ command: 'copyPath', relPath });
          btn.classList.add('copied');
          setTimeout(() => btn.classList.remove('copied'), 1200);
        });
      });

      root.querySelectorAll('.task-row').forEach(row => {
        if (row.dataset.boundSidebarRow === 'true') { return; }
        row.dataset.boundSidebarRow = 'true';
        row.setAttribute('draggable', 'true');

        row.addEventListener('click', () =>
          vscode.postMessage({ command: 'openFile', filePath: row.dataset.fp })
        );

        row.addEventListener('dragstart', e => {
          dragging.fp     = row.dataset.fp;
          dragging.status = row.closest('.group').dataset.status;
          e.dataTransfer.effectAllowed = 'move';
          setTimeout(() => row.classList.add('dragging'), 0);
        });

        row.addEventListener('dragend', () => {
          row.classList.remove('dragging');
          dragging = { fp: null, status: null };
          document.querySelectorAll('.group').forEach(g => g.classList.remove('drop-target'));
        });
      });

      root.querySelectorAll('.group').forEach(group => {
        if (group.dataset.boundSidebarGroup === 'true') { return; }
        group.dataset.boundSidebarGroup = 'true';

        group.addEventListener('dragover', e => {
          if (!dragging.fp || group.dataset.status === dragging.status) { return; }
          e.preventDefault();
          document.querySelectorAll('.group').forEach(g => g.classList.remove('drop-target'));
          group.classList.add('drop-target');
        });

        group.addEventListener('dragleave', e => {
          if (!group.contains(e.relatedTarget)) {
            group.classList.remove('drop-target');
          }
        });

        group.addEventListener('drop', e => {
          e.preventDefault();
          group.classList.remove('drop-target');
          const newStatus = group.dataset.status;
          if (!dragging.fp || newStatus === dragging.status) { return; }
          vscode.postMessage({ command: 'moveTask', filePath: dragging.fp, newStatus });
        });
      });
    }

    bindSidebarContent(document);

    window.addEventListener('message', event => {
      if (event.data?.command !== 'renderSidebar') { return; }
      const content = document.getElementById('sidebar-content');
      if (content) {
        content.innerHTML = event.data.html ?? '';
        bindSidebarContent(content);
      }
      const toggleBtn = document.getElementById('sidebar-view-toggle');
      if (toggleBtn && event.data.toggleBtnText) {
        toggleBtn.title = event.data.toggleBtnText;
        toggleBtn.setAttribute('aria-label', event.data.toggleBtnText);
        toggleBtn.firstElementChild.className = 'material-icon mi-' + (event.data.toggleIcon === 'flag' ? 'flag' : 'view_kanban');
      }
      const openBoardBtn = document.getElementById('open-board');
      if (openBoardBtn && event.data.openBoardText) {
        openBoardBtn.title = event.data.openBoardText;
        openBoardBtn.setAttribute('aria-label', event.data.openBoardText);
      }
    });

    document.getElementById('open-board')?.addEventListener('click', () =>
      vscode.postMessage({ command: 'openBoard' })
    );

    document.getElementById('sidebar-view-toggle')?.addEventListener('click', () =>
      vscode.postMessage({ command: 'toggleSidebarView' })
    );
  </script>
</body>
</html>`;
  }
}
