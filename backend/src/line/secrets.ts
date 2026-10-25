// อ่าน LINE secret/token: ในเครื่องใช้ env, บน AWS อ่านจาก SSM Parameter Store (SecureString)
// ไม่ log ค่าลับ และเก็บแคชในหน่วยความจำของ Lambda container เท่านั้น

import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import type { LineSecrets } from './client.js';

export const DEFAULT_SECRET_PARAM = '/mara-agrially/line/channel-secret';
export const DEFAULT_TOKEN_PARAM = '/mara-agrially/line/channel-access-token';

export function secretsLoader(env: Record<string, string | undefined> = process.env, ssm: Pick<SSMClient, 'send'> = new SSMClient({ region: env.AWS_REGION })): () => Promise<LineSecrets> {
  let cached: Promise<LineSecrets> | undefined;
  return () => {
    if (!cached) {
      cached = load(env, ssm).catch((e) => {
        cached = undefined; // ลองใหม่ได้ครั้งหน้า (เช่น เพิ่งตั้งค่าเสร็จ)
        throw e;
      });
    }
    return cached;
  };
}

async function load(env: Record<string, string | undefined>, ssm: Pick<SSMClient, 'send'>): Promise<LineSecrets> {
  if (env.LINE_CHANNEL_SECRET && env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { channelSecret: env.LINE_CHANNEL_SECRET, channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN };
  }
  const secretName = env.LINE_SECRET_PARAM || DEFAULT_SECRET_PARAM;
  const tokenName = env.LINE_TOKEN_PARAM || DEFAULT_TOKEN_PARAM;
  const out = await ssm.send(new GetParametersCommand({ Names: [secretName, tokenName], WithDecryption: true }));
  const byName = new Map((out.Parameters ?? []).map((p) => [p.Name, p.Value]));
  const channelSecret = byName.get(secretName);
  const channelAccessToken = byName.get(tokenName);
  if (!channelSecret || !channelAccessToken) {
    throw new Error(`ไม่พบค่า LINE ใน SSM: ${[!channelSecret && secretName, !channelAccessToken && tokenName].filter(Boolean).join(', ')}`);
  }
  return { channelSecret, channelAccessToken };
}
