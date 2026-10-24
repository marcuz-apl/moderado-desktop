export function canSend(initialized: boolean, busy: boolean): boolean {
  return initialized && !busy;
}

export function selectedModelLabel(
  mode: 'plan' | 'act',
  settings: { providerId?: string; planModel: string; actModel: string },
): string {
  const model = mode === 'plan' ? settings.planModel : settings.actModel;
  const prefix = settings.providerId ? `${settings.providerId} | ` : '';
  return `${mode === 'plan' ? 'Plan' : 'Act'} model: ${prefix}${model || 'None selected'}`;
}

export function shouldAutoScroll(scrollTop: number, scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight <= 48;
}

export async function sessionForSubmit(
  activeSessionId: string | null,
  createSession: () => Promise<string>,
): Promise<string> {
  return activeSessionId ?? createSession();
}
