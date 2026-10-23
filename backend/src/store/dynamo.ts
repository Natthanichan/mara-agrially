// DynamoDB (ตารางเดียว, on-demand) — โครงสร้าง key:
//   DEAL#<id>   / META             ข้อมูลดีล
//   DEAL#<id>   / EV#000001        เหตุการณ์ใน ledger (มี hash chain)
//   DEALINDEX   / <createdAt>#<id> ดัชนีดีลล่าสุด
//   QUOTA       / <YYYY-MM-DD>     ตัวนับโควตาการเจรจาต่อวัน
//   NABC        / <YYYY-MM-DD>     snapshot ราคาตลาดรายวัน (ใช้วิเคราะห์ต่อได้)
//   LINE#<uid>  / SESSION          สถานะคุยกับเกษตรกรใน LINE (ร่างผลผลิตรอยืนยัน) — มี ttl
//   LINEEVENT   / <webhookEventId> กัน LINE ส่ง event ซ้ำ — มี ttl
//   BUYERREQ#<uid>        / <createdAt>#<id>  ความต้องการซื้อของผู้ซื้อ (ดูของตัวเอง)
//   BUYERREQ#OPEN#<crop>  / <createdAt>#<id>  ดัชนีตามพืช (ไว้จับคู่แจ้งเตือนผู้ซื้อในขั้นต่อไป)

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { LedgerEvent } from '../core/ledger.js';
import type { NabcRecord, SnapshotStore } from '../market/nabcClient.js';
import type { BuyerRequest, DealRecord, DealStore, LineSession } from './types.js';

type Doc = Pick<DynamoDBDocumentClient, 'send'>;

export const docClient = (region?: string): DynamoDBDocumentClient =>
  DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true } });

const pad = (n: number) => String(n).padStart(6, '0');
const dealKey = (id: string) => ({ pk: `DEAL#${id}`, sk: 'META' });
const isConditionFail = (e: unknown) => (e as { name?: string })?.name === 'ConditionalCheckFailedException';

export class DynamoDealStore implements DealStore {
  constructor(private db: Doc, private table: string) {}

