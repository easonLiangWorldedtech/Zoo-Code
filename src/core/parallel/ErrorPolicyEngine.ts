/**
 * ErrorPolicyEngine — Preset defaults + per-node override for TaskFlowAgent.
 *
 * Phase 7g: Extracted from TaskFlowAgent to provide a reusable, testable module
 * that resolves error policies for workflow nodes.
 *
 * Architecture:
 *   Workflow JSON (per_node overrides) → ErrorPolicyEngine → Resolved policy per node
 */

import type { ParallelTaskType, ErrorPolicy as ErrorPolicyType } from "@roo-code/types"

// Re-export the ErrorPolicy type for consumers
export type ErrorPolicy = ErrorPolicyType

/** Default error policy when no explicit config exists */
const DEFAULT_WORKFLOW_ERROR_POLICY: ErrorPolicy = "stop_downstream"

// ─── Preset Defaults by Task Type ──────────────────────────────────────────────

/**
 * Default error policies per task type.
 * These are the sensible defaults that apply when a workflow doesn't specify overrides.
 */
export const ERROR_POLICY_PRESETS: Record<ParallelTaskType, ErrorPolicy> = {
    [ParallelTaskType.Search]: "continue",           // Search failure rarely blocks downstream
    [ParallelTaskType.Doc]: "skip_dependents",       // Doc failure — code still works without docs
    [ParallelTaskType.Code]: "stop_downstream",      // Code failure may cause wrong downstream behavior
    [ParallelTaskType.Debug]: "retry",               // Debug sometimes needs retry
    [ParallelTaskType.Commit]: "stop_downstream",    // Commit is final step — failure stops everything
    [ParallelTaskType.General]: "continue",          // Generic tasks are non-blocking
}

// ─── Engine ─────────────────────────────────────────────────────────────────────

/**
 * ErrorPolicyEngine resolves error policies for workflow nodes.
 * Priority: per-node override > type default > global default.
 */
export class ErrorPolicyEngine {
    /** Default policy for workflows without explicit config */
    private defaultPolicy: ErrorPolicy

    /** Per-node overrides from workflow JSON */
    private perNodeOverrides?: Record<string, ErrorPolicy>

    constructor(defaultPolicy: ErrorPolicy = DEFAULT_WORKFLOW_ERROR_POLICY) {
        this.defaultPolicy = defaultPolicy
    }

    /** Set per-node overrides (called when loading a workflow) */
    setPerNodeOverrides(overrides: Record<string, ErrorPolicy>): void {
        this.perNodeOverrides = overrides
    }

    /** Clear all per-node overrides */
    clearOverrides(): void {
        this.perNodeOverrides = undefined
    }

    /**
     * Resolve error policy for a specific node.
     * Priority: per-node override > type default > global default.
     */
    resolve(taskType: ParallelTaskType, nodeId: string): ErrorPolicy {
        // 1. Check per-node override first
        if (this.perNodeOverrides?.[nodeId]) {
            return this.perNodeOverrides[nodeId]
        }

        // 2. Fall back to type default
        const typeDefault = ERROR_POLICY_PRESETS[taskType] ?? DEFAULT_WORKFLOW_ERROR_POLICY
        return typeDefault
    }

    /** Get the current default policy */
    getDefaultPolicy(): ErrorPolicy {
        return this.defaultPolicy
    }

    /** Set a new global default policy */
    setDefaultPolicy(policy: ErrorPolicy): void {
        this.defaultPolicy = policy
    }

    /** Check if a specific node has an override */
    hasOverride(nodeId: string): boolean {
        return !!this.perNodeOverrides?.[nodeId]
    }

    /** Get all current overrides */
    getAllOverrides(): Record<string, ErrorPolicy> | undefined {
        return this.perNodeOverrides
    }
}

// ─── Helper Functions (for use outside the class) ──────────────────────────────

/** Resolve error policy for a node — standalone function version */
export function resolveErrorPolicy(
    taskType: ParallelTaskType,
    nodeId: string,
    perNodeOverrides?: Record<string, ErrorPolicy>,
): ErrorPolicy {
    // Per-node override first
    if (perNodeOverrides?.[nodeId]) {
        return perNodeOverrides[nodeId]
    }

    // Type default
    const typeDefault = ERROR_POLICY_PRESETS[taskType] ?? DEFAULT_WORKFLOW_ERROR_POLICY
    return typeDefault
}

/** Get the preset error policy for a task type */
export function getErrorPolicyPreset(taskType: ParallelTaskType): ErrorPolicy {
    return ERROR_POLICY_PRESETS[taskType] ?? DEFAULT_WORKFLOW_ERROR_POLICY
}
