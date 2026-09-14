import { lumenBus } from "@/lib/jobs/events";

export function emitNotification(ownerId: string): void {
  lumenBus().emit(`notification:${ownerId}`);
}

export function onNotification(ownerId: string, fn: () => void): () => void {
  const emitter = lumenBus();
  const channel = `notification:${ownerId}`;
  emitter.on(channel, fn);
  return () => emitter.off(channel, fn);
}
