// The effect format shared by presets, the DSL, the editor (H5) and saved files.
// See PLAN.md §2.

export type OutputId = 'o0' | 'o1' | 'o2' | 'o3';
export const OUTPUTS: readonly OutputId[] = ['o0', 'o1', 'o2', 'o3'];

export interface NodeSpec {
  op: string;
  in?: string[];
  params?: Record<string, number>;
}

export interface Macro {
  label: string;
  /** "<nodeId>.<param>" */
  target: string;
  range: [number, number];
}

export interface EffectGraph {
  id: string;
  /** Catalogue number shown in the UI: FX-<code>. */
  code: string;
  /** One word, shown in caps. */
  name: string;
  version: 1;
  nodes: Record<string, NodeSpec>;
  outputs: Partial<Record<OutputId, string>>;
  display: OutputId;
  macros: Macro[];
}
