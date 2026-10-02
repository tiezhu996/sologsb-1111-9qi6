import { db } from './db';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';
import type { CoreBox } from '../types/core-box';
import type { LithoLog } from '../types/litho-log';
import { footageOf, recoveryOf } from './recovery';

const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

export const SEED_HOLES: DrillHole[] = [
  {
    id: 'hole-001',
    holeNo: 'ZK-2401',
    coordX: 512340.5,
    coordY: 3210880.2,
    collarElevation: 1246.5,
    designDepth: 300,
    finalDepth: 0,
    startDate: daysAgo(26),
    rigNo: 'XY-1',
    shift: '甲班',
    surveyData: [
      { id: 'sv-001-1', depth: 50, dip: 88.5, azimuth: 132 },
      { id: 'sv-001-2', depth: 100, dip: 87.2, azimuth: 133.5 },
      { id: 'sv-001-3', depth: 150, dip: 86.4, azimuth: 134 },
    ],
    remark: '设计见矿层位 120~160m',
  },
  {
    id: 'hole-002',
    holeNo: 'ZK-2402',
    coordX: 512420.1,
    coordY: 3210940.8,
    collarElevation: 1251.2,
    designDepth: 250,
    finalDepth: 250,
    startDate: daysAgo(48),
    endDate: daysAgo(12),
    rigNo: 'XY-2',
    shift: '甲班',
    surveyData: [
      { id: 'sv-002-1', depth: 80, dip: 89.1, azimuth: 128 },
      { id: 'sv-002-2', depth: 180, dip: 87.8, azimuth: 129.4 },
    ],
    remark: '已终孔并完成编录',
  },
  {
    id: 'hole-003',
    holeNo: 'ZK-2403',
    coordX: 512505.9,
    coordY: 3210810.4,
    collarElevation: 1238.8,
    designDepth: 400,
    finalDepth: 320,
    startDate: daysAgo(60),
    endDate: daysAgo(5),
    rigNo: 'XY-4',
    shift: '乙班',
    surveyData: [
      { id: 'sv-003-1', depth: 100, dip: 86.9, azimuth: 141 },
      { id: 'sv-003-2', depth: 200, dip: 85.1, azimuth: 142.6 },
      { id: 'sv-003-3', depth: 300, dip: 83.4, azimuth: 143.8 },
    ],
    remark: '孔内坍塌提前终孔，未达设计孔深',
  },
  {
    id: 'hole-004',
    holeNo: 'ZK-2404',
    coordX: 512288.3,
    coordY: 3211020.6,
    collarElevation: 1260.4,
    designDepth: 180,
    finalDepth: 180,
    startDate: daysAgo(34),
    endDate: daysAgo(18),
    rigNo: 'HGY-300',
    shift: '丙班',
    surveyData: [{ id: 'sv-004-1', depth: 90, dip: 89.4, azimuth: 120 }],
  },
  {
    id: 'hole-005',
    holeNo: 'ZK-2405',
    coordX: 512610.7,
    coordY: 3210765.1,
    collarElevation: 1233.6,
    designDepth: 220,
    finalDepth: 0,
    startDate: daysAgo(9),
    rigNo: 'XY-1',
    shift: '乙班',
    surveyData: [{ id: 'sv-005-1', depth: 40, dip: 88.2, azimuth: 137 }],
    remark: '在钻，已完成首段编录',
  },
];

/** 按孔生成回次：5m 一回次，采取率在 62%~98% 之间波动（含低采取率异常回次） */
function buildRuns(): DrillRun[] {
  const plan: Array<{ holeId: string; runNoPrefix: string; reached: number; base: number; anomalyRuns: number[] }> = [
    { holeId: 'hole-001', runNoPrefix: '2401', reached: 155, base: 91, anomalyRuns: [17] },
    { holeId: 'hole-002', runNoPrefix: '2402', reached: 250, base: 93, anomalyRuns: [12, 33] },
    { holeId: 'hole-003', runNoPrefix: '2403', reached: 320, base: 88, anomalyRuns: [8, 22, 41] },
    { holeId: 'hole-004', runNoPrefix: '2404', reached: 180, base: 95, anomalyRuns: [] },
    { holeId: 'hole-005', runNoPrefix: '2405', reached: 45, base: 90, anomalyRuns: [6] },
  ];

  const runs: DrillRun[] = [];
  plan.forEach((item) => {
    const total = Math.floor(item.reached / 5);
    for (let i = 0; i < total; i += 1) {
      const fromDepth = Number((i * 5).toFixed(2));
      const toDepth = Number(Math.min((i + 1) * 5, item.reached).toFixed(2));
      const footage = footageOf(fromDepth, toDepth);
      const recovering = item.anomalyRuns.includes(i + 1) ? 58 + ((i * 7) % 14) : item.base + ((i * 5) % 8) - 3;
      const recovery = Math.min(99, Math.max(45, recovering));
      const coreLength = Number(((footage * recovery) / 100).toFixed(2));
      runs.push({
        id: `run-${item.runNoPrefix}-${String(i + 1).padStart(3, '0')}`,
        runNo: `${item.runNoPrefix}-${String(i + 1).padStart(2, '0')}`,
        holeId: item.holeId,
        fromDepth,
        toDepth,
        footage,
        coreLength,
        recovery: recoveryOf(coreLength, footage),
        waterLevel: Number((12 + ((i * 3) % 25)).toFixed(1)),
        shift: (['甲班', '乙班', '丙班'] as const)[i % 3],
        drilledAt: daysAgo(30 - Math.min(28, i)),
        recorder: i % 2 === 0 ? '高振华' : '周明',
        remark: recovery < 75 ? '岩芯破碎，采取率偏低' : undefined,
      });
    }
  });
  return runs;
}

