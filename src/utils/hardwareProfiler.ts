export type HardwareTier = 'constrained' | 'balanced' | 'performance';
export type QuantizationTag = 'q4f16_1' | 'q4f32_1';
export type SystemPromptBudget = 'compact' | 'standard' | 'full';
export type WebGpuModelFamily = 'Qwen3-0.6B' | 'Qwen2.5-1.5B-Instruct';
export type LocalModelFamily =
  | 'Deterministic'
  | 'Qwen3-0.6B'
  | 'Qwen2.5-0.5B-Instruct'
  | 'Qwen2.5-1.5B-Instruct';

export interface HardwareCapabilityInput {
  isMobileOrTouch: boolean;
  isMobileUa?: boolean;
  isCompactViewport: boolean;
  deviceMemoryGb: number | null;
  hardwareConcurrency: number;
  hasWebGpu: boolean;
  supportsShaderF16: boolean;
  maxStorageBufferBindingSize: number;
}

export interface HardwareProfile extends HardwareCapabilityInput {
  tier: HardwareTier;
  tierOverride: HardwareTier | null;
  allowWebLlm: boolean;
  constrainedReason: string | null;
  quantization: QuantizationTag;
  modelFamily: LocalModelFamily;
  modelId: string | null;
  candidateModelIds: string[];
  contextWindowSize: 1024 | 1536 | 2048;
  maxTokens: 140 | 220 | 320;
  systemPromptBudget: SystemPromptBudget;
  enableWarmup: boolean;
}

export const MB_128 = 128 * 1024 * 1024;
export const MB_256 = 256 * 1024 * 1024;
export const GB_1 = 1024 * 1024 * 1024;

let cachedProfile: HardwareProfile | null = null;
let pendingProfilePromise: Promise<HardwareProfile> | null = null;

/**
 * Parses ?tier=constrained|balanced|performance from a URL search string.
 */
export function parseTierOverrideFromSearch(search: string): HardwareTier | null {
  if (!search) return null;
  try {
    const params = new URLSearchParams(search.startsWith('?') ? search : `?${search}`);
    const raw = params.get('tier')?.trim().toLowerCase();
    if (raw === 'constrained' || raw === 'balanced' || raw === 'performance') {
      return raw;
    }
  } catch {
    // Ignore malformed query string
  }
  return null;
}

/**
 * Returns the short UI display family label for a WebGPU model family or MLC model ID.
 */
export function formatModelFamilyLabel(
  familyOrModelId: WebGpuModelFamily | LocalModelFamily | string | null | undefined,
): string {
  const raw = (familyOrModelId ?? '').toLowerCase();
  if (raw.includes('qwen2.5-1.5b')) return 'Qwen2.5-1.5B';
  if (raw.includes('qwen2.5-0.5b')) return 'Qwen2.5-0.5B';
  if (raw.includes('qwen3-0.6b') || raw.includes('qwen3')) return 'Qwen3-0.6B';
  return 'Qwen3-0.6B';
}

/**
 * Resolves the canonical MLC model ID string for UI display given shader-f16 capability.
 */
export function resolveDisplayModelId(
  modelFamily: WebGpuModelFamily,
  caps?: Pick<HardwareCapabilityInput, 'supportsShaderF16'> | null,
): string {
  const quant: QuantizationTag = caps?.supportsShaderF16 === false ? 'q4f32_1' : 'q4f16_1';
  if (modelFamily === 'Qwen2.5-1.5B-Instruct') {
    return `Qwen2.5-1.5B-Instruct-${quant}-MLC`;
  }
  return `Qwen3-0.6B-${quant}-MLC`;
}

function buildCandidateModelIds(
  preferredFamily: WebGpuModelFamily,
  quantization: QuantizationTag,
  altQuantization: QuantizationTag,
): string[] {
  const qwen3 = [
    `Qwen3-0.6B-${quantization}-MLC`,
    `Qwen3-0.6B-${altQuantization}-MLC`,
  ];
  const qwen25Small = [
    `Qwen2.5-0.5B-Instruct-${quantization}-MLC`,
    `Qwen2.5-0.5B-Instruct-${altQuantization}-MLC`,
  ];
  const qwen25Large = [
    `Qwen2.5-1.5B-Instruct-${quantization}-MLC`,
    `Qwen2.5-1.5B-Instruct-${altQuantization}-MLC`,
  ];

  if (preferredFamily === 'Qwen2.5-1.5B-Instruct') {
    return [...qwen25Large, ...qwen3, ...qwen25Small];
  }
  return [...qwen3, ...qwen25Small, ...qwen25Large];
}

