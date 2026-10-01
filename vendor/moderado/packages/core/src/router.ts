import {
  DiscoveredModel,
  ModelClassification,
  ModelInventoryEntry,
} from '@moderado/contracts';

export class NoEligibleModelError extends Error {
  constructor(message: string, public readonly suggestions: string[]) {
    super(message);
    this.name = 'NoEligibleModelError';
  }
}

export interface RouteSelectionOptions {
  pinnedModelId?: string;
  allowPaid?: boolean;
  allowUnknown?: boolean;
  requireTools?: boolean;
  isLocalProfile?: boolean;
  customClassifications?: Record<string, Partial<ModelClassification>>;
}

export interface SelectedModelResult {
  selectedModel: DiscoveredModel;
  rankedCandidates: DiscoveredModel[];
}

const BUILTIN_MODEL_CLASSIFICATIONS: Record<string, Partial<ModelClassification>> = {
  'mock/free-tool-model': { accessTier: 'free_trial', toolSupport: 'supported' },
  'mock/paid-tool-model': { accessTier: 'paid', toolSupport: 'supported' },
  'mock/text-only-model': { accessTier: 'free_trial', toolSupport: 'unsupported' },
  'nvidia/llama-3.1-nemotron-70b-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'meta/llama-3.3-70b-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'meta/llama-3.2-90b-vision-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'meta/llama-3.2-11b-vision-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'meta/llama-3.1-70b-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'meta/llama-3.1-8b-instruct': { accessTier: 'free_trial', toolSupport: 'supported' },
  'mistralai/mixtral-8x7b-instruct-v0.1': { accessTier: 'free_trial', toolSupport: 'supported' },
  'mistralai/mistral-large-2-instruct': { accessTier: 'paid', toolSupport: 'supported' },
  'mistralai/codestral-22b-instruct-v0.1': { accessTier: 'paid', toolSupport: 'supported' },
  'deepseek-ai/deepseek-coder-6.7b-instruct': { accessTier: 'paid', toolSupport: 'supported' },
  'deepseek-ai/deepseek-v4-flash-0731': { accessTier: 'paid', toolSupport: 'supported' },
  'deepseek-ai/deepseek-r1': { accessTier: 'free_trial', toolSupport: 'unsupported' },
  'google/codegemma-7b': { accessTier: 'paid', toolSupport: 'supported' },
  'ibm/granite-34b-code-instruct': { accessTier: 'paid', toolSupport: 'supported' },
  'openai/gpt-oss-20b': { accessTier: 'paid', toolSupport: 'supported' },
};

export class Router {
  private classifications: Map<string, ModelClassification> = new Map();

  constructor(customClassifications: Record<string, Partial<ModelClassification>> = {}) {
    // Populate with builtins
    for (const [id, meta] of Object.entries(BUILTIN_MODEL_CLASSIFICATIONS)) {
      this.classifications.set(id, {
        modelId: id,
        accessTier: meta.accessTier ?? 'unknown',
        toolSupport: meta.toolSupport ?? 'unknown',
        source: 'official_metadata',
      });
    }

    // Override with custom user classifications
    for (const [id, meta] of Object.entries(customClassifications)) {
      const existing = this.classifications.get(id);
      this.classifications.set(id, {
        modelId: id,
        accessTier: meta.accessTier ?? existing?.accessTier ?? 'unknown',
        toolSupport: meta.toolSupport ?? existing?.toolSupport ?? 'unknown',
        source: 'user_config',
      });
    }
  }

  classifyModel(
    modelId: string,
    isLocalProfile = false,
    supportedParameters?: string[]
  ): ModelClassification {
    if (supportedParameters) {
      const toolSupport = supportedParameters.some(
        (parameter) => parameter === 'tools' || parameter === 'tool_choice'
      )
        ? 'supported'
        : 'unsupported';
      return {
        modelId,
        accessTier: isLocalProfile ? 'local' : 'free_trial',
        toolSupport,
        source: 'official_metadata',
        notes: `Provider advertises ${toolSupport === 'supported' ? '' : 'no '}tool calling`,
      };
    }

    const found = this.classifications.get(modelId);
    if (found) {
      return { ...found };
    }

    const id = modelId.toLowerCase();

    // 1. Utility, safety guard, detector, or embedding models (not chat/coding agents)
    const isUtilityOrEmbedding =
      id.includes('embed') ||
      id.includes('qa-') ||
      id.includes('detector') ||
      id.includes('calibration') ||
      id.includes('clip') ||
      id.includes('safety-guard') ||
      id.includes('nemoguard') ||
      id.includes('reward') ||
      id.includes('parse');

    if (isUtilityOrEmbedding) {
      return {
        modelId,
        accessTier: isLocalProfile ? 'local' : 'free_trial',
        toolSupport: 'unsupported',
        source: 'heuristic',
        notes: 'Utility or embedding endpoint',
      };
    }

    // 2. Chat, reasoning, and instruction models (hosted under free trial credits on build.nvidia.com)
    const isChatOrInstruct =
      id.includes('instruct') ||
      id.includes('-it') ||
      id.includes('coder') ||
      id.includes('vision') ||
      id.includes('chat') ||
      id.includes('large') ||
      id.includes('flash') ||
      id.includes('glm') ||
      id.includes('kimi') ||
      id.includes('dbrx') ||
      id.includes('yi') ||
      id.includes('granite') ||
      id.includes('gemma') ||
      id.includes('codestral') ||
      id.includes('starcoder') ||
      id.includes('llama') ||
      id.includes('mistral');

    return {
      modelId,
      accessTier: isLocalProfile ? 'local' : 'free_trial',
      toolSupport: isChatOrInstruct ? 'supported' : 'unknown',
      source: 'heuristic',
      notes: isChatOrInstruct ? 'Inferred instruction/chat model with tool support' : undefined,
    };
  }

