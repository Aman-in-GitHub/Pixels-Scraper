import pino from "pino";

const logger = pino({
  level: "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (level) => ({ level }),
  },
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      singleLine: true,
      levelFirst: true,
      ignore: "pid,hostname",
      translateTime: "SYS:standard",
    },
  },
});

export { logger };
