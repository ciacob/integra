/**
 * @integra/cli - args.js
 * Minimal argument parsing utilities shared across CLI commands.
 */

/**
 * Parses a flat argv array into { flags, positional }.
 * Flags: --key value or --key (boolean)
 * Positional: everything that isn't a flag name or flag value
 *
 * @param {string[]} argv
 * @returns {{ flags: object, positional: string[] }}
 */
export function parseArgs(argv) {
  const flags      = {};
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      // Next arg is the value if it doesn't start with --
      if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }

  return { flags, positional };
}
