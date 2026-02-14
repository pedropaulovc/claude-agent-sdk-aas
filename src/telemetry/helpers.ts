import * as Sentry from "@sentry/node";

export type LogLine = {
  timestamp: string;
  level: "info" | "warn" | "error";
  message: string;
  attributes?: Record<string, unknown>;
};

type LogSubscriber = (line: LogLine) => void;

const subscribers = new Set<LogSubscriber>();

export function subscribeToLogs(fn: LogSubscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

function broadcast(line: LogLine): void {
  for (const fn of subscribers) {
    try {
      fn(line);
    } catch {
      /* fail-open */
    }
  }
}

export async function withSpan<T>(
  name: string,
  op: string,
  fn: (span: Sentry.Span) => Promise<T>,
): Promise<T> {
  return Sentry.startSpan({ name, op }, fn);
}

export function logInfo(
  message: string,
  attributes?: Record<string, unknown>,
): void {
  Sentry.logger.info(message, attributes);
  broadcast({ timestamp: new Date().toISOString(), level: "info", message, attributes });
}

export function logWarn(
  message: string,
  attributes?: Record<string, unknown>,
): void {
  Sentry.logger.warn(message, attributes);
  broadcast({ timestamp: new Date().toISOString(), level: "warn", message, attributes });
}

export function logError(
  message: string,
  attributes?: Record<string, unknown>,
): void {
  Sentry.logger.error(message, attributes);
  broadcast({ timestamp: new Date().toISOString(), level: "error", message, attributes });
}

export function countMetric(
  name: string,
  value: number = 1,
  attributes?: Record<string, string>,
): void {
  Sentry.startSpan({ name: `metric.${name}`, op: "metric" }, (span) => {
    span.setAttribute("metric.name", name);
    span.setAttribute("metric.value", value);
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(`metric.tag.${k}`, v);
      }
    }
  });
}

export function distributionMetric(
  name: string,
  value: number,
  unit: string,
  attributes?: Record<string, string>,
): void {
  Sentry.startSpan({ name: `metric.${name}`, op: "metric" }, (span) => {
    span.setAttribute("metric.name", name);
    span.setAttribute("metric.value", value);
    span.setAttribute("metric.unit", unit);
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) {
        span.setAttribute(`metric.tag.${k}`, v);
      }
    }
  });
}

export function chunkedLog(
  prefix: string,
  text: string,
  maxLen: number = 5000,
): void {
  if (text.length <= maxLen) {
    logInfo(`${prefix} | ${text}`);
    return;
  }

  const totalChunks = Math.ceil(text.length / maxLen);
  for (let i = 0; i < totalChunks; i++) {
    const chunk = text.slice(i * maxLen, (i + 1) * maxLen);
    logInfo(`${prefix} | [chunk ${i + 1}/${totalChunks}] ${chunk}`);
  }
}
