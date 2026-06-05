/**
 * @int3gra/engine - error.js
 * Error types and bubbling envelope for the engine.
 */

export class StepError extends Error {
  constructor({ message, stepId, componentId, input, cause }) {
    super(message);
    this.name        = "StepError";
    this.stepId      = stepId      ?? null;
    this.componentId = componentId ?? null;
    this.input       = input       ?? null;
    this.cause       = cause       ?? null;
  }
}

export class BreakSignal {
  constructor(target) {
    this.target = target; // loop id or null (current)
  }
}

export class ContinueSignal {
  constructor(target) {
    this.target = target; // loop id or null (current)
  }
}

export class EngineError extends Error {
  constructor(message, cause) {
    super(message);
    this.name  = "EngineError";
    this.cause = cause ?? null;
  }
}

/**
 * Builds a consistent error context object injected into onError resolver calls.
 */
export function buildErrorCtx(error, meta) {
  return {
    message:   error.message,
    step:      meta.stepId      ?? null,
    component: meta.componentId ?? null,
    input:     meta.input       ?? null,
    cause:     error.cause      ?? error,
  };
}
