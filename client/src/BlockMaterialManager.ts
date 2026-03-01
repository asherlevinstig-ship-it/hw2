// client/src/BlockMaterialManager.ts
// FULL FILE - No Omits

import { Texture, StandardMaterial, Scene, Color3, Material } from "@babylonjs/core";
import { BlockRegistry, getTexturePathsForBlock } from "./BlockRegistry.js";

export class BlockMaterialManager {
  private scene: Scene;
  private textureCache: Map<string, Texture>;
  private materialCache: Map<number, Material | Material[]>;

  constructor(scene: Scene) {
    this.scene = scene;
    this.textureCache = new Map<string, Texture>();
    this.materialCache = new Map<number, Material | Material[]>();
  }

  public async loadAllTextures(): Promise<void> {
    const loadPromises: Promise<void>[] = [];

    for (const stringId in BlockRegistry) {
      const id = parseInt(stringId, 10);
      const paths = getTexturePathsForBlock(id);

      for (const path of paths) {
        if (!this.textureCache.has(path)) {
          const promise = this.loadTexture(path).then((texture) => {
            this.textureCache.set(path, texture);
          });
          loadPromises.push(promise);
        }
      }
    }

    await Promise.all(loadPromises);
    this.buildAllMaterials();
  }

  private loadTexture(path: string): Promise<Texture> {
    return new Promise((resolve, reject) => {
      const texture = new Texture(
        path,
        this.scene,
        true, // noMipmap: keeps pixels crisp
        true, // invertY: usually needed for 3D engine texture coordinates
        Texture.NEAREST_SAMPLINGMODE,
        () => resolve(texture),
        (message?: string, exception?: any) => {
          console.error(`Failed to load texture at path: ${path}`, message, exception);
          reject(exception || new Error(message || "Unknown texture load error"));
        }
      );
      
      // Ensure alpha is respected for textures that have transparency
      texture.hasAlpha = true;
    });
  }

  private buildAllMaterials(): void {
    for (const stringId in BlockRegistry) {
      const id = parseInt(stringId, 10);
      const blockDef = BlockRegistry[id];
      
      // Air does not need a material
      if (id === 0) {
        continue;
      }

      if (blockDef.textures.all) {
        const mat = this.createMaterial(blockDef.textures.all, blockDef.isTransparent, blockDef.name);
        this.materialCache.set(id, mat);
      } else {
        const matTop = this.createMaterial(blockDef.textures.top, blockDef.isTransparent, `${blockDef.name}_top`);
        const matBottom = this.createMaterial(blockDef.textures.bottom, blockDef.isTransparent, `${blockDef.name}_bottom`);
        const matSide = this.createMaterial(blockDef.textures.side, blockDef.isTransparent, `${blockDef.name}_side`);
        const matFront = this.createMaterial(blockDef.textures.front || blockDef.textures.side, blockDef.isTransparent, `${blockDef.name}_front`);

        // Babylon.js Face Material Order for standard Box meshes:
        // 0: Back, 1: Front, 2: Right, 3: Left, 4: Top, 5: Bottom
        const materialsArray = [
          matSide,   // 0: Back
          matFront,  // 1: Front
          matSide,   // 2: Right
          matSide,   // 3: Left
          matTop,    // 4: Top
          matBottom  // 5: Bottom
        ];

        this.materialCache.set(id, materialsArray);
      }
    }
  }

  private createMaterial(texturePath: string | undefined, isTransparent: boolean, name: string): StandardMaterial {
    const mat = new StandardMaterial(`mat_${name}`, this.scene);
    
    if (!texturePath || !this.textureCache.has(texturePath)) {
      // Fallback magenta texture for missing definitions
      mat.diffuseColor = new Color3(1, 0, 1);
      mat.emissiveColor = new Color3(1, 0, 1); // Makes fallback visible in the dark
      if (isTransparent) {
        mat.alpha = 0.5;
      }
      return mat;
    }

    const tex = this.textureCache.get(texturePath)!;
    
    // Applying to both diffuse and emissive channels
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex; 
    
    if (isTransparent) {
      mat.diffuseTexture.hasAlpha = true;
      mat.useAlphaFromDiffuseTexture = true;
      mat.transparencyMode = StandardMaterial.MATERIAL_ALPHATESTANDBLEND;
    }

    return mat;
  }

  public getMaterialForBlock(id: number): Material | Material[] | null {
    const material = this.materialCache.get(id);
    if (material) {
      return material;
    }
    return null;
  }
}