/**
 * Pure deterministic hardware tier & model configuration classifier.
 * Only classifies as `constrained` when:
 * - WebGPU is completely unavailable (`!hasWebGpu`), OR
 * - User-Agent is a mobile phone/tablet (`isMobileUa`), OR
 * - `deviceMemory` is explicitly reported (`deviceMemoryGb !== null && > 0`) and `<= 2` GB, OR
 * - `maxStorageBufferBindingSize < 128 MB`.
 * Desktop browsers with undefined/spoofed `deviceMemory` (e.g. Brave), narrow split-screen
 * viewports (`isCompactViewport`), or touchscreen desktop monitors are NOT flagged `constrained`.
 */
export function classifyHardwareCapabilities(
  input: HardwareCapabilityInput,
  tierOverride: HardwareTier | null = null,
  preferredModelFamily: WebGpuModelFamily = 'Qwen3-0.6B',
): HardwareProfile {
  const {
    isMobileOrTouch,
    isMobileUa,
    deviceMemoryGb,
    hardwareConcurrency,
    hasWebGpu,
    supportsShaderF16,
    maxStorageBufferBindingSize,
  } = input;

  const quantization: QuantizationTag = supportsShaderF16 ? 'q4f16_1' : 'q4f32_1';
  const altQuantization: QuantizationTag = supportsShaderF16 ? 'q4f32_1' : 'q4f16_1';

  const isActualMobile = isMobileUa ?? isMobileOrTouch;
  const hasExplicitLowMemory =
    deviceMemoryGb !== null && Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0 && deviceMemoryGb <= 2;
  const hasTinyBuffer = hasWebGpu && maxStorageBufferBindingSize < MB_128;

  let constrainedReason: string | null = null;
  if (!hasWebGpu) {
    constrainedReason = 'WebGPU adapter unavailable (check HTTPS or browser graphics acceleration)';
  } else if (isActualMobile || hasExplicitLowMemory || hasTinyBuffer) {
    constrainedReason = 'Mobile/low-memory device';
  } else if (tierOverride === 'constrained') {
    constrainedReason = 'URL ?tier=constrained override active';
  }

  let detectedTier: HardwareTier;
  if (!hasWebGpu || isActualMobile || hasExplicitLowMemory || hasTinyBuffer) {
    detectedTier = 'constrained';
  } else if (
    (deviceMemoryGb !== null && deviceMemoryGb <= 8) ||
    maxStorageBufferBindingSize < GB_1 ||
    hardwareConcurrency <= 4
  ) {
    detectedTier = 'balanced';
  } else {
    detectedTier = 'performance';
  }

  const effectiveTier: HardwareTier = tierOverride ?? detectedTier;

  if (effectiveTier === 'constrained') {
    return {
      ...input,
      tier: 'constrained',
      tierOverride,
      allowWebLlm: false,
      constrainedReason:
        constrainedReason ?? 'Mobile/low-memory device',
      quantization,
      modelFamily: 'Deterministic',
      modelId: null,
      candidateModelIds: [],
      contextWindowSize: 1024,
      maxTokens: 140,
      systemPromptBudget: 'compact',
      enableWarmup: false,
    };
  }

  const candidateModelIds = buildCandidateModelIds(
    preferredModelFamily,
    quantization,
    altQuantization,
  );
  const primaryModelId = candidateModelIds[0];

  if (effectiveTier === 'balanced') {
    return {
      ...input,
      tier: 'balanced',
      tierOverride,
      allowWebLlm: hasWebGpu || tierOverride === 'balanced',
      constrainedReason: hasWebGpu
        ? null
        : 'WebGPU adapter unavailable (check HTTPS or browser graphics acceleration)',
      quantization,
      modelFamily: preferredModelFamily,
      modelId: primaryModelId,
      candidateModelIds,
      contextWindowSize: 1536,
      maxTokens: 320,
      systemPromptBudget: 'standard',
      enableWarmup: true,
    };
  }

  return {
    ...input,
    tier: 'performance',
    tierOverride,
    allowWebLlm: hasWebGpu || tierOverride === 'performance',
    constrainedReason: hasWebGpu
      ? null
      : 'WebGPU adapter unavailable (check HTTPS or browser graphics acceleration)',
    quantization,
    modelFamily: preferredModelFamily,
    modelId: primaryModelId,
    candidateModelIds,
    contextWindowSize: 2048,
    maxTokens: 320,
    systemPromptBudget: 'full',
    enableWarmup: true,
  };
}

