import test from 'node:test';
import assert from 'node:assert/strict';
import { prebuiltAppConfig } from '@mlc-ai/web-llm';
import {
  classifyHardwareCapabilities,
  formatModelFamilyLabel,
  formatTierStatusLabel,
  GB_1,
  getGenerationParamsForModel,
  isQwen3ModelId,
  MB_128,
  MB_256,
  parseTierOverrideFromSearch,
  resolveDisplayModelId,
  resolveVerifiedMlcModelId,
} from './hardwareProfiler';

test('classifyHardwareCapabilities only locks genuinely constrained devices and exposes constrainedReason', () => {
  const mobileProfile = classifyHardwareCapabilities({
    isMobileOrTouch: true,
    isMobileUa: true,
    isCompactViewport: true,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(mobileProfile.tier, 'constrained');
  assert.equal(mobileProfile.allowWebLlm, false);
  assert.equal(mobileProfile.modelFamily, 'Deterministic');
  assert.equal(mobileProfile.modelId, null);
  assert.equal(mobileProfile.enableWarmup, false);
  assert.equal(mobileProfile.constrainedReason, 'Mobile/low-memory device');

  const noWebGpuProfile = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: false,
    isCompactViewport: false,
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    hasWebGpu: false,
    supportsShaderF16: false,
    maxStorageBufferBindingSize: 0,
  });
  assert.equal(noWebGpuProfile.tier, 'constrained');
  assert.equal(noWebGpuProfile.allowWebLlm, false);
  assert.equal(
    noWebGpuProfile.constrainedReason,
    'WebGPU adapter unavailable (check HTTPS or browser graphics acceleration)',
  );

  const lowRamProfile = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: false,
    isCompactViewport: false,
    deviceMemoryGb: 2,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1,
  });
  assert.equal(lowRamProfile.tier, 'constrained');
  assert.equal(lowRamProfile.allowWebLlm, false);
  assert.equal(lowRamProfile.constrainedReason, 'Mobile/low-memory device');

  const smallBufferProfile = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: false,
    isCompactViewport: false,
    deviceMemoryGb: 16,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: MB_128 - 1024,
  });
  assert.equal(smallBufferProfile.tier, 'constrained');
  assert.equal(smallBufferProfile.allowWebLlm, false);
  assert.equal(smallBufferProfile.constrainedReason, 'Mobile/low-memory device');
});

test('Brave spoofed/undefined deviceMemory, narrow split-screen desktop, and 4GB desktop with WebGPU are NOT falsely constrained', () => {
  // Brave browser often omits/spoofs navigator.deviceMemory (null) + narrow split-screen + touchscreen monitor
  const braveSplitDesktop = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: false,
    isCompactViewport: true,
    deviceMemoryGb: null,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(braveSplitDesktop.tier, 'performance');
  assert.equal(braveSplitDesktop.allowWebLlm, true);
  assert.equal(braveSplitDesktop.constrainedReason, null);
  assert.equal(braveSplitDesktop.modelFamily, 'Qwen3-0.6B');
  assert.equal(braveSplitDesktop.modelId, 'Qwen3-0.6B-q4f16_1-MLC');

  // Explicit 4 GB RAM + >= 128 MB buffer with desktop UA is balanced, not constrained
  const fourGbDesktop = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: false,
    isCompactViewport: false,
    deviceMemoryGb: 4,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: MB_256,
  });
  assert.equal(fourGbDesktop.tier, 'balanced');
  assert.equal(fourGbDesktop.allowWebLlm, true);
  assert.equal(fourGbDesktop.constrainedReason, null);
});

