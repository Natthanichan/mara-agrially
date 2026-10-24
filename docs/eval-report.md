# ผลประเมินการเจรจา (ข้อมูลจำลอง)

สถานการณ์ 25 แบบ: ข้าวเปลือกหอมมะลิ, มันสำปะหลังสด, มะระจีน × บุคลิกผู้ซื้อ (ผู้ซื้อตั้งต้น, งบตึง, งบหลวม, ไม่ค่อยฟังเหตุผล) × มี/ไม่มีราคา NABC

| แบบ | ได้ดีล | เพิ่มจาก "ไม่เจรจา" (บาท/กก.) | เพิ่มจากข้อเสนอแรกของรายที่เลือก (บาท/กก.) | รอบเฉลี่ย | ถูกบล็อก | ตัวเลขไม่มีหลักฐาน | เหตุผลซ้ำ |
|---|---|---|---|---|---|---|---|
| รับข้อเสนอแรกที่ดีที่สุด (ไม่เจรจา) | 8/25 | 0.00 | – | 0.00 | 0 | 0 | 0 |
| เจรจาด้วยตัวเลขอย่างเดียว | 17/25 | +0.61 | +0.57 | 4.80 | 0 | 0 | 47 |
| เจรจาด้วยกลยุทธ์ + หลักฐาน (AI สำรอง) | 25/25 | +0.65 | +1.46 | 5.04 | 9 | 0 | 0 |

"เพิ่มจาก ไม่เจรจา" = ราคาสุทธิเฉลี่ยทั้งกลุ่มที่ได้เพิ่มจากการรับข้อเสนอแรกที่ดีที่สุด เทียบเฉพาะสถานการณ์ที่ได้ดีลทั้งคู่ · ราคาสุทธิ = หลังค่าขนส่งและส่วนหัก

## รายสถานการณ์ (ราคาสุทธิเฉลี่ย บาท/กก. · – = ไม่ได้ดีล)

| สถานการณ์ | opening | numbers | evidence |
|---|---|---|---|
| rice_hommali/default/nabc | 17.30 | 17.95 | 17.99 |
| rice_hommali/default/no-nabc | 17.30 | 17.95 | 17.97 |
| rice_hommali/tight/nabc | 17.30 | 17.76 | 17.80 |
| rice_hommali/tight/no-nabc | 17.30 | 17.76 | 17.80 |
| rice_hommali/generous/nabc | 17.30 | 17.97 | 18.06 |
| rice_hommali/generous/no-nabc | 17.30 | 17.95 | 18.06 |
| rice_hommali/stubborn/nabc | 17.30 | 17.95 | 17.97 |
| rice_hommali/stubborn/no-nabc | 17.30 | 17.95 | 17.95 |
| cassava/default/nabc | – | 3.83 | 3.99 |
| cassava/default/no-nabc | – | 3.70 | 3.76 |
| cassava/tight/nabc | – | 3.73 | 3.80 |
| cassava/tight/no-nabc | – | 3.70 | 3.76 |
| cassava/generous/nabc | – | 3.83 | 3.99 |
| cassava/generous/no-nabc | – | 3.70 | 3.76 |
| cassava/stubborn/nabc | – | 3.83 | 3.87 |
| cassava/stubborn/no-nabc | – | 3.70 | 3.75 |
| bitter_gourd/default/nabc | – | – | 19.11 |
| bitter_gourd/default/no-nabc | – | – | 19.11 |
| bitter_gourd/tight/nabc | – | – | 19.11 |
| bitter_gourd/tight/no-nabc | – | – | 19.11 |
| bitter_gourd/generous/nabc | – | – | 19.11 |
| bitter_gourd/generous/no-nabc | – | – | 19.11 |
| bitter_gourd/stubborn/nabc | – | – | 19.03 |
| bitter_gourd/stubborn/no-nabc | – | – | 19.03 |
| rice_hommali/default/nabc/high-floor-17.5 | – | 17.95 | 17.99 |

กลยุทธ์ที่ AI สำรองใช้ (รวมทุกสถานการณ์): competitive_leverage ×18, contest_deduction ×9, address_objection ×35, evidence_value ×43, final_push ×5, anchor ×16

> ผลทดสอบจากข้อมูลจำลองและผู้ซื้อจำลอง ไม่ใช่ผลในตลาดจริง
