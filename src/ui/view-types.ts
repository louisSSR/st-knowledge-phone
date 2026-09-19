import type { EntryType, PhoneController, PhoneState } from '../core/types.js';

export interface ViewContext {
  state: PhoneState;
  controller: PhoneController;
  offset: number;
  run(task: Promise<unknown>): void;
  search(query: string, types?: EntryType[], offset?: number): void;
  navigate(page: PhoneState['page'], offset?: number): void;
}
