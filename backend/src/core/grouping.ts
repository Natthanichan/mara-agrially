// จับกลุ่มเกษตรกร: พืชเดียวกัน เกรดเดียวกัน จังหวัดเดียวกัน และวันส่งมอบใกล้กัน

import type { Farmer, Group, Listing } from './types.js';

export interface GroupingOptions {
  /** วันส่งมอบในกลุ่มห่างจากรายการแรกได้ไม่เกินกี่วัน */
  deliveryWindowDays: number;
  /** จำนวนสมาชิกขั้นต่ำต่อกลุ่ม */
  minMembers: number;
}

const DAY_MS = 86_400_000;
const dayDiff = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);

export function groupListings(
  listings: Listing[],
  farmers: Farmer[],
  opts: GroupingOptions = { deliveryWindowDays: 7, minMembers: 2 },
): Group[] {
  const farmerById = new Map(farmers.map((f) => [f.id, f]));
  const buckets = new Map<string, Listing[]>();

  for (const l of listings) {
    const f = farmerById.get(l.farmerId);
    if (!f || l.quantityKg <= 0) continue;
    const key = `${l.crop}|${l.grade}|${f.province}`;
    const arr = buckets.get(key) ?? [];
    arr.push(l);
    buckets.set(key, arr);
  }

  const groups: Group[] = [];
  for (const [key, items] of [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const [crop, grade, province] = key.split('|') as [Listing['crop'], Listing['grade'], string];
    const sorted = [...items].sort((a, b) => a.deliveryDate.localeCompare(b.deliveryDate) || a.id.localeCompare(b.id));

    let cluster: Listing[] = [];
    const flush = () => {
      // เกษตรกร 1 คนต่อ 1 กลุ่ม (ถ้ามีหลายรายการ ใช้รายการแรก)
      const seen = new Set<string>();
      const unique = cluster.filter((l) => (seen.has(l.farmerId) ? false : (seen.add(l.farmerId), true)));
      if (unique.length >= opts.minMembers) {
        groups.push({
          id: `G-${crop}-${grade}-${groups.length + 1}`,
          crop,
          grade,
          province,
          deliveryWindow: { from: unique[0]!.deliveryDate, to: unique[unique.length - 1]!.deliveryDate },
          members: unique.map((l) => ({ farmerId: l.farmerId, listingId: l.id, quantityKg: l.quantityKg, confirmed: false, status: 'active' })),
        });
      }
      cluster = [];
    };

    for (const l of sorted) {
      if (cluster.length && dayDiff(cluster[0]!.deliveryDate, l.deliveryDate) > opts.deliveryWindowDays) flush();
      cluster.push(l);
    }
    flush();
  }
  return groups;
}

export const activeMembers = (g: Group) => g.members.filter((m) => m.status === 'active');
export const activeQuantityKg = (g: Group) => activeMembers(g).reduce((s, m) => s + m.quantityKg, 0);

/**
 * สมาชิกปฏิเสธดีล → ถอนตัวจากดีลนี้ กลุ่มไปต่อได้
 * คืนค่า needsRenegotiation=true ถ้าปริมาณที่เหลือต่ำกว่าขั้นต่ำของผู้ซื้อ
 */
export function withdrawMember(g: Group, farmerId: string, buyerMinKg: number): { group: Group; remainingKg: number; needsRenegotiation: boolean } {
  if (!g.members.some((m) => m.farmerId === farmerId && m.status === 'active')) {
    throw new Error(`ไม่พบสมาชิกที่ยังอยู่ในกลุ่ม: ${farmerId}`);
  }
  const group: Group = {
    ...g,
    members: g.members.map((m) => (m.farmerId === farmerId ? { ...m, status: 'withdrawn' as const } : m)),
  };
  const remainingKg = activeQuantityKg(group);
  return { group, remainingKg, needsRenegotiation: remainingKg < buyerMinKg };
}
