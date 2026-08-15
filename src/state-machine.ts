import type { JobStatus } from "./schemas.js";

const allowed: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ["provisioning", "cancelling", "failed", "interrupted"],
  provisioning: ["running", "cancelling", "failed", "interrupted"],
  running: ["verifying", "cancelling", "failed", "interrupted"],
  verifying: ["committing", "cancelling", "failed", "interrupted"],
  committing: ["succeeded", "cancelling", "failed", "interrupted"],
  cancelling: ["cancelled", "failed", "interrupted"],
  succeeded: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return from === to || allowed[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`invalid job transition: ${from} -> ${to}`);
  }
}

export const terminalStatuses = new Set<JobStatus>([
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
