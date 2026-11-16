import * as vscode from 'vscode';

export const PROJECT_ENABLED_KEY = 'kanban.projectEnabled';
export const UI_SCALE_KEY = 'kanban.uiScale';
export const UI_SCALES = [80, 90, 100, 110, 125, 150];
let projectEnabled = true;
let uiScale = 100;

export function loadPreferences(context: vscode.ExtensionContext): void {
  projectEnabled = context.workspaceState.get<boolean>(PROJECT_ENABLED_KEY) ?? true;
  setUiScale(context.workspaceState.get<number>(UI_SCALE_KEY) ?? 100);
}
export function isProjectEnabled(): boolean { return projectEnabled; }
export function setProjectEnabled(enabled: boolean): void { projectEnabled = enabled; }
export function getUiScale(): number { return uiScale; }
export function setUiScale(scale: number): void {
  uiScale = UI_SCALES.includes(scale) ? scale : 100;
}

export const VISIBILITY_KEY = 'kanban.visibility';
export const VISIBILITY_ITEMS = ['goals', 'architecture', 'other', 'agents', 'save', 'refresh', 'status', 'count'] as const;
export type VisibilityItem = typeof VISIBILITY_ITEMS[number];
export type Visibility = Record<VisibilityItem, boolean>;
export function isVisibilityItem(value: unknown): value is VisibilityItem {
  return typeof value === 'string' && VISIBILITY_ITEMS.includes(value as VisibilityItem);
}
export function getVisibility(saved: unknown): Visibility {
  const values = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return Object.fromEntries(VISIBILITY_ITEMS.map(key => [key, values[key] !== false])) as Visibility;
}