export interface ModelGenerationParams {
  temperature: number;
  top_p: number;
  top_k?: number;
  max_tokens: number;
  enableThinking: boolean;
}

/**
 * Detects whether the active WebLLM model ID belongs to the Qwen3 reasoning family.
 */
export function isQwen3ModelId(modelId: string | null | undefined): boolean {
  return Boolean(modelId && /^qwen3/i.test(modelId.trim()));
}

/**
 * Returns Qwen-approved non-greedy sampling parameters for Qwen3 reasoning models
 * (temperature 0.6, top_p 0.95, top_k 20, max_tokens >= 320) to prevent repetitive
 * thinking loops, or locked low-temperature sampling for Qwen2.5 Instruct models.
 */
export function getGenerationParamsForModel(
  modelId: string | null | undefined,
  profile?: Pick<HardwareProfile, 'maxTokens'> | null,
): ModelGenerationParams {
  const baseMaxTokens = profile?.maxTokens ?? 320;
  if (isQwen3ModelId(modelId)) {
    return {
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      max_tokens: Math.max(320, baseMaxTokens),
      enableThinking: true,
    };
  }
  return {
    temperature: 0.15,
    top_p: 0.9,
    max_tokens: baseMaxTokens,
    enableThinking: false,
  };
}

function matchModelIdBySubstring(
  availableModelIds: readonly string[],
  familySubstring: string,
  preferredQuant: QuantizationTag,
  altQuant: QuantizationTag,
): string | null {
  const needle = familySubstring.toLowerCase();
  const matches = availableModelIds.filter((id) => id.toLowerCase().includes(needle));
  if (matches.length === 0) return null;

  const pref = matches.find((id) => id.toLowerCase().includes(preferredQuant));
  if (pref) return pref;

  const alt = matches.find((id) => id.toLowerCase().includes(altQuant));
  if (alt) return alt;

  const nonZeroQuant = matches.find((id) => !id.toLowerCase().includes('q0f'));
  return nonZeroQuant ?? matches[0];
}

export interface ResolveModelOptions {
  preferredModelFamily?: WebGpuModelFamily;
  allowManualOverride?: boolean;
}

/**
 * Dynamically resolves the verified MLC model ID from `@mlc-ai/web-llm`'s
 * `prebuiltAppConfig.model_list` by substring (`qwen3-0.6b`, `qwen2.5-0.5b`,
 * `qwen2.5-1.5b`), preferring `q4f16_1` when `shader-f16` is supported and `q4f32_1`
 * otherwise, with automatic fallback across families or `null` when absent.
 */
export function resolveVerifiedMlcModelId(
  profile: HardwareProfile,
  availableModelIds: readonly string[],
  options?: ResolveModelOptions,
): string | null {
  const allowManual = Boolean(options?.allowManualOverride && profile.hasWebGpu);
  if (!allowManual && (!profile.allowWebLlm || profile.tier === 'constrained')) {
    return null;
  }

  const preferredQuant: QuantizationTag = profile.supportsShaderF16 ? 'q4f16_1' : 'q4f32_1';
  const altQuant: QuantizationTag = profile.supportsShaderF16 ? 'q4f32_1' : 'q4f16_1';
  const targetFamily: WebGpuModelFamily =
    options?.preferredModelFamily ??
    (profile.modelFamily === 'Qwen2.5-1.5B-Instruct' ? 'Qwen2.5-1.5B-Instruct' : 'Qwen3-0.6B');

  const searchOrder =
    targetFamily === 'Qwen2.5-1.5B-Instruct'
      ? ['qwen2.5-1.5b', 'qwen3-0.6b', 'qwen2.5-0.5b']
      : ['qwen3-0.6b', 'qwen2.5-0.5b', 'qwen2.5-1.5b'];

  for (const familySubstring of searchOrder) {
    const matched = matchModelIdBySubstring(
      availableModelIds,
      familySubstring,
      preferredQuant,
      altQuant,
    );
    if (matched) return matched;
  }

  return null;
}

