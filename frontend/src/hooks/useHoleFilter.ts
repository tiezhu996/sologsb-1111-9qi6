import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DrillHole } from '../types/drill-hole';
import type { DrillRun } from '../types/drill-run';

export interface HoleFilterState {
  keyword: string;
  rigNo: string;
  shift: string;
}

export interface HoleFilterApi extends HoleFilterState {
  activeCount: number;
  setKeyword: (value: string) => void;
  setRigNo: (value: string) => void;
  setShift: (value: string) => void;
  reset: () => void;
  /** 按孔号 / 钻机 / 班组筛选钻孔 */
  apply: (holes: DrillHole[]) => DrillHole[];
  /** 回次是否命中当前筛选（按所属钻孔） */
  matchRun: (run: DrillRun, holes: DrillHole[]) => boolean;
}

/**
 * 孔号、钻机与施工班组筛选条件：条件保存在 URL query 中，
 * 刷新与前进后退都能还原，钻孔台帐与工作台共用。
 */
export function useHoleFilter(): HoleFilterApi {
  const [params, setParams] = useSearchParams();

  const state: HoleFilterState = useMemo(
    () => ({
      keyword: params.get('kw') ?? '',
      rigNo: params.get('rig') ?? '',
      shift: params.get('shift') ?? '',
    }),
    [params],
  );

  const patch = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(params);
      Object.entries(updates).forEach(([key, value]) => {
        if (value) next.set(key, value);
        else next.delete(key);
      });
      setParams(next, { replace: true });
    },
    [params, setParams],
  );

  const apply = useCallback(
    (holes: DrillHole[]) => {
      const kw = state.keyword.trim().toLowerCase();
      return holes.filter((hole) => {
        if (state.rigNo && hole.rigNo !== state.rigNo) return false;
        if (state.shift && hole.shift !== state.shift) return false;
        if (kw) {
          const haystack = `${hole.holeNo} ${hole.rigNo} ${hole.shift} ${hole.remark ?? ''}`.toLowerCase();
          if (!haystack.includes(kw)) return false;
        }
        return true;
      });
    },
    [state],
  );

  const matchRun = useCallback(
    (run: DrillRun, holes: DrillHole[]) => apply(holes).some((hole) => hole.id === run.holeId),
    [apply],
  );

  const activeCount = [state.keyword, state.rigNo, state.shift].filter(Boolean).length;

  return {
    ...state,
    activeCount,
    setKeyword: (value) => patch({ kw: value }),
    setRigNo: (value) => patch({ rig: value }),
    setShift: (value) => patch({ shift: value }),
    reset: () => patch({ kw: '', rig: '', shift: '' }),
    apply,
    matchRun,
  };
}
