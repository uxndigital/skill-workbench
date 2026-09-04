export class WorkbenchError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(message: string, code = 'WORKBENCH_ERROR', exitCode = 1) {
    super(message);
    this.name = 'WorkbenchError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function toWorkbenchError(error: unknown): WorkbenchError {
  if (error instanceof WorkbenchError) return error;
  if (error instanceof Error) return new WorkbenchError(error.message);
  return new WorkbenchError(String(error));
}
