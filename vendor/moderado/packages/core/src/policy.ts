export interface AgentPolicyConfig {
  maxSteps?: number;
  readOnly?: boolean;
  nonInteractive?: boolean;
  timeoutSeconds?: number;
}

export class PolicyManager {
  public readonly maxSteps: number;
  public readonly readOnly: boolean;
  public readonly nonInteractive: boolean;
  public readonly timeoutSeconds: number;

  constructor(config: AgentPolicyConfig = {}) {
    this.maxSteps = config.maxSteps ?? 25;
    this.readOnly = config.readOnly ?? false;
    this.nonInteractive = config.nonInteractive ?? false;
    this.timeoutSeconds = config.timeoutSeconds ?? 600;
  }

  isStepWithinLimit(step: number): boolean {
    return step < this.maxSteps;
  }

  validateToolAction(toolName: string, requiresApproval: boolean): { allowed: boolean; reason?: string } {
    if (this.readOnly && requiresApproval) {
      return {
        allowed: false,
        reason: `Operation '${toolName}' denied: Session is running in --read-only mode. All file mutations and command executions are blocked.`,
      };
    }

    if (this.nonInteractive && requiresApproval) {
      return {
        allowed: false,
        reason: `Operation '${toolName}' denied: Operation requires interactive human approval, but session is running in --non-interactive mode.`,
      };
    }

    return { allowed: true };
  }
}
