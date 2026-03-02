// client/src/RemoteEntityRenderer.ts
// FULL FILE - No Omits

import * as BABYLON from "@babylonjs/core/Legacy/legacy";
import "@babylonjs/loaders/glTF"; 

export type NetTransform = { 
  x: number; 
  y: number; 
  z: number; 
  yaw?: number;
  hp?: number;
  maxHp?: number;
};

export class RemoteEntityRenderer {
  private ready = false;
  public scene: BABYLON.Scene | null = null;
  private cam: BABYLON.FreeCamera | null = null;
  private glowLayer: BABYLON.GlowLayer | null = null;
  private engineHooked = false;

  private meshes = new Map<string, BABYLON.TransformNode>();
  private mats = new Map<string, BABYLON.StandardMaterial[]>(); 

  private renderOffset = new BABYLON.Vector3(0, 0, 0);
  private readonly Y_VISUAL_OFFSET = -1.65;

  private targetPos = new Map<string, BABYLON.Vector3>();

  private activeVFX: Array<{ 
    type: string; 
    mesh: BABYLON.Mesh; 
    mat: BABYLON.StandardMaterial; 
    life: number; 
    maxLife: number; 
    basePos: BABYLON.Vector3 
  }> = [];

  public enabled = true;
  public xrayEnabled = true;

