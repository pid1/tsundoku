export interface Env {
  DB: D1Database;
  BOOKS: R2Bucket;
  ASSETS: Fetcher;

  /** Keyed-hash pepper for credential verifiers. Secret. */
  PEPPER: string;
  /** HMAC key for session cookies. Secret. */
  SESSION_KEY: string;

  /** Seeds the first admin while the users table is empty. Secret, optional. */
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;

  CATALOG_TITLE: string;
  PAGE_SIZE: string;
  MAX_UPLOAD_MB: string;
  ALLOW_KOSYNC_REGISTER: string;
}

export interface User {
  id: string;
  username: string;
  display_name: string | null;
  role: "admin" | "reader";
  opds_verifier: string;
  kosync_verifier: string;
  disabled: number;
  created_at: number;
  password_set_at: number;
}

export interface Book {
  id: string;
  r2_key: string;
  format: string;
  mime: string;
  filename: string;
  byte_size: number;
  content_md5: string | null;
  partial_md5: string | null;
  partial_md5_alt: string | null;
  title: string;
  sort_title: string;
  series: string | null;
  series_index: number | null;
  language: string | null;
  publisher: string | null;
  published: string | null;
  isbn: string | null;
  description: string | null;
  cover_key: string | null;
  cover_mime: string | null;
  indexed: number;
  index_error: string | null;
  added_at: number;
  added_by: string;
  updated_at: number;
}

/** A book plus its joined authors and tags. What every renderer consumes. */
export interface BookView extends Book {
  authors: string[];
  tags: string[];
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NavEntry {
  id: string;
  title: string;
  count: number;
}

export interface ProgressRow {
  user_id: string;
  document: string;
  percentage: number;
  progress: string;
  device: string;
  device_id: string;
  metadata: string | null;
  updated_at: number;
}
