// server/src/inventory/InventoryManager.ts
// FULL FILE - No Omits

import { Client } from "colyseus";
import * as fs from "node:fs";
import * as path from "node:path";
import { Items, ITEM_DEFS, type ItemStack as SharedItemStack } from "../shared/items.js";

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function toInt(n: number): number {
  return n < 0 ? Math.ceil(n - 0.0000001) : Math.floor(n);
}

export type ItemStack = SharedItemStack;

export type PlayerStats = {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  auraArchetype: string;
};

export type InvState = {
  slots: ItemStack[];
  cursor: ItemStack;
  stats: PlayerStats;
};

export class InventoryManager {
  public readonly HOTBAR_SLOTS = 5;
  public readonly BACKPACK_SLOTS = 20;
  public readonly INV_SLOTS = this.HOTBAR_SLOTS + this.BACKPACK_SLOTS;

  public readonly HP_PER_HEART = 2;
  public readonly DEFAULT_HEARTS = 10;
  public readonly DEFAULT_MANA_CONTAINERS = 5;
  public readonly MANA_PER_CONTAINER = 10;

  private inventories = new Map<string, InvState>();
  private invDir: string;

  constructor(invDir: string) {
    this.invDir = invDir;
    if (!fs.existsSync(this.invDir)) {
      fs.mkdirSync(this.invDir, { recursive: true });
    }
  }

  public getInventory(userId: string): InvState | undefined {
    return this.inventories.get(userId);
  }

  public clear(): void {
    this.inventories.clear();
  }

  private invFilePath(userId: string): string { 
    return path.join(this.invDir, `inv_${userId}.json`); 
  }

