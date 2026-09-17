import { randomUUID } from "node:crypto";
import { supabaseAdmin } from "../../lib/supabase.js";

export type OrderRealtimeEvent = {
  type: "order.created" | "order.status" | "order.updated";
  orderId: string;
  storeId: string;
  trackingToken: string;
  status: string;
  previousStatus?: string;
};

type Listener = (event: OrderRealtimeEvent) => void;
type SourceStarter = (
  publish: (event: OrderRealtimeEvent) => void
) => Promise<() => Promise<void> | void>;

export class OrderEventBus {
  private readonly listeners = new Set<Listener>();
  private startPromise: Promise<void> | null = null;
  private stopSource: (() => Promise<void> | void) | null = null;

  constructor(private readonly startSource?: SourceStarter) {}

  async ensureStarted() {
    if (!this.startSource || this.stopSource) return;
    if (!this.startPromise) {
      this.startPromise = this.startSource((event) => this.publish(event))
        .then((stop) => {
          this.stopSource = stop;
        })
        .catch((error) => {
          this.startPromise = null;
          throw error;
        });
    }
    await this.startPromise;
  }

  listen(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: OrderRealtimeEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async close() {
    const stop = this.stopSource;
    this.stopSource = null;
    this.startPromise = null;
    this.listeners.clear();
    if (stop) await stop();
  }
}

function stringField(row: Record<string, unknown>, key: string) {
  const value = row[key];
  return typeof value === "string" && value ? value : null;
}

export function orderChangeFromPayload(payload: {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, unknown>;
  old: Record<string, unknown>;
}): OrderRealtimeEvent | null {
  const current = payload.eventType === "DELETE" ? payload.old : payload.new;
  const previous = payload.old ?? {};
  const orderId = stringField(current, "id");
  const storeId = stringField(current, "store_id");
  const trackingToken = stringField(current, "tracking_token");
  const status = stringField(current, "status");
  if (!orderId || !storeId || !trackingToken || !status) return null;

  const previousStatus = stringField(previous, "status") ?? undefined;
  const type = payload.eventType === "INSERT"
    ? "order.created"
    : previousStatus && previousStatus !== status
      ? "order.status"
      : "order.updated";

  return { type, orderId, storeId, trackingToken, status, previousStatus };
}

export function createSupabaseOrderEventBus() {
  return new OrderEventBus(async (publish) => {
    const channel = supabaseAdmin
      .channel(`backend-orders-${randomUUID()}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders" },
        (payload) => {
          const event = orderChangeFromPayload(payload as any);
          if (event) publish(event);
        }
      );

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Supabase Realtime subscription timed out."));
      }, 10_000);
      timer.unref();

      channel.subscribe((status) => {
        if (status === "SUBSCRIBED" && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        } else if ((status === "CHANNEL_ERROR" || status === "TIMED_OUT") && !settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`Supabase Realtime subscription failed: ${status}`));
        }
      });
    });

    return async () => {
      await supabaseAdmin.removeChannel(channel);
    };
  });
}
