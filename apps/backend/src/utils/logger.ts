import winston from "winston";

const { combine, timestamp, colorize, printf, json } = winston.format;

const devFormat = combine(
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${timestamp} [${level}] ${message}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  // morgan이 'http' 레벨로 요청 로그를 기록하므로 개발 시 http 레벨 이상 출력
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "http"),
  format: process.env.NODE_ENV === "production" ? combine(timestamp(), json()) : devFormat,
  transports: [new winston.transports.Console()],
});
