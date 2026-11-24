import { useMemo } from 'react';
import type { Instance, InstanceActivityItem } from '@nf-hub/protocol';
import { toActivityView, unknownActivity, type TabActivityView } from '../lib/tabActivity';

export type TabActivityIndex = {
  activityFor: (instanceId: string) => TabActivityView;
  lastSuccessFor: (instanceId: string) => number | null;
};
/**
 * Adapter over the shared per-instance activity projection. Counts are trusted only for a
 * connected, fresh instance inside a verified snapshot; anything else stays unknown and
 * renders as `—`, never as 0. The item type comes from the protocol owner.
 */
export function useTabActivity(instances: readonly Instance[], items?: readonly InstanceActivityItem[], trusted = true): TabActivityIndex {
  return useMemo(() => {
    const activity = new Map<string, TabActivityView>();
    const lastSuccess = new Map<string, number | null>();
    const byId = new Map((items ?? []).map(item => [item.instanceId, item]));
    for (const instance of instances) {
      const item = byId.get(instance.id);
      const current = trusted && instance.freshness === 'fresh' && instance.connection === 'connected';
      activity.set(instance.id, item ? toActivityView(item, current) : unknownActivity);
      lastSuccess.set(instance.id, trusted ? item?.lastSuccessAt ?? instance.lastSuccessAt : null);
    }
    return { activityFor: (id: string) => activity.get(id) ?? unknownActivity, lastSuccessFor: (id: string) => lastSuccess.get(id) ?? null };
  }, [instances, items, trusted]);
}
