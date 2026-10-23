# น้องมะระ-สหายเกษตร (MaRa-AgriAlly)

ต้นแบบสำหรับการประกวด: AI Agent รวมผลผลิตเกษตรกรรายย่อยเป็นกลุ่ม แล้วเจรจาขายแทนกลุ่ม
โดยเกษตรกรเป็นผู้อนุมัติดีลเองทุกครั้ง และผู้ซื้อโอนเงินตรงเข้าบัญชีเกษตรกรแต่ละคน

> ข้อมูลทั้งหมดในต้นแบบเป็นข้อมูลจำลอง ไม่ใช่ข้อมูลเกษตรกรหรือราคาตลาดจริง

## สถานะ
- [x] ขั้นที่ 1 โครง repo, ข้อมูลจำลอง (ข้าวหอมมะลิเป็นหลัก + มะระจีน, มันสำปะหลัง)
- [x] ขั้นที่ 2 Deterministic engine + unit test
- [x] ขั้นที่ 3 Mock Buyer API (ผู้ซื้อจำลอง 4 ราย: กดราคา, กลางๆ, ซ่อนค่าหักความชื้น, ค้าส่งผัก)
- [x] ขั้นที่ 3.5 ราคาตลาดจริงจาก NABC + RAG (custom chunking, BM25 + bigram, รองรับ embedding ภายหลัง)
- [x] ขั้นที่ 4 Agent loop (Nova บน Bedrock หรือ LLM จำลอง + tool calling + guardrails)
- [x] ขั้นที่ 5 อนุมัติ/ปฏิเสธรายคน + ledger ต่อ hash chain (API `POST /api/deals/{id}/approvals`)
- [x] ขั้นที่ 6 (เวอร์ชันเดโม) หน้าเล่นซ้ำการเจรจา `web/index.html` — สร้างจากผลรันจริงด้วย `npm run demo:export`
- [x] ขั้นที่ 7 (พร้อม deploy) SAM template: API Gateway + Lambda × 2 + DynamoDB — ดูหัวข้อ Deploy
- [x] ขั้นที่ 8 LINE OA adapter (โค้ดพร้อม + เทสด้วย LINE client จำลอง 25 ข้อ — **ยังไม่ได้ทดสอบกับ LINE จริง** ดูหัวข้อ LINE)

## กติกาที่บังคับในโค้ด (`backend/src/core`)
| กติกา | ไฟล์ |
|---|---|
| ราคาสุทธิ = ราคาเสนอ − ค่าขนส่ง/กก. (ค่าขนส่งรวม ÷ น้ำหนักรวมของเที่ยว) − ส่วนหักอื่น ปัดลงเป็นสตางค์ | `pricing.ts` |
| Price Floor: ทุกคนในดีลต้องได้สุทธิ ≥ ขั้นต่ำของตัวเอง ไม่มีข้อมูล = ไม่ผ่าน | `pricing.ts` |
| จับกลุ่ม: พืช + เกรด + จังหวัดเดียวกัน วันส่งมอบห่างกันไม่เกิน 7 วัน อย่างน้อย 2 คน | `grouping.ts` |
| สมาชิกปฏิเสธ → ถอนตัว กลุ่มไปต่อ ถ้าปริมาณต่ำกว่าขั้นต่ำผู้ซื้อ → ต้องเจรจาใหม่ | `grouping.ts` |
| Agent ปิดดีลเองไม่ได้ ต้องผ่าน `pending_approval` และทุกคนที่เหลืออนุมัติ | `stateMachine.ts` |
| สถานะดีล / ส่งมอบ / ชำระเงิน แยกกัน และต้องเป็นไปตามลำดับ | `stateMachine.ts` |
| Ledger ต่อท้ายอย่างเดียว พร้อม hash chain ตรวจการแก้ไขย้อนหลัง (ไม่ได้กันทุจริตได้ทั้งหมด) | `ledger.ts` |

