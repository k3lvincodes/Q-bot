import winston from 'winston';

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Check if we're in Vercel (serverless environment)
const isVercel = process.env.VERCEL === '1';

// Define the format for the console logs
const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }), // Include stack traces for errors
  printf(({ level, message, timestamp, stack }) => {
    return `${timestamp} ${level}: ${stack || message}`;
  })
);

// JSON format for production (better for logging services)
const jsonFormat = combine(
  timestamp(),
  errors({ stack: true }),
  printf(({ level, message, timestamp, stack, ...metadata }) => {
    return JSON.stringify({
      level,
      message: stack || message,
      timestamp,
      ...metadata
    });
  })
);

const transports = [];

if (isVercel || process.env.NODE_ENV === 'production') {
  // In Vercel/production, use JSON format to console (for Vercel logs)
  transports.push(
    new winston.transports.Console({
      format: jsonFormat,
    })
  );
} else {
  // In development, use pretty console format and file logs
  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
    })
  );

  // Only add file transports if not in Vercel
  if (!isVercel) {
    transports.push(
      new winston.transports.File({
        filename: 'logs/error.log',
        level: 'error',
        format: jsonFormat
      })
    );
    transports.push(
      new winston.transports.File({
        filename: 'logs/combined.log',
        format: jsonFormat
      })
    );
  }
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: transports,
  // Don't exit on handled exceptions
  exitOnError: false,
});

// Handle uncaught exceptions and rejections
if (!isVercel) {
  logger.exceptions.handle(
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: 'logs/exceptions.log' })
  );

  logger.rejections.handle(
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({ filename: 'logs/rejections.log' })
  );
}

export default logger;