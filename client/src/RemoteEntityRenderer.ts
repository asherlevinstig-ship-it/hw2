// client/src/RemoteEntityRenderer.ts
// FULL FILE - No Omits

import * as BABYLON from "@babylonjs/core/Legacy/legacy";
import { Items } from "./shared/items";
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
  private mats = new Map<string, BABYLON.StandardMaterial>();

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
      this.glowLayer.intensity = 0.4;
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
      for (const mat of this.mats.values()) {
        mat.disableDepthWrite = true;
        mat.depthFunction = BABYLON.Constants.ALWAYS;
      }
    } else {
      this.scene.autoClearDepthAndStencil = false;
      for (const mat of this.mats.values()) {
        mat.disableDepthWrite = false;
        mat.depthFunction = BABYLON.Constants.LESS;
      }
    }
  }

  private makeRemoteMaterial(id: string): BABYLON.StandardMaterial {
    const mat = new BABYLON.StandardMaterial(`rpMat:${id}`, this.scene!);
    mat.disableLighting = true;
    mat.emissiveColor = new BABYLON.Color3(1, 0.15, 0.15);
    mat.diffuseColor = mat.emissiveColor.clone();
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.backFaceCulling = false;
    (mat as any).fogEnabled = false;
    return mat;
  }

  private updateMobNameplate(root: BABYLON.TransformNode, id: string, hp: number, maxHp: number) {
      if (!this.scene) return;

      let plate = (root as any).__nameplate as BABYLON.Mesh;
      let tex = (root as any).__nameplateTex as BABYLON.DynamicTexture;

      const isGiant = id.includes("npc_giant");
      const nameplateWidth = isGiant ? 6.0 : 1.5;
      const nameplateHeight = isGiant ? 1.6 : 0.4;
      const nameplateYOffset = isGiant ? 6.5 : 2.2;

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
      }

      const lastHp = (root as any).__lastHp;
      if (lastHp !== hp) {
          (root as any).__lastHp = hp;
          
          const ctx = tex.getContext() as unknown as CanvasRenderingContext2D;
          ctx.clearRect(0, 0, 512, 128);

          ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
          ctx.fillRect(20, 70, 472, 24);

          const pct = Math.max(0, hp / maxHp);
          ctx.fillStyle = pct > 0.5 ? "#00ff00" : (pct > 0.25 ? "#ffff00" : "#ff0000");
          ctx.fillRect(20, 70, 472 * pct, 24);

          ctx.font = "bold 48px monospace";
          ctx.fillStyle = isGiant ? "#FFD700" : "white"; 
          ctx.textAlign = "center";
          ctx.shadowColor = "black";
          ctx.shadowBlur = 4;
          
          let name = "Player";
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
    const root = new BABYLON.TransformNode(`remoteRoot:${id}`, this.scene);
    
    (root as any).__isMob = isMob;
    (root as any).__isGiant = isGiant;

    let parts: any = {};

    if (isMob) {
      const mobMat = new BABYLON.StandardMaterial(`rpMat:${id}`, this.scene);
      mobMat.disableLighting = true;
      mobMat.backFaceCulling = false;
      (mobMat as any).fogEnabled = false;

      const targetBlock = isGiant ? Items.RAW_GOLD : Items.DEEPSLATE;
      const baseMatInfo = matManager?.getMaterialForBlock(targetBlock);
      const baseMat = (Array.isArray(baseMatInfo) ? baseMatInfo[0] : baseMatInfo) as BABYLON.StandardMaterial | undefined;

      if (baseMat && baseMat.diffuseTexture) {
        mobMat.diffuseTexture = baseMat.diffuseTexture;
        mobMat.emissiveTexture = baseMat.diffuseTexture;
      } else {
        mobMat.emissiveColor = isGiant ? new BABYLON.Color3(1, 0.8, 0) : new BABYLON.Color3(0.5, 0.5, 0.5); 
      }

      this.mats.set(id, mobMat);
      
      const body = BABYLON.MeshBuilder.CreateBox(`mobBody:${id}`, { width: 0.9, height: 0.9, depth: 0.6 }, this.scene);
      body.position.set(0, 0.9, 0); 
      
      const head = BABYLON.MeshBuilder.CreateBox(`mobHead:${id}`, { width: 0.5, height: 0.5, depth: 0.5 }, this.scene);
      head.position.set(0, 1.5, 0.15); 

      const armL = BABYLON.MeshBuilder.CreateBox(`mobArmL:${id}`, { width: 0.35, height: 1.1, depth: 0.35 }, this.scene);
      armL.position.set(-0.65, 1.0, 0);

      const armR = BABYLON.MeshBuilder.CreateBox(`mobArmR:${id}`, { width: 0.35, height: 1.1, depth: 0.35 }, this.scene);
      armR.position.set(0.65, 1.0, 0);

      const legL = BABYLON.MeshBuilder.CreateBox(`mobLegL:${id}`, { width: 0.3, height: 0.5, depth: 0.3 }, this.scene);
      legL.position.set(-0.25, 0.25, 0);

      const legR = BABYLON.MeshBuilder.CreateBox(`mobLegR:${id}`, { width: 0.3, height: 0.5, depth: 0.3 }, this.scene);
      legR.position.set(0.25, 0.25, 0);

      [body, head, armL, armR, legL, legR].forEach(m => {
          m.parent = root;
          m.material = mobMat;
          m.isPickable = false;
          (m as any).isInFrustum = () => true;
      });

      const eyeMat = new BABYLON.StandardMaterial(`mobEyeMat:${id}`, this.scene);
      eyeMat.disableLighting = true;
      eyeMat.emissiveColor = isGiant ? new BABYLON.Color3(0, 1, 1) : new BABYLON.Color3(1, 0.1, 0.1); 
      (eyeMat as any).fogEnabled = false;

      const eyeL = BABYLON.MeshBuilder.CreateBox(`mobEyeL:${id}`, { size: 0.1 }, this.scene);
      eyeL.parent = head;
      eyeL.position.set(-0.12, 0.05, 0.26);
      eyeL.material = eyeMat;

      const eyeR = BABYLON.MeshBuilder.CreateBox(`mobEyeR:${id}`, { size: 0.1 }, this.scene);
      eyeR.parent = head;
      eyeR.position.set(0.12, 0.05, 0.26);
      eyeR.material = eyeMat;

      const orbiters: BABYLON.Mesh[] = [];
      if (!isGiant) {
          for(let i=0; i<3; i++) {
              const orb = BABYLON.MeshBuilder.CreateBox(`mobOrb${i}:${id}`, {size: 0.15}, this.scene);
              orb.material = eyeMat; 
              orb.parent = root;
              orb.isPickable = false;
              (orb as any).isInFrustum = () => true;
              orbiters.push(orb);
          }
      }

      if (isGiant) {
          root.scaling.set(4, 4, 4); 
      }

      parts = { body, head, armL, armR, legL, legR, eyeMat, orbiters, mobMat };

    } else {
      const BODY_W = 0.65;
      const BODY_H = 0.95;
      const BODY_D = 0.32;
      const HEAD = 0.55;
      const ARM_W = 0.2;
      const ARM_H = 0.85;
      const ARM_D = 0.2;
      const LEG_W = 0.22;
      const LEG_H = 0.9;
      const LEG_D = 0.22;

      const legTopY = LEG_H;
      const bodyBottomY = legTopY;
      const bodyCenterY = bodyBottomY + BODY_H * 0.5;
      const headCenterY = bodyBottomY + BODY_H + HEAD * 0.5;

      const mat = this.makeRemoteMaterial(id);
      this.mats.set(id, mat);

      const body = BABYLON.MeshBuilder.CreateBox(`remoteBody:${id}`, { width: BODY_W, height: BODY_H, depth: BODY_D }, this.scene);
      body.parent = root;
      body.position.set(0, bodyCenterY, 0);
      body.material = mat;
      body.isPickable = false;

      const head = BABYLON.MeshBuilder.CreateBox(`remoteHead:${id}`, { width: HEAD, height: HEAD, depth: HEAD }, this.scene);
      head.parent = root;
      head.position.set(0, headCenterY, 0);
      head.material = mat;
      head.isPickable = false;

      const armL = BABYLON.MeshBuilder.CreateBox(`remoteArmL:${id}`, { width: ARM_W, height: ARM_H, depth: ARM_D }, this.scene);
      armL.parent = root;
      armL.position.set(-(BODY_W * 0.5 + ARM_W * 0.5) + 0.02, bodyBottomY + BODY_H * 0.65, 0);
      armL.material = mat;
      armL.isPickable = false;

      const armR = BABYLON.MeshBuilder.CreateBox(`remoteArmR:${id}`, { width: ARM_W, height: ARM_H, depth: ARM_D }, this.scene);
      armR.parent = root;
      armR.position.set(BODY_W * 0.5 + ARM_W * 0.5 - 0.02, bodyBottomY + BODY_H * 0.65, 0);
      armR.material = mat;
      armR.isPickable = false;

      const legL = BABYLON.MeshBuilder.CreateBox(`remoteLegL:${id}`, { width: LEG_W, height: LEG_H, depth: LEG_D }, this.scene);
      legL.parent = root;
      legL.position.set(-0.16, LEG_H * 0.5, 0);
      legL.material = mat;
      legL.isPickable = false;

      const legR = BABYLON.MeshBuilder.CreateBox(`remoteLegR:${id}`, { width: LEG_W, height: LEG_H, depth: LEG_D }, this.scene);
      legR.parent = root;
      legR.position.set(0.16, LEG_H * 0.5, 0);
      legR.material = mat;
      legR.isPickable = false;

      [body, head, armL, armR, legL, legR].forEach(m => {
          (m as any).isInFrustum = () => true;
      });

      parts = { body, head, armL, armR, legL, legR, bodyCenterY, headCenterY };
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
      try { root.dispose(); } catch {}
      this.meshes.delete(id);
    }
    const mat = this.mats.get(id);
    if (mat) {
      try { mat.dispose(); } catch {}
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

      const target = this.targetPos.get(id) ?? new BABYLON.Vector3();
      target.set(t.x + this.renderOffset.x, t.y + this.renderOffset.y + this.Y_VISUAL_OFFSET, t.z + this.renderOffset.z);
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

      const isMob = (root as any).__isMob;
      const parts = (root as any).__parts;
      const mat = this.mats.get(id);

      const hp = t.hp ?? 100;
      const maxHp = t.maxHp ?? 100;
      this.updateMobNameplate(root, id, hp, maxHp);

      if (isMob) {
        const healthPct = hp / Math.max(1, maxHp);
        const isRaging = healthPct < 0.5;

        const targetScale = isRaging ? 1.25 : 1.0;
        root.scaling.x += (targetScale - root.scaling.x) * 0.1;
        root.scaling.y += (targetScale - root.scaling.y) * 0.1;
        root.scaling.z += (targetScale - root.scaling.z) * 0.1;

        const flashTime = remoteFlashes.get(id);
        const isHit = flashTime && now - flashTime < 200;

        if (mat) {
          if (isHit) {
            mat.emissiveColor.set(1, 0.2, 0.2);
            mat.diffuseColor.set(1, 0.2, 0.2);
          } else {
            mat.emissiveColor.set(1, 1, 1);
            mat.diffuseColor.set(1, 1, 1);
          }
        }

        if (parts.eyeMat) {
          if (isRaging) {
            parts.eyeMat.emissiveColor.set(1, 0.4, 0); 
          } else {
            parts.eyeMat.emissiveColor.set(1, 0.05, 0.05); 
          }
        }

        if (parts.orbiters) {
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

        const moving = speed > 0.15;
        const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * (isRaging ? 0.25 : 0.15);
        let phase = (root as any).__walkPhase as number;
        if (!Number.isFinite(phase)) phase = 0;
        phase += moving ? phaseSpeed : 0.02;
        (root as any).__walkPhase = phase;

        const breath = Math.sin(now * 0.002) * 0.03;
        const bounce = moving ? Math.abs(Math.sin(phase)) * 0.15 : 0;
        const swing = Math.sin(phase) * (moving ? 0.6 : 0.05);
        
        let armPitch = 0;
        let bodyPitch = 0;
        const swingTime = remoteSwings.get(id);
        
        if (swingTime && now - swingTime < 600) {
          const elapsed = now - swingTime;
          if (elapsed < 200) {
            const t = elapsed / 200;
            armPitch = -0.8 * t;
            bodyPitch = -0.2 * t;
          } else {
            const t = (elapsed - 200) / 400;
            armPitch = Math.sin(t * Math.PI) * 2.5 - 0.8 * (1 - t);
            bodyPitch = Math.sin(t * Math.PI) * 0.4;
          }
        }

        if (parts.body && parts.head && parts.legL && parts.legR && parts.armL && parts.armR) {
            parts.body.position.y = 0.9 + breath + bounce;
            parts.head.position.y = 1.5 + breath + bounce;
            
            parts.body.rotation.x = bodyPitch;
            parts.head.rotation.x = bodyPitch * 0.5;

            parts.legL.rotation.x = swing;
            parts.legR.rotation.x = -swing;
            parts.armL.rotation.x = -swing * 0.5;
            parts.armR.rotation.x = swing * 0.5 - armPitch;
        }
      } else {
        if (parts?.legL && parts?.legR && parts?.armL && parts?.armR && parts?.body && parts?.head) {
          const moving = speed > 0.15;
          const phaseSpeed = BABYLON.Scalar.Clamp(speed, 0, 6) * 0.18;

          let phase = (root as any).__walkPhase as number;
          if (!Number.isFinite(phase)) phase = 0;

          phase += moving ? phaseSpeed : 0.02;
          (root as any).__walkPhase = phase;

          const breath = Math.sin(now * 0.002) * 0.02;
          const bounce = moving ? Math.abs(Math.sin(phase * 2)) * 0.05 : 0;
          const swing = Math.sin(phase) * (moving ? 0.55 : 0.08);

          if (mat) {
            const flashTime = remoteFlashes.get(id);
            if (flashTime && now - flashTime < 200) {
              mat.emissiveColor.set(1, 0.3, 0.3); 
            } else {
              mat.emissiveColor.set(1, 0.15, 0.15); 
            }
          }

          let armPitch = 0;
          let bodyPitch = moving ? 0.1 : 0;
          let bodyYaw = 0;
          let headYaw = 0;

          const swingTime = remoteSwings.get(id);
          if (swingTime && now - swingTime < 450) {
            const elapsed = now - swingTime;
            if (elapsed < 150) {
              const t = elapsed / 150;
              const ease = t * t * (3 - 2 * t);
              armPitch = -0.6 * ease;
              bodyPitch += -0.15 * ease;
              bodyYaw = 0.3 * ease; 
              headYaw = -0.3 * ease; 
            } else {
              const t = (elapsed - 150) / 300;
              const strikeT = Math.sin(Math.pow(t, 0.5) * Math.PI);
              
              armPitch = strikeT * 2.2 - 0.6 * (1 - t);
              bodyPitch += strikeT * 0.4;
              bodyYaw = -0.4 * strikeT + 0.3 * (1 - t); 
              headYaw = 0.4 * strikeT - 0.3 * (1 - t);
            }
          }

          parts.body.position.y = parts.bodyCenterY + breath + bounce;
          parts.head.position.y = parts.headCenterY + breath + bounce;

          parts.body.rotation.x = bodyPitch;
          parts.body.rotation.y = bodyYaw;
          parts.head.rotation.x = bodyPitch * 0.5;
          parts.head.rotation.y = headYaw;

          parts.legL.rotation.x = swing * 0.55;
          parts.legR.rotation.x = -swing * 0.55;
          parts.armL.rotation.x = -swing * 0.35 + bodyYaw * 0.5; 
          parts.armR.rotation.x = swing * 0.35 - armPitch; 
        }
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