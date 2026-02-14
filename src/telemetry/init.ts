import * as Sentry from "@sentry/node";

export function initSentry(): void {
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    tracesSampleRate: 1.0,
    enableLogs: true,
    beforeSendSpan: (span) => {
      const duration =
        ((span.timestamp ?? 0) - (span.start_timestamp ?? 0)) * 1000;
      console.log(
        `[sentry] ${span.op} | ${span.description} | ${duration.toFixed(0)}ms | trace=${span.trace_id}`,
      );
      return span;
    },
  });
}
