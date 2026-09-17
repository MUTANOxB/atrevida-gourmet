import type { FastifyReply } from "fastify";

export class SseConnectionLimiter {
  private readonly active = new Map<string, number>();

  constructor(readonly maxPerIp = 6) {}

  acquire(ip: string) {
    const current = this.active.get(ip) ?? 0;
    if (current >= this.maxPerIp) return null;
    this.active.set(ip, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.active.get(ip) ?? 1) - 1;
      if (next <= 0) this.active.delete(ip);
      else this.active.set(ip, next);
    };
  }

  count(ip: string) {
    return this.active.get(ip) ?? 0;
  }
}

export type SseOptions = {
  heartbeatMs?: number;
  maxDurationMs?: number;
  onClose?: () => void;
};

export function openSse(reply: FastifyReply, options: SseOptions = {}) {
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const maxDurationMs = options.maxDurationMs ?? 15 * 60_000;
  reply.hijack();
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
    Connection: "keep-alive"
  });
  reply.raw.write("retry: 3000\n\n");

  let closed = false;
  const cleanups = new Set<() => void>();
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(timeout);
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    options.onClose?.();
    if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
  };
  const heartbeat = setInterval(() => {
    if (reply.raw.destroyed || reply.raw.writableEnded) close();
    else reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
  }, heartbeatMs);
  heartbeat.unref();
  const timeout = setTimeout(close, maxDurationMs);
  timeout.unref();
  reply.raw.once("close", close);
  reply.raw.once("error", close);

  return {
    send(data: unknown) {
      if (closed || reply.raw.destroyed || reply.raw.writableEnded) return false;
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    },
    addCleanup(cleanup: () => void) {
      if (closed) cleanup();
      else cleanups.add(cleanup);
    },
    close
  };
}
