// เรียก LINE Messaging API (reply = ฟรี ใช้ตอบข้อความ, push = นับโควตาของแพ็กเกจ ใช้ครั้งเดียวตอนมีผลเจรจา)

export type LineMessage = Record<string, unknown>;

export interface LineSecrets {
  channelSecret: string;
  channelAccessToken: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class LineApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class LineClient {
  constructor(
    private token: string,
    private fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private base = 'https://api.line.me/v2/bot/message',
  ) {}

  reply(replyToken: string, messages: LineMessage[]) {
    return this.post('reply', { replyToken, messages: messages.slice(0, 5) });
  }

  push(to: string, messages: LineMessage[]) {
    return this.post('push', { to, messages: messages.slice(0, 5) });
  }

  private async post(kind: 'reply' | 'push', payload: unknown) {
    const res = await this.fetchImpl(`${this.base}/${kind}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.token}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      // ไม่ใส่ token หรือ body ของคำขอใน error — LINE ตอบเหตุผลสั้นๆ มาให้
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      throw new LineApiError(res.status, `LINE ${kind} ล้มเหลว (${res.status}) ${detail}`);
    }
  }
}
