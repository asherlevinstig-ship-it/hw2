// client/src/RemoteEntityRenderer.ts
// FULL FILE - No Omits

import * as BABYLON from "@babylonjs/core/Legacy/legacy";
import type { BlockMaterialManager } from "./BlockMaterialManager";

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
  private mats = new Map<string, BABYLON.StandardMaterial[]>(); // Track all mats per ID for cleanup

  private renderOffset = new BABYLON.Vector3(0, 0, 0);
  private readonly Y_VISUAL_OFFSET = -1.65;

  private prevPos = new Map<string, BABYLON.Vector3>();
  private prevAt = new Map<string, number>();
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

    this.cam = new BABYLON.FreeCamera("rpCam", new BABYLON.Vector3(0, 0, 0), this.scene);
    this.cam.minZ = 0.05;
    this.cam.maxZ = 10000;
    this.cam.rotationQuaternion = new BABYLON.Quaternion();
    this.scene.activeCamera = this.cam;

    if (!this.glowLayer) {
      this.glowLayer = new BABYLON.GlowLayer("rpGlow", this.scene);
      this.glowLayer.intensity = 0.7; // Crisp bloom for eyes and magic only
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

  // Smart Material Generator: Kills fullbright textures, uses subtle color lifts, allows optional glow
  private getMat(matManager: BlockMaterialManager | null, blockId: number, fallbackColor: BABYLON.Color3, isGlowing: boolean = false, idKey: string): BABYLON.StandardMaterial {
    const mat = new BABYLON.StandardMaterial(`mat_${blockId}_${idKey}`, this.scene!);
    mat.disableLighting = true; 
    mat.backFaceCulling = false;
    (mat as any).fogEnabled = false;

    const baseInfo = matManager?.getMaterialForBlock(blockId);
    const baseMat = (Array.isArray(baseInfo) ? baseInfo[0] : baseInfo) as BABYLON.StandardMaterial | undefined;

    if (baseMat && baseMat.diffuseTexture) {
      mat.diffuseTexture = baseMat.diffuseTexture;
      if (isGlowing) {
        mat.emissiveTexture = baseMat.diffuseTexture;
        mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      } else {
        // Subtle ambient lift so it's readable without a light source, but doesn't bloom or look flat
        mat.emissiveColor = new BABYLON.Color3(0.2, 0.2, 0.2); 
      }
    } else {
      mat.emissiveColor = fallbackColor;
    }

    // Register material for cleanup
    if (!this.mats.has(idKey)) this.mats.set(idKey, []);
    this.mats.get(idKey)!.push(mat);

    return mat;
  }

  // Deterministic Hash for randomizing mob accessories
  private hashId(id: string): number {
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        const char = id.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash) / 2147483647; // 0.0 to 1.0
  }

  private updateMobNameplate(root: BABYLON.TransformNode, id: string, hp: number, maxHp: number) {
      if (!this.scene || !this.cam) return;

      let plate = (root as any).__nameplate as BABYLON.Mesh;
      let tex = (root as any).__nameplateTex as BABYLON.DynamicTexture;

      const isGiant = (root as any).__isGiant;
      const isPlayer = !(root as any).__isMob && !isGiant;
      
      const nameplateWidth = isGiant ? 6.0 : (isPlayer ? 2.0 : 1.5);
      const nameplateHeight = isGiant ? 1.6 : 0.4;
      const nameplateYOffset = isGiant ? 6.5 : (isPlayer ? 2.4 : 2.2);

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

          // Track nameplate material for cleanup
          if (!this.mats.has(id)) this.mats.set(id, []);
          this.mats.get(id)!.push(mat);
      }

      // Distance Fade Logic
      const dist = BABYLON.Vector3.Distance(this.cam.position, plate.getAbsolutePosition());
      const maxDist = isGiant ? 60 : 15; // Nameplates fade out far away
      const fadeAlpha = BABYLON.Scalar.Clamp(1.0 - (dist - (maxDist - 5)) / 5, 0, 1);
      plate.visibility = fadeAlpha;

      if (fadeAlpha <= 0) return; // Skip canvas redraw if invisible

      const lastHp = (root as any).__lastHp;
      if (lastHp !== hp) {
          (root as any).__lastHp = hp;
          
          const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
          ctx.clearRect(0, 0, 512, 128);

          // Much darker, cleaner background
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
          
          let name = isPlayer ? id.slice(0, 8) : "Player";
          if (isGiant) name = "The Ancient Warden";
          else if (id.includes("golem")) name = "Deepslate Golem";
          else if (id.includes("dummy")) name = "Training Dummy";
          
          ctx.fillText(name, 256, 50);
          tex.update();
      }
  }

  private ensureRemoteMesh(id: string, matManager: BlockMaterialManager | null): BABYLON.TransformNode | null {
    if (!this.scene) return null;

    const existing = this.meshes.get(id);
    if (existing) return existing;

    const isMob = id.includes("dummy") || id.includes("mob") || id.includes("golem") || id.includes("npc_");
    const isGiant = id.includes("npc_giant");
    const isPlayer = !isMob && !isGiant;

    const root = new BABYLON.TransformNode(`remoteRoot:${id}`, this.scene);
    (root as any).__isMob = isMob;
    (root as any).__isGiant = isGiant;
    (root as any).__isPlayer = isPlayer;

    let parts: any = {};
    const seed = this.hashId(id);

    // Initialize Material Array for cleanup tracking
    this.mats.set(id, []);

    // Common materials via helper
    const stoneMat = this.getMat(matManager, 90, new BABYLON.Color3(0.2, 0.2, 0.2), false, id); // 90 = Deepslate
    const trimMat = this.getMat(matManager, 91, new BABYLON.Color3(0.3, 0.3, 0.3), false, id); // 91 = Tuff
    const darkMat = this.getMat(matManager, 30, new BABYLON.Color3(0.05, 0.05, 0.05), false, id); // 30 = Coal Ore
    const goldMat = this.getMat(matManager, 32, new BABYLON.Color3(0.8, 0.7, 0.1), false, id); // 32 = Gold Ore
    const woodMat = this.getMat(matManager, 4, new BABYLON.Color3(0.4, 0.3, 0.1), false, id); // 4 = Wood

    if (isGiant) {
      // ==========================================
      // THE ANCIENT WARDEN (Giant Boss Rig)
      // ==========================================
      const magicMat = new BABYLON.StandardMaterial(`gMagic:${id}`, this.scene);
      magicMat.disableLighting = true;
      magicMat.emissiveColor = new BABYLON.Color3(0, 1, 1);
      (magicMat as any).fogEnabled = false;
      this.mats.get(id)!.push(magicMat);

      const torso = new BABYLON.TransformNode(`gTorso:${id}`, this.scene);
      torso.parent = root;
      torso.position.y = 1.0;

      const body = BABYLON.MeshBuilder.CreateBox(`gBody:${id}`, { width: 1.4, height: 1.8, depth: 0.8 }, this.scene);
      body.material = stoneMat;
      body.parent = torso;
      body.position.y = 0.9;

      const chestCore = BABYLON.MeshBuilder.CreateBox(`gCore:${id}`, { width: 0.5, height: 0.5, depth: 0.9 }, this.scene);
      chestCore.material = magicMat;
      chestCore.parent = torso;
      chestCore.position.y = 0.9;

      const headJoint = new BABYLON.TransformNode(`gHeadJoint:${id}`, this.scene);
      headJoint.parent = torso;
      headJoint.position.y = 1.9;

      const head = BABYLON.MeshBuilder.CreateBox(`gHead:${id}`, { width: 0.6, height: 0.6, depth: 0.6 }, this.scene);
      head.material = stoneMat;
      head.parent = headJoint;
      head.position.y = 0.4;

      const halo = BABYLON.MeshBuilder.CreateTorus(`gHalo:${id}`, { diameter: 1.2, thickness: 0.1, tessellation: 16 }, this.scene);
      halo.material = magicMat;
      halo.parent = headJoint;
      halo.position.y = 0.9;

      const armJointL = new BABYLON.TransformNode(`gArmJL:${id}`, this.scene);
      armJointL.parent = torso;
      armJointL.position.set(-0.9, 1.6, 0);

      const pL = BABYLON.MeshBuilder.CreateBox(`gPL:${id}`, { width: 0.6, height: 0.5, depth: 0.9 }, this.scene);
      pL.material = goldMat;
      pL.parent = armJointL;
      pL.position.y = 0.2;

      const armL = BABYLON.MeshBuilder.CreateBox(`gArmL:${id}`, { width: 0.4, height: 2.0, depth: 0.4 }, this.scene);
      armL.material = stoneMat;
      armL.parent = armJointL;
      armL.position.y = -0.8;

      const armJointR = new BABYLON.TransformNode(`gArmJR:${id}`, this.scene);
      armJointR.parent = torso;
      armJointR.position.set(0.9, 1.6, 0);

      const pR = BABYLON.MeshBuilder.CreateBox(`gPR:${id}`, { width: 0.6, height: 0.5, depth: 0.9 }, this.scene);
      pR.material = goldMat;
      pR.parent = armJointR;
      pR.position.y = 0.2;

      const armR = BABYLON.MeshBuilder.CreateBox(`gArmR:${id}`, { width: 0.4, height: 2.0, depth: 0.4 }, this.scene);
      armR.material = stoneMat;
      armR.parent = armJointR;
      armR.position.y = -0.8;

      const legL = BABYLON.MeshBuilder.CreateBox(`gLegL:${id}`, { width: 0.5, height: 1.0, depth: 0.5 }, this.scene);
      legL.material = stoneMat;
      legL.parent = root;
      legL.position.set(-0.4, 0.5, 0);

      const legR = BABYLON.MeshBuilder.CreateBox(`gLegR:${id}`, { width: 0.5, height: 1.0, depth: 0.5 }, this.scene);
      legR.material = stoneMat;
      legR.parent = root;
      legR.position.set(0.4, 0.5, 0);

      const staff = BABYLON.MeshBuilder.CreateCylinder(`gStaff:${id}`, { height: 4.0, diameter: 0.15 }, this.scene);
      staff.material = goldMat;
      staff.parent = armR;
      staff.position.set(0, -0.5, 0.4);
      staff.rotation.x = Math.PI / 8;

      const crystal = BABYLON.MeshBuilder.CreateSphere(`gCrys:${id}`, { diameter: 0.6, segments: 4 }, this.scene);
      crystal.material = magicMat;
      crystal.parent = staff;
      crystal.position.y = 2.0;

      [body, head, pL, pR, armL, armR, legL, legR, halo, chestCore, staff, crystal].forEach(m => {
          m.isPickable = false;
          (m as any).isInFrustum = () => true;
      });

      root.scaling.set(3, 3, 3); 
      parts = { torso, headJoint, armJointL, armJointR, legL, legR, halo, crystal, magicMat, bodyMat: stoneMat };

    } else if (isMob) {
      // ==========================================
      // STANDARD GOLEM RIG (Hierarchical & Proportional)
      // ==========================================
      const eyeMat = new BABYLON.StandardMaterial(`mobEyeMat:${id}`, this.scene);
      eyeMat.disableLighting = true;
      eyeMat.emissiveColor = new BABYLON.Color3(1, 0.1, 0.1); 
      (eyeMat as any).fogEnabled = false;
      this.mats.get(id)!.push(eyeMat);

      // Main Skeleton
      const torso = new BABYLON.TransformNode(`mTorso:${id}`, this.scene);
      torso.parent = root;
      torso.position.y = 0.5; // Hips

      // Fixed Proportions: Wider, slightly flatter body
      const body = BABYLON.MeshBuilder.CreateBox(`mBody:${id}`, { width: 0.95, height: 1.05, depth: 0.7 }, this.scene);
      body.parent = torso;
      body.position.y = 0.525;
      body.material = stoneMat;

      // Custom Voxel Face
      const headJoint = new BABYLON.TransformNode(`mHeadJoint:${id}`, this.scene);
      headJoint.parent = torso;
      headJoint.position.set(0, 1.05, 0.05); // Less snouty Z

      const head = BABYLON.MeshBuilder.CreateBox(`mHead:${id}`, { size: 0.6 }, this.scene);
      head.parent = headJoint;
      head.position.y = 0.3;
      head.material = stoneMat;

      const face = BABYLON.MeshBuilder.CreateBox(`mFace:${id}`, { width: 0.45, height: 0.35, depth: 0.05 }, this.scene);
      face.parent = head;
      face.position.set(0, -0.05, 0.31); // Embedded dark mask
      face.material = darkMat;

      const brow = BABYLON.MeshBuilder.CreateBox(`mBrow:${id}`, { width: 0.5, height: 0.1, depth: 0.1 }, this.scene);
      brow.parent = head;
      brow.position.set(0, 0.15, 0.31);
      brow.material = trimMat; // Trim colored brow

      const eyeL = BABYLON.MeshBuilder.CreateBox(`mEyeL:${id}`, { size: 0.08 }, this.scene);
      eyeL.parent = face;
      eyeL.position.set(-0.12, 0.0, 0.02);
      eyeL.material = eyeMat;

      const eyeR = BABYLON.MeshBuilder.CreateBox(`mEyeR:${id}`, { size: 0.08 }, this.scene);
      eyeR.parent = face;
      eyeR.position.set(0.12, 0.0, 0.02);
      eyeR.material = eyeMat;

      // Arms & Shoulders
      const armJointL = new BABYLON.TransformNode(`mArmJL:${id}`, this.scene);
      armJointL.parent = torso;
      armJointL.position.set(-0.65, 0.9, 0);

      const pauldronL = BABYLON.MeshBuilder.CreateBox(`mPauldronL:${id}`, { width: 0.4, height: 0.25, depth: 0.45 }, this.scene);
      pauldronL.parent = armJointL;
      pauldronL.position.set(-0.05, 0.1, 0);
      pauldronL.material = trimMat; // 2-tone pop

      const armL = BABYLON.MeshBuilder.CreateBox(`mArmL:${id}`, { width: 0.3, height: 1.1, depth: 0.3 }, this.scene);
      armL.parent = armJointL;
      armL.position.y = -0.4;
      armL.material = stoneMat;

      const armJointR = new BABYLON.TransformNode(`mArmJR:${id}`, this.scene);
      armJointR.parent = torso;
      armJointR.position.set(0.65, 0.9, 0);

      const pauldronR = BABYLON.MeshBuilder.CreateBox(`mPauldronR:${id}`, { width: 0.4, height: 0.25, depth: 0.45 }, this.scene);
      pauldronR.parent = armJointR;
      pauldronR.position.set(0.05, 0.1, 0);
      pauldronR.material = trimMat;

      const armR = BABYLON.MeshBuilder.CreateBox(`mArmR:${id}`, { width: 0.3, height: 1.1, depth: 0.3 }, this.scene);
      armR.parent = armJointR;
      armR.position.y = -0.4;
      armR.material = stoneMat;

      // Legs & Feet (Wider stance)
      const legL = BABYLON.MeshBuilder.CreateBox(`mLegL:${id}`, { width: 0.28, height: 0.5, depth: 0.28 }, this.scene);
      legL.parent = root;
      legL.position.set(-0.3, 0.25, 0);
      legL.material = stoneMat;

      const footL = BABYLON.MeshBuilder.CreateBox(`mFootL:${id}`, { width: 0.32, height: 0.18, depth: 0.45 }, this.scene);
      footL.parent = legL;
      footL.position.set(0, -0.16, 0.05);
      footL.material = trimMat;

      const legR = BABYLON.MeshBuilder.CreateBox(`mLegR:${id}`, { width: 0.28, height: 0.5, depth: 0.28 }, this.scene);
      legR.parent = root;
      legR.position.set(0.3, 0.25, 0);
      legR.material = stoneMat;

      const footR = BABYLON.MeshBuilder.CreateBox(`mFootR:${id}`, { width: 0.32, height: 0.18, depth: 0.45 }, this.scene);
      footR.parent = legR;
      footR.position.set(0, -0.16, 0.05);
      footR.material = trimMat;

      // --- Deterministic Accessories based on Hash ---
      const orbiters: BABYLON.Mesh[] = [];
      if (seed < 0.3) {
        // Option 1: Horns
        const hornL = BABYLON.MeshBuilder.CreateBox(`mHornL:${id}`, { width: 0.1, height: 0.3, depth: 0.1 }, this.scene);
        hornL.parent = head; hornL.position.set(-0.25, 0.4, 0.1); hornL.rotation.z = Math.PI/6; hornL.material = trimMat;
        const hornR = BABYLON.MeshBuilder.CreateBox(`mHornR:${id}`, { width: 0.1, height: 0.3, depth: 0.1 }, this.scene);
        hornR.parent = head; hornR.position.set(0.25, 0.4, 0.1); hornR.rotation.z = -Math.PI/6; hornR.material = trimMat;
      } else if (seed > 0.7) {
        // Option 2: Crystal Back Spikes
        const spikeMat = new BABYLON.StandardMaterial(`mSpikeMat:${id}`, this.scene);
        spikeMat.disableLighting = true; spikeMat.emissiveColor = new BABYLON.Color3(0, 0.8, 1);
        this.mats.get(id)!.push(spikeMat);

        const spike1 = BABYLON.MeshBuilder.CreateCylinder(`mSpike1:${id}`, { diameterTop: 0, diameterBottom: 0.3, height: 0.7, tessellation: 4 }, this.scene);
        spike1.parent = torso; spike1.position.set(0, 0.7, -0.35); spike1.rotation.x = -Math.PI/4; spike1.material = spikeMat;
      } else {
        // Option 3: Orbiters
        for(let i=0; i<3; i++) {
            const orb = BABYLON.MeshBuilder.CreateBox(`mobOrb${i}:${id}`, {size: 0.15}, this.scene);
            orb.material = eyeMat; orb.parent = root; orbiters.push(orb);
        }
      }

      [body, head, face, brow, armL, armR, pauldronL, pauldronR, legL, legR, footL, footR].forEach(m => {
          m.isPickable = false;
          (m as any).isInFrustum = () => true;
      });

      parts = { torso, headJoint, armJointL, armJointR, legL, legR, orbiters, eyeMat, bodyMat: stoneMat };

    } else {
      // ==========================================
      // STANDARD PLAYER RIG (Hierarchical)
      // ==========================================
      const torso = new BABYLON.TransformNode(`pTorso:${id}`, this.scene);
      torso.parent = root;
      torso.position.y = 0.9;

      const body = BABYLON.MeshBuilder.CreateBox(`pBody:${id}`, { width: 0.65, height: 0.95, depth: 0.32 }, this.scene);
      body.parent = torso;
      body.position.y = 0.475;
      body.material = woodMat; // Using wood as a fallback player skin texture

      const headJoint = new BABYLON.TransformNode(`pHeadJoint:${id}`, this.scene);
      headJoint.parent = torso;
      headJoint.position.y = 0.95;

      const head = BABYLON.MeshBuilder.CreateBox(`pHead:${id}`, { size: 0.55 }, this.scene);
      head.parent = headJoint;
      head.position.y = 0.275;
      head.material = woodMat;

      const armJointL = new BABYLON.TransformNode(`pArmJL:${id}`, this.scene);
      armJointL.parent = torso;
      armJointL.position.set(-0.45, 0.8, 0);

      const armL = BABYLON.MeshBuilder.CreateBox(`pArmL:${id}`, { width: 0.2, height: 0.85, depth: 0.2 }, this.scene);
      armL.parent = armJointL;
      armL.position.y = -0.3;
      armL.material = woodMat;

      const armJointR = new BABYLON.TransformNode(`pArmJR:${id}`, this.scene);
      armJointR.parent = torso;
      armJointR.position.set(0.45, 0.8, 0);

      const armR = BABYLON.MeshBuilder.CreateBox(`pArmR:${id}`, { width: 0.2, height: 0.85, depth: 0.2 }, this.scene);
      armR.parent = armJointR;
      armR.position.y = -0.3;
      armR.material = woodMat;

      const legL = BABYLON.MeshBuilder.CreateBox(`pLegL:${id}`, { width: 0.22, height: 0.9, depth: 0.22 }, this.scene);
      legL.parent = root;
      legL.position.set(-0.16, 0.45, 0);
      legL.material = woodMat;

      const legR = BABYLON.MeshBuilder.CreateBox(`pLegR:${id}`, { width: 0.22, height: 0.9, depth: 0.22 }, this.scene);
      legR.parent = root;
      legR.position.set(0.16, 0.45, 0);
      legR.material = woodMat;

      [body, head, armL, armR, legL, legR].forEach(m => {
          m.isPickable = false;
          (m as any).isInFrustum = () => true;
      });

      // Simple player backpack based on hash
      if (seed > 0.5) {
        const pack = BABYLON.MeshBuilder.CreateBox(`pPack:${id}`, { width: 0.5, height: 0.6, depth: 0.2 }, this.scene);
        pack.parent = torso; pack.position.set(0, 0.5, -0.26); pack.material = trimMat;
      }

      parts = { torso, headJoint, armJointL, armJointR, legL, legR, bodyMat: woodMat };
    }

    (root as any).__parts = parts;
    (root as any).__walkPhase = 0;

    this.meshes.set(id, root);
    this.prevPos.set(id, new BABYLON.Vector3(0, 0, 0));
    this.prevAt.set(id, performance.now());
    this.targetPos.set(id, new BABYLON.Vector3(0, 0, 0));

    return root;
  }

  public removeRemoteMesh(id: string) {
    const root = this.meshes.get(id);
    if (root) {
      // Disposing the root node disposes child meshes, but not their materials
      try { root.dispose(false, true); } catch {}
      this.meshes.delete(id);
    }
    
    // Safely dispose of all materials created uniquely for this entity
    const matList = this.mats.get(id);
    if (matList) {
      for (const m of matList) {
        try { m.dispose(); } catch {}
      }
      this.mats.delete(id);
    }
    
    this.prevPos.delete(id);
    this.prevAt.delete(id);
    this.targetPos.delete(id);
  }

  public update(dtSec: number, netTransforms: Map<string, NetTransform>, mySessionId: string | undefined, matManager: BlockMaterialManager | null, remoteFlashes: Map<string, number>, remoteSwings: Map<string, number>) {
    if (!this.enabled || !this.ready || !this.scene) return;

    for (const id of Array.from(this.meshes.keys())) {
      if (!netTransforms.has(id)) this.removeRemoteMesh(id);
    }

    const now = performance.now();

    for (const [id, t] of netTransforms.entries()) {
      if (id === mySessionId) continue;

      const root = this.ensureRemoteMesh(id, matManager);
      if (!root) continue;

      const isGiant = (root as any).__isGiant;
      const isMob = (root as any).__isMob;
      const targetYOffset = isGiant ? -0.5 : this.Y_VISUAL_OFFSET;

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

      const prev = this.prevPos.get(id) ?? new BABYLON.Vector3(root.position.x, root.position.y, root.position.z);
      const prevAt = this.prevAt.get(id) ?? now;
      const dtMove = Math.max(0.001, (now - prevAt) / 1000);

      const dx = root.position.x - prev.x;
      const dz = root.position.z - prev.z;
      const speed = Math.sqrt(dx * dx + dz * dz) / dtMove;

      prev.copyFrom(root.position);
      this.prevPos.set(id, prev);
      this.prevAt.set(id, now);

      const parts = (root as any).__parts;
      
      const hp = t.hp ?? 100;
      const maxHp = t.maxHp ?? 100;
      this.updateMobNameplate(root, id, hp, maxHp);

      // Hit Flashing Logic
      const flashTime = remoteFlashes.get(id);
      const isHit = flashTime && now - flashTime < 200;

      if (parts.bodyMat) {
        if (isHit) {
          parts.bodyMat.emissiveColor.set(1, 0.2, 0.2);
        } else {
          // Restore the subtle lift we assigned in getMat
          parts.bodyMat.emissiveColor.set(0.2, 0.2, 0.2);
        }
      }

      if (isGiant) {
        // =====================================
        // GIANT ANIMATION (Idle Floating)
        // =====================================
        const floatY = Math.sin(now * 0.001) * 0.15;
        
        parts.torso.position.y = 1.0 + floatY;
        parts.headJoint.position.y = 1.9 + floatY * 0.5; 
        
        // Spinning Magic parts
        parts.halo.rotation.y += dtSec * 1.5;
        parts.crystal.rotation.y += dtSec * 2.0;
        parts.crystal.rotation.x += dtSec * 1.0;

        if (parts.magicMat) {
            if (isHit) parts.magicMat.emissiveColor.set(1, 1, 1);
            else parts.magicMat.emissiveColor.set(0, 1, 1);
        }

      } else {
        // =====================================
        // STANDARD MOB & PLAYER ANIMATION (Kinematic walking)
        // =====================================
        const healthPct = hp / Math.max(1, maxHp);
        const isRaging = isMob && healthPct < 0.5;

        // Size scaling for enraged mobs
        const targetScale = isRaging ? 1.25 : 1.0;
        root.scaling.x += (targetScale - root.scaling.x) * 0.1;
        root.scaling.y += (targetScale - root.scaling.y) * 0.1;
        root.scaling.z += (targetScale - root.scaling.z) * 0.1;

        if (parts.eyeMat) {
          if (isRaging) parts.eyeMat.emissiveColor.set(1, 0.4, 0); 
          else parts.eyeMat.emissiveColor.set(1, 0.05, 0.05); 
        }

        if (parts.orbiters && parts.orbiters.length > 0) {
          const orbitSpeed = isRaging ? 6.0 : 2.0;
          const orbitRadius = isRaging ? 1.4 : 1.0;
          const heightBob = Math.sin(now * 0.003) * 0.2;
          
          parts.orbiters.forEach((orb: BABYLON.Mesh, i: number) => {
              const angle = ((now * 0.001) * orbitSpeed) + (i * ((Math.PI * 2) / parts.orbiters.length));
              orb.position.set(
                  Math.cos(angle) * orbitRadius,
                  0.8 + heightBob + (i * 0.15),
                  Math.sin(angle) * orbitRadius
              );
              orb.rotation.x += dtSec * 2;
              orb.rotation.y += dtSec * 3;
          });
        }

        // Locomotion Kinematics
        const moving = speed > 0.15;
        const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * (isRaging ? 0.25 : 0.18);
        let phase = (root as any).__walkPhase as number;
        if (!Number.isFinite(phase)) phase = 0;
        phase += moving ? phaseSpeed : 0.02; // Slow breathe when still
        (root as any).__walkPhase = phase;

        const baseHipY = isMob ? 0.5 : 0.9;
        const breath = Math.sin(now * 0.002) * 0.02;
        const bounce = moving ? Math.abs(Math.sin(phase * 2)) * 0.06 : 0;
        const swing = Math.sin(phase) * (moving ? 0.6 : 0.05);

        let armPitch = 0;
        let bodyPitch = moving ? 0.1 : 0;
        let bodyYaw = moving ? Math.sin(phase) * 0.2 : 0; // Torso twists slightly with walk

        // Swing Animation Override
        const swingTime = remoteSwings.get(id);
        if (swingTime && now - swingTime < 450) {
          const elapsed = now - swingTime;
          if (elapsed < 150) { // Windup
            const t = elapsed / 150;
            const ease = t * t * (3 - 2 * t);
            armPitch = -0.6 * ease;
            bodyPitch += -0.15 * ease;
            bodyYaw += 0.3 * ease; 
          } else { // Strike
            const t = (elapsed - 150) / 300;
            const strikeT = Math.sin(Math.pow(t, 0.5) * Math.PI);
            
            armPitch = strikeT * 2.2 - 0.6 * (1 - t);
            bodyPitch += strikeT * 0.4;
            bodyYaw += -0.4 * strikeT + 0.3 * (1 - t); 
          }
        }

        // Apply Hierarchical Transformations
        parts.torso.position.y = baseHipY + breath + bounce;
        parts.torso.rotation.x = bodyPitch;
        parts.torso.rotation.y = bodyYaw;
        
        // Head lag/counter-yaw: The torso turns, but the head keeps looking forward
        parts.headJoint.rotation.x = bodyPitch * 0.3; // Look up slightly when leaning down
        parts.headJoint.rotation.y = -bodyYaw * 0.8; 

        parts.legL.rotation.x = swing;
        parts.legR.rotation.x = -swing;
        
        parts.armJointL.rotation.x = -swing * 0.5; 
        parts.armJointR.rotation.x = swing * 0.5 - armPitch; // Right arm handles attacks
      }
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