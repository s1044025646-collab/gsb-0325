import { AppError, ErrorCode } from './errors.js';
import type { Comparator, NetworkDef, Stage } from './types.js';

export const SUPPORTED_WIRE_COUNTS = [1, 2, 4, 8, 16] as const;

/**
 * 生成 Batcher 双调排序网络（最终升序）。
 *
 * 算法（自行展开比较交换阶段，不调用数组排序）：
 *   for p = 2,4,...,n:        // 双调构造粒度翻倍
 *     for k = p/2, p/4, ...,1 // 双调合并的跨度递降
 *       对每个满足 (i & k)==0 的 i 放置比较器 (i, i+k)
 *       方向由 (i & p)==0 决定：构造段下半 asc、上半 desc；
 *       合并推进后同一 (p) 组整体朝升序归并。
 *
 * 每个 (p, k) 层内比较器互不共线，天然并行，成为一个阶段。
 */
export function generateBitonic(wireCount: number): NetworkDef {
  if (!SUPPORTED_WIRE_COUNTS.includes(wireCount as (typeof SUPPORTED_WIRE_COUNTS)[number])) {
    throw new AppError(
      ErrorCode.UNSUPPORTED_SIZE,
      `仅支持线路数 ${SUPPORTED_WIRE_COUNTS.join('/')}，收到 ${wireCount}`
    );
  }

  const stages: Stage[] = [];

  if (wireCount === 1) {
    return { wireCount: 1, stages: [] };
  }

  for (let p = 2; p <= wireCount; p *= 2) {
    for (let k = p / 2; k >= 1; k /= 2) {
      const comparators: Comparator[] = [];
      for (let i = 0; i < wireCount; i++) {
        if ((i & k) === 0) {
          const dir = (i & p) === 0 ? 'asc' : 'desc';
          comparators.push({ a: i, b: i + k, dir });
        }
      }
      const isMergeEntry = k === p / 2;
      const explanation =
        `构造粒度 p=${p}，合并跨度 k=${k}；` +
        (isMergeEntry
          ? '双调合并入口：按构造段分组，段内下半升序(asc)、上半降序(desc)比较'
          : '双调合并推进：跨度递降，按构造段方向继续归并') +
        `，最终整体归为升序`;
      stages.push({ comparators, explanation });
    }
  }

  return { wireCount, stages };
}
