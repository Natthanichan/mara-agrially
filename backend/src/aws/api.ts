import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handleHttp } from './http.js';
import { ctx } from './runtime.js';

export const handler = (e: APIGatewayProxyEventV2) => handleHttp(ctx, e);
