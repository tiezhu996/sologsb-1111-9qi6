import { create } from 'zustand';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { deleteStamped, putStamped } from '../sync/syncDb';
import type { CoreBox } from '../types/core-box';
import type { StampedEntity } from '../sync/types';

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

type BoxRow = StampedEntity<CoreBox>;

interface BoxState {
  boxes: BoxRow[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  addBox: (input: BoxInput) => Promise<BoxRow>;
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
    const id = uid('box');
    let box: BoxRow | undefined;
    await putStamped<CoreBox>('boxes', id, (stamp) => {
      box = {
        id,
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
        ...stamp,
      };
      return box;
    });
    const row = box as BoxRow;
    set({ boxes: [...get().boxes, row] });
    return row;
  },

  updateBox: async (id, patch) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    let next: BoxRow | undefined;
    await putStamped<CoreBox>('boxes', id, (stamp) => {
      next = { ...current, ...patch, id, ...stamp };
      return next;
    });
    const row = next as BoxRow;
    set({ boxes: get().boxes.map((b) => (b.id === id ? row : b)) });
  },

  removeBox: async (id) => {
    await deleteStamped('boxes', id);
    set({ boxes: get().boxes.filter((b) => b.id !== id) });
  },

  toggleDamagedSlot: async (id, slot) => {
    const current = get().boxes.find((b) => b.id === id);
    if (!current) return;
    const damagedSlots = current.damagedSlots.includes(slot)
      ? current.damagedSlots.filter((s) => s !== slot)
      : [...current.damagedSlots, slot].sort((a, b) => a - b);
    let next: BoxRow | undefined;
    await putStamped<CoreBox>('boxes', id, (stamp) => {
      next = { ...current, damagedSlots, id, ...stamp };
      return next;
    });
    const row = next as BoxRow;
    set({ boxes: get().boxes.map((b) => (b.id === id ? row : b)) });
  },
}));
