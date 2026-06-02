/**
 * @integra/engine - loader.js
 * Reads, validates, and registers all component JSON files.
 * Builds three registries: connections, maps, processes.
 * Validates each file against its JSON Schema using ajv.
 * Cross-validates that all component references exist.
 */

import { readdir, readFile } from "fs/promises";
import { resolve, join }     from "path";
import { createRequire }     from "module";
import Ajv                   from "ajv";
import addFormats            from "ajv-formats";
import { logger }            from "./logger.js";
import { EngineError }       from "./error.js";

const require = createRequire(import.meta.url);

function makeAjv() {
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv;
}

const SCHEMA_DIR = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "../schemas");

async function loadSchema(name) {
  const raw = await readFile(join(SCHEMA_DIR, `${name}.schema.json`), "utf-8");
  return JSON.parse(raw);
}

async function loadDir(baseDir, subDir, schema, ajv) {
  const dir      = join(baseDir, subDir);
  const validate = ajv.compile(schema);
  const registry = {};

  let files;
  try {
    files = await readdir(dir);
  } catch {
    logger.warn("loader.dir_missing", { dir });
    return registry;
  }

  const jsonFiles = files.filter(f => f.endsWith(".json"));

  for (const file of jsonFiles) {
    const filePath = join(dir, file);
    let   parsed;

    try {
      const raw = await readFile(filePath, "utf-8");
      parsed    = JSON.parse(raw);
    } catch (err) {
      throw new EngineError(`Failed to parse JSON: ${filePath}`, err);
    }

    const valid = validate(parsed);
    if (!valid) {
      const errors = validate.errors.map(e => `  ${e.instancePath} ${e.message}`).join("\n");
      throw new EngineError(`Schema validation failed for ${filePath}:\n${errors}`);
    }

    if (registry[parsed.id]) {
      throw new EngineError(`Duplicate component id "${parsed.id}" in ${filePath}`);
    }

    registry[parsed.id] = parsed;
    logger.debug("loader.component_loaded", { id: parsed.id, type: subDir, file });
  }

  logger.info("loader.dir_loaded", { dir: subDir, count: Object.keys(registry).length });
  return registry;
}

/**
 * Validates that all component references within processes exist in registries.
 */
function validateReferences({ connections, maps, processes }) {
  const allComponents = { ...connections, ...maps, ...processes };

  function walkSteps(steps, processId) {
    for (const step of steps ?? []) {
      if (step.component && !allComponents[step.component]) {
        throw new EngineError(
          `Process "${processId}" references unknown component "${step.component}"`
        );
      }
      walkSteps(step.steps, processId);
      if (step.cases) {
        for (const c of Object.values(step.cases)) {
          walkSteps(c.steps, processId);
        }
      }
    }
  }

  for (const process of Object.values(processes)) {
    walkSteps(process.flow?.steps, process.id);
  }
}

/**
 * Collects all resolver paths declared across all components.
 */
export function collectResolverPaths(registry) {
  const paths = [];
  for (const components of Object.values(registry)) {
    for (const component of Object.values(components)) {
      if (component.resolver) paths.push(component.resolver);
    }
  }
  return [...new Set(paths)];
}

export async function load(cwd) {
  const [connectionSchema, mapSchema, processSchema] = await Promise.all([
    loadSchema("connection"),
    loadSchema("map"),
    loadSchema("process"),
  ]);

  const ajv = makeAjv();

  const [connections, maps, processes] = await Promise.all([
    loadDir(cwd, "connections", connectionSchema, ajv),
    loadDir(cwd, "maps",        mapSchema,        ajv),
    loadDir(cwd, "processes",   processSchema,    ajv),
  ]);

  validateReferences({ connections, maps, processes });

  logger.info("loader.complete", {
    connections: Object.keys(connections).length,
    maps:        Object.keys(maps).length,
    processes:   Object.keys(processes).length,
  });

  return { connections, maps, processes };
}
