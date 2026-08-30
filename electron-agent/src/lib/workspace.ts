import { invoke } from '../platform/runtime';

export const workspace = {
  requestApproval: (path: string) =>
    invoke<void>('request_workspace_approval', { path }),

  isApproved: (path: string) =>
    invoke<boolean>('is_workspace_approved', { path }),
};
