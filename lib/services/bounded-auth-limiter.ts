import { createHmac, randomBytes } from "node:crypto";

type Entry = { count: number; windowStartedAt: number };

export function createBoundedAuthLimiter(options: {
  purpose: string;
  windowMs: number;
  subjectLimit: number;
  aggregateLimit: number;
  maxSubjectScopes: number;
  maxAggregateScopes: number;
}) {
  const secret = randomBytes(32);
  const subjects = new Map<string, Entry>();
  const aggregates = new Map<string, Entry>();
  const key = (kind: string, value: string) => createHmac("sha256", secret)
    .update(`${options.purpose}:${kind}:${value}`)
    .digest("base64url");

  const prune = (entries: Map<string, Entry>, now: number, maximum: number, incomingKey: string) => {
    for (const [entryKey, entry] of entries) {
      if (now - entry.windowStartedAt >= options.windowMs) entries.delete(entryKey);
    }
    if (entries.has(incomingKey)) return;
    while (entries.size >= maximum) entries.delete(entries.keys().next().value!);
  };

  const current = (entries: Map<string, Entry>, entryKey: string, now: number) => {
    const entry = entries.get(entryKey);
    return entry && now - entry.windowStartedAt < options.windowMs
      ? entry
      : { count: 0, windowStartedAt: now };
  };

  return {
    allow(subject: string, source: string | null, now = Date.now()) {
      const sourceKey = key("source", source ?? "unattributed");
      const subjectKey = key("subject", `${source ?? "unattributed"}:${subject}`);
      prune(aggregates, now, options.maxAggregateScopes, sourceKey);
      prune(subjects, now, options.maxSubjectScopes, subjectKey);
      const aggregate = current(aggregates, sourceKey, now);
      const scoped = current(subjects, subjectKey, now);
      if (aggregate.count >= options.aggregateLimit || scoped.count >= options.subjectLimit) {
        return false;
      }
      aggregate.count += 1;
      scoped.count += 1;
      aggregates.set(sourceKey, aggregate);
      subjects.set(subjectKey, scoped);
      return true;
    },
    reset() {
      aggregates.clear();
      subjects.clear();
    },
    stats() {
      return { aggregateScopes: aggregates.size, subjectScopes: subjects.size };
    },
  };
}
