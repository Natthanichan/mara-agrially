// ที่เก็บข้อมูลดีล — ตอนเทสใช้ memory, บน AWS ใช้ DynamoDB (ตารางเดียว on-demand)
import type { LedgerEvent } from '../core/ledger.js';
import type { DealStatus } from '../core/stateMachine.js';
import type { Crop, Grade, Listing } from '../core/types.js';
import type { AgentMetrics, AgentOutcome } from '../agent/loop.js';

export type ApprovalDecision = 'approve' | 'reject';

/** ผลผลิตที่เกษตรกรพิมพ์ใน LINE รอกดยืนยัน */
export interface ListingDraft {
  crop: Crop;
  quantityKg: number;
  grade: Grade;
  /** ราคาสุทธิขั้นต่ำต่อกก. ของเกษตรกร — ข้อมูลส่วนตัว ห้ามส่งให้ผู้ซื้อ */
  floorPricePerKg: number;
}

export type LineRole = 'farmer' | 'buyer';

/** ผู้ซื้อ (คนจริงใน LINE) กำลังตอบคำถามทีละข้อเพื่อลงทะเบียนความต้องการซื้อ */
export interface BuyerDraft {
  step: 'crop' | 'quantity' | 'location' | 'price' | 'confirm';
  crop?: Crop;
  quantityKg?: number;
  location?: string;
  /** ราคาที่ผู้ซื้อเสนอซื้อ (บาท/กก.) */
  offerPerKg?: number;
}

/** ความต้องการซื้อที่ผู้ซื้อลงทะเบียนไว้ */
export interface BuyerRequest {
  id: string;
  userId: string;
  crop: Crop;
  quantityKg: number;
  location: string;
  offerPerKg: number;
  status: 'open';
  createdAt: string;
}

/** สถานะการคุยกับผู้ใช้ LINE 1 คน (เกษตรกรหรือผู้ซื้อ) */
export interface LineSession {
  role?: LineRole;
  draft?: ListingDraft;
  buyerDraft?: BuyerDraft;
  lastDealId?: string;
  updatedAt: string;
}

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
  /** ดีลที่เริ่มจาก LINE: ผู้ใช้ LINE ที่เล่นบทเกษตรกร และเกษตรกรในกลุ่มที่เขาสวมบทบาท */
  lineUserId?: string;
  lineFarmerId?: string;
  /** ผลผลิตที่เกษตรกรใน LINE พิมพ์ — ใช้แทนรายการจำลองของเกษตรกรคนนั้นเฉพาะดีลนี้ */
  listingOverrides?: Listing[];
  /** รอบการเจรจาใหม่ต่อจากดีลเดิม (0 = ดีลแรก) */
  round?: number;
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
  getLineSession(userId: string): Promise<LineSession | undefined>;
  putLineSession(userId: string, s: LineSession): Promise<void>;
  /** จดว่า webhook event นี้ถูกประมวลผลแล้ว คืน false ถ้าเคยจดไว้ (กัน LINE ส่งซ้ำแล้วเริ่มดีลซ้ำ) */
  claimWebhookEvent(eventId: string): Promise<boolean>;
  createBuyerRequest(r: BuyerRequest): Promise<void>;
  /** คำขอซื้อของผู้ใช้คนนี้ ใหม่สุดก่อน */
  listBuyerRequests(userId: string, limit: number): Promise<BuyerRequest[]>;
}
