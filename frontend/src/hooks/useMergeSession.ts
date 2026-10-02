import { useCallback, useEffect, useState } from 'react';
import { App as AntApp } from 'antd';
import {
  applyStagedMerge,
  clearResolution,
  clearStaged,
  countStagedPending,
  loadStaged,
  setResolution,
  type StagedMerge,
} from '../utils/mergeIO';
import { getDeviceIdentity } from '../utils/db';
import type { DeviceIdentity } from '../utils/provenance';
import type { ResolutionChoice } from '../utils/merge';

/** 差量合并会话：读取暂存、登记决议、整包应用、刷新四张表 */
export function useMergeSession(onApplied: () => void) {
  const { message } = AntApp.useApp();
  const [staged, setStaged] = useState<StagedMerge | undefined>();
  const [identity, setIdentity] = useState<DeviceIdentity | undefined>();
  const [pendingCount, setPendingCount] = useState(0);
  const [applying, setApplying] = useState(false);

  const refresh = useCallback(async () => {
    const [next, nextIdentity, count] = await Promise.all([loadStaged(), getDeviceIdentity(), countStagedPending()]);
    setStaged(next);
    setIdentity(nextIdentity);
    setPendingCount(count);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const choose = useCallback(
    async (itemId: string, choice: ResolutionChoice) => {
      try {
        const next = await setResolution(itemId, choice);
        setStaged(next);
      } catch (error) {
        message.error((error as Error).message);
      }
    },
    [message],
  );

  const unchoose = useCallback(async (itemId: string) => {
    const next = await clearResolution(itemId);
    setStaged(next);
  }, []);

  const apply = useCallback(async () => {
    if (!identity) return;
    setApplying(true);
    try {
      const result = await applyStagedMerge(identity);
      message.success(`整包应用完成：并入/更新 ${result.upserted} 条，删除 ${result.deleted} 条；待处理区剩余 ${result.remaining} 条`);
      await refresh();
      onApplied();
    } catch (error) {
      message.error(`${(error as Error).message}（四张旧表已保留，可重试）`);
      await refresh();
    } finally {
      setApplying(false);
    }
  }, [identity, message, onApplied, refresh]);

  const discard = useCallback(async () => {
    await clearStaged();
    await refresh();
  }, [refresh]);

  return { staged, identity, pendingCount, applying, refresh, choose, unchoose, apply, discard, message };
}