export const SEED_RUNS: DrillRun[] = buildRuns();

export const SEED_BOXES: CoreBox[] = [
  { id: 'box-001', boxNo: 'X-2402-01', holeId: 'hole-002', fromDepth: 0, toDepth: 25, slots: 10, slotLength: 2.5, boxedAt: daysAgo(40), shelfPos: 'A 区 1 架', damagedSlots: [], operator: '高振华' },
  { id: 'box-002', boxNo: 'X-2402-02', holeId: 'hole-002', fromDepth: 25, toDepth: 50, slots: 10, slotLength: 2.5, boxedAt: daysAgo(39), shelfPos: 'A 区 1 架', damagedSlots: [4], operator: '高振华', remark: '第 4 格岩芯破碎' },
  { id: 'box-003', boxNo: 'X-2402-03', holeId: 'hole-002', fromDepth: 50, toDepth: 75, slots: 10, slotLength: 2.5, boxedAt: daysAgo(38), shelfPos: 'A 区 2 架', damagedSlots: [], operator: '周明' },
  { id: 'box-004', boxNo: 'X-2403-01', holeId: 'hole-003', fromDepth: 0, toDepth: 30, slots: 12, slotLength: 2.5, boxedAt: daysAgo(52), shelfPos: 'B 区 1 架', damagedSlots: [], operator: '周明' },
  { id: 'box-005', boxNo: 'X-2403-02', holeId: 'hole-003', fromDepth: 30, toDepth: 60, slots: 12, slotLength: 2.5, boxedAt: daysAgo(51), shelfPos: 'B 区 1 架', damagedSlots: [7, 8], operator: '周明', remark: '断层破碎带，两格岩芯缺失' },
  { id: 'box-006', boxNo: 'X-2404-01', holeId: 'hole-004', fromDepth: 0, toDepth: 28, slots: 12, slotLength: 2.5, boxedAt: daysAgo(30), shelfPos: 'B 区 2 架', damagedSlots: [], operator: '赵晓峰' },
  { id: 'box-007', boxNo: 'X-2401-01', holeId: 'hole-001', fromDepth: 0, toDepth: 26, slots: 11, slotLength: 2.5, boxedAt: daysAgo(22), shelfPos: 'C 区 1 架', damagedSlots: [], operator: '高振华' },
];

