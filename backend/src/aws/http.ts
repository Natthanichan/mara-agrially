// แปลง HTTP API (payload v2) ↔ ฟังก์ชันของแอป — แยกจาก runtime เพื่อเทสได้โดยไม่ต้องมี AWS
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { AppError, getDeal, listDeals, recordApproval, startDeal, type AppContext } from '../app/service.js';
import { PAGE_HTML } from '../generated/page.js';

const json = (status: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});

function parseBody(e: APIGatewayProxyEventV2): Record<string, unknown> {
  if (!e.body) return {};
  const raw = e.isBase64Encoded ? Buffer.from(e.body, 'base64').toString('utf8') : e.body;
  if (raw.length > 10_000) throw new AppError(413, 'ข้อมูลใหญ่เกินไป');
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new AppError(400, 'รูปแบบ JSON ไม่ถูกต้อง');
  }
}

export async function handleHttp(ctx: AppContext, e: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const method = e.requestContext.http.method;
  const path = e.rawPath.replace(/\/+$/, '') || '/';
  try {
    if (method === 'GET' && path === '/') {
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }, body: PAGE_HTML };
    }
    if (method === 'GET' && path === '/api/health') return json(200, { ok: true });
    if (method === 'GET' && path === '/api/deals') return json(200, { deals: await listDeals(ctx) });
    if (method === 'POST' && path === '/api/deals') return json(202, await startDeal(ctx, parseBody(e)));
    const m = /^\/api\/deals\/([A-Za-z0-9-]{1,64})(\/approvals)?$/.exec(path);
    if (m && method === 'GET' && !m[2]) return json(200, await getDeal(ctx, m[1]!));
    if (m && method === 'POST' && m[2]) return json(200, await recordApproval(ctx, m[1]!, parseBody(e)));
    if (method === 'POST' && (path === '/line/webhook' || path === '/api/line/webhook')) {
      if (!ctx.line) return json(503, { error: 'ยังไม่ได้ตั้งค่า LINE' });
      // ต้องใช้ body ดิบตามที่ LINE ส่งมาเพื่อตรวจลายเซ็น (ห้าม parse แล้วแปลงกลับ)
      const raw = e.body ? (e.isBase64Encoded ? Buffer.from(e.body, 'base64').toString('utf8') : e.body) : '';
      if (raw.length > 100_000) return json(413, { error: 'ข้อมูลใหญ่เกินไป' });
      const sig = e.headers?.['x-line-signature'] ?? e.headers?.['X-Line-Signature'];
      const r = await ctx.line.handleWebhook(raw, sig);
      return json(r.status, r.status === 200 ? { ok: true } : { error: r.error ?? 'ผิดพลาด' });
    }
    return json(404, { error: 'ไม่พบหน้า/คำสั่งนี้' });
  } catch (err) {
    if (err instanceof AppError) return json(err.status, { error: err.message });
    console.error('unhandled', err);
    return json(500, { error: 'เกิดข้อผิดพลาดภายใน' });
  }
}
