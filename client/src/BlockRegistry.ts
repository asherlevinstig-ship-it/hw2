// client/src/BlockRegistry.ts
// FULL FILE - No Omits
// Maps server-authoritative Block IDs to individual texture PNGs

export interface BlockDefinition {
  id: number;
  name: string;
  isTransparent: boolean;
  textures: {
    top?: string;
    bottom?: string;
    side?: string;
    all?: string;
    front?: string;
  };
}

export const BlockRegistry: Record<number, BlockDefinition> = {
  0: {
    id: 0,
    name: "Air",
    isTransparent: true,
    textures: {}
  },
  1: {
    id: 1,
    name: "Grass",
    isTransparent: false,
    textures: {
      top: "assets/blocks/grass_block_top.png",
      bottom: "assets/blocks/dirt.png",
      side: "assets/blocks/grass_block_side.png"
    }
  },
  2: {
    id: 2,
    name: "Dirt",
    isTransparent: false,
    textures: {
      all: "assets/blocks/dirt.png"
    }
  },
  3: {
    id: 3,
    name: "Stone",
    isTransparent: false,
    textures: {
      all: "assets/blocks/stone.png"
    }
  },
  4: {
    id: 4,
    name: "Wood",
    isTransparent: false,
    textures: {
      top: "assets/blocks/oak_log_top.png",
      bottom: "assets/blocks/oak_log_top.png",
      side: "assets/blocks/oak_log.png"
    }
  },
  5: {
    id: 5,
    name: "Leaves",
    isTransparent: true,
    textures: {
      all: "assets/blocks/oak_leaves.png"
    }
  },
  6: {
    id: 6,
    name: "Bedrock",
    isTransparent: false,
    textures: {
      all: "assets/blocks/bedrock.png"
    }
  },
  8: {
    id: 8,
    name: "Chest",
    isTransparent: true,
    textures: {
      top: "assets/blocks/chest_top.png",
      bottom: "assets/blocks/oak_planks.png",
      side: "assets/blocks/chest_side.png",
      front: "assets/blocks/chest_front.png"
    }
  },
  11: {
    id: 11,
    name: "Sand",
    isTransparent: false,
    textures: {
      all: "assets/blocks/sand.png"
    }
  },
  12: {
    id: 12,
    name: "Snow",
    isTransparent: false,
    textures: {
      all: "assets/blocks/snow.png"
    }
  },
  30: {
    id: 30,
    name: "Coal Ore",
    isTransparent: false,
    textures: {
      all: "assets/blocks/coal_ore.png"
    }
  },
  31: {
    id: 31,
    name: "Iron Ore",
    isTransparent: false,
    textures: {
      all: "assets/blocks/iron_ore.png"
    }
  },
  32: {
    id: 32,
    name: "Gold Ore",
    isTransparent: false,
    textures: {
      all: "assets/blocks/gold_ore.png"
    }
  },
  33: {
    id: 33,
    name: "Diamond Ore",
    isTransparent: false,
    textures: {
      all: "assets/blocks/diamond_ore.png"
    }
  },
  40: {
    id: 40,
    name: "Planks",
    isTransparent: false,
    textures: {
      all: "assets/blocks/oak_planks.png"
    }
  },
  41: {
    id: 41,
    name: "Stone Bricks",
    isTransparent: false,
    textures: {
      all: "assets/blocks/stone_bricks.png"
    }
  },
  42: {
    id: 42,
    name: "Carpet",
    isTransparent: true,
    textures: {
      all: "assets/blocks/red_carpet.png"
    }
  },
  43: {
    id: 43,
    name: "Glass",
    isTransparent: true,
    textures: {
      all: "assets/blocks/glass.png"
    }
  },
  44: {
    id: 44,
    name: "Lantern",
    isTransparent: true,
    textures: {
      all: "assets/blocks/lantern.png"
    }
  },
  90: {
    id: 90,
    name: "Deepslate",
    isTransparent: false,
    textures: {
      top: "assets/blocks/deepslate_top.png",
      bottom: "assets/blocks/deepslate_top.png",
      side: "assets/blocks/deepslate.png"
    }
  },
  91: {
    id: 91,
    name: "Tuff",
    isTransparent: false,
    textures: {
      all: "assets/blocks/tuff.png"
    }
  },
  92: {
    id: 92,
    name: "Moss",
    isTransparent: false,
    textures: {
      all: "assets/blocks/moss_block.png"
    }
  },
  93: {
    id: 93,
    name: "Mossy Stone",
    isTransparent: false,
    textures: {
      all: "assets/blocks/mossy_cobblestone.png"
    }
  },
  94: {
    id: 94,
    name: "Dripstone",
    isTransparent: true,
    textures: {
      all: "assets/blocks/pointed_dripstone.png"
    }
  },
  95: {
    id: 95,
    name: "Dripstone Block",
    isTransparent: false,
    textures: {
      all: "assets/blocks/dripstone_block.png"
    }
  },
  96: {
    id: 96,
    name: "Glow Shroom",
    isTransparent: false,
    textures: {
      all: "assets/blocks/shroomlight.png"
    }
  },
  97: {
    id: 97,
    name: "Crystal",
    isTransparent: true,
    textures: {
      all: "assets/blocks/amethyst_block.png"
    }
  }
};

export function getTexturePathsForBlock(id: number): string[] {
  const block = BlockRegistry[id];
  if (!block || !block.textures) {
    return [];
  }

  const paths = new Set<string>();
  if (block.textures.all) paths.add(block.textures.all);
  if (block.textures.top) paths.add(block.textures.top);
  if (block.textures.bottom) paths.add(block.textures.bottom);
  if (block.textures.side) paths.add(block.textures.side);
  if (block.textures.front) paths.add(block.textures.front);

  return Array.from(paths);
}