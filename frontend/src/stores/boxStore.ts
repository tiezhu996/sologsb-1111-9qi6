import { create } from 'zustand';
import { db, getDeviceIdentity } from '../utils/db';
import { uid } from '../utils/id';
import { stampCreate, stampUpdate } from '../utils/provenance';
import type { CoreBox } from '../types/core-box';

export interface BoxInput {
  boxNo: string;
  holeId: string;
  fromDepth: number;
  toDepth: number;
  slots: number;
  slotLength: number;
  boxedAt: string;
  shelfPos: string;
  damagedSlots: number[];
  operator: string;
  remark?: string;
}

interface BoxState {
  boxes: CoreBox[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<CoreBox>;
  updateBox: (id: string, patch: Partial<BoxInput>) => Promise<void>;
  removeBox: (id: string) => Promise<void>;
  /** 标记/取消破损格 */
  toggleDamagedSlot: (id: string, slot: number) => Promise<void>;
}

/** 岩芯箱与格位分配 */
export const useBoxStore = create<BoxState>()((set, get) => ({
  boxes: [],
  hydrated: false,

  hydrate: async () => {
    const boxes = await db.boxes.orderBy('boxNo').toArray();
    set({ boxes, hydrated: true });
  },

  addBox: async (input) => {
    const base: CoreBox = {
      id: uid('box'),
      boxNo: input.boxNo.trim(),
      holeId: input.holeId,
      fromDepth: Number(input.fromDepth) || 0,
      toDepth: Number(input.toDepth) || 0,
      slots: Number(input.slots) || 0,
      slotLength: Number(input.slotLength) || 0,
      boxedAt: input.boxedAt,
      shelfPos: input.shelfPos,
      damagedSlots: input.damagedSlots ?? [],
      operator: input.operator.trim(),
      remark: input.remark?.trim() || undefined,
    };
    const box = stampCreate(base, await getDeviceIdentity());
    await db.boxes.put(box);
    set({ boxes: [...get().boxes, box] });
    return box;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const merged: CoreBox = { ...current, ...patch };
    const next = stampUpdate(current, merged, await getDeviceIdentity());
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },

  removeBox: async (id) => {
    await db.boxes.delete(id);
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },

  toggleDamagedSlot: async (id, slot) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const damagedSlots = current.damagedSlots.includes(slot)
      ? current.damagedSlots.filter((s) => s !== slot)
      : [...current.damagedSlots, slot].sort((a, b) => a - b);
    const merged: CoreBox = { ...current, damagedSlots };
    const next = stampUpdate(current, merged, await getDeviceIdentity());
    await db.boxes.put(next);
    set({ boxes: get().boxes.map((b) => (b.id === id ? next : b)) });
  },
}));