## แหล่งข้อมูล
| ข้อมูล | แหล่ง | หมายเหตุ |
|---|---|---|
| ราคาข้าวเปลือกหอมมะลิ, มันสำปะหลังสด | [NABC API](https://agriapi.nabc.go.th) (`src/market/nabcClient.ts`) | ข้อมูลจริงรายวัน แปลงเป็นบาท/กก. API ล่ม → ใช้ snapshot ล่าสุดและระบุว่าเป็นข้อมูลเก่า |
| ราคามะระ | จำลอง (`knowledge/bitter-gourd-market.md`) | NABC ไม่มีราคามะระ |
| เกษตรกร, ผู้ซื้อ, ประวัติผู้ซื้อ | จำลอง | ราคาขั้นต่ำตั้งให้ใกล้ราคา NABC วันที่ 19 ต.ค. 2569 |
| เกณฑ์ความชื้น/เกรด, แนวทางเจรจา | `knowledge/*.md` | สรุปอย่างง่ายสำหรับต้นแบบ ไม่ใช่ประกาศทางการ |

## RAG (`backend/src/rag`)
- **Custom chunking:** ตัดตามหัวข้อ `##` (1 หัวข้อ = 1 ความคิด) ติด meta `docType/crop/buyer` จาก front matter และ `<!-- buyer: B-C -->` ส่วนที่ยาวเกินแบ่งย่อยแบบมีส่วนซ้อน
- **ค้นหา:** BM25 บน character bigram (ภาษาไทยไม่เว้นวรรค จึงไม่ต้องใช้พจนานุกรมตัดคำ) ไม่ต้องใช้ AWS ผลเหมือนเดิมทุกครั้ง
- **Hybrid:** ถ้ามี embedding model ใน region จะรวมคะแนนความหมาย ถ้าล่มหรือช้าเกิน timeout กลับไปใช้ lexical อัตโนมัติ
- เพิ่มความรู้: เพิ่มไฟล์ `.md` ใน `backend/knowledge/` ไม่ต้องแก้โค้ด

## Agent (`backend/src/agent`)
วงจร: **วางแผน → เรียก tool → ดูคำตอบผู้ซื้อ → ประเมินใหม่ → ทำซ้ำ** จนได้ดีลรออนุมัติ หรือส่งเรื่องให้กลุ่ม

| Tool | ทำอะไร |
|---|---|
| `get_market_price` | ราคาจริงจาก NABC |
| `search_knowledge` | RAG: ประวัติผู้ซื้อ กติกาหักความชื้น แนวทางเจรจา |
| `list_buyers` / `request_quote` | หาผู้ซื้อ ขอใบเสนอราคา |
| `evaluate_offer` | ราคาสุทธิหลังค่าขนส่ง+ส่วนหัก และตรวจ floor ทุกคน (โค้ดคำนวณ ไม่ใช่ LLM) |
| `submit_counter` | ยื่นข้อเสนอโต้กลับ / ขอลดส่วนหัก |
| `prepare_deal_for_approval` | เตรียมดีลให้เกษตรกรอนุมัติ (ไม่มี tool ปิดดีล) |
| `escalate_to_farmers` | ส่งเรื่องให้กลุ่มเมื่อไม่มีข้อเสนอผ่าน floor |

**Guardrails (บังคับในโค้ด):** ราคาต่ำกว่า floor · ข้อความมีตัวเลขขั้นต่ำ · เสนอต่ำกว่าที่ผู้ซื้อให้อยู่แล้ว · เกินจำนวนรอบต่อผู้ซื้อ · เตรียมดีลที่ไม่ผ่าน floor → บล็อกและบันทึก `guardrail_blocked`
**ขีดจำกัด:** 14 ขั้น, LLM timeout 20 วิ, retry 1 ครั้ง, งบ token ต่อการเจรจา — LLM ล่มแล้วหยุดอย่างปลอดภัย ไม่มีดีลค้าง

```bash
cd backend
NABC_OFFLINE=1 npm run agent:demo                 # LLM จำลอง + ราคาตัวอย่าง (ไม่มีค่าใช้จ่าย)
NABC_OFFLINE=1 npm run agent:demo -- bitter_gourd # กรณีส่งเรื่องให้กลุ่ม
LLM_PROVIDER=bedrock BEDROCK_MODEL_ID=<จาก console> AWS_REGION=ap-southeast-1 npm run agent:demo   # Nova จริง
```
ผลทดสอบ (LLM จำลอง, ข้อมูลจำลอง + ราคา NABC 19 ต.ค.): ข้าว 41.5 ตัน → เลือกโรงสี C หลังต่อรองหักความชื้น 4%→1.5% ราคาสุทธิเฉลี่ย 17.91 บาท/กก. สูงกว่าข้อเสนอแรกที่ดีที่สุด +0.61 บาท/กก. (≈25,315 บาททั้งกลุ่ม) — *เป็นผลทดสอบจากข้อมูลจำลอง ไม่ใช่ผลจริงในตลาด*

## Deploy บน AWS (CloudShell, `ap-southeast-1`)
```bash
git clone https://github.com/Natthanichan/mara-agrially && cd mara-agrially/backend
npm install
sam build
sam deploy --parameter-overrides BedrockModelId=<Nova model/inference profile ID>   # ยืนยัน changeset ด้วย y
```
ผลลัพธ์ `AppUrl` คือหน้าเว็บ (กด "เริ่มเจรจาด้วย AI" เพื่อรันดีลสด) · อัปเดตโค้ด: `git pull && sam build && sam deploy` · ลบทั้งหมด: `sam delete`

| Resource | ทำอะไร | ค่าใช้จ่าย |
|---|---|---|
| API Gateway HTTP API (throttle 10 req/s) | หน้าเว็บ + API + LINE webhook | จ่ายตามใช้ |
| Lambda `api` (15 วิ) / `worker` (180 วิ, ไม่ retry) | ตอบเร็ว / รัน Agent เบื้องหลัง | จ่ายตามใช้ |
| DynamoDB on-demand 1 ตาราง | ดีล, ledger, โควตา, snapshot ราคา NABC | จ่ายตามใช้ |
| Bedrock Amazon Nova (IAM อนุญาตเฉพาะ Nova) | Agent | ต่อ token · จำกัด `DailyNegotiationLimit` ครั้ง/วัน (ค่าเริ่มต้น 60) |
| CloudWatch Logs (เก็บ 7 วัน) | log | จ่ายตามใช้ |

ไม่มี EC2, NAT Gateway, load balancer หรือ OpenSearch · ใช้ LLM จำลองแทน Nova ได้: `--parameter-overrides LlmProvider=mock`

## LINE chatbot (`backend/src/line`)
ทีมเล่นบทเกษตรกร: พิมพ์ผลผลิตแบบอิสระ (เช่น “ข้าวหอมมะลิ 12 ตัน เกรด A ขั้นต่ำ 17 บาท/กก.”) → น้องมะระสรุปให้และมีปุ่มยืนยัน → เจรจาเบื้องหลัง → **ส่งข้อความหาเกษตรกรครั้งเดียว** ตอนมีผล พร้อมปุ่ม [อนุมัติ] [ไม่เอา] [ต่อรองใหม่]

| เรื่อง | รายละเอียด |
|---|---|
| Webhook | `POST /line/webhook` (และ `/api/line/webhook`) ตรวจ `X-Line-Signature` (HMAC-SHA256 กับ body ดิบ) ไม่ผ่าน = 401 |
| ค่าลับ | อ่านจาก SSM SecureString `/mara-agrially/line/channel-secret` และ `/mara-agrially/line/channel-access-token` (เปลี่ยนชื่อได้ด้วย parameter `LineChannelSecretParam` / `LineChannelAccessTokenParam`) ไม่เก็บในโค้ด |
| บทบาท | ผู้ใช้ LINE สวมบทเกษตรกร 1 คนในกลุ่มจำลอง (ข้าว=F01, มะระ=F06, มันสำปะหลัง=F09) ผลผลิตที่พิมพ์แทนที่รายการจำลองของคนนั้นเฉพาะดีลนี้ |
| สมาชิกคนอื่น | เป็นตัวจำลอง อนุมัติอัตโนมัติเมื่อผู้ใช้กดตอบ และ ledger ติดป้าย `simulated: true` |
| ไม่เอา | ผู้ใช้ถอนตัว คนที่เหลือไปต่อได้ถ้ายังผ่านราคาขั้นต่ำและปริมาณขั้นต่ำของผู้ซื้อ ไม่ผ่านก็ให้ต่อรองใหม่ |
| ต่อรองใหม่ | ยกเลิกดีลเดิม เริ่มดีลใหม่ด้วยผลผลิตเดิม ไม่เกิน 3 ครั้ง (นับโควตารายวันด้วย) |
| กันซ้ำ | `webhookEventId` ถูกจดไว้ (DynamoDB TTL 2 วัน) · ล้างร่างก่อนเริ่มดีลเพื่อกันกดยืนยันซ้ำ · ปุ่มของดีลใช้ได้เฉพาะเจ้าของ |
| ข้อความ | ใช้ reply (ไม่นับโควตา) เกือบทั้งหมด ใช้ push แค่ 1 ครั้งต่อดีลตอนเจรจาเสร็จ — แพ็กเกจฟรีของ LINE OA จำกัดจำนวนข้อความ push ต่อเดือน |
| ข้อจำกัด | อ่านข้อความด้วยกฎ regex (ไม่ใช้ AI) รองรับแชตส่วนตัวเท่านั้น (ไม่รองรับกลุ่ม) ปริมาณ 100–1,000,000 กก. ราคา 0.5–1,000 บาท/กก. |

**เลือกบทบาท:** เพิ่มเพื่อน/พิมพ์ “เมนู” → ปุ่ม [ฉันเป็นเกษตรกร] [ฉันเป็นผู้ซื้อ] (บทบาทเก็บใน session) น้องมะระเป็นผู้หญิง ใช้ “หนู/ค่ะ” ทั้งข้อความบอทและ prompt ของ Agent

**ฝั่งผู้ซื้อ (คนจริงใน LINE):** บอทถามทีละข้อ พืช (ปุ่มหรือพิมพ์) → ปริมาณ → สถานที่ส่งมอบ → ราคาที่เสนอ (บาท/กก.) → สรุปให้กดยืนยัน → บันทึกเป็น `BuyerRequest` (DynamoDB `BUYERREQ#<uid>` + ดัชนีตามพืช `BUYERREQ#OPEN#<crop>`) แล้วบอกภาพรวมผลผลิตที่มีในระบบ (ข้อมูลจำลอง ไม่มีราคาขั้นต่ำของเกษตรกร) · “คำขอของฉัน” ดูรายการ · “ยกเลิก” ล้างร่าง
**ยังไม่ได้ทำ (ขั้นต่อไป):** แจ้งเตือนผู้ซื้อเมื่อมีเกษตรกรที่ตรงกัน และให้ผู้ซื้อคุยถามเหตุผล/ต่อราคากับน้องมะระ (ต้องให้ราคาที่ตกลงผ่านโค้ดและตรวจราคาขั้นต่ำเหมือนเดิม) ตอนนี้คำขอซื้อยังไม่ถูกจับคู่กับดีลของเกษตรกร ฝั่งเกษตรกรยังเจรจากับผู้ซื้อจำลอง

ตั้งค่า: LINE Developers Console → Messaging API → **Webhook URL** = ค่า `LineWebhookUrl` จาก output ของ `sam deploy` → กด **Verify** → เปิด **Use webhook** · LINE Official Account Manager → Response settings: ปิด Auto-response messages

## รันในเครื่อง
```bash
cd backend
npm install
npm test               # unit test ทั้งหมด
npm run dev            # ทั้งระบบในเครื่อง http://localhost:3000 (memory + LLM จำลอง)
npm run build:assets   # หลังแก้ knowledge/*.md หรือ web/index.template.html
```