test('classifyHardwareCapabilities defaults both balanced and performance tiers to Qwen3-0.6B while supporting Qwen2.5-1.5B selection', () => {
  const balancedF16 = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isCompactViewport: false,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(balancedF16.tier, 'balanced');
  assert.equal(balancedF16.allowWebLlm, true);
  assert.equal(balancedF16.modelFamily, 'Qwen3-0.6B');
  assert.equal(balancedF16.modelId, 'Qwen3-0.6B-q4f16_1-MLC');
  assert.ok(balancedF16.candidateModelIds.includes('Qwen3-0.6B-q4f32_1-MLC'));
  assert.equal(balancedF16.contextWindowSize, 1536);
  assert.equal(balancedF16.maxTokens, 320);
  assert.equal(balancedF16.enableWarmup, true);

  const balancedF32 = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isCompactViewport: false,
    deviceMemoryGb: 8,
    hardwareConcurrency: 4,
    hasWebGpu: true,
    supportsShaderF16: false,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(balancedF32.tier, 'balanced');
  assert.equal(balancedF32.modelId, 'Qwen3-0.6B-q4f32_1-MLC');
  assert.equal(balancedF32.contextWindowSize, 1536);
  assert.equal(balancedF32.maxTokens, 320);

  const perfDefaultQwen3 = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isCompactViewport: false,
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    hasWebGpu: true,
    supportsShaderF16: false,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(perfDefaultQwen3.tier, 'performance');
  assert.equal(perfDefaultQwen3.allowWebLlm, true);
  assert.equal(perfDefaultQwen3.modelFamily, 'Qwen3-0.6B');
  assert.equal(perfDefaultQwen3.modelId, 'Qwen3-0.6B-q4f32_1-MLC');
  assert.equal(perfDefaultQwen3.contextWindowSize, 2048);
  assert.equal(perfDefaultQwen3.maxTokens, 320);
  assert.equal(perfDefaultQwen3.enableWarmup, true);

  const perfSecondaryQwen25 = classifyHardwareCapabilities(
    {
      isMobileOrTouch: false,
      isCompactViewport: false,
      deviceMemoryGb: 16,
      hardwareConcurrency: 12,
      hasWebGpu: true,
      supportsShaderF16: false,
      maxStorageBufferBindingSize: GB_1 * 2,
    },
    null,
    'Qwen2.5-1.5B-Instruct',
  );
  assert.equal(perfSecondaryQwen25.modelFamily, 'Qwen2.5-1.5B-Instruct');
  assert.equal(perfSecondaryQwen25.modelId, 'Qwen2.5-1.5B-Instruct-q4f32_1-MLC');
});

