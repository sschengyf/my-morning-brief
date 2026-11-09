/** An open todo from either backend (todo.md or Microsoft To Do). */
export interface Todo {
  title: string;
  /** The due date, YYYY-MM-DD; null when there is none. */
  due: string | null;
  /** Starred in Microsoft To Do. */
  important: boolean;
  /** The Microsoft To Do list it is in; null for todo.md. */
  list: string | null;
  /** todo.md only: the number /done takes. */
  number?: number;
}

export interface TodosRaw {
  open: Todo[];
}