/**
 * Formats a concise status bar label showing active hardware tier and model/engine.
 */
export function formatTierStatusLabel(
  profile: HardwareProfile | null,
  activeModelId: string | null,
  allowManualOverride = false,
): string {
  const canShowModel = Boolean(
    profile &&
      activeModelId &&
      ((profile.tier !== 'constrained' && profile.allowWebLlm) ||
        (allowManualOverride && profile.hasWebGpu)),
  );
  if (!canShowModel || !profile || !activeModelId) {
    const tierName = profile?.tier ?? 'constrained';
    return `Tier: ${tierName} · Deterministic`;
  }
  const shortModel = activeModelId.replace(/-MLC$/i, '');
  return `Tier: ${profile.tier} · ${shortModel}`;
}

/**
 * Probes device capabilities once per session (respecting ?tier= URL override)
 * and caches the resulting HardwareProfile.
 */
export async function getHardwareProfile(forceRefresh = false): Promise<HardwareProfile> {
  if (!forceRefresh && cachedProfile) {
    return cachedProfile;
  }
  if (!forceRefresh && pendingProfilePromise) {
    return pendingProfilePromise;
  }

  pendingProfilePromise = (async (): Promise<HardwareProfile> => {
    const hasWindow = typeof window !== 'undefined';
    const hasNavigator = typeof navigator !== 'undefined';

    const tierOverride = hasWindow
      ? parseTierOverrideFromSearch(window.location.search)
      : null;

    const ua = hasNavigator ? navigator.userAgent || '' : '';
    const isMobileUa = /Android|iPhone|iPad|iPod/i.test(ua);
    const isCompactViewport = hasWindow ? window.innerWidth <= 430 : false;

    const rawMem =
      hasNavigator && 'deviceMemory' in navigator
        ? Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory)
        : NaN;
    const deviceMemoryGb = Number.isFinite(rawMem) && rawMem > 0 ? rawMem : null;

    const rawCores = hasNavigator ? Number(navigator.hardwareConcurrency) : NaN;
    const hardwareConcurrency = Number.isFinite(rawCores) && rawCores > 0 ? rawCores : 4;

    let hasWebGpu = false;
    let supportsShaderF16 = false;
    let maxStorageBufferBindingSize = 0;

    const navGpu =
      hasNavigator && 'gpu' in navigator
        ? (navigator as Navigator & {
            gpu?: {
              requestAdapter?: () => Promise<{
                limits?: { maxStorageBufferBindingSize?: number };
                features?: { has?: (name: string) => boolean };
              } | null>;
            };
          }).gpu
        : undefined;

    if (navGpu && typeof navGpu.requestAdapter === 'function') {
      try {
        const adapter = await navGpu.requestAdapter();
        if (adapter) {
          hasWebGpu = true;
          maxStorageBufferBindingSize = Number(
            adapter.limits?.maxStorageBufferBindingSize ?? MB_256,
          );
          supportsShaderF16 = Boolean(adapter.features?.has?.('shader-f16'));
        }
      } catch {
        hasWebGpu = false;
      }
    }

    const profile = classifyHardwareCapabilities(
      {
        isMobileOrTouch: isMobileUa,
        isMobileUa,
        isCompactViewport,
        deviceMemoryGb,
        hardwareConcurrency,
        hasWebGpu,
        supportsShaderF16,
        maxStorageBufferBindingSize,
      },
      tierOverride,
    );

    cachedProfile = profile;
    return profile;
  })();

  try {
    return await pendingProfilePromise;
  } finally {
    pendingProfilePromise = null;
  }
}

export function getCachedHardwareProfile(): HardwareProfile | null {
  return cachedProfile;
}

export function clearHardwareProfileCacheForTests(): void {
  cachedProfile = null;
  pendingProfilePromise = null;
}
