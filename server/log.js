// Logs go to stderr so CLI output on stdout stays clean.
// Warnings and errors always print; progress messages only in server mode or with CONTAINEREDITOR_DEBUG.

let verbose = Boolean(process.env.CONTAINEREDITOR_DEBUG);
export const setVerbose = (value) => { verbose = verbose || value; };

export const logger = (tag) => (level, message) => {
  if (!verbose && (level === 'info' || level === 'debug')) return;
  console.error(`${new Date().toISOString()} [${tag}] ${level} ${message}`);
};
