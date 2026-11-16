import { Task, TaskStatus, DEFAULT_COLUMN_ORDER } from './types';

export const COLUMN_SORT_KEY = 'kanban.columnSort';
export const BOARD_SORT_KEY = 'kanban.boardSort';
export const BOARD_SORT_MODES = ['date-desc', 'date-asc', 'name-asc', 'name-desc'] as const;
export type BoardSort = typeof BOARD_SORT_MODES[number];
export function isBoardSort(value: unknown): value is BoardSort {
  return BOARD_SORT_MODES.includes(value as BoardSort);
}

export function getColumnSorts(saved: unknown, legacy: unknown): Partial<Record<TaskStatus, BoardSort>> {
  const values = saved && typeof saved === 'object' ? saved as Record<string, unknown> : {};
  return Object.fromEntries(DEFAULT_COLUMN_ORDER.map(status => [status,
    isBoardSort(values[status]) ? values[status] : isBoardSort(legacy) ? legacy : 'date-desc',
  ]));
}

/** Pinned cards always lead; the selected order applies within both groups. */
export function sortBoardTasks(tasks: Task[], sort: BoardSort, language: string): Task[] {
  const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true });
  const byName = (a: Task, b: Task) => collator.compare(a.title, b.title);
  return [...tasks].sort((a, b) => {
    const pinned = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pinned) { return pinned; }
    let order: number;
    if (sort.startsWith('name-')) {
      order = byName(a, b) * (sort === 'name-desc' ? -1 : 1);
    } else {
      const aDate = Date.parse(a.date);
      const bDate = Date.parse(b.date);
      // Missing or invalid dates remain last in either direction.
      if (Number.isFinite(aDate) !== Number.isFinite(bDate)) {
        return Number.isFinite(aDate) ? -1 : 1;
      }
      order = Number.isFinite(aDate) ? (aDate - bDate) * (sort === 'date-desc' ? -1 : 1) : 0;
    }
    return order || byName(a, b) || a.relPath.localeCompare(b.relPath);
  });
}
