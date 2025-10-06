import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

// Define the format for the console logs
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  printf(({ level, message, timestamp }) => `${timestamp} ${level}: ${message}`)
);

const transports = [
  new winston.transports.Console({
    format: consoleFormat,
  }),
];

// Only add file transports if not in a production environment
if (process.env.NODE_ENV !== 'production') {
  transports.push(new winston.transports.File({ filename: 'logs/error.log', level: 'error' }));
  transports.push(new winston.transports.File({ filename: 'logs/combined.log' }));
}

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: transports,
});

export default logger;