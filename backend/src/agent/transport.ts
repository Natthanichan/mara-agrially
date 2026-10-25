// จัดเที่ยวขนส่ง: ฟาร์มในเส้นทาง (routeId) เดียวกันใช้รถเที่ยวเดียวกัน
// ค่าขนส่งต่อเที่ยวเป็นค่าจำลอง — ระบบคำนวณราคาสุทธิจะเฉลี่ยเป็นต่อกก. ให้เอง (core/pricing.ts)

import type { Farmer, GroupMember, TransportTrip } from '../core/types.js';

/** ค่าขนส่งจำลองต่อเที่ยว (บาท) แยกตามเส้นทาง */
export const ROUTE_TRIP_COST: Record<string, number> = {
  'RE-1': 7_000,
  'RE-2': 8_000,
  'RB-1': 2_500,
  'NR-1': 9_000,
  'SR-1': 3_000,
  'PB-1': 6_000,
};
export const DEFAULT_TRIP_COST = 8_000;

export function planTrips(members: Pick<GroupMember, 'farmerId'>[], farmers: Farmer[]): TransportTrip[] {
  const routeOf = new Map(farmers.map((f) => [f.id, f.routeId]));
  const byRoute = new Map<string, string[]>();
  for (const m of members) {
    const r = routeOf.get(m.farmerId) ?? `solo-${m.farmerId}`;
    byRoute.set(r, [...(byRoute.get(r) ?? []), m.farmerId]);
  }
  return [...byRoute.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([route, ids]) => ({ id: `T-${route}`, totalCost: ROUTE_TRIP_COST[route] ?? DEFAULT_TRIP_COST, farmerIds: ids }));
}
