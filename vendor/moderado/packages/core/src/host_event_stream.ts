import crypto from 'node:crypto';
import { AgentEvent, HostEventEnvelope, HostEventListener } from '@moderado/contracts';
export class HostEventStream {
  readonly sessionId: string;
  private sequence = 0;
  constructor(private readonly listener: HostEventListener, sessionId = crypto.randomUUID()) { this.sessionId = sessionId; }
  emit(event: AgentEvent): HostEventEnvelope { const envelope: HostEventEnvelope = { protocolVersion: 1, sessionId: this.sessionId, sequence: ++this.sequence, timestamp: Date.now(), event }; this.listener(envelope); return envelope; }
}