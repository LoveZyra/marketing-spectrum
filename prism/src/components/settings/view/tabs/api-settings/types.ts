export type ApiKeyItem = {
  id: string;
  key_name: string;
  /**
   * Masked display value ("ck_1a2b3c4d..."). Keys are stored as hashes, so the
   * full value exists only in the one-time `CreatedApiKey.apiKey` response.
   */
  api_key: string;
  api_key_prefix?: string | null;
  created_at: string;
  last_used?: string | null;
  is_active: boolean;
};

export type CreatedApiKey = {
  id: string;
  keyName: string;
  /** Full key. Returned once at creation and never retrievable again. */
  apiKey: string;
  apiKeyPrefix?: string;
  createdAt?: string;
};

/**
 * A GitHub personal-access token row.
 *
 * Stored in `user_credentials` with `credential_type = 'github_token'`, not in
 * a table of its own. Its only reader is the external `/api/agent` endpoint,
 * which uses it to clone private repositories and open pull requests — Prism's
 * own UI has no git surface any more, so this is the one place a token is
 * entered and the one place it is used.
 */
export type GithubCredentialItem = {
  id: string;
  credential_name: string;
  description?: string | null;
  created_at: string;
  is_active: boolean;
};

export type ApiKeysResponse = {
  apiKeys?: ApiKeyItem[];
  success?: boolean;
  error?: string;
  apiKey?: CreatedApiKey;
};

export type GithubCredentialsResponse = {
  credentials?: GithubCredentialItem[];
  success?: boolean;
  error?: string;
};
