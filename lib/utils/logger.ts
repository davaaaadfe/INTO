type LogLevel = "info" | "warn" | "error";

function write(level: LogLevel, event: string, detail?: Record<string, unknown>) {
  const payload = {
    level,
    event,
    at: new Date().toISOString(),
    ...detail,
  };

  if (level === "error") {
    console.error(JSON.stringify(payload));
    return;
  }

  if (level === "warn") {
    console.warn(JSON.stringify(payload));
    return;
  }

  console.log(JSON.stringify(payload));
}

export const logger = {
  info: (event: string, detail?: Record<string, unknown>) =>
    write("info", event, detail),
  warn: (event: string, detail?: Record<string, unknown>) =>
    write("warn", event, detail),
  error: (event: string, detail?: Record<string, unknown>) =>
    write("error", event, detail),
};
