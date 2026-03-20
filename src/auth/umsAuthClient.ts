import axios from 'axios';
import { env } from '../config/env';
import { IAuthUser } from '../types';

interface IOauthTokenResponse {
  status: string;
  responseBody?: {
    accessToken: string;
    entityId: string;
    userType: string;
    userRole?: string;
    supeTenantId?: string;
  };
}

interface IVerifyTokenResponse {
  status: string;
  responseBody?: {
    entityId: string;
    userType: string;
    userRole?: string;
    supeTenantId?: string;
  };
}

function authHeaders(): Record<string, string> {
  if (!env.UMS_AUTH_PARAM) {
    return {};
  }
  return { Authorization: env.UMS_AUTH_PARAM };
}

export async function verifyOauthCode(oauthCode: string): Promise<{ token: string; user: IAuthUser } | null> {
  try {
    const url = `${env.UMS_AUTH_URL}/oauth2/token/supe`;
    const response = await axios.post<IOauthTokenResponse>(
      url,
      {
        grantType: 'authorization_code',
        code: oauthCode
      },
      { headers: authHeaders(), timeout: 8000 }
    );

    if (response.data?.status !== 'Success' || !response.data.responseBody) {
      return null;
    }
    if (!response.data.responseBody.supeTenantId) {
      return null;
    }

    return {
      token: response.data.responseBody.accessToken,
      user: {
        id: response.data.responseBody.entityId,
        userType: response.data.responseBody.userType,
        userRole: response.data.responseBody.userRole || null,
        tenantId: response.data.responseBody.supeTenantId
      }
    };
  } catch (_error) {
    return null;
  }
}

export async function verifySessionToken(token: string): Promise<IAuthUser | null> {
  try {
    const url = `${env.UMS_AUTH_URL}/ums/ts/verifyToken/supe`;
    const response = await axios.get<IVerifyTokenResponse>(url, {
      headers: {
        ...authHeaders(),
        'x-session-token': token
      },
      timeout: 8000
    });

    if (response.data?.status !== 'Success' || !response.data.responseBody) {
      return null;
    }
    if (!response.data.responseBody.supeTenantId) {
      return null;
    }

    return {
      id: response.data.responseBody.entityId,
      userType: response.data.responseBody.userType,
      userRole: response.data.responseBody.userRole || null,
      tenantId: response.data.responseBody.supeTenantId
    };
  } catch (_error) {
    return null;
  }
}
