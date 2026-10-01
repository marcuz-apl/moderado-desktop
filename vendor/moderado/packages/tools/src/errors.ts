export class ToolExecutionError extends Error {
  constructor(message: string, public readonly code = 'ERR_TOOL_EXECUTION') {
    super(message);
    this.name = 'ToolExecutionError';
  }
}

export class SecurityViolationError extends ToolExecutionError {
  constructor(message: string) {
    super(message, 'ERR_SECURITY_VIOLATION');
    this.name = 'SecurityViolationError';
  }
}

export class TargetNotFoundError extends ToolExecutionError {
  constructor(message: string) {
    super(message, 'ERR_TARGET_NOT_FOUND');
    this.name = 'TargetNotFoundError';
  }
}

export class AmbiguousTargetError extends ToolExecutionError {
  constructor(message: string) {
    super(message, 'ERR_AMBIGUOUS_TARGET');
    this.name = 'AmbiguousTargetError';
  }
}

export class ExecutionTimeoutError extends ToolExecutionError {
  constructor(message: string) {
    super(message, 'ERR_COMMAND_TIMEOUT');
    this.name = 'ExecutionTimeoutError';
  }
}
