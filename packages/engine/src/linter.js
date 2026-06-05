/**
 * @int3gra/engine - linter.js
 * Structural validation of process JSON files.
 * Checks for loose else, break/continue outside while, and other logical errors.
 * Runs before execution. Halts on any error found.
 */

import { logger }      from "./logger.js";
import { EngineError } from "./error.js";

export function lint(processes) {
  const errors = [];

  for (const process of Object.values(processes)) {
    const state = {
      insideWhile: false,
      whileIds:    [],
      processId:   process.id,
    };
    walkSteps(process.flow?.steps ?? [], errors, state);
  }

  if (errors.length) {
    errors.forEach(e => logger.warn("linter.error", { message: e }));
    throw new EngineError(`Linter found ${errors.length} structural error(s). Halting.`);
  }

  logger.info("linter.passed", { processes: Object.keys(processes).length });
}

function walkSteps(steps, errors, state) {
  let lastStepWasIf = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // Loose else check
    if ("else" in step && !lastStepWasIf) {
      errors.push(
        `[${state.processId}] 'else' at step index ${i} has no preceding 'if'`
      );
    }

    // break/continue outside while
    if ("break" in step && !state.insideWhile) {
      errors.push(
        `[${state.processId}] 'break' at step index ${i} is outside a 'while' loop`
      );
    }

    if ("continue" in step && !state.insideWhile) {
      errors.push(
        `[${state.processId}] 'continue' at step index ${i} is outside a 'while' loop`
      );
    }

    // break/continue targeting unknown loop ids
    if ("break" in step && step.break !== null) {
      if (!state.whileIds.includes(step.break)) {
        errors.push(
          `[${state.processId}] 'break' targets unknown loop id "${step.break}"`
        );
      }
    }

    if ("continue" in step && step.continue !== null) {
      if (!state.whileIds.includes(step.continue)) {
        errors.push(
          `[${state.processId}] 'continue' targets unknown loop id "${step.continue}"`
        );
      }
    }

    lastStepWasIf = "if" in step;

    // Recurse into nested steps
    if (step.steps) {
      const childState = {
        ...state,
        insideWhile: state.insideWhile || "while" in step,
        whileIds:    "while" in step && step.id
          ? [...state.whileIds, step.id]
          : state.whileIds,
      };
      walkSteps(step.steps, errors, childState);
    }

    // Recurse into switch cases
    if (step.cases) {
      for (const [caseName, caseFlow] of Object.entries(step.cases)) {
        if (caseFlow?.steps) {
          walkSteps(caseFlow.steps, errors, state);
        }
      }
    }
  }
}
