// ที่เก็บข้อมูลดีล — ตอนเทสใช้ memory, บน AWS ใช้ DynamoDB (ตารางเดียว on-demand)
import type { LedgerEvent } from '../core/ledger.js';
import type { DealStatus } from '../core/stateMachine.js';
import type { Crop } from '../core/types.js';
import type { AgentMetrics, AgentOutcome } from '../agent/loop.js';

export type ApprovalDecision = 'approve' | 'reject';

export interface DealRecord {
  id: string;
  crop: Crop;
  groupId: string;
  /** queued = รอ worker เริ่ม */
  status: DealStatus | 'queued';
  llm: string;
  createdAt: string;
  updatedAt: string;
  marketDate: string;
  outcome?: AgentOutcome;
  metrics?: AgentMetrics;
  approvals: Record<string, ApprovalDecision>;
  deliveryStatus?: string;
  paymentStatus?: string;
  error?: string;
}

export interface DealStore {
  createDeal(rec: DealRecord): Promise<void>;
  getDeal(id: string): Promise<DealRecord | undefined>;
  /** อัปเดตแบบมีเงื่อนไข: ถ้าระบุ expectStatus แล้วสถานะไม่ตรง → คืน false (กันสองคำขอชนกัน) */
  updateDeal(id: string, patch: Partial<DealRecord>, expectStatus?: DealRecord['status']): Promise<boolean>;
  appendEvents(dealId: string, events: LedgerEvent[]): Promise<void>;
  listEvents(dealId: string): Promise<LedgerEvent[]>;
  listRecentDeals(limit: number): Promise<DealRecord[]>;
  /** บันทึกการอนุมัติของเกษตรกร 1 คนแบบ atomic (ไม่ทับของคนอื่น) เฉพาะตอนสถานะรออนุมัติ */
  setApproval(id: string, farmerId: string, decision: ApprovalDecision, at: string): Promise<boolean>;
  /** เขียนเหตุการณ์ 1 รายการ ถ้า seq นี้มีแล้ว (มีคนเขียนก่อน) คืน false ให้ลองใหม่ */
  appendEventIfNew(dealId: string, e: LedgerEvent): Promise<boolean>;
  /** นับจำนวนการเจรจาต่อวัน คืน false ถ้าเกินโควตา (กันค่าใช้จ่าย Bedrock บาน) */
  takeDailyQuota(date: string, limit: number): Promise<boolean>;
}
