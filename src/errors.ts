/** Thrown when a context cannot establish or refresh local usability right now. */
export class ContextNotReadyError extends Error {
  public constructor(cause?: unknown) {
    super('Context is not ready.', cause === undefined ? undefined : { cause });
    this.name = 'ContextNotReadyError';
  }
}

/** Thrown when a retained context handle or record was fenced by ended authority. */
export class ContextRetiredError extends Error {
  public constructor(contextId: string) {
    super(`Context '${contextId}' is no longer available through this handle.`);
    this.name = 'ContextRetiredError';
  }
}

/** Recognize `ContextNotReadyError` across `@enbox/api` and `@enbox/contexts` boundaries. */
export function isContextNotReadyError(error: unknown): error is ContextNotReadyError {
  return error instanceof ContextNotReadyError
    || (error instanceof Error && error.name === 'ContextNotReadyError');
}

/** Recognize `ContextRetiredError` across `@enbox/api` and `@enbox/contexts` boundaries. */
export function isContextRetiredError(error: unknown): error is ContextRetiredError {
  return error instanceof ContextRetiredError
    || (error instanceof Error && error.name === 'ContextRetiredError');
}

/** Recognize `@enbox/agent`'s `FollowedSourceNotReadyError` without a runtime package import. */
export function isFollowedSourceNotReadyError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'FollowedSourceNotReadyError';
}

/** Recognize codec validation errors raised while decoding untrusted records. */
export function isRecordValidationError(error: unknown): boolean {
  return error instanceof SyntaxError
    || (error instanceof Error && error.name === 'RecordValidationError');
}
