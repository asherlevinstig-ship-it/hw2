// server/src/types/prismarine-schematic.d.ts
// FULL FILE — paste exactly as-is

declare module "prismarine-schematic" {
  /**
   * prismarine-schematic expects Vec3-like objects (from `vec3`)
   * in methods like getBlock/getBlockStateId. We keep these as `any`
   * to avoid hard-coupling to a specific Vec3 type package.
   */

  export type Vec3Like = any;

  export type PrismarineBlock = {
    name?: string;
    type?: number;
    metadata?: number;
    stateId?: number;
    properties?: Record<string, any>;
  } | null;

  export type ReadSchematicResult = {
    // schematic dimensions
    size: { x: number; y: number; z: number };

    // origin/offset are used internally by prismarine-schematic
    offset?: { x: number; y: number; z: number };

    // block accessors (Vec3-like required by the lib)
    getBlock(pos: Vec3Like): PrismarineBlock;
    getBlockStateId?(pos: Vec3Like): number;
  };

  export const Schematic: {
    read(buffer: Buffer, opts?: any): Promise<ReadSchematicResult>;
  };
}