test('resolveVerifiedMlcModelId matches prebuiltAppConfig.model_list dynamically by substring with quant preference and manual override', () => {
  assert.equal(parseTierOverrideFromSearch('?tier=constrained'), 'constrained');
  assert.equal(parseTierOverrideFromSearch('?o2=21&tier=balanced'), 'balanced');
  assert.equal(parseTierOverrideFromSearch('?tier=PERFORMANCE'), 'performance');
  assert.equal(parseTierOverrideFromSearch('?tier=invalid'), null);

  const installedIds = prebuiltAppConfig.model_list.map((m) => m.model_id);
  const balancedProfile = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isCompactViewport: false,
    deviceMemoryGb: 8,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1 * 2,
  });
  assert.equal(
    resolveVerifiedMlcModelId(balancedProfile, installedIds),
    'Qwen3-0.6B-q4f16_1-MLC',
  );
  // Falls back to q4f32_1 when q4f16_1 is absent
  assert.equal(
    resolveVerifiedMlcModelId(balancedProfile, ['Qwen3-0.6B-q4f32_1-MLC']),
    'Qwen3-0.6B-q4f32_1-MLC',
  );

  const perfProfile = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isCompactViewport: false,
    deviceMemoryGb: 16,
    hardwareConcurrency: 12,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1 * 2,
  });

  // Default for performance is Qwen3-0.6B
  assert.equal(
    resolveVerifiedMlcModelId(perfProfile, installedIds),
    'Qwen3-0.6B-q4f16_1-MLC',
  );
  // Selecting secondary Qwen2.5-1.5B resolves exact MLC ID
  assert.equal(
    resolveVerifiedMlcModelId(perfProfile, installedIds, {
      preferredModelFamily: 'Qwen2.5-1.5B-Instruct',
    }),
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  );

  // Automatic fallback to Qwen2.5-0.5B or Qwen2.5-1.5B when Qwen3 is absent
  assert.equal(
    resolveVerifiedMlcModelId(perfProfile, ['Qwen2.5-0.5B-Instruct-q4f16_1-MLC']),
    'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
  );
  assert.equal(
    resolveVerifiedMlcModelId(perfProfile, ['Qwen2.5-1.5B-Instruct-q4f16_1-MLC']),
    'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
  );

  // Fall back to null (Deterministic) when no candidate is registered
  assert.equal(resolveVerifiedMlcModelId(perfProfile, ['Llama-3-8B-Instruct']), null);

  // Manual override allows constrained device WITH WebGPU to resolve model ID
  const constrainedWithGpu = classifyHardwareCapabilities({
    isMobileOrTouch: false,
    isMobileUa: true,
    isCompactViewport: true,
    deviceMemoryGb: 4,
    hardwareConcurrency: 8,
    hasWebGpu: true,
    supportsShaderF16: true,
    maxStorageBufferBindingSize: GB_1,
  });
  assert.equal(resolveVerifiedMlcModelId(constrainedWithGpu, installedIds), null);
  assert.equal(
    resolveVerifiedMlcModelId(constrainedWithGpu, installedIds, { allowManualOverride: true }),
    'Qwen3-0.6B-q4f16_1-MLC',
  );

  assert.equal(
    formatTierStatusLabel(perfProfile, 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC'),
    'Tier: performance · Qwen2.5-1.5B-Instruct-q4f16_1',
  );
  assert.equal(
    formatTierStatusLabel(balancedProfile, 'Qwen3-0.6B-q4f16_1-MLC'),
    'Tier: balanced · Qwen3-0.6B-q4f16_1',
  );
  assert.equal(formatTierStatusLabel(perfProfile, null), 'Tier: performance · Deterministic');
  assert.equal(
    formatTierStatusLabel(constrainedWithGpu, 'Qwen3-0.6B-q4f16_1-MLC', true),
    'Tier: constrained · Qwen3-0.6B-q4f16_1',
  );

  assert.equal(formatModelFamilyLabel('Qwen3-0.6B-q4f16_1-MLC'), 'Qwen3-0.6B');
  assert.equal(formatModelFamilyLabel('Qwen2.5-1.5B-Instruct-q4f32_1-MLC'), 'Qwen2.5-1.5B');
  assert.equal(resolveDisplayModelId('Qwen3-0.6B', { supportsShaderF16: true }), 'Qwen3-0.6B-q4f16_1-MLC');
  assert.equal(
    resolveDisplayModelId('Qwen2.5-1.5B-Instruct', { supportsShaderF16: false }),
    'Qwen2.5-1.5B-Instruct-q4f32_1-MLC',
  );

  assert.equal(isQwen3ModelId('Qwen3-0.6B-q4f16_1-MLC'), true);
  assert.equal(isQwen3ModelId('Qwen2.5-1.5B-Instruct-q4f16_1-MLC'), false);

  const qwen3Gen = getGenerationParamsForModel('Qwen3-0.6B-q4f16_1-MLC', balancedProfile);
  assert.deepEqual(qwen3Gen, {
    temperature: 0.6,
    top_p: 0.95,
    top_k: 20,
    max_tokens: 320,
    enableThinking: true,
  });

  const qwen25Gen = getGenerationParamsForModel('Qwen2.5-1.5B-Instruct-q4f16_1-MLC', perfProfile);
  assert.deepEqual(qwen25Gen, {
    temperature: 0.15,
    top_p: 0.9,
    max_tokens: 320,
    enableThinking: false,
  });
});
