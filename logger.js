let pino;
try {
  pino = require('pino');
} catch (err) {
  pino = () => {
    const level = process.env.LOG_LEVEL || 'info';
    const levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
    const noop = () => {};
    const make = name =>
      levels[name] <= levels[level]
        ? (...args) => console[name](...args)
        : noop;
    return {
      error: make('error'),
      warn: make('warn'),
      info: make('info'),
      debug: make('debug'),
      trace: make('trace')
    };
  };
}
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
module.exports = logger;
