const { createLogger, format, transports } = require('winston');
const fs = require('fs');

if (!fs.existsSync('logs')) fs.mkdirSync('logs');

const logger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.printf(info => `[${info.level.toUpperCase()}] ${info.timestamp} - ${info.message}`)
  ),
  transports: [
    new transports.File({ filename: 'logs/conversation.log', maxsize: 10485760, maxFiles: 5 }),
    new transports.Console()
  ]
});

module.exports = logger;