  selectModel(
    inventory: ModelInventoryEntry[],
    options: RouteSelectionOptions = {}
  ): SelectedModelResult {
    // 1. Explicit Model Pinning
    if (options.pinnedModelId) {
      const pinnedId = options.pinnedModelId;
      const entry = inventory.find((m) => m.id === pinnedId) ?? {
        id: pinnedId,
        object: 'model' as const,
        owned_by: 'nvidia',
      };
      const classification = this.classifyModel(
        pinnedId,
        options.isLocalProfile,
        entry.supported_parameters
      );

      const pinnedModel: DiscoveredModel = {
        id: pinnedId,
        created: entry.created,
        ownedBy: entry.owned_by,
        classification,
      };

      return {
        selectedModel: pinnedModel,
        rankedCandidates: [pinnedModel],
      };
    }

    // 2. Discover & Classify Candidates
    const candidates: DiscoveredModel[] = inventory.map((entry) => ({
      id: entry.id,
      created: entry.created,
      ownedBy: entry.owned_by,
      classification: this.classifyModel(
        entry.id,
        options.isLocalProfile,
        entry.supported_parameters
      ),
    }));

    // 3. Stage 1: Capability Filtering
    const requireTools = options.requireTools ?? true;
    let eligible = candidates.filter((m) => {
      if (requireTools && m.classification.toolSupport === 'unsupported') {
        return false;
      }
      return true;
    });

    // 4. Stage 2: Access Tier Filtering
    const allowPaid = options.allowPaid ?? false;
    const allowUnknown = options.allowUnknown ?? false;

    eligible = eligible.filter((m) => {
      const tier = m.classification.accessTier;
      if (tier === 'free_trial' || tier === 'local') {
        return true;
      }
      if (tier === 'paid') {
        return allowPaid;
      }
      if (tier === 'unknown') {
        return allowUnknown;
      }
      return false;
    });

    // 5. Stage 3: Free-First Priority Ranking
    eligible.sort((a, b) => {
      const scoreA = this.getTierScore(a.classification, requireTools);
      const scoreB = this.getTierScore(b.classification, requireTools);
      return scoreB - scoreA;
    });

    if (eligible.length === 0) {
      throw new NoEligibleModelError(
        `No eligible models found matching free-first criteria (inventory count: ${inventory.length}).`,
        [
          'Run "moderado models" to inspect available models and classifications.',
          'Explicitly pin a model using --model <model-id>.',
          'Allow paid models by providing the --allow-paid flag.',
          'Allow unclassified models by providing the --allow-unknown flag.',
        ]
      );
    }

    return {
      selectedModel: eligible[0],
      rankedCandidates: eligible,
    };
  }

  getNextFallback(
    rankedCandidates: DiscoveredModel[],
    currentModelId: string
  ): DiscoveredModel | undefined {
    const currentIndex = rankedCandidates.findIndex((m) => m.id === currentModelId);
    if (currentIndex === -1 || currentIndex + 1 >= rankedCandidates.length) {
      return undefined;
    }
    return rankedCandidates[currentIndex + 1];
  }

  private getTierScore(c: ModelClassification, requireTools: boolean): number {
    let score = 0;
    // Access score
    if (c.accessTier === 'free_trial') score += 1000;
    else if (c.accessTier === 'local') score += 500;
    else if (c.accessTier === 'paid') score += 100;
    else score += 10;

    // Tool score
    if (requireTools) {
      if (c.toolSupport === 'supported') score += 200;
      else if (c.toolSupport === 'unknown') score += 50;
    }

    // Capacity & reasoning preference within the same access tier
    const id = c.modelId.toLowerCase();
    if (id.includes('nemotron-70b') || id.includes('llama-3.3-70b')) score += 30;
    else if (id.includes('llama-3.1-70b') || id.includes('llama-3.2-90b')) score += 20;
    else if (id.includes('mixtral')) score += 10;

    return score;
  }
}
