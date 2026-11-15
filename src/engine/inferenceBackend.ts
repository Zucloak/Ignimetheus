export type InferenceBackendId = 'verified' | 'webgpu';

export type WebGpuRuntimePhase =
  | 'idle'
  | 'probing'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error';

export const WEBGPU_IFRAME_DISABLED_NOTE =
  'WebGPU disabled in preview iframe — open in Chrome/Edge desktop for local GPU inference; using Verified Telemetry Engine meanwhile';

export function getSelectedEngineLabel(
  selectedBackend: InferenceBackendId,
  modelFamily = 'Qwen3-0.6B',
): string {
  return selectedBackend === 'webgpu'
    ? `${modelFamily} Local WebGPU`
    : 'Verified Telemetry Engine';
}

export const COMPILING_SHADERS_LABEL = 'Compiling WebGPU shaders...';

export function formatLoadProgressNote(
  progress: number,
  modelId: string,
  reportText?: string,
): { pct: number; note: string; isCompilingShaders: boolean } {
  const safeProgress = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  if (safeProgress >= 0.99) {
    return {
      pct: 100,
      note: COMPILING_SHADERS_LABEL,
      isCompilingShaders: true,
    };
  }
  const pct = Math.max(0, Math.min(98, Math.round(safeProgress * 100)));
  return {
    pct,
    note: reportText || `Loading ${modelId} · ${pct}%`,
    isCompilingShaders: false,
  };
}

export function formatComposerBackendStatus(
  selectedBackend: InferenceBackendId,
  phase: WebGpuRuntimePhase,
  progressPct: number,
  modelFamily = 'Qwen3-0.6B',
): { label: string; dotColor: 'cyan' | 'amber' | 'zinc' } {
  if (selectedBackend === 'verified') {
    return { label: 'Telemetry Grounded', dotColor: 'zinc' };
  }

  if (phase === 'ready') {
    return { label: 'WebGPU Ready', dotColor: 'cyan' };
  }

  if (phase === 'probing' || phase === 'loading') {
    const clamped = Math.max(0, Math.min(100, Math.round(progressPct)));
    if (clamped >= 99) {
      return { label: COMPILING_SHADERS_LABEL, dotColor: 'amber' };
    }
    return { label: `Loading ${modelFamily} · ${clamped}%`, dotColor: 'amber' };
  }

  if (phase === 'unavailable' || phase === 'error') {
    return { label: 'Telemetry Grounded', dotColor: 'amber' };
  }

  return { label: 'Telemetry Grounded', dotColor: 'zinc' };
}

export function isWorkerSandboxError(err: unknown): boolean {
  if (!err) return false;
  if (typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: unknown }).name ?? '');
    if (name === 'SecurityError') return true;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : typeof err === 'object' && 'message' in err
          ? String((err as { message?: unknown }).message ?? '')
          : '';
  return /securityerror|sandbox|worker|cross-origin|origin|blocked|script.*failed/i.test(message);
}