export const SEED_LITHOS: LithoLog[] = [
  { id: 'litho-001', holeId: 'hole-002', fromDepth: 0, toDepth: 8, lithology: '第四系覆盖层', color: '黄褐色', alteration: '无', mineralization: '无', rqd: 0, sampleNo: '', logger: '陈立', remark: '残坡积层' },
  { id: 'litho-002', holeId: 'hole-002', fromDepth: 8, toDepth: 62, lithology: '花岗闪长岩', color: '灰白色', alteration: '绿泥石化', mineralization: '无', rqd: 82, sampleNo: 'YP-2402-01', logger: '陈立' },
  { id: 'litho-003', holeId: 'hole-002', fromDepth: 62, toDepth: 96, lithology: '矽卡岩', color: '暗绿色', alteration: '矽卡岩化', mineralization: '磁铁矿', rqd: 68, sampleNo: 'YP-2402-02', logger: '陈立', remark: '见稀疏浸染状磁铁矿' },
  { id: 'litho-004', holeId: 'hole-002', fromDepth: 96, toDepth: 132, lithology: '大理岩', color: '白色', alteration: '碳酸盐化', mineralization: '黄铜矿', rqd: 74, sampleNo: 'YP-2402-03', logger: '陈立', remark: '见细脉状黄铜矿' },
  { id: 'litho-005', holeId: 'hole-002', fromDepth: 132, toDepth: 168, lithology: '矽卡岩', color: '褐绿色', alteration: '硅化', mineralization: '黄铜矿', rqd: 61, sampleNo: 'YP-2402-04', logger: '陈立', remark: '主矿化段' },
  { id: 'litho-006', holeId: 'hole-002', fromDepth: 168, toDepth: 250, lithology: '花岗闪长岩', color: '浅灰色', alteration: '绿泥石化', mineralization: '黄铁矿', rqd: 88, sampleNo: '', logger: '陈立' },
  { id: 'litho-007', holeId: 'hole-003', fromDepth: 0, toDepth: 12, lithology: '第四系覆盖层', color: '褐黄色', alteration: '无', mineralization: '无', rqd: 0, sampleNo: '', logger: '吴倩' },
  { id: 'litho-008', holeId: 'hole-003', fromDepth: 12, toDepth: 74, lithology: '花岗闪长岩', color: '灰白色', alteration: '绿泥石化', mineralization: '无', rqd: 79, sampleNo: 'YP-2403-01', logger: '吴倩' },
  { id: 'litho-009', holeId: 'hole-003', fromDepth: 74, toDepth: 118, lithology: '断层角砾岩', color: '杂色', alteration: '碳酸盐化', mineralization: '无', rqd: 32, sampleNo: 'YP-2403-02', logger: '吴倩', remark: '破碎带，岩芯采取率低' },
  { id: 'litho-010', holeId: 'hole-003', fromDepth: 118, toDepth: 205, lithology: '矽卡岩', color: '暗绿色', alteration: '矽卡岩化', mineralization: '磁铁矿', rqd: 66, sampleNo: 'YP-2403-03', logger: '吴倩' },
  { id: 'litho-011', holeId: 'hole-003', fromDepth: 205, toDepth: 320, lithology: '大理岩', color: '灰白色', alteration: '硅化', mineralization: '黄铁矿', rqd: 71, sampleNo: 'YP-2403-04', logger: '吴倩' },
  { id: 'litho-012', holeId: 'hole-004', fromDepth: 0, toDepth: 10, lithology: '第四系覆盖层', color: '黄褐色', alteration: '无', mineralization: '无', rqd: 0, sampleNo: '', logger: '赵晓峰' },
  { id: 'litho-013', holeId: 'hole-004', fromDepth: 10, toDepth: 180, lithology: '花岗闪长岩', color: '浅灰白色', alteration: '硅化', mineralization: '磁铁矿', rqd: 86, sampleNo: 'YP-2404-01', logger: '赵晓峰' },
  { id: 'litho-014', holeId: 'hole-001', fromDepth: 0, toDepth: 9, lithology: '第四系覆盖层', color: '黄褐色', alteration: '无', mineralization: '无', rqd: 0, sampleNo: '', logger: '陈立' },
  { id: 'litho-015', holeId: 'hole-001', fromDepth: 9, toDepth: 86, lithology: '花岗闪长岩', color: '灰白色', alteration: '绿泥石化', mineralization: '无', rqd: 84, sampleNo: 'YP-2401-01', logger: '陈立' },
  { id: 'litho-016', holeId: 'hole-001', fromDepth: 86, toDepth: 155, lithology: '矽卡岩', color: '褐绿色', alteration: '矽卡岩化', mineralization: '黄铜矿', rqd: 69, sampleNo: 'YP-2401-02', logger: '陈立', remark: '主矿化段，与设计见矿层位吻合' },
  { id: 'litho-017', holeId: 'hole-005', fromDepth: 0, toDepth: 11, lithology: '第四系覆盖层', color: '褐黄色', alteration: '无', mineralization: '无', rqd: 0, sampleNo: '', logger: '吴倩' },
  { id: 'litho-018', holeId: 'hole-005', fromDepth: 11, toDepth: 45, lithology: '花岗闪长岩', color: '灰白色', alteration: '硅化', mineralization: '无', rqd: 87, sampleNo: 'YP-2405-01', logger: '吴倩' },
];

/** 首次打开（表内无数据）时写入示例数据；已有数据则不动 */
export async function seedIfEmpty(): Promise<void> {
  const flag = await db.meta.get('seeded');
  if (flag) {
    return;
  }
  const [holeCount, runCount, boxCount, lithoCount] = await Promise.all([
    db.holes.count(),
    db.runs.count(),
    db.boxes.count(),
    db.lithos.count(),
  ]);

  await db.transaction('rw', db.holes, db.runs, db.boxes, db.lithos, db.meta, async () => {
    if (holeCount === 0) await db.holes.bulkPut(SEED_HOLES);
    if (runCount === 0) await db.runs.bulkPut(SEED_RUNS);
    if (boxCount === 0) await db.boxes.bulkPut(SEED_BOXES);
    if (lithoCount === 0) await db.lithos.bulkPut(SEED_LITHOS);
    await db.meta.put({ key: 'seeded', value: new Date().toISOString() });
  });
}
