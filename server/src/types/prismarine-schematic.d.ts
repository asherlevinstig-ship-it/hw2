declare module "prismarine-schematic" {
  // Minimal typing to satisfy TS (we only type what we use)
  export const Schematic: {
    read(buffer: Buffer, opts?: any): Promise<{
      size: { x: number; y: number; z: number };
      getBlock(pos: { x: number; y: number; z: number }): { name?: string } | null;
    }>;
  };
}
