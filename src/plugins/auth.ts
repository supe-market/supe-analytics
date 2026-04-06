import { FastifyReply, FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { env } from '../config/env';
import { COOKIE_NAME_BY_APP_TYPE, FALLBACK_COOKIE_NAMES } from '../config/constants';
import { verifyOauthCode, verifySessionToken } from '../auth/umsAuthClient';

const FRESH_MARKER_COOKIE = 'AUTH_FRESH_SUPE';

function buildCookieOptions(request: FastifyRequest) {
  const forwardedProto = request.headers['x-forwarded-proto'];
  const isHttps =
    request.protocol === 'https' ||
    forwardedProto === 'https' ||
    (Array.isArray(forwardedProto) && forwardedProto.includes('https'));
  const sameSite: 'none' | 'lax' = isHttps || env.NODE_ENV === 'production' ? 'none' : 'lax';

  return {
    httpOnly: true,
    signed: true,
    secure: isHttps || env.NODE_ENV === 'production',
    sameSite,
    path: '/',
    maxAge: env.SESSION_TTL_SECONDS
  };
}

function buildMarkerCookieOptions(request: FastifyRequest) {
  // Marker is unsigned and short-lived; same security flags as the auth cookie
  // but with maxAge = half the session TTL.
  const opts = buildCookieOptions(request);
  return {
    ...opts,
    signed: false,
    maxAge: Math.floor(env.SESSION_TTL_SECONDS / 2)
  };
}

function isSessionFresh(request: FastifyRequest): boolean {
  return Boolean((request.cookies || {})[FRESH_MARKER_COOKIE]);
}

function getCookieName(request: FastifyRequest): string {
  const appType = String(request.headers.apptype || request.headers.appType || '');
  return COOKIE_NAME_BY_APP_TYPE[appType] || 'AUTH_TOKEN_COOKIE_SUPE';
}

function getSessionTokenFromRequest(request: FastifyRequest): string | null {
  const cookieName = getCookieName(request);
  const signedCookies = request.cookies || {};

  if (signedCookies[cookieName]) {
    const unsigned = request.unsignCookie(String(signedCookies[cookieName]));
    return unsigned.valid ? unsigned.value : null;
  }

  for (const name of FALLBACK_COOKIE_NAMES) {
    if (signedCookies[name]) {
      const unsigned = request.unsignCookie(String(signedCookies[name]));
      return unsigned.valid ? unsigned.value : null;
    }
  }

  const headerToken = request.headers['x-session-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  return null;
}

export async function registerAuth(app: any): Promise<void> {
  await app.register(cookie, { secret: env.COOKIE_SECRET, parseOptions: {} });

  app.decorate(
    'authenticate',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const token = getSessionTokenFromRequest(request);
      if (!token) {
        reply.status(403).send({
          responseCode: '000028',
          responseMessage: 'No Token Present or Auth code , Logout user',
          status: 'Fail'
        });
        return;
      }

      const verified = await verifySessionToken(token);
      if (!verified) {
        reply.status(403).send({
          responseCode: '000028',
          responseMessage: 'Token is invalid , Logout user',
          status: 'Fail'
        });
        return;
      }

      // Sliding window with halfway-point refresh: only re-issue the cookie
      // when the short-lived marker cookie has expired (i.e. we're past the
      // halfway mark). Avoids a Set-Cookie header on every request.
      if (!isSessionFresh(request)) {
        const cookieName = getCookieName(request);
        reply.setCookie(cookieName, token, buildCookieOptions(request));
        reply.setCookie(FRESH_MARKER_COOKIE, '1', buildMarkerCookieOptions(request));
      }

      request.user = verified;
    }
  );

  const cookieHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const oauthCodeRaw = (request.query as Record<string, unknown> | undefined)?.oauthCode;
    const oauthCode = typeof oauthCodeRaw === 'string' ? oauthCodeRaw : '';
    if (oauthCode) {
      const oauthResult = await verifyOauthCode(oauthCode);
      if (!oauthResult) {
        reply.status(403).send({ responseCode: '000028', responseMessage: 'oauth not valid , Logout user', status: 'Fail' });
        return;
      }

      const cookieName = getCookieName(request);
      reply.setCookie(cookieName, oauthResult.token, buildCookieOptions(request));
      reply.setCookie(FRESH_MARKER_COOKIE, '1', buildMarkerCookieOptions(request));
      request.user = oauthResult.user;
      reply.status(200).send({ success: true, message: 'cookie-set' });
      return;
    }

    const token = getSessionTokenFromRequest(request);
    if (!token) {
      reply.status(403).send({ responseCode: '000028', responseMessage: 'No Token Present or Auth code , Logout user', status: 'Fail' });
      return;
    }

    const verified = await verifySessionToken(token);
    if (!verified) {
      reply.status(403).send({ responseCode: '000028', responseMessage: 'Token is invalid , Logout user', status: 'Fail' });
      return;
    }

    request.user = verified;
    reply.status(200).send({ success: true, message: 'cookie-valid' });
  };

  const clearCookieHandler = async (_request: FastifyRequest, reply: FastifyReply) => {
    for (const cookieName of FALLBACK_COOKIE_NAMES) {
      reply.clearCookie(cookieName, buildCookieOptions(_request));
    }
    reply.clearCookie(FRESH_MARKER_COOKIE, { path: '/' });
    reply.status(200).send({ success: true, message: 'Deleted' });
  };

  app.get('/cookie', cookieHandler);
  app.get('/oms/cookie', cookieHandler);
  app.get('/api/v1/cookie', cookieHandler);
  app.get('/api/v1/oms/cookie', cookieHandler);

  app.delete('/cookie', clearCookieHandler);
  app.delete('/oms/cookie', clearCookieHandler);
  app.delete('/api/v1/cookie', clearCookieHandler);
  app.delete('/api/v1/oms/cookie', clearCookieHandler);
}