  public ensureScene(noaScene: BABYLON.Scene) {
    if (this.ready && this.scene && this.cam) return;

    const engine = noaScene.getEngine();

    this.scene = new BABYLON.Scene(engine);
    this.scene.useRightHandedSystem = noaScene.useRightHandedSystem;
    this.scene.autoClear = false;
    this.scene.autoClearDepthAndStencil = false;

    if (!this.scene.lights || this.scene.lights.length === 0) {
        const light = new BABYLON.HemisphericLight("rpLight", new BABYLON.Vector3(0, 1, 0), this.scene);
        light.intensity = 1.2;
        light.specular = new BABYLON.Color3(0.1, 0.1, 0.1);
    }

    this.cam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, 0), this.scene);
    this.cam.minZ = 0.05;
    this.cam.maxZ = 10000;
    this.cam.rotationQuaternion = new BABYLON.Quaternion();
    this.scene.activeCamera = this.cam;

    if (!this.glowLayer) {
      this.glowLayer = new BABYLON.GlowLayer("rpGlow", this.scene);
      this.glowLayer.intensity = 0.8;
    }

    if (!this.engineHooked) {
      this.engineHooked = true;
      engine.onEndFrameObservable.add(() => {
        if (this.enabled && this.scene) {
          this.scene.render();
        }
      });
    }

    this.ready = true;
  }

  public syncCamera(worldScene: BABYLON.Scene, playerPos: number[] | null, enableXray: boolean) {
    if (!this.ready || !this.scene || !this.cam) return;

    this.xrayEnabled = enableXray;
    const worldCam = worldScene.activeCamera as any;
    if (!worldCam) return;

    this.cam.viewport = worldCam.viewport?.clone?.() ?? this.cam.viewport;

    if (typeof worldCam.fov === "number") (this.cam as any).fov = worldCam.fov;
    if (typeof worldCam.fovMode === "number") (this.cam as any).fovMode = worldCam.fovMode;
    if (typeof worldCam.minZ === "number") this.cam.minZ = worldCam.minZ;
    if (typeof worldCam.maxZ === "number") this.cam.maxZ = worldCam.maxZ;

    const wm = typeof worldCam.getWorldMatrix === "function" ? worldCam.getWorldMatrix() : null;
    if (wm) {
      const absPos = new BABYLON.Vector3();
      wm.decompose(undefined, undefined, absPos);
      this.cam.position.copyFrom(absPos);

      const rotMat = wm.getRotationMatrix();
      const absRotQ = BABYLON.Quaternion.FromRotationMatrix(rotMat);
      if (!this.cam.rotationQuaternion) this.cam.rotationQuaternion = new BABYLON.Quaternion();
      this.cam.rotationQuaternion.copyFrom(absRotQ);
    } else {
      if (typeof worldCam.getAbsolutePosition === "function") {
        this.cam.position.copyFrom(worldCam.getAbsolutePosition());
      } else if (worldCam.globalPosition instanceof BABYLON.Vector3) {
        this.cam.position.copyFrom(worldCam.globalPosition);
      } else if (worldCam.position instanceof BABYLON.Vector3) {
        this.cam.position.copyFrom(worldCam.position);
      }

      if (worldCam.rotationQuaternion && this.cam.rotationQuaternion) {
        this.cam.rotationQuaternion.copyFrom(worldCam.rotationQuaternion);
      } else if (worldCam.rotation instanceof BABYLON.Vector3) {
        this.cam.rotation.copyFrom(worldCam.rotation);
      }
    }

    if (playerPos) {
      this.renderOffset.set(this.cam.position.x - playerPos[0], this.cam.position.y - playerPos[1], this.cam.position.z - playerPos[2]);
    }

    if (this.xrayEnabled) {
      this.scene.autoClearDepthAndStencil = true;
      for (const matList of this.mats.values()) {
        matList.forEach(mat => {
          mat.disableDepthWrite = true;
          mat.depthFunction = BABYLON.Constants.ALWAYS;
        });
      }
    } else {
      this.scene.autoClearDepthAndStencil = false;
      for (const matList of this.mats.values()) {
        matList.forEach(mat => {
          mat.disableDepthWrite = false;
          mat.depthFunction = BABYLON.Constants.LESS;
        });
      }
    }
  }

  private updateMobNameplate(root: BABYLON.TransformNode, id: string, hp: number, maxHp: number) {
      if (!this.scene || !this.cam) return;

      let plate = (root as any).__nameplate as BABYLON.Mesh;
      let tex = (root as any).__nameplateTex as BABYLON.DynamicTexture;

      const isGiant = (root as any).__isGiant;
      const isPlayer = !(root as any).__isMob && !isGiant;
      
      const nameplateWidth = isGiant ? 16.0 : (isPlayer ? 2.0 : 1.5);
      const nameplateHeight = isGiant ? 4.0 : 0.4;
      
      // TWEAKED: Significantly lowered to sit closely to the top of the scaled model's head
      const nameplateYOffset = isGiant ? 16.0 : 2.0; 

      if (!plate) {
          plate = BABYLON.MeshBuilder.CreatePlane("np:" + id, { width: nameplateWidth, height: nameplateHeight }, this.scene);
          plate.parent = root;
          plate.position.y = nameplateYOffset; 
          plate.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
          plate.isPickable = false;
          
          tex = new BABYLON.DynamicTexture("npTex:" + id, { width: 512, height: 128 }, this.scene, false);
          tex.hasAlpha = true;

          const mat = new BABYLON.StandardMaterial("npMat:" + id, this.scene);
          mat.diffuseTexture = tex;
          mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
          mat.disableLighting = true;
          mat.backFaceCulling = false;
          
          plate.material = mat;

          (root as any).__nameplate = plate;
          (root as any).__nameplateTex = tex;

          if (!this.mats.has(id)) this.mats.set(id, []);
          this.mats.get(id)!.push(mat);
      }

      const dist = BABYLON.Vector3.Distance(this.cam.position, plate.getAbsolutePosition());
      const maxDist = isGiant ? 300 : 15; 
      const fadeAlpha = BABYLON.Scalar.Clamp(1.0 - (dist - (maxDist - 5)) / 5, 0, 1);
      plate.visibility = fadeAlpha;

      if (fadeAlpha <= 0) return; 

      const lastHp = (root as any).__lastHp;
      if (lastHp !== hp) {
          (root as any).__lastHp = hp;
          
          const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
          ctx.clearRect(0, 0, 512, 128);

          ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
          ctx.fillRect(20, 70, 472, 24);

          const pct = Math.max(0, hp / maxHp);
          ctx.fillStyle = pct > 0.5 ? "#00ff00" : (pct > 0.25 ? "#ffff00" : "#ff0000");
          ctx.fillRect(20, 70, 472 * pct, 24);

          ctx.font = isGiant ? "bold 48px monospace" : "bold 38px monospace";
          ctx.fillStyle = isGiant ? "#FFD700" : (isPlayer ? "#00FFFF" : "white"); 
          ctx.textAlign = "center";
          ctx.shadowColor = "black";
          ctx.shadowBlur = 4;
          
          let name = id.slice(0, 8);
          if (isGiant) name = "The Ancient Warden";
          else if (id.includes("golem")) name = "Deepslate Golem";
          else if (id.includes("dummy")) name = "Training Dummy";
          
          ctx.fillText(name, 256, 50);
          tex.update();
      }
  }

  private ensureRemoteMesh(id: string): BABYLON.TransformNode | null {
    if (!this.scene) return null;

    const existing = this.meshes.get(id);
    if (existing) return existing;

    const isMob = id.includes("dummy") || id.includes("mob") || id.includes("golem") || id.includes("npc_");
    const isGiant = id.includes("npc_giant");
    const isPlayer = !isMob && !isGiant;

    const root = new BABYLON.TransformNode(`remoteRoot:${id}`, this.scene);
    (root as any).__isGiant = isGiant;
    (root as any).__isMob = isMob;
    (root as any).__isPlayer = isPlayer;

    let parts: any = {};
    this.mats.set(id, []);

    BABYLON.SceneLoader.ImportMeshAsync(
        "",
        "/models/sukuna/", 
        "Sukuna Character GLTF.gltf",
        this.scene
    ).then(result => {
        if (root.isDisposed()) {
            result.meshes.forEach(m => m.dispose());
            return;
        }

        const rootMesh = result.meshes[0];
        rootMesh.parent = root;

        const baseScale = isGiant ? 0.25 : 0.012;
        rootMesh.scaling.setAll(baseScale);
        rootMesh.rotation.y = Math.PI;

        result.meshes.forEach(m => {
            m.isPickable = false;
        });

        // Force strictly IDLE animation
        if (result.animationGroups && result.animationGroups.length > 0) {
            let idleAnim = result.animationGroups.find(a => a.name.toLowerCase().includes("idle"));
            if (!idleAnim) idleAnim = result.animationGroups[0]; 

            result.animationGroups.forEach(anim => {
                anim.stop(); 
            });

            idleAnim.start(true);
            idleAnim.weight = 1.0;
        }
    }).catch(err => console.warn(`[GLTF] Failed to load model for ${id}:`, err));

    (root as any).__parts = parts;

    this.meshes.set(id, root);
    this.targetPos.set(id, new BABYLON.Vector3(0, 0, 0));

    return root;
  }

  public removeRemoteMesh(id: string) {
    const root = this.meshes.get(id);
    if (root) {
      const tex = (root as any).__nameplateTex as BABYLON.DynamicTexture | undefined;
      if (tex) {
          try { tex.dispose(); } catch {}
      }
      try { root.dispose(false, false); } catch {}
      this.meshes.delete(id);
    }
    
    const matList = this.mats.get(id);
    if (matList) {
      for (const m of matList) {
        try { m.dispose(false, false); } catch {}
      }
      this.mats.delete(id);
    }
    
    this.targetPos.delete(id);
  }

  public update(dtSec: number, netTransforms: Map<string, NetTransform>, mySessionId: string | undefined, _matManager: any, remoteFlashes: Map<string, number>, _remoteSwings: any) {
    if (!this.enabled || !this.ready || !this.scene) return;

    for (const id of Array.from(this.meshes.keys())) {
      if (!netTransforms.has(id)) this.removeRemoteMesh(id);
    }

    const now = performance.now();

    for (const [id, t] of netTransforms.entries()) {
      if (id === mySessionId) continue;

      const root = this.ensureRemoteMesh(id);
      if (!root) continue;

      const isGiant = (root as any).__isGiant;
      
      const targetYOffset = isGiant ? -1.0 : this.Y_VISUAL_OFFSET;

      const target = this.targetPos.get(id) ?? new BABYLON.Vector3();
      target.set(t.x + this.renderOffset.x, t.y + this.renderOffset.y + targetYOffset, t.z + this.renderOffset.z);
      this.targetPos.set(id, target);

      const lerp = 1 - Math.pow(0.001, dtSec);
      root.position.x += (target.x - root.position.x) * lerp;
      root.position.y += (target.y - root.position.y) * lerp;
      root.position.z += (target.z - root.position.z) * lerp;

      if (typeof t.yaw === "number") {
        let dyaw = t.yaw - root.rotation.y;
        while (dyaw > Math.PI) dyaw -= Math.PI * 2;
        while (dyaw < -Math.PI) dyaw += Math.PI * 2;
        root.rotation.y += dyaw * lerp;
      }

      const hp = t.hp ?? 100;
      const maxHp = t.maxHp ?? 100;
      
      this.updateMobNameplate(root, id, hp, maxHp);

      const flashTime = remoteFlashes.get(id);
      const isHit = flashTime && now - flashTime < 200;

      const childMeshes = root.getChildMeshes();
      childMeshes.forEach(m => {
          if (m.material && m.material.getClassName() === "PBRMaterial") {
              const pbr = m.material as BABYLON.PBRMaterial;
              if (isHit) {
                  if (!(pbr as any).__baseEmissive) (pbr as any).__baseEmissive = pbr.emissiveColor.clone();
                  pbr.emissiveColor = new BABYLON.Color3(1, 0, 0); 
              } else {
                  if ((pbr as any).__baseEmissive) {
                      pbr.emissiveColor.copyFrom((pbr as any).__baseEmissive);
                  }
              }
          }
      });
    }
  }

  public spawnSkillVFX(attackId: string, globalX: number, globalY: number, globalZ: number, yaw: number) {
    if (!this.ready || !this.scene) return;

    const uid = `${attackId}_${Date.now()}_${Math.random().toString(16).slice(2)}`;

    let mesh: BABYLON.Mesh;
    const mat = new BABYLON.StandardMaterial(`vfxMat_${uid}`, this.scene);
    mat.disableLighting = true;
    mat.backFaceCulling = false;
    mat.alpha = 1.0;
    mat.alphaMode = BABYLON.Constants.ALPHA_ADD;
    mat.disableDepthWrite = true;
    mat.depthFunction = BABYLON.Constants.ALWAYS;
    
    let maxLife = 0.6;

    if (attackId === "AURA_SLASH") {
      mesh = BABYLON.MeshBuilder.CreateTorus(`slashVFX_${uid}`, { diameter: 4, thickness: 0.2, tessellation: 24 }, this.scene);
      mesh.scaling.y = 0.1; 
      mat.emissiveColor = new BABYLON.Color3(0, 1, 1); 
    } else if (attackId === "AURA_HEAVY") {
      mesh = BABYLON.MeshBuilder.CreateSphere(`heavyVFX_${uid}`, { diameter: 3, segments: 16 }, this.scene);
      mat.emissiveColor = new BABYLON.Color3(1, 0, 1); 
      maxLife = 0.8;
    } else if (attackId === "AURA_THRUST") {
      mesh = BABYLON.MeshBuilder.CreateCylinder(`thrustVFX_${uid}`, { height: 6, diameter: 0.6 }, this.scene);
      mesh.rotation.x = Math.PI / 2; 
      mat.emissiveColor = new BABYLON.Color3(1, 1, 0); 
    } else if (attackId === "NATURE_GRASP") {
      mesh = BABYLON.MeshBuilder.CreateTorusKnot(`natureVFX_${uid}`, { radius: 1.5, tube: 0.2, radialSegments: 64, tubularSegments: 8, p: 2, q: 3 }, this.scene);
      mat.emissiveColor = new BABYLON.Color3(0.2, 1.0, 0.2); 
      maxLife = 0.9;
    } else {
      return; 
    }

    mesh.material = mat;
    mesh.isPickable = false;
    mesh.renderingGroupId = 3; 
    (mesh as any).isInFrustum = () => true;
    (mesh as any).alwaysSelectAsActiveMesh = true;
    
    const forwardX = Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    
    let bx = globalX + forwardX * 1.5;
    let by = globalY + 1.2;
    let bz = globalZ + forwardZ * 1.5;
    
    if (attackId === "AURA_THRUST") {
      mesh.rotation.y = yaw;
      bx = globalX + forwardX * 3;
      bz = globalZ + forwardZ * 3;
    }

    const basePos = new BABYLON.Vector3(bx, by, bz);

    mesh.position.set(
      basePos.x + this.renderOffset.x,
      basePos.y + this.renderOffset.y,
      basePos.z + this.renderOffset.z
    );

    this.activeVFX.push({ type: attackId, mesh, mat, life: 0, maxLife, basePos }); 
  }

  public updateVFX(dtSec: number) {
    for (let i = this.activeVFX.length - 1; i >= 0; i--) {
      const vfx = this.activeVFX[i];
      vfx.life += dtSec;
      
      const progress = Math.min(1, vfx.life / vfx.maxLife);
      
      if (progress > 0.5) {
        vfx.mat.alpha = 1.0 * (1 - ((progress - 0.5) * 2));
      }
      
      if (vfx.type === "AURA_SLASH") {
        vfx.mesh.scaling.x += dtSec * 8;
        vfx.mesh.scaling.z += dtSec * 8;
      } else if (vfx.type === "AURA_HEAVY") {
        vfx.mesh.scaling.x += dtSec * 5;
        vfx.mesh.scaling.y += dtSec * 5;
        vfx.mesh.scaling.z += dtSec * 5;
      } else if (vfx.type === "AURA_THRUST") {
        vfx.mesh.scaling.y += dtSec * 8; 
      } else if (vfx.type === "NATURE_GRASP") {
        vfx.mesh.rotation.y += dtSec * 10;
        vfx.mesh.scaling.x += dtSec * 4;
        vfx.mesh.scaling.y += dtSec * 4;
        vfx.mesh.scaling.z += dtSec * 4;
      }

      vfx.mesh.position.set(
        vfx.basePos.x + this.renderOffset.x,
        vfx.basePos.y + this.renderOffset.y,
        vfx.basePos.z + this.renderOffset.z
      );

      if (vfx.life >= vfx.maxLife) {
        vfx.mat.dispose();
        vfx.mesh.dispose();
        this.activeVFX.splice(i, 1);
      }
    }
  }
}