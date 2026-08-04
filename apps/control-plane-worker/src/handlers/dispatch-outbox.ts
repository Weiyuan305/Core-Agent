interface OutboxWakeup { readonly tenantId: string; readonly outboxId: string; readonly streamId: string; readonly lastSequence: number; readonly attemptCount?: number }
export interface OutboxDispatchPort {
  claim(workerId: string, limit: number): Promise<readonly OutboxWakeup[]>;
  notify(payload: string): Promise<void>;
  delivered(row: OutboxWakeup, workerId: string): Promise<boolean>;
  retry(row: OutboxWakeup, workerId: string, summary: string): Promise<boolean>;
}
export async function dispatchOutbox(port: OutboxDispatchPort, workerId: string): Promise<{ delivered: number; retried: number }> {
  let delivered = 0; let retried = 0;
  for (const row of await port.claim(workerId, 64)) {
    try {
      await port.notify(JSON.stringify({ tenant_id: row.tenantId, stream_id: row.streamId, last_committed_sequence: row.lastSequence }));
      if (await port.delivered(row, workerId)) delivered += 1;
    } catch (error) {
      const text = (error instanceof Error ? error.message : "Outbox delivery failed").slice(0, 1000);
      if (await port.retry(row, workerId, text)) retried += 1;
    }
  }
  return { delivered, retried };
}
