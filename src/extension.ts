import * as vscode from 'vscode';
import { loadPreferences } from './preferences';
import { KanbanPanel } from './KanbanPanel';
import { KanbanSidebarProvider } from './KanbanSidebarProvider';
import { setConfiguredLanguage } from './i18n';

export function activate(context: vscode.ExtensionContext): void {
  if (!vscode.workspace.isTrusted) { return; }
  loadPreferences(context);
  const savedLang = context.globalState.get<string>('kanban.language');
  if (savedLang) {
    setConfiguredLanguage(savedLang);
  }

  // Sidebar list view
  const sidebarProvider = new KanbanSidebarProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(KanbanSidebarProvider.viewType, sidebarProvider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('kanban-vsc.refreshSidebar', (forceRebuild = true) => {
      sidebarProvider.refresh(forceRebuild);
    })
  );

  // Main board command
  context.subscriptions.push(
    vscode.commands.registerCommand('kanban-vsc.open', () => {
      KanbanPanel.createOrShow(context);
    })
  );

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text    = '$(tasklist) Kanban';
  statusBar.command = 'kanban-vsc.open';
  statusBar.tooltip = 'Open Kanban Board';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // File watcher — refresh both panel and sidebar
  const watcher = vscode.workspace.createFileSystemWatcher('**/docs/**/*');
  const onFileChange = () => {
    KanbanPanel.refresh();
    sidebarProvider.refresh();
  };
  watcher.onDidCreate(onFileChange);
  watcher.onDidDelete(onFileChange);
  watcher.onDidChange(onFileChange);
  context.subscriptions.push(watcher);
}

export function deactivate(): void {}
