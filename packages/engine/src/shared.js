/**
 * @int3gra/engine - shared.js
 * In-memory shared space scoped to a single process run.
 * Acts as the data bus between all steps and components.
 */

export function createSharedSpace() {
  const space = {};

  return {
    get:    (key)        => space[key],
    set:    (key, value) => { space[key] = value; },
    delete: (key)        => { delete space[key]; },
    all:    ()           => ({ ...space }),
    has:    (key)        => key in space,
  };
}
