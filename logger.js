const configuredLevel = process.env.LOG_LEVEL || 'info';
const levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

function makeLoggerMethod(level) {
  if (levels[level] > levels[configuredLevel]) return () => {};
  return (...args) => {
    const writer = console[level] || console.log;
    writer(...args);
  };
}

module.exports = {
  error: makeLoggerMethod('error'),
  warn: makeLoggerMethod('warn'),
  info: makeLoggerMethod('info'),
  debug: makeLoggerMethod('debug'),
  trace: makeLoggerMethod('trace'),
};