  async createDeal(rec: DealRecord) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { ...dealKey(rec.id), ...rec }, ConditionExpression: 'attribute_not_exists(pk)' }));
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'DEALINDEX', sk: `${rec.createdAt}#${rec.id}`, id: rec.id } }));
  }

  async getDeal(id: string) {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: dealKey(id), ConsistentRead: true }));
    if (!r.Item) return undefined;
    const { pk: _pk, sk: _sk, ...rest } = r.Item;
    return rest as DealRecord;
  }

  async updateDeal(id: string, patch: Partial<DealRecord>, expectStatus?: DealRecord['status']) {
    const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'id');
    if (!entries.length) return true;
    // DynamoDB ปฏิเสธคำสั่งที่ประกาศ ExpressionAttributeNames แต่ไม่ได้ใช้ → ใส่ #status เฉพาะตอนมีเงื่อนไขสถานะ
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};
    const sets = entries.map(([k, v], i) => {
      names[`#f${i}`] = k;
      values[`:v${i}`] = v;
      return `#f${i} = :v${i}`;
    });
    let cond = 'attribute_exists(pk)';
    if (expectStatus) {
      names['#status'] = 'status';
      cond += ' AND #status = :expect';
      values[':expect'] = expectStatus;
    }
    try {
      await this.db.send(
        new UpdateCommand({ TableName: this.table, Key: dealKey(id), UpdateExpression: `SET ${sets.join(', ')}`, ConditionExpression: cond, ExpressionAttributeNames: names, ExpressionAttributeValues: values }),
      );
      return true;
    } catch (e) {
      if (isConditionFail(e)) return false;
      throw e;
    }
  }

  async appendEvents(dealId: string, events: LedgerEvent[]) {
    // ทีละ 25 รายการ (ขีดจำกัดของ BatchWrite) — ใช้ Put แบบมีเงื่อนไขทีละรายการจะช้ากว่า แต่ seq ไม่ซ้ำอยู่แล้ว
    for (let i = 0; i < events.length; i += 25) {
      let req: Record<string, any[]> | undefined = {
        [this.table]: events.slice(i, i + 25).map((e) => ({ PutRequest: { Item: { pk: `DEAL#${dealId}`, sk: `EV#${pad(e.seq)}`, ...e } } })),
      };
      for (let attempt = 0; req && Object.keys(req).length && attempt < 5; attempt++) {
        const out: { UnprocessedItems?: Record<string, any[]> } = await this.db.send(new BatchWriteCommand({ RequestItems: req }));
        req = out.UnprocessedItems && Object.keys(out.UnprocessedItems).length ? out.UnprocessedItems : undefined;
      }
      if (req) throw new Error('บันทึกเหตุการณ์ลง DynamoDB ไม่ครบ');
    }
  }

  async listEvents(dealId: string) {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :ev)',
          ExpressionAttributeValues: { ':pk': `DEAL#${dealId}`, ':ev': 'EV#' },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      items.push(...((r.Items ?? []) as Record<string, unknown>[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return items.map(({ pk: _p, sk: _s, ...e }) => e as unknown as LedgerEvent);
  }

  async listRecentDeals(limit: number) {
    const idx = await this.db.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': 'DEALINDEX' }, ScanIndexForward: false, Limit: limit }),
    );
    const ids = (idx.Items ?? []).map((i) => String(i.id));
    if (!ids.length) return [];
    const r = await this.db.send(new BatchGetCommand({ RequestItems: { [this.table]: { Keys: ids.map(dealKey) } } }));
    const byId = new Map(((r.Responses?.[this.table] ?? []) as DealRecord[]).map((d) => [d.id, d]));
    return ids.map((id) => byId.get(id)).filter((d): d is DealRecord => !!d);
  }

  async setApproval(id: string, farmerId: string, decision: 'approve' | 'reject', at: string) {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: dealKey(id),
          UpdateExpression: 'SET approvals.#f = :d, updatedAt = :at',
          ConditionExpression: '#status = :pending',
          ExpressionAttributeNames: { '#f': farmerId, '#status': 'status' },
          ExpressionAttributeValues: { ':d': decision, ':at': at, ':pending': 'pending_approval' },
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFail(e)) return false;
      throw e;
    }
  }

  async appendEventIfNew(dealId: string, e: LedgerEvent) {
    try {
      await this.db.send(
        new PutCommand({ TableName: this.table, Item: { pk: `DEAL#${dealId}`, sk: `EV#${pad(e.seq)}`, ...e }, ConditionExpression: 'attribute_not_exists(sk)' }),
      );
      return true;
    } catch (err) {
      if (isConditionFail(err)) return false;
      throw err;
    }
  }

  async takeDailyQuota(date: string, limit: number) {
    try {
      await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: 'QUOTA', sk: date },
          UpdateExpression: 'ADD n :one',
          ConditionExpression: 'attribute_not_exists(n) OR n < :limit',
          ExpressionAttributeValues: { ':one': 1, ':limit': limit },
        }),
      );
      return true;
    } catch (e) {
      if (isConditionFail(e)) return false;
      throw e;
    }
  }

  async getLineSession(userId: string) {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: `LINE#${userId}`, sk: 'SESSION' }, ConsistentRead: true }));
    if (!r.Item) return undefined;
    const { pk: _pk, sk: _sk, ttl: _ttl, ...rest } = r.Item;
    return rest as LineSession;
  }

  async putLineSession(userId: string, s: LineSession) {
    // เก็บ 30 วันแล้วให้ DynamoDB ลบเอง (TTL)
    const ttl = Math.floor(Date.now() / 1000) + 30 * 86_400;
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `LINE#${userId}`, sk: 'SESSION', ttl, ...s } }));
  }

  async createBuyerRequest(r: BuyerRequest) {
    const sk = `${r.createdAt}#${r.id}`;
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `BUYERREQ#${r.userId}`, sk, ...r } }));
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: `BUYERREQ#OPEN#${r.crop}`, sk, id: r.id, userId: r.userId, quantityKg: r.quantityKg, offerPerKg: r.offerPerKg } }));
  }

  async listBuyerRequests(userId: string, limit: number) {
    const r = await this.db.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': `BUYERREQ#${userId}` }, ScanIndexForward: false, Limit: limit }),
    );
    return (r.Items ?? []).map(({ pk: _p, sk: _s, ...rest }) => rest as unknown as BuyerRequest);
  }

  async claimWebhookEvent(eventId: string) {
    const ttl = Math.floor(Date.now() / 1000) + 2 * 86_400;
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'LINEEVENT', sk: eventId, ttl }, ConditionExpression: 'attribute_not_exists(sk)' }));
      return true;
    } catch (e) {
      if (isConditionFail(e)) return false;
      throw e;
    }
  }
}

/** snapshot ราคา NABC รายวันใน DynamoDB — API ล่มก็ยังมีข้อมูลล่าสุด */
export class DynamoSnapshotStore implements SnapshotStore {
  constructor(private db: Doc, private table: string) {}
  async get(date: string) {
    const r = await this.db.send(new GetCommand({ TableName: this.table, Key: { pk: 'NABC', sk: date } }));
    return r.Item?.records as NabcRecord[] | undefined;
  }
  async put(date: string, records: NabcRecord[]) {
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: 'NABC', sk: date, records, fetchedAt: new Date().toISOString() } }));
  }
  async latestBefore(date: string) {
    const r = await this.db.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p AND sk < :d', ExpressionAttributeValues: { ':p': 'NABC', ':d': date }, ScanIndexForward: false, Limit: 1 }),
    );
    const it = r.Items?.[0];
    return it ? { date: String(it.sk), records: it.records as NabcRecord[] } : undefined;
  }
}
