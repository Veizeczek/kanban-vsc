export type TaskStatus = 'proposed' | 'active' | 'closed' | 'architecture' | 'rejected' | 'other';

export interface Task {
  title: string;
  date: string;
  status: TaskStatus;
  filePath: string;
  fileName: string;
  relPath: string;
  pinned?: boolean;
}

export interface GoalItem {
  text: string;
  completed: boolean;
}

export interface GoalSection {
  title: string;
  items: GoalItem[];
}

export interface GoalsState {
  exists: boolean;
  filePath: string | null;
  sections: GoalSection[];
}

export const STATUS_FOLDERS: Record<TaskStatus, string> = {
  proposed:     'proposed',
  active:       'active',
  closed:       'closed',
  architecture: 'architecture',
  rejected:     'rejected',
  other:        '',
};

export const STATUS_COLORS: Record<TaskStatus, string> = {
  proposed:     '#1095c1',
  active:       '#e67e22',
  closed:       '#27ae60',
  architecture: '#8e44ad',
  rejected:     '#c0392b',
  other:        '#7f8c8d',
};

/** Default main board column order — overridable per workspace via workspaceState */
export const DEFAULT_COLUMN_ORDER: TaskStatus[] = [
  'rejected', 'proposed', 'active', 'closed',
];

export const SIDEBAR_STATUS_ORDER: TaskStatus[] = [
  'rejected', 'proposed', 'active', 'closed', 'architecture', 'other',
];

export const READONLY_STATUSES: TaskStatus[] = [];
