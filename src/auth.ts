import axios from "axios";
import { B2AuthResponse, B2Config } from "./utils/types.js";
import { withRetry } from "./utils/retry.js";
import { buildUserAgent } from "./utils/user-agent.js";

/** Timeout for the authorize_account request. */
const AUTH_TIMEOUT_MS = 30_000;

// v3 is required: Partner API (Groups) and Backup API endpoints reject v2 tokens.
const AUTH_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";

interface B2V3AuthResponse {
  accountId: string;
  authorizationToken: string;
  apiInfo: {
    storageApi: {
      apiUrl: string;
      downloadUrl: string;
      s3ApiUrl: string;
      recommendedPartSize: number;
      absoluteMinimumPartSize: number;
    };
  };
}
// Token lifetime is 24h but we refresh after 23h to be safe
const TOKEN_TTL_MS = 23 * 60 * 60 * 1000;

/**
 * B2AuthManager handles account authorization and caches the token
 * to avoid redundant authorize_account calls. If a request fails
 * with 401, call invalidate() and the next call to getAuth() will
 * re-authorize automatically.
 */
export class B2AuthManager {
  private config: B2Config;
  private cachedAuth: B2AuthResponse | null = null;
  private authTime: number | null = null;
  private inflightAuth: Promise<B2AuthResponse> | null = null;

  constructor(config: B2Config) {
    this.config = config;
  }

  /**
   * Return cached auth or re-authorize. Thread-safe — multiple concurrent
   * callers will share a single in-flight authorize call.
   */
  async getAuth(): Promise<B2AuthResponse> {
    if (this.isValid()) {
      return this.cachedAuth!;
    }

    if (this.inflightAuth) {
      return this.inflightAuth;
    }

    this.inflightAuth = this.authorize().finally(() => {
      this.inflightAuth = null;
    });

    return this.inflightAuth;
  }

  /**
   * Invalidate the cached token. Subsequent getAuth() calls will re-authorize.
   */
  invalidate(): void {
    this.cachedAuth = null;
    this.authTime = null;
  }

  /**
   * Force a fresh authorization and return the result.
   * Useful for testing credentials or initial setup.
   */
  async forceRefresh(): Promise<B2AuthResponse> {
    this.invalidate();
    return this.getAuth();
  }

  private isValid(): boolean {
    if (!this.cachedAuth || this.authTime === null) return false;
    return Date.now() - this.authTime < TOKEN_TTL_MS;
  }

  private async authorize(): Promise<B2AuthResponse> {
    const credentials = Buffer.from(
      `${this.config.applicationKeyId}:${this.config.applicationKey}`,
    ).toString("base64");

    const response = await withRetry(() =>
      axios.get<B2V3AuthResponse>(AUTH_URL, {
        headers: {
          Authorization: `Basic ${credentials}`,
          "User-Agent": buildUserAgent(this.config),
        },
        timeout: AUTH_TIMEOUT_MS,
      }),
    );

    const v3 = response.data;
    this.cachedAuth = {
      accountId: v3.accountId,
      authorizationToken: v3.authorizationToken,
      apiUrl: v3.apiInfo.storageApi.apiUrl,
      downloadUrl: v3.apiInfo.storageApi.downloadUrl,
      s3ApiUrl: v3.apiInfo.storageApi.s3ApiUrl,
      recommendedPartSize: v3.apiInfo.storageApi.recommendedPartSize,
      absoluteMinimumPartSize: v3.apiInfo.storageApi.absoluteMinimumPartSize,
    };
    this.authTime = Date.now();
    return this.cachedAuth;
  }
}