  private readInvFromDisk(userId: string): InvState | null {
    const fp = this.invFilePath(userId);
    try {
      if (!fs.existsSync(fp)) return null;
      const raw = fs.readFileSync(fp, "utf8");
      const j = JSON.parse(raw);

      const slotsIn = Array.isArray(j?.slots) ? j.slots : null;
      const cursorIn = typeof j?.cursor === "object" && j?.cursor ? j.cursor : null;
      const statsIn = typeof j?.stats === "object" && j?.stats ? j.stats : null;

      const slots: ItemStack[] = Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })) as any;
      if (slotsIn) {
        for (let i = 0; i < Math.min(this.INV_SLOTS, slotsIn.length); i++) {
          const s = slotsIn[i];
          const id = toInt(clamp(Number(s?.id ?? 0), 0, 999999));
          const count = toInt(clamp(Number(s?.count ?? 0), 0, 999999));
          const durRaw = Number(s?.dur ?? 0);
          const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
          slots[i] = id > 0 && count > 0 ? dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any) : ({ id: 0, count: 0 } as any);
        }
      }

      const cId = toInt(clamp(Number((cursorIn as any)?.id ?? 0), 0, 999999));
      const cCount = toInt(clamp(Number((cursorIn as any)?.count ?? 0), 0, 999999));
      const cDurRaw = Number((cursorIn as any)?.dur ?? 0);
      const cDur = Number.isFinite(cDurRaw) ? toInt(clamp(cDurRaw, 0, 999999)) : 0;
      const cursor: ItemStack = cId > 0 && cCount > 0 ? cDur > 0 ? ({ id: cId, count: cCount, dur: cDur } as any) : ({ id: cId, count: cCount } as any) : ({ id: 0, count: 0 } as any);

      const defaultMaxHp = this.DEFAULT_HEARTS * this.HP_PER_HEART;
      const defaultMaxMana = this.DEFAULT_MANA_CONTAINERS * this.MANA_PER_CONTAINER;
      
      const maxHp = toInt(clamp(Number((statsIn as any)?.maxHp ?? defaultMaxHp), 2, 9999));
      const hp = toInt(clamp(Number((statsIn as any)?.hp ?? maxHp), 0, maxHp));
      const maxMana = toInt(clamp(Number((statsIn as any)?.maxMana ?? defaultMaxMana), 0, 999999));
      const mana = toInt(clamp(Number((statsIn as any)?.mana ?? maxMana), 0, maxMana));

      const auraArchetype = String((statsIn as any)?.auraArchetype ?? "BASIC");

      return { slots, cursor, stats: { hp, maxHp, mana, maxMana, auraArchetype } };
    } catch (e) {
      return null;
    }
  }

  private writeInvToDisk(userId: string, inv: InvState): void {
    const fp = this.invFilePath(userId);
    const tmp = fp + ".tmp";
    const safe = {
      slots: inv.slots.map((s) => ({ id: toInt((s as any).id || 0), count: toInt((s as any).count || 0), dur: toInt((s as any).dur || 0) })),
      cursor: { id: toInt((inv.cursor as any).id || 0), count: toInt((inv.cursor as any).count || 0), dur: toInt((inv.cursor as any).dur || 0) },
      stats: { 
        hp: toInt(inv.stats.hp), 
        maxHp: toInt(inv.stats.maxHp), 
        mana: toInt(inv.stats.mana), 
        maxMana: toInt(inv.stats.maxMana),
        auraArchetype: String(inv.stats.auraArchetype),
      }
    };
    fs.writeFileSync(tmp, JSON.stringify(safe));
    fs.renameSync(tmp, fp);
  }

  public getOrLoadInventory(userId: string): InvState {
    const cached = this.inventories.get(userId);
    if (cached) return cached;

    const fromDisk = this.readInvFromDisk(userId);
    if (fromDisk) {
      this.inventories.set(userId, fromDisk);
      return fromDisk;
    }

    const defaultMaxHp = this.DEFAULT_HEARTS * this.HP_PER_HEART;
    const defaultMaxMana = this.DEFAULT_MANA_CONTAINERS * this.MANA_PER_CONTAINER;
    const inv: InvState = {
      slots: Array.from({ length: this.INV_SLOTS }, () => ({ id: 0, count: 0 })) as any,
      cursor: { id: 0, count: 0 } as any,
      stats: { 
        hp: defaultMaxHp, 
        maxHp: defaultMaxHp, 
        mana: defaultMaxMana, 
        maxMana: defaultMaxMana,
        auraArchetype: "BASIC"
      }
    };

    inv.slots[0] = { id: Items.WOOD_LOG, count: 4 } as any;
    inv.slots[1] = { id: Items.STONE_SHADOW, count: 1 } as any; 
    inv.slots[2] = { id: Items.STONE_IRON, count: 1 } as any; 

    this.inventories.set(userId, inv);
    this.saveInventory(userId, inv);
    return inv;
  }

  public saveInventory(userId: string, inv: InvState): void {
    this.inventories.set(userId, inv);
    try { this.writeInvToDisk(userId, inv); } catch (e) {}
  }

  public sendInvStateToClient(client: Client, inv: InvState): void {
    client.send("invState", { slots: inv.slots, cursor: inv.cursor, stats: inv.stats });
  }

  public normalizeStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999)); 
    const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999)); 
    const durRaw = Number((s as any)?.dur ?? 0); 
    const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
    
    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  public maxStackFor(itemId: number): number { 
    return clamp(toInt(ITEM_DEFS[itemId]?.maxStack ?? 64), 1, 999999); 
  }

  public inventoryCountSlots(inv: InvState, itemId: number): number {
    let n = 0;
    for (const s of inv.slots) if ((s as any).id === itemId && (s as any).count > 0) n += (s as any).count;
    return n;
  }

  public inventoryCanFit(inv: InvState, itemId: number, count: number): boolean {
    const maxS = this.maxStackFor(itemId); let remaining = clamp(toInt(count), 1, 999999);
    for (const s of inv.slots as any[]) if (s.id === itemId && s.count > 0 && maxS - s.count > 0) if ((remaining -= Math.min(maxS - s.count, remaining)) <= 0) return true;
    for (const s of inv.slots as any[]) if (s.id === 0 || s.count <= 0) if ((remaining -= Math.min(maxS, remaining)) <= 0) return true;
    return remaining <= 0;
  }

  public inventoryAdd(inv: InvState, stack: ItemStack): number {
    const s = this.normalizeStack(stack);
    if ((s as any).id <= 0 || (s as any).count <= 0) return 0;
    const id = (s as any).id | 0; const maxS = this.maxStackFor(id);
    let remaining = (s as any).count | 0; let accepted = 0;

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === id && slot.count > 0 && maxS - slot.count > 0) {
        const take = Math.min(maxS - slot.count, remaining);
        slot.count += take; remaining -= take; accepted += take;
        if (remaining <= 0) return accepted;
      }
    }

    for (let i = 0; i < inv.slots.length; i++) {
      const slot = inv.slots[i] as any;
      if (slot.id === 0 || slot.count <= 0) {
        const def = ITEM_DEFS[id];
        if (!!def?.tool) { inv.slots[i] = { id, count: 1, dur: def!.tool!.maxDurability } as any; remaining -= 1; accepted += 1; } 
        else { const take = Math.min(maxS, remaining); inv.slots[i] = { id, count: take } as any; remaining -= take; accepted += take; }
        if (remaining <= 0) return accepted;
      }
    }
    return accepted;
  }

  public inventoryRemoveSlots(inv: InvState, itemId: number, count: number): number {
    let remaining = clamp(toInt(count), 1, 999999); let removed = 0;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i] as any;
      if (s.id === itemId && s.count > 0) {
        const take = Math.min(s.count, remaining);
        s.count -= take; remaining -= take; removed += take;
        if (s.count <= 0) inv.slots[i] = { id: 0, count: 0 } as any;
        if (remaining <= 0) break;
      }
    }
    return removed;
  }

  public applyInvClick(inv: InvState, slotIndex: number, button: "L" | "R", shift: boolean): void {
    inv.cursor = this.normalizeStack(inv.cursor); inv.slots[slotIndex] = this.normalizeStack(inv.slots[slotIndex]);
    const cursor = inv.cursor as any; const slot = inv.slots[slotIndex] as any;
    const cursorIsTool = cursor.id > 0 && cursor.count > 0 && this.isToolItem(cursor.id);
    const slotIsTool = slot.id > 0 && slot.count > 0 && this.isToolItem(slot.id);

    if (shift && button === "L") {
      if (slot.id <= 0 || slot.count <= 0) return;
      const isHotbar = slotIndex < this.HOTBAR_SLOTS;
      if (this.moveStackBetweenRanges(inv, slotIndex, isHotbar ? this.HOTBAR_SLOTS : 0, isHotbar ? this.INV_SLOTS : this.HOTBAR_SLOTS)) return;
      return;
    }

    if (button === "L") {
      if (cursor.id <= 0 || cursor.count <= 0) { inv.cursor = this.cloneStack(slot) as any; inv.slots[slotIndex] = { id: 0, count: 0 } as any; return; }
      if (slot.id <= 0 || slot.count <= 0) { inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = { id: 0, count: 0 } as any; return; }
      if (slot.id === cursor.id) {
        const space = this.maxStackFor(slot.id) - slot.count;
        if (space > 0) {
          const take = Math.min(space, cursor.count);
          slot.count += take; cursor.count -= take;
          inv.slots[slotIndex] = slot as any; inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
        }
        return;
      }
      inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    if (cursor.id <= 0 || cursor.count <= 0) {
      if (slot.id <= 0 || slot.count <= 0) return;
      if (slotIsTool) { inv.cursor = this.cloneStack(slot) as any; inv.slots[slotIndex] = { id: 0, count: 0 } as any; return; }
      const take = Math.ceil(slot.count / 2); inv.cursor = { id: slot.id, count: take } as any; slot.count -= take;
      inv.slots[slotIndex] = slot.count > 0 ? (slot as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (cursorIsTool) {
      if (slot.id <= 0 || slot.count <= 0) { inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = { id: 0, count: 0 } as any; return; }
      inv.slots[slotIndex] = this.cloneStack(cursor) as any; inv.cursor = this.cloneStack(slot) as any;
      return;
    }

    if (slot.id <= 0 || slot.count <= 0) {
      inv.slots[slotIndex] = { id: cursor.id, count: 1 } as any; cursor.count -= 1;
      inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      return;
    }

    if (slot.id === cursor.id) {
      if (slot.count < this.maxStackFor(slot.id)) {
        slot.count += 1; cursor.count -= 1;
        inv.slots[slotIndex] = slot as any; inv.cursor = cursor.count > 0 ? (cursor as any) : ({ id: 0, count: 0 } as any);
      }
      return;
    }
  }

  public moveStackBetweenRanges(inv: InvState, fromIndex: number, toStart: number, toEnd: number): boolean {
    inv.slots[fromIndex] = this.normalizeStack(inv.slots[fromIndex]);
    const from = inv.slots[fromIndex] as any;
    if (from.id <= 0 || from.count <= 0) return false;

    const maxS = this.maxStackFor(from.id);
    if (this.isToolItem(from.id) || maxS === 1) {
      for (let i = toStart; i < toEnd; i++) {
        const s = this.normalizeStack(inv.slots[i]) as any;
        if (s.id <= 0 || s.count <= 0) { inv.slots[i] = this.cloneStack(from) as any; inv.slots[fromIndex] = { id: 0, count: 0 } as any; return true; }
      }
      return false;
    }

    let remaining = from.count;
    for (let i = toStart; i < toEnd; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id === from.id && s.count > 0 && maxS - s.count > 0) {
        const take = Math.min(maxS - s.count, remaining);
        s.count += take; remaining -= take; inv.slots[i] = s as any;
        if (remaining <= 0) break;
      }
    }

    for (let i = toStart; i < toEnd && remaining > 0; i++) {
      const s = this.normalizeStack(inv.slots[i]) as any;
      if (s.id <= 0 || s.count <= 0) {
        const take = Math.min(maxS, remaining);
        inv.slots[i] = { id: from.id, count: take } as any; remaining -= take;
      }
    }

    const moved = from.count - remaining;
    if (moved <= 0) return false;
    inv.slots[fromIndex] = remaining > 0 ? ({ id: from.id, count: remaining } as any) : ({ id: 0, count: 0 } as any);
    return true;
  }

  public cloneStack(s: ItemStack): ItemStack {
    const id = toInt(clamp(Number((s as any)?.id ?? 0), 0, 999999)); 
    const count = toInt(clamp(Number((s as any)?.count ?? 0), 0, 999999)); 
    const durRaw = Number((s as any)?.dur ?? 0); 
    const dur = Number.isFinite(durRaw) ? toInt(clamp(durRaw, 0, 999999)) : 0;
    
    if (id > 0 && count > 0) return dur > 0 ? ({ id, count, dur } as any) : ({ id, count } as any);
    return { id: 0, count: 0 } as any;
  }

  public getToolDef(itemId: number) { 
    return ITEM_DEFS[itemId]?.tool ?? null; 
  }

  public isToolItem(itemId: number): boolean { 
    return !!ITEM_DEFS[itemId]?.tool || this.maxStackFor(itemId) === 1; 
  }

  public choosePickStack(inv: InvState, heldSlot: number): { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<InventoryManager["getToolDef"]>> } | null {
    if (heldSlot >= 0 && heldSlot < this.HOTBAR_SLOTS) {
      const s = inv.slots[heldSlot];
      if (s && (s as any).id > 0 && (s as any).count > 0 && this.getToolDef((s as any).id)?.kind === "pick") return { slotIndex: heldSlot, stack: s, tool: this.getToolDef((s as any).id)! };
    }
    let best: { slotIndex: number; stack: ItemStack; tool: NonNullable<ReturnType<InventoryManager["getToolDef"]>> } | null = null;
    for (let i = 0; i < inv.slots.length; i++) {
      const s = inv.slots[i];
      if (!s || (s as any).id <= 0 || (s as any).count <= 0) continue;
      const tool = this.getToolDef((s as any).id);
      if (!tool || tool.kind !== "pick") continue;
      if (!best || tool.tier > best.tool.tier) best = { slotIndex: i, stack: s, tool };
    }
    return best;
  }

  public damageTool(inv: InvState, slotIndex: number): void {
    const s = inv.slots[slotIndex];
    if (!s || (s as any).id <= 0 || (s as any).count <= 0) return;
    const tool = this.getToolDef((s as any).id);
    if (!tool) return;
    const next = toInt(clamp(Number((s as any).dur ?? tool.maxDurability), 0, 999999)) - 1;
    if (next <= 0) inv.slots[slotIndex] = { id: 0, count: 0 } as any; else (s as any).dur = next;
  }
}