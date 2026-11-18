import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { ErrorCode, PlatformError } from '@edusports/shared';

export interface SessionClaims {
  clientInstanceId: string;
  allowedModeIds: string[];
  origin: string;
  jti: string;
}

export function issueSessionToken(
  secret: string,
  expiresInSeconds: number,
  params: {
    clientInstanceId: string;
    allowedModeIds?: string[];
    origin?: string;
  },
): { token: string; expiresAt: number; claims: SessionClaims } {
  const claims: SessionClaims = {
    clientInstanceId: params.clientInstanceId,
    allowedModeIds: params.allowedModeIds ?? ['*'],
    origin: params.origin ?? '*',
    jti: randomUUID(),
  };

  const token = jwt.sign(claims, secret, {
    expiresIn: expiresInSeconds,
    subject: params.clientInstanceId,
  });

  return {
    token,
    expiresAt: Date.now() + expiresInSeconds * 1000,
    claims,
  };
}

export function verifySessionToken(secret: string, token: string): SessionClaims {
  try {
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload & SessionClaims;
    if (!decoded || typeof decoded.clientInstanceId !== 'string') {
      throw new PlatformError(ErrorCode.UNAUTHORIZED, 'Invalid session token claims');
    }
    return {
      clientInstanceId: decoded.clientInstanceId,
      allowedModeIds: Array.isArray(decoded.allowedModeIds)
        ? decoded.allowedModeIds
        : ['*'],
      origin: typeof decoded.origin === 'string' ? decoded.origin : '*',
      jti: typeof decoded.jti === 'string' ? decoded.jti : '',
    };
  } catch (err) {
    if (err instanceof PlatformError) {
      throw err;
    }
    if (err instanceof jwt.TokenExpiredError) {
      throw new PlatformError(ErrorCode.TOKEN_EXPIRED, 'Session token has expired');
    }
    throw new PlatformError(ErrorCode.UNAUTHORIZED, 'Invalid or malformed session token');
  }
}